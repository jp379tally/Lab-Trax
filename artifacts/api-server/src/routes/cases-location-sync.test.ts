/**
 * Regression suite: Mobile case location changes must sync to web and desktop.
 *
 * Protected workflow: "Mobile Case Location Cross-Platform Sync"
 *
 * Root cause (fixed): batchLocateCases() only wrote to AsyncStorage; it never
 * called syncCaseToServer(), so batch location changes were invisible to
 * web/desktop. Single-case updateCaseStatus() already called syncCaseToServer()
 * correctly — this suite guards both paths at the API level.
 *
 * A second bug (fixed alongside): the GET /api/cases list endpoint had a local
 * MOBILE_TO_DESKTOP_STATUS that was missing SCAN, POST_MILL, SINTERING_FURNACE,
 * MODEL_ROOM, and mapped COMPLETE to "delivered" instead of "complete". This
 * caused the web/desktop list view to show the wrong location even when the
 * mobile client had correctly synced the new status to the server. The detail
 * endpoint (tryProjectLegacyCaseForDesktop) had the correct mapping; the list
 * endpoint was out of sync with it.
 *
 * The server-side sync path for both single and batch locate is identical:
 *   1. Mobile calls POST /api/legacy/cases with the full case blob
 *      (caseData includes the new `status` field).
 *   2. Server stores it in lab_cases.caseData (blob-replace / append-only merge
 *      for arrays; scalar fields like `status` come from the new payload).
 *   3. GET /api/cases bridges lab_cases → canonical shape, reading
 *      parsed.status from the blob and mapping it via MOBILE_TO_DESKTOP_STATUS.
 *   4. Web/desktop GET /api/cases and GET /api/cases/:id both return the
 *      updated location.
 *
 * Response envelope: all API routes return { ok: true, data: T } via ok().
 *
 * Test coverage:
 *   (1) Single locate  — POST with updated status stores new location; GET
 *                        /api/cases returns the mapped desktop status.
 *   (2) Location overwrite — a third POST replaces the previous status; no
 *                        stale location leaks through.
 *   (3) Batch locate   — two cases synced independently; GET /api/cases
 *                        shows updated status for both (guards batchLocateCases).
 *   (4) Case detail    — GET /api/cases/:id returns the updated location
 *                        (the endpoint desktop uses for case detail view).
 *   (5) Cross-workflow — case creation + multiple location changes stay
 *                        consistent across list and detail views.
 *   (6) Auth guard     — unauthenticated client cannot read location.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import request from "supertest";
import { vi } from "vitest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-location-sync"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

maybe("Mobile case location sync — cross-platform regression", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const userId = rid("uloc");
  let token = "";

  async function makeSession(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const t = auth.signAccessToken(uid, sessionId);
    const hash = createHash("sha256").update(t).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId: uid, tokenHash: hash, expiresAt });
    return t;
  }

  /** Simulate mobile client syncing a case to the server. */
  async function syncCase(
    caseId: string,
    status: string,
    extra: Record<string, unknown> = {}
  ) {
    const caseBlob = {
      id: caseId,
      caseNumber: `26-LOC-${caseId.slice(-4)}`,
      patientName: "Test Patient",
      doctorName: "Dr. Test",
      toothIndices: "#8",
      material: "Zirconia",
      status,
      affiliationKey: `org:${labOrgId}`,
      ...extra,
    };
    return request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: caseId, ownerId: userId, caseData: JSON.stringify(caseBlob) });
  }

  /** Fetch the case list and find a specific case by ID. */
  async function fetchCaseFromList(caseId: string) {
    const res = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // ok() wraps as { ok: true, data: T }
    const list: any[] = res.body.data ?? [];
    return list.find((c: any) => c.id === caseId) ?? null;
  }

  beforeAll(async () => {
    fs.mkdirSync(
      path.join(os.tmpdir(), "labtrax-test-location-sync"),
      { recursive: true }
    );
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-locsync";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: userId, username: `loc_${userId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Location Sync Test Lab" },
    ]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId,
        role: "admin",
        status: "active",
      },
    ]);
    token = await makeSession(userId);
  });

  // Refresh session token before every test so a concurrent user_sessions
  // wipe does not invalidate the shared token mid-suite.
  beforeEach(async () => {
    token = await makeSession(userId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      users,
      organizations,
      organizationMemberships,
      labCases,
      invoices,
      userSessions,
      auditLogs,
    } = dbMod as any;
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(labCases).where(eq(labCases.organizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  // ── (1) Single locate — server stores new location ────────────────────────
  it("(1a) POST /api/legacy/cases with updated status stores new location in lab_cases", async () => {
    token = await makeSession(userId);
    const caseId = rid("c1a");

    const create = await syncCase(caseId, "INTAKE");
    expect(create.status).toBe(200);

    const move = await syncCase(caseId, "DESIGN");
    expect(move.status).toBe(200);

    const { db, labCases } = dbMod as any;
    const row = await db.query.labCases.findFirst({
      where: eq(labCases.id, caseId),
    });
    expect(row, "lab_cases row must exist").toBeDefined();
    const parsed = JSON.parse(row.caseData as string);
    expect(parsed.status).toBe("DESIGN");
  });

  it("(1b) GET /api/cases returns the updated location mapped to desktop format", async () => {
    token = await makeSession(userId);
    const caseId = rid("c1b");

    await syncCase(caseId, "INTAKE");
    await syncCase(caseId, "SCAN");

    const found = await fetchCaseFromList(caseId);
    expect(found, "updated case must appear in GET /api/cases").not.toBeNull();
    // Mobile "SCAN" → desktop "scan"
    expect(found.status).toBe("scan");
    expect(found._source).toBe("mobile");
    expect(found.labOrganizationId).toBe(labOrgId);
  });

  it("(1c) GET /api/cases maps MODEL_ROOM and MILLING statuses correctly", async () => {
    token = await makeSession(userId);
    const millId = rid("c1c_mill");
    const modelId = rid("c1c_model");

    await syncCase(millId, "INTAKE");
    await syncCase(millId, "MILLING");
    await syncCase(modelId, "INTAKE");
    await syncCase(modelId, "MODEL_ROOM");

    const mill = await fetchCaseFromList(millId);
    const model = await fetchCaseFromList(modelId);

    expect(mill?.status).toBe("in_milling");
    expect(model?.status).toBe("model_room");
  });

  // ── (2) Location overwrite — old status replaced, not retained ────────────
  it("(2) A later sync with a different status replaces the old location", async () => {
    token = await makeSession(userId);
    const caseId = rid("c2");

    await syncCase(caseId, "INTAKE");
    await syncCase(caseId, "MILLING");
    await syncCase(caseId, "QC_CHECK"); // third state — must win

    const found = await fetchCaseFromList(caseId);
    expect(found, "case must appear after multiple status syncs").not.toBeNull();
    // Should show the LAST synced status, not any earlier one
    expect(found.status).toBe("qc");
  });

  // ── (3) Batch locate — multiple cases all sync ────────────────────────────
  it("(3) Batch: two cases synced with new status both appear updated on web/desktop", async () => {
    token = await makeSession(userId);
    const caseIdA = rid("c3a");
    const caseIdB = rid("c3b");

    await syncCase(caseIdA, "INTAKE");
    await syncCase(caseIdB, "INTAKE");

    // Simulate batch locate: syncCaseToServer fires for each case in the batch.
    await syncCase(caseIdA, "PORCELAIN");
    await syncCase(caseIdB, "PORCELAIN");

    const foundA = await fetchCaseFromList(caseIdA);
    const foundB = await fetchCaseFromList(caseIdB);

    expect(foundA, "case A must appear after batch sync").not.toBeNull();
    expect(foundB, "case B must appear after batch sync").not.toBeNull();

    // "PORCELAIN" → "in_porcelain" on desktop
    expect(foundA.status).toBe("in_porcelain");
    expect(foundB.status).toBe("in_porcelain");
  });

  // ── (4) Case detail view — GET /api/cases/:id returns updated location ────
  it("(4) GET /api/cases/:id returns the updated location (desktop case detail bridge)", async () => {
    token = await makeSession(userId);
    const caseId = rid("c4");

    await syncCase(caseId, "INTAKE");
    await syncCase(caseId, "MODEL_ROOM");

    const res = await request(appMod.default)
      .get(`/api/cases/${encodeURIComponent(caseId)}`)
      .set("Authorization", `Bearer ${token}`);

    // tryProjectLegacyCaseForDesktop bridges a lab_cases row into the
    // canonical DetailedCase shape when the id isn't in the cases table.
    // ok() wraps as { ok: true, data: T }.
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("model_room");
    expect(res.body.data?._source).toBe("mobile");
  });

  // ── (5) Cross-workflow — list and detail agree after multiple moves ────────
  it("(5) List and detail views agree on location after several syncs", async () => {
    token = await makeSession(userId);
    const caseId = rid("c5");

    await syncCase(caseId, "INTAKE");
    await syncCase(caseId, "SCAN");
    await syncCase(caseId, "MILLING");
    await syncCase(caseId, "COMPLETE");

    // List view
    const fromList = await fetchCaseFromList(caseId);
    expect(fromList, "case must appear in list after location changes").not.toBeNull();
    // "COMPLETE" → "complete" (fixed from erroneously mapping to "delivered")
    expect(fromList.status).toBe("complete");

    // Detail view — must agree
    const detail = await request(appMod.default)
      .get(`/api/cases/${encodeURIComponent(caseId)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data?.status).toBe("complete");
  });

  // ── (6) Auth guard — unauthenticated client cannot read location ──────────
  it("(6) GET /api/cases requires authentication (returns 401 without token)", async () => {
    const res = await request(appMod.default).get("/api/cases");
    expect(res.status).toBe(401);
  });
});
