/**
 * Integration tests for POST /api/cases/bulk-reassign and
 * POST /api/cases/bulk-status.
 *
 * Regression coverage for the desktop "Reassign / change status → 404 'No
 * matching cases found.'" bug: the desktop case list (GET /cases) merges
 * canonical `cases` rows with legacy mobile `lab_cases` rows. The old handlers
 * resolved the lab + existence from `uniqueCaseIds[0]` against the canonical
 * table only, so a lab whose cases were all created in the mobile app 404'd on
 * every bulk-reassign and bulk-status.  This mirrors the same fix applied to
 * bulk-delete (cases-bulk-delete.test.ts).
 *
 * Skipped when DATABASE_URL is not configured (same convention used by
 * sibling test suites). Each test cleans up its own rows; afterAll sweeps the
 * rest so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  bulk-reassign
 *  - Happy path (canonical): cases reassigned, updatedCount correct
 *  - REGRESSION (legacy-only): no 404, skippedLegacyCount reported
 *  - REGRESSION (mixed, legacy id first): canonical updated, legacy skipped
 *  - 403 when the caller is a member but not admin/owner
 *  - 404 when no id matches either table
 *  - 401 when no auth token is provided
 *
 *  bulk-status
 *  - Happy path (canonical): status updated, updatedCount correct
 *  - REGRESSION (legacy-only): no 404, skippedLegacyCount reported
 *  - REGRESSION (mixed, legacy id first): canonical updated, legacy skipped
 *  - 404 when no id matches either table
 *  - 401 when no auth token is provided
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("POST /api/cases/bulk-reassign and /bulk-status (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab2");
  const practiceId = rid("prov");
  const otherPracticeId = rid("prov2");
  const adminUserId = rid("uadmin");
  const staffUserId = rid("ustaff");

  const tokens = { admin: "", staff: "" };

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt,
    });
    return token;
  }

  async function insertCanonical(caseNumber: string): Promise<string> {
    const { db, cases } = dbMod as any;
    const id = rid("c");
    await db.insert(cases).values({
      id,
      caseNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName: "Dr. Test",
      patientFirstName: "Pat",
      patientLastName: "Test",
      status: "draft",
      createdByUserId: adminUserId,
    });
    return id;
  }

  async function insertLegacy(): Promise<string> {
    const { db, labCases } = dbMod as any;
    const id = rid("legacy");
    await db.insert(labCases).values({
      id,
      ownerId: adminUserId,
      organizationId: labOrgId,
      caseData: JSON.stringify({ patientName: "Legacy Pat", status: "RECEIVED" }),
    });
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-bulk-reassign-status";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "x" },
      { id: staffUserId, username: `stf_${staffUserId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Bulk Ops Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Bulk Ops Other Lab" },
      {
        id: practiceId,
        type: "provider",
        name: "Bulk Ops Test Practice",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: otherPracticeId,
        type: "provider",
        name: "Bulk Ops Other Practice",
        parentLabOrganizationId: otherLabOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: adminUserId,
        role: "admin",
        status: "active",
      },
      {
        id: rid("m"),
        labId: labOrgId,
        userId: staffUserId,
        role: "staff",
        status: "active",
      },
    ]);

    tokens.admin = await makeSession(adminUserId);
    tokens.staff = await makeSession(staffUserId);
  }, 60_000);

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      cases,
      labCases,
      organizationMemberships,
      userSessions,
      auditLogs,
    } = dbMod as any;
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, otherLabOrgId]));
    await db
      .delete(cases)
      .where(inArray(cases.labOrganizationId, [labOrgId, otherLabOrgId]));
    await db
      .delete(labCases)
      .where(inArray(labCases.organizationId, [labOrgId, otherLabOrgId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [adminUserId, staffUserId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [adminUserId, staffUserId]));
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [labOrgId, otherLabOrgId, practiceId, otherPracticeId]),
      );
    await db.delete(users).where(inArray(users.id, [adminUserId, staffUserId]));
  });

  // ── bulk-reassign ────────────────────────────────────────────────────────────

  describe("bulk-reassign", () => {
    it("happy path: reassigns canonical cases and returns updatedCount", async () => {
      const c1 = await insertCanonical(rid("RA1"));
      const c2 = await insertCanonical(rid("RA2"));

      const r = await request(appMod.default)
        .post("/api/cases/bulk-reassign")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({ caseIds: [c1, c2], providerOrganizationId: practiceId });

      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.data.updatedCount).toBe(2);
      expect(r.body.data.skippedLegacyCount).toBe(0);

      const { db, cases } = dbMod as any;
      const rows = await db
        .select({ providerOrganizationId: cases.providerOrganizationId })
        .from(cases)
        .where(inArray(cases.id, [c1, c2]));
      for (const row of rows) {
        expect(row.providerOrganizationId).toBe(practiceId);
      }
    });

    it("REGRESSION: legacy-only selection returns 200 with skippedLegacyCount (no 404)", async () => {
      const l1 = await insertLegacy();
      const l2 = await insertLegacy();

      const r = await request(appMod.default)
        .post("/api/cases/bulk-reassign")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({ caseIds: [l1, l2], providerOrganizationId: practiceId });

      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.data.updatedCount).toBe(0);
      expect(r.body.data.skippedLegacyCount).toBe(2);
    });

    it("REGRESSION: mixed batch with legacy id first — canonical updated, legacy skipped", async () => {
      const legacy = await insertLegacy();
      const canonical = await insertCanonical(rid("RA_MIX"));

      const r = await request(appMod.default)
        .post("/api/cases/bulk-reassign")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({ caseIds: [legacy, canonical], providerOrganizationId: practiceId });

      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.data.updatedCount).toBe(1);
      expect(r.body.data.skippedLegacyCount).toBe(1);

      const { db, cases } = dbMod as any;
      const [canonRow] = await db
        .select({ providerOrganizationId: cases.providerOrganizationId })
        .from(cases)
        .where(eq(cases.id, canonical));
      expect(canonRow.providerOrganizationId).toBe(practiceId);
    });

    it("returns 403 when the caller is a member but not admin/owner", async () => {
      const c1 = await insertCanonical(rid("RA_NOADMIN"));

      const r = await request(appMod.default)
        .post("/api/cases/bulk-reassign")
        .set("Authorization", `Bearer ${tokens.staff}`)
        .send({ caseIds: [c1], providerOrganizationId: practiceId });

      expect(r.status).toBe(403);
    });

    it("returns 404 when no id matches either table", async () => {
      const r = await request(appMod.default)
        .post("/api/cases/bulk-reassign")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({ caseIds: [rid("ghost")], providerOrganizationId: practiceId });

      expect(r.status).toBe(404);
    });

    it("returns 401 when no auth token is provided", async () => {
      const r = await request(appMod.default)
        .post("/api/cases/bulk-reassign")
        .send({ caseIds: [rid("c")], providerOrganizationId: practiceId });

      expect(r.status).toBe(401);
    });
  });

  // ── bulk-status ──────────────────────────────────────────────────────────────

  describe("bulk-status", () => {
    it("happy path: updates canonical case status and returns updatedCount", async () => {
      const c1 = await insertCanonical(rid("ST1"));
      const c2 = await insertCanonical(rid("ST2"));

      const r = await request(appMod.default)
        .post("/api/cases/bulk-status")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({ caseIds: [c1, c2], status: "shipped" });

      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.data.updatedCount).toBe(2);
      expect(r.body.data.skippedLegacyCount).toBe(0);

      const { db, cases } = dbMod as any;
      const rows = await db
        .select({ status: cases.status })
        .from(cases)
        .where(inArray(cases.id, [c1, c2]));
      for (const row of rows) {
        expect(row.status).toBe("shipped");
      }
    });

    it("REGRESSION: legacy-only selection returns 200 with skippedLegacyCount (no 404)", async () => {
      const l1 = await insertLegacy();
      const l2 = await insertLegacy();

      const r = await request(appMod.default)
        .post("/api/cases/bulk-status")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({ caseIds: [l1, l2], status: "complete" });

      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.data.updatedCount).toBe(0);
      expect(r.body.data.skippedLegacyCount).toBe(2);
    });

    it("REGRESSION: mixed batch with legacy id first — canonical updated, legacy skipped", async () => {
      const legacy = await insertLegacy();
      const canonical = await insertCanonical(rid("ST_MIX"));

      const r = await request(appMod.default)
        .post("/api/cases/bulk-status")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({ caseIds: [legacy, canonical], status: "qc" });

      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.data.updatedCount).toBe(1);
      expect(r.body.data.skippedLegacyCount).toBe(1);

      const { db, cases } = dbMod as any;
      const [canonRow] = await db
        .select({ status: cases.status })
        .from(cases)
        .where(eq(cases.id, canonical));
      expect(canonRow.status).toBe("qc");
    });

    it("returns 404 when no id matches either table", async () => {
      const r = await request(appMod.default)
        .post("/api/cases/bulk-status")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({ caseIds: [rid("ghost")], status: "complete" });

      expect(r.status).toBe(404);
    });

    it("returns 401 when no auth token is provided", async () => {
      const r = await request(appMod.default)
        .post("/api/cases/bulk-status")
        .send({ caseIds: [rid("c")], status: "complete" });

      expect(r.status).toBe(401);
    });
  });
});
