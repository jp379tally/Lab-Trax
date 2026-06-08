/**
 * Integration tests for invoice routes (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/invoices — creates a draft invoice (201)
 *  - GET /api/invoices — returned list includes the created invoice
 *  - POST /api/invoices — 403 when caller is not a lab member
 *  - Unauthenticated requests return 401
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-invoices"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Invoices (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const outsiderId = rid("out");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  async function makeSession(userId: string): Promise<{ access: string; refresh: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access, refresh };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-invoices";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: labOwnerId, username: `invowner_${labOwnerId}`, password: "x" },
      { id: outsiderId, username: `invout_${outsiderId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("InvTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("InvTestPractice"),
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
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      invoiceLineItems,
      invoices,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    if (invoiceLineItems) {
      await db.delete(invoiceLineItems).where(
        inArray(
          invoiceLineItems.invoiceId,
          (await db.select({ id: invoices.id }).from(invoices).where(
            inArray(invoices.labOrganizationId, [labOrgId])
          )).map((r: any) => r.id)
        )
      );
    }
    await db.delete(invoices).where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db.delete(userSessions).where(
      inArray(userSessions.userId, [labOwnerId, outsiderId])
    );
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labOwnerId, outsiderId])
    );
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId, outsiderId]));
  });

  // ── POST /api/invoices ────────────────────────────────────────────────────

  it("POST /api/invoices creates a draft invoice and returns 201", async () => {
    const { access } = await makeSession(labOwnerId);
    const invoiceNumber = rid("INV");

    const r = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });

    expect(r.status).toBe(201);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.invoiceNumber).toBe(invoiceNumber);
    expect(r.body.data.status).toBe("draft");
    expect(r.body.data.labOrganizationId).toBe(labOrgId);
  });

  it("POST /api/invoices without required fields returns 400", async () => {
    const { access } = await makeSession(labOwnerId);

    const r = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId });

    expect(r.status).toBe(400);
  });

  it("POST /api/invoices as non-member returns 403", async () => {
    const { access } = await makeSession(outsiderId);

    const r = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber: rid("INV"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });

    expect(r.status).toBe(403);
  });

  it("unauthenticated POST /api/invoices returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/invoices")
      .send({
        invoiceNumber: rid("INV"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(r.status).toBe(401);
  });

  // ── PATCH /api/invoices/:id (status transition) ───────────────────────────

  it("PATCH /api/invoices/:id updates status to open", async () => {
    const { access } = await makeSession(labOwnerId);
    const invoiceNumber = rid("PATCHINV");

    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(create.status).toBe(201);
    const invoiceId = create.body.data.id;

    const patch = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "open" });
    expect(patch.status).toBe(200);
    expect(patch.body.data?.status ?? patch.body.status).toBe("open");
  });

  it("GET /api/invoices as non-lab-member returns 200 with no results for that lab", async () => {
    // The list endpoint filters by the caller's own memberships, so a user with
    // no membership in labOrgId gets 200 with an empty result set — not a 403.
    // This is the cross-lab scoping guarantee: non-members cannot see other labs' invoices.
    const { access } = await makeSession(outsiderId);

    const r = await request(appMod.default)
      .get(`/api/invoices?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const list: any[] = r.body.data ?? [];
    expect(list.length).toBe(0);
  });

  // ── PATCH /api/invoices/:id — line items ─────────────────────────────────

  it("PATCH /api/invoices/:id with items array stores line items (subtotal reflects them)", async () => {
    const { access } = await makeSession(labOwnerId);
    const invoiceNumber = rid("LIINV");

    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(create.status).toBe(201);
    const invoiceId = create.body.data.id;

    const patch = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        items: [
          { description: "PFM Crown", quantity: 1, unitPrice: 150 },
          { description: "Porcelain Veneer", quantity: 2, unitPrice: 75 },
        ],
      });
    expect(patch.status).toBe(200);
    // 150*1 + 75*2 = 300
    const subtotal = Number(
      patch.body.data?.subtotal ?? patch.body.subtotal ?? 0
    );
    expect(subtotal).toBeCloseTo(300, 1);
  });

  // ── PATCH /api/invoices/:id — mark paid ──────────────────────────────────

  it("PATCH /api/invoices/:id with status 'paid' marks the invoice as paid", async () => {
    const { access } = await makeSession(labOwnerId);
    const invoiceNumber = rid("PAIDINV");

    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(create.status).toBe(201);
    const invoiceId = create.body.data.id;

    // Move to open first so the status history is realistic
    const toOpen = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "open" });
    expect(toOpen.status).toBe(200);

    const paid = await request(appMod.default)
      .patch(`/api/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "paid" });
    expect(paid.status).toBe(200);
    expect(paid.body.data?.status ?? paid.body.status).toBe("paid");
  });

  // ── GET /api/invoices ─────────────────────────────────────────────────────

  it("GET /api/invoices returns list including the created invoice", async () => {
    const { access } = await makeSession(labOwnerId);
    const invoiceNumber = rid("LISTINV");

    const create = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(create.status).toBe(201);
    const invoiceId = create.body.data.id;

    const list = await request(appMod.default)
      .get(`/api/invoices?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const ids: string[] = (list.body.data ?? []).map((inv: any) => inv.id);
    expect(ids).toContain(invoiceId);
  });
});
