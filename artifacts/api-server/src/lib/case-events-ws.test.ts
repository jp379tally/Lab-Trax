/**
 * Real-time case-updates WebSocket channel — integration tests.
 *
 * Covers the gap flagged in code review of the original implementation:
 * ticket-based auth on the WS upgrade, room isolation between cases, and
 * delivery of a `case-updated` event immediately after a REST mutation.
 *
 * Skipped when DATABASE_URL is not configured — mirrors the SHOULD_RUN
 * pattern used by the other case route integration tests in this directory.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { inArray, eq } from "drizzle-orm";
import request from "supertest";
import WebSocket from "ws";
import * as path from "node:path";

vi.mock("./backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("./statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("./case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-case-ws"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("case-events-ws — WebSocket auth, room isolation, and delivery", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("./auth.js");
  let wsLib: typeof import("./case-events-ws.js");

  let httpServer: HttpServer;
  let wsBaseUrl: string;

  const labOwnerId = rid("u");
  const outsiderId = rid("u_out"); // never joins any org below
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  const createdCaseIds: string[] = [];

  async function makeSession(userId: string): Promise<{ access: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access };
  }

  async function createCase(access: string): Promise<string> {
    const res = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("C"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Wendy",
        patientLastName: "Socket",
        doctorName: "Dr. Realtime",
        status: "received",
      });
    expect(res.status).toBe(201);
    const caseId = res.body?.data?.id as string;
    createdCaseIds.push(caseId);
    return caseId;
  }

  async function mintTicket(access: string, caseId: string): Promise<string> {
    const res = await request(appMod.default)
      .post(`/api/cases/${caseId}/ws-ticket`)
      .set("Authorization", `Bearer ${access}`);
    expect(res.status).toBe(200);
    const ticket = res.body?.data?.ticket as string;
    expect(typeof ticket).toBe("string");
    expect(ticket.length).toBeGreaterThan(0);
    return ticket;
  }

  function wsUrlFor(ticket: string, caseId: string): string {
    const url = new URL(wsBaseUrl);
    url.searchParams.set("ticket", ticket);
    url.searchParams.set("caseId", caseId);
    return url.toString();
  }

  /**
   * Opens a socket and waits to see whether the server closes it. The WS
   * upgrade handshake (client "open") completes before the connection
   * handler's async ticket/access checks run, so a rejected client still
   * sees "open" fire first — only resolve "stayed open" once a grace period
   * has passed with no subsequent close.
   */
  function connectAndWait(
    ticket: string,
    caseId: string,
    graceMs = 800,
  ): Promise<{ ws: WebSocket; closeCode: number | null }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrlFor(ticket, caseId));
      let settled = false;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      ws.on("open", () => {
        graceTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ ws, closeCode: null });
        }, graceMs);
      });
      ws.on("close", (code: number) => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        resolve({ ws, closeCode: code });
      });
    });
  }

  /** Waits for the next message on an open socket, or null on timeout/close. */
  function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<any | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      ws.once("message", (data: Buffer) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(data.toString()));
        } catch {
          resolve(null);
        }
      });
      ws.once("close", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-case-events-ws";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("./auth.js");
    wsLib = await import("./case-events-ws.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: labOwnerId, username: `case_ws_${labOwnerId}`, password: "doesnotmatter" },
      { id: outsiderId, username: `case_ws_${outsiderId}`, password: "doesnotmatter" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("CaseWsLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("CaseWsPractice"),
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: labOrgId,
      userId: labOwnerId,
      role: "owner",
      status: "active",
      approvedByUserId: labOwnerId,
      joinedAt: new Date(),
    });
    // outsiderId is deliberately given NO membership anywhere.

    if (!SHOULD_RUN) return;
    httpServer = appMod.default.listen(0);
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    wsLib.attachCaseEventsWebSocketServer(httpServer);
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    wsBaseUrl = `ws://127.0.0.1:${port}/api/ws/cases`;
  }, 30000);

  afterEach(() => {
    // Nothing socket-specific to clean up globally — each test closes its
    // own sockets — but keep the hook so future additions have a home.
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      caseEvents,
      caseNotes,
      invoices,
      cases: casesTable,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    if (createdCaseIds.length) {
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, createdCaseIds));
      await db.delete(caseNotes).where(inArray(caseNotes.caseId, createdCaseIds));
    }
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db.delete(invoices).where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db.delete(casesTable).where(inArray(casesTable.labOrganizationId, [labOrgId]));
    await db.delete(userSessions).where(inArray(userSessions.userId, [labOwnerId, outsiderId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [labOwnerId, outsiderId]));
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId, outsiderId]));

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("mints a ticket via REST and admits a WS connection that then receives case-updated after a mutation", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const ticket = await mintTicket(access, caseId);

    const { ws, closeCode } = await connectAndWait(ticket, caseId);
    expect(closeCode).toBeNull();

    const messagePromise = nextMessage(ws);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "in_design" });
    expect(patch.status).toBe(200);

    const message = await messagePromise;
    expect(message).not.toBeNull();
    expect(message.type).toBe("case-updated");
    expect(message.caseId).toBe(caseId);

    ws.close();
  }, 20000);

  it("a case-updated push always arrives after its status_changed timeline event is committed", async () => {
    // Regression for a review finding: broadcastCaseUpdated used to fire
    // immediately after the `cases` row UPDATE but before the status/step/
    // shade case_events inserts that follow in the same handler. A mobile
    // client that refetched the instant it received the push could see the
    // new status with a stale (pre-change) timeline. The broadcast must now
    // be the very last thing the PATCH handler does.
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const ticket = await mintTicket(access, caseId);

    const { ws, closeCode } = await connectAndWait(ticket, caseId);
    expect(closeCode).toBeNull();

    const messagePromise = nextMessage(ws);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "in_design" });
    expect(patch.status).toBe(200);

    const message = await messagePromise;
    expect(message).not.toBeNull();
    expect(message.type).toBe("case-updated");
    expect(message.caseId).toBe(caseId);

    // The instant the push is observed, the accompanying status_changed
    // event must already be committed and visible.
    const { db, caseEvents } = dbMod as any;
    const events = await db.query.caseEvents.findMany({
      where: eq(caseEvents.caseId, caseId),
    });
    const statusEvent = events.find(
      (e: any) => e.eventType === "status_changed",
    );
    expect(statusEvent).toBeDefined();
    expect(statusEvent.metadataJson).toMatchObject({
      fromStatus: "received",
      toStatus: "in_design",
    });

    ws.close();
  }, 20000);

  it("a bulk-pricing push arrives only after the affected invoice total is resynced", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);

    const restoration = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        toothNumber: "8",
        restorationType: "crown",
        material: "Realtime Zirconia",
        quantity: 1,
        unitPrice: 10,
      });
    expect(restoration.status).toBe(201);

    const ticket = await mintTicket(access, caseId);
    const { ws, closeCode } = await connectAndWait(ticket, caseId);
    expect(closeCode).toBeNull();
    const messagePromise = nextMessage(ws);

    const pricing = await request(appMod.default)
      .patch("/api/cases/restorations/pricing")
      .set("Authorization", `Bearer ${access}`)
      .send({
        restorationType: "crown",
        material: "Realtime Zirconia",
        unitPrice: 87,
      });
    expect(pricing.status).toBe(200);
    expect(pricing.body?.data?.updated).toBe(1);

    const message = await messagePromise;
    expect(message).not.toBeNull();
    expect(message.type).toBe("case-updated");
    expect(message.caseId).toBe(caseId);

    // The push is the client's signal to refetch. At that exact point the
    // invoice must already expose the new total, not the old pre-sync value.
    const { db, invoices } = dbMod as any;
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.caseId, caseId),
    });
    expect(invoice).toBeDefined();
    expect(Number(invoice.total)).toBe(87);
    expect(Number(invoice.balanceDue)).toBe(87);

    ws.close();
  }, 20000);

  it("rejects a connection with a missing/invalid ticket (close code 4001)", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);

    const { closeCode } = await connectAndWait("not-a-real-ticket", caseId);
    expect(closeCode).toBe(4001);
  }, 20000);

  it("rejects a connection whose caseId does not match the ticket's case (close code 4003)", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseIdA = await createCase(access);
    const caseIdB = await createCase(access);
    const ticketForA = await mintTicket(access, caseIdA);

    const { closeCode } = await connectAndWait(ticketForA, caseIdB);
    expect(closeCode).toBe(4003);
  }, 20000);

  it("rejects a ticket that has already been redeemed once (close code 4001 on replay)", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);
    const ticket = await mintTicket(access, caseId);

    const first = await connectAndWait(ticket, caseId);
    expect(first.closeCode).toBeNull();
    first.ws.close();

    const replay = await connectAndWait(ticket, caseId);
    expect(replay.closeCode).toBe(4001);
  }, 20000);

  it("the REST ticket-mint endpoint itself refuses a user with no access to the case (403)", async () => {
    const { access: ownerAccess } = await makeSession(labOwnerId);
    const caseId = await createCase(ownerAccess);
    const { access: outsiderAccess } = await makeSession(outsiderId);

    const res = await request(appMod.default)
      .post(`/api/cases/${caseId}/ws-ticket`)
      .set("Authorization", `Bearer ${outsiderAccess}`);
    expect(res.status).toBe(403);
  }, 20000);

  it("the WS layer itself re-checks case access and rejects a ticket minted for an unauthorized user (close code 4003)", async () => {
    // Simulates access being revoked between ticket mint and redemption: mint
    // the ticket directly via the exported helper (bypassing the REST gate)
    // for a user who has no membership anywhere, and confirm the connection
    // handler's own userCanAccessCase re-check rejects it independently of
    // the REST endpoint's authorization.
    const { access: ownerAccess } = await makeSession(labOwnerId);
    const caseId = await createCase(ownerAccess);
    const ticket = wsLib.issueCaseWsTicket(outsiderId, caseId);

    const { closeCode } = await connectAndWait(ticket, caseId);
    expect(closeCode).toBe(4003);
  }, 20000);

  it("room isolation — a client subscribed to case A gets nothing when only case B changes", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseIdA = await createCase(access);
    const caseIdB = await createCase(access);

    const ticketA = await mintTicket(access, caseIdA);
    const ticketB = await mintTicket(access, caseIdB);

    const clientA = await connectAndWait(ticketA, caseIdA);
    const clientB = await connectAndWait(ticketB, caseIdB);
    expect(clientA.closeCode).toBeNull();
    expect(clientB.closeCode).toBeNull();

    const messageAPromise = nextMessage(clientA.ws, 1500);
    const messageBPromise = nextMessage(clientB.ws, 3000);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseIdB}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "in_design" });
    expect(patch.status).toBe(200);

    const [messageA, messageB] = await Promise.all([messageAPromise, messageBPromise]);
    expect(messageA).toBeNull(); // case A's room got nothing
    expect(messageB).not.toBeNull();
    expect(messageB.caseId).toBe(caseIdB);

    clientA.ws.close();
    clientB.ws.close();
  }, 20000);
});
