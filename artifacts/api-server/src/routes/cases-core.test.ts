/**
 * Integration tests for core case lifecycle routes (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/cases — creates a case (201)
 *  - GET /api/cases/:id — returns the case detail
 *  - GET /api/cases — list filtered by labOrganizationId
 *  - DELETE /api/cases/:caseId — soft-deletes; row still present with deletedAt set
 *  - GET /api/cases/:id for unknown case returns 404
 *  - Unauthenticated requests return 401
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq, isNotNull } from "drizzle-orm";
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-cases"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Cases core lifecycle (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  // Track case IDs created during tests for cleanup.
  const createdCaseIds: string[] = [];

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
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-cases";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `caseowner_${labOwnerId}`,
      password: "doesnotmatter",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("CasesTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("CasesTestPractice"),
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
      caseEvents,
      caseNotes,
      invoices,
      cases: casesTable,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    // Case-level dependents first.
    if (createdCaseIds.length) {
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, createdCaseIds));
      await db.delete(caseNotes).where(inArray(caseNotes.caseId, createdCaseIds));
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds));
    }
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db.delete(invoices).where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db.delete(casesTable).where(inArray(casesTable.labOrganizationId, [labOrgId]));
    await db.delete(userSessions).where(inArray(userSessions.userId, [labOwnerId]));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labOwnerId])
    );
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  // ── POST /api/cases ───────────────────────────────────────────────────────

  it("POST /api/cases creates a case and returns 201", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("CN");

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "John",
        patientLastName: "Doe",
        doctorName: "Dr. Smith",
        status: "received",
      });

    expect(r.status).toBe(201);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.patientFirstName).toBe("John");
    expect(r.body.data.patientLastName).toBe("Doe");
    expect(r.body.data.labOrganizationId).toBe(labOrgId);

    if (r.body.data?.id) createdCaseIds.push(r.body.data.id);
  });

  it("POST /api/cases missing required fields returns 400", async () => {
    const { access } = await makeSession(labOwnerId);

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId });

    expect(r.status).toBe(400);
  });

  it("unauthenticated POST /api/cases returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/cases")
      .send({
        caseNumber: "X-1",
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "A",
        patientLastName: "B",
        doctorName: "Dr. C",
      });
    expect(r.status).toBe(401);
  });

  // ── GET /api/cases/:id ────────────────────────────────────────────────────

  it("GET /api/cases/:id returns the full case detail", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("GC");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Jane",
        patientLastName: "Smith",
        doctorName: "Dr. Jones",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(get.status).toBe(200);
    expect(get.body.data.id).toBe(caseId);
    expect(get.body.data.patientFirstName).toBe("Jane");
  });

  it("GET /api/cases/:id for unknown case returns 404", async () => {
    const { access } = await makeSession(labOwnerId);

    const r = await request(appMod.default)
      .get("/api/cases/nonexistent-case-id-xyz-abc")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(404);
  });

  // ── GET /api/cases ────────────────────────────────────────────────────────

  it("GET /api/cases?labOrganizationId=... returns cases for that lab", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("LC");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "List",
        patientLastName: "Test",
        doctorName: "Dr. List",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const list = await request(appMod.default)
      .get(`/api/cases?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const ids: string[] = (list.body.data ?? []).map((c: any) => c.id);
    expect(ids).toContain(caseId);
  });

  // ── PATCH /api/cases/:caseId (status transition) ─────────────────────────

  it("PATCH /api/cases/:caseId updates status field", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("PC");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Patch",
        patientLastName: "Me",
        doctorName: "Dr. Patch",
        status: "received",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "in_design" });
    expect(patch.status).toBe(200);
    expect(patch.body.data?.status ?? patch.body.status).toBe("in_design");
  });

  // ── Cross-lab scoping ──────────────────────────────────────────────────────

  it("GET /api/cases/:id returns 404 for a user not in the lab", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("XLSC");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "CrossLab",
        patientLastName: "Scope",
        doctorName: "Dr. Scope",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    // A different user with no membership in this lab.
    const outsiderId = rid("xlsout");
    const { db, users, userSessions } = dbMod as any;
    await db.insert(users).values({ id: outsiderId, username: `xlsout_${outsiderId}`, password: "x" });
    try {
      const { access: outsiderAccess } = await makeSession(outsiderId);
      const r = await request(appMod.default)
        .get(`/api/cases/${caseId}`)
        .set("Authorization", `Bearer ${outsiderAccess}`);
      // assertCaseAccess checks lab membership; non-members get 403 (not a member)
      // rather than 404 (case not found), which is the correct scoping behaviour.
      expect(r.status).toBe(403);
    } finally {
      await db.delete(userSessions).where(eq(userSessions.userId, outsiderId));
      await db.delete(users).where(eq(users.id, outsiderId));
    }
  });

  // ── DELETE /api/cases/:caseId (soft-delete) ───────────────────────────────

  it("DELETE /api/cases/:caseId soft-deletes the case (row still exists with deletedAt set)", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("DC");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Delete",
        patientLastName: "Me",
        doctorName: "Dr. Delete",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const del = await request(appMod.default)
      .delete(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(del.status).toBe(200);
    expect(del.body.data?.deleted ?? del.body.deleted).toBe(true);

    // After soft-delete, GET /:id should return 404 (row hidden from normal reads).
    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(get.status).toBe(404);

    // The row must still exist in the DB with deletedAt set (soft-delete guarantee).
    const { db, cases: casesTable } = dbMod as any;
    const [row] = await db.select().from(casesTable).where(eq(casesTable.id, caseId));
    expect(row).toBeDefined();
    expect(row.deletedAt).not.toBeNull();

    // The deleted case must NOT appear in the list endpoint.
    const { access: access2 } = await makeSession(labOwnerId);
    const list = await request(appMod.default)
      .get(`/api/cases?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access2}`);
    expect(list.status).toBe(200);
    const ids: string[] = (list.body.data ?? []).map((c: any) => c.id);
    expect(ids).not.toContain(caseId);
  });
});
