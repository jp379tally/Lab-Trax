/**
 * Integration tests for POST /api/cases/bulk-reassign (Task #910).
 *
 * Skipped when DATABASE_URL is not configured (same convention used by
 * sibling test suites).  Each test is self-contained: all inserted rows are
 * removed in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - Happy path: n cases updated, updatedCount matches
 *  - 403 when caller is not a lab member
 *  - 400 when providerOrganizationId doesn't exist
 *  - 404 when a caseId doesn't exist in the lab
 *  - 403 when the batch contains a caseId from a different lab
 *  - 400 when caseIds array is empty (Zod schema: min(1))
 *  - Duplicate caseIds are deduplicated; updatedCount reflects unique cases
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  startDailyOneDriveBackup: vi.fn(),
  start15MinRollingBackup: vi.fn(),
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

maybe("POST /api/cases/bulk-reassign (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab2");
  const practiceAId = rid("provA");
  const practiceBId = rid("provB");
  const crossLabPracticeId = rid("provX");
  const labTypeOrgId = rid("labType");
  const adminUserId = rid("uadmin");
  const outsiderUserId = rid("uout");

  const tokens = { admin: "", outsider: "" };

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

  async function insertCase(opts: {
    caseNumber: string;
    practiceId: string;
    labId?: string;
  }) {
    const { db, cases } = dbMod as any;
    const id = rid("c");
    await db.insert(cases).values({
      id,
      caseNumber: opts.caseNumber,
      labOrganizationId: opts.labId ?? labOrgId,
      providerOrganizationId: opts.practiceId,
      doctorName: "Dr. Test",
      patientFirstName: "Pat",
      patientLastName: "Test",
      status: "draft",
      createdByUserId: adminUserId,
    });
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-bulk-reassign";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "x" },
      { id: outsiderUserId, username: `out_${outsiderUserId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Bulk Reassign Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Other Lab" },
      {
        id: practiceAId,
        type: "provider",
        name: "Practice A",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: practiceBId,
        type: "provider",
        name: "Practice B",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: crossLabPracticeId,
        type: "provider",
        name: "Cross-Lab Practice",
        parentLabOrganizationId: otherLabOrgId,
      },
      {
        id: labTypeOrgId,
        type: "lab",
        name: "Another Lab (not a provider)",
        parentLabOrganizationId: labOrgId,
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
      // outsiderUserId intentionally has NO membership in labOrgId
    ]);

    tokens.admin = await makeSession(adminUserId);
    tokens.outsider = await makeSession(outsiderUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      cases,
      organizationMemberships,
      userSessions,
      auditLogs,
    } = dbMod as any;
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, otherLabOrgId]));
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db.delete(cases).where(eq(cases.labOrganizationId, otherLabOrgId));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [adminUserId, outsiderUserId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [adminUserId, outsiderUserId]));
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [
          labOrgId,
          otherLabOrgId,
          practiceAId,
          practiceBId,
          crossLabPracticeId,
          labTypeOrgId,
        ]),
      );
    await db
      .delete(users)
      .where(inArray(users.id, [adminUserId, outsiderUserId]));
  });

  it("happy path: reassigns n cases and returns correct updatedCount", async () => {
    const c1 = await insertCase({ caseNumber: rid("BR1"), practiceId: practiceAId });
    const c2 = await insertCase({ caseNumber: rid("BR2"), practiceId: practiceAId });
    const c3 = await insertCase({ caseNumber: rid("BR3"), practiceId: practiceAId });

    const r = await request(appMod.default)
      .post("/api/cases/bulk-reassign")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ caseIds: [c1, c2, c3], providerOrganizationId: practiceBId });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.updatedCount).toBe(3);

    // Verify the DB rows were actually updated.
    const { db, cases } = dbMod as any;
    const { inArray: inArrayDrizzle } = await import("drizzle-orm");
    const updated = await db
      .select({ id: cases.id, providerOrganizationId: cases.providerOrganizationId })
      .from(cases)
      .where(inArrayDrizzle(cases.id, [c1, c2, c3]));
    for (const row of updated) {
      expect(row.providerOrganizationId).toBe(practiceBId);
    }

    await db.delete(cases).where(inArrayDrizzle(cases.id, [c1, c2, c3]));
  });

  it("deduplicates submitted caseIds; updatedCount reflects unique cases", async () => {
    const c1 = await insertCase({ caseNumber: rid("DUP1"), practiceId: practiceAId });

    const r = await request(appMod.default)
      .post("/api/cases/bulk-reassign")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ caseIds: [c1, c1, c1], providerOrganizationId: practiceBId });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.updatedCount).toBe(1);

    const { db, cases } = dbMod as any;
    const { eq: eqDrizzle } = await import("drizzle-orm");
    await db.delete(cases).where(eqDrizzle(cases.id, c1));
  });

  it("returns 403 when the caller is not a member of the lab", async () => {
    const c1 = await insertCase({ caseNumber: rid("NOACC"), practiceId: practiceAId });

    const r = await request(appMod.default)
      .post("/api/cases/bulk-reassign")
      .set("Authorization", `Bearer ${tokens.outsider}`)
      .send({ caseIds: [c1], providerOrganizationId: practiceBId });

    expect(r.status).toBe(403);

    const { db, cases } = dbMod as any;
    const { eq: eqDrizzle } = await import("drizzle-orm");
    await db.delete(cases).where(eqDrizzle(cases.id, c1));
  });

  it("returns 400 when providerOrganizationId does not exist", async () => {
    const c1 = await insertCase({ caseNumber: rid("BADPROV"), practiceId: practiceAId });

    const r = await request(appMod.default)
      .post("/api/cases/bulk-reassign")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ caseIds: [c1], providerOrganizationId: rid("ghost") });

    expect(r.status).toBe(400);

    const { db, cases } = dbMod as any;
    const { eq: eqDrizzle } = await import("drizzle-orm");
    await db.delete(cases).where(eqDrizzle(cases.id, c1));
  });

  it("returns 400 when the target org is a lab, not a provider", async () => {
    const c1 = await insertCase({ caseNumber: rid("LABTYP"), practiceId: practiceAId });

    const r = await request(appMod.default)
      .post("/api/cases/bulk-reassign")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ caseIds: [c1], providerOrganizationId: labTypeOrgId });

    expect(r.status).toBe(400);

    const { db, cases } = dbMod as any;
    const { eq: eqDrizzle } = await import("drizzle-orm");
    await db.delete(cases).where(eqDrizzle(cases.id, c1));
  });

  it("returns 404 when a caseId does not exist in the lab", async () => {
    const r = await request(appMod.default)
      .post("/api/cases/bulk-reassign")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        caseIds: [rid("ghost_case")],
        providerOrganizationId: practiceBId,
      });

    expect(r.status).toBe(404);
  });

  it("returns 403 when the batch contains a caseId from a different lab", async () => {
    // A case that belongs to the admin's lab (used to resolve the labOrg).
    const myCase = await insertCase({ caseNumber: rid("MINE"), practiceId: practiceAId });

    // A case in the other lab — the admin is not a member there.
    const { db, organizations, cases, organizationMemberships } = dbMod as any;
    const { eq: eqDrizzle } = await import("drizzle-orm");

    // We need a provider in otherLabOrgId for the cross-lab case.
    const otherPracticeId = rid("provO");
    await db.insert(organizations).values({
      id: otherPracticeId,
      type: "provider",
      name: "Other Lab Practice",
      parentLabOrganizationId: otherLabOrgId,
    });

    const foreignCase = rid("cForeign");
    await db.insert(cases).values({
      id: foreignCase,
      caseNumber: rid("FOREIGN"),
      labOrganizationId: otherLabOrgId,
      providerOrganizationId: otherPracticeId,
      doctorName: "Dr. Other",
      patientFirstName: "Other",
      patientLastName: "Patient",
      status: "draft",
      createdByUserId: adminUserId,
    });

    // The endpoint resolves the lab from the first caseId. Submit myCase
    // first so the lab is resolved correctly, then include the foreign case.
    const r = await request(appMod.default)
      .post("/api/cases/bulk-reassign")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        caseIds: [myCase, foreignCase],
        providerOrganizationId: practiceBId,
      });

    expect(r.status).toBe(403);

    await db.delete(cases).where(eqDrizzle(cases.id, myCase));
    await db.delete(cases).where(eqDrizzle(cases.id, foreignCase));
    await db
      .delete(organizations)
      .where(eqDrizzle(organizations.id, otherPracticeId));
  });

  it("returns 400 when caseIds array is empty (Zod min(1))", async () => {
    const r = await request(appMod.default)
      .post("/api/cases/bulk-reassign")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ caseIds: [], providerOrganizationId: practiceBId });

    expect(r.status).toBe(400);
  });

  it("returns 401 when no auth token is provided", async () => {
    const r = await request(appMod.default)
      .post("/api/cases/bulk-reassign")
      .send({ caseIds: [rid("c")], providerOrganizationId: practiceBId });

    expect(r.status).toBe(401);
  });

  it("chunks large batches: 150 cases spanning 2 chunk boundaries are all updated", async () => {
    const { db, cases } = dbMod as any;
    const { inArray: inArrayDrizzle } = await import("drizzle-orm");

    const COUNT = 150;
    const caseRows = Array.from({ length: COUNT }, (_, i) => ({
      id: rid(`CHK${i}`),
      caseNumber: rid(`BLK${i}`),
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceAId,
      doctorName: "Dr. Chunk",
      patientFirstName: "Chunk",
      patientLastName: "Test",
      status: "draft",
      createdByUserId: adminUserId,
    }));

    await db.insert(cases).values(caseRows);
    const caseIds = caseRows.map((c: { id: string }) => c.id);

    const r = await request(appMod.default)
      .post("/api/cases/bulk-reassign")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ caseIds, providerOrganizationId: practiceBId });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.updatedCount).toBe(COUNT);

    const updated = await db
      .select({ id: cases.id, providerOrganizationId: cases.providerOrganizationId })
      .from(cases)
      .where(inArrayDrizzle(cases.id, caseIds));
    expect(updated).toHaveLength(COUNT);
    for (const row of updated) {
      expect(row.providerOrganizationId).toBe(practiceBId);
    }

    await db.delete(cases).where(inArrayDrizzle(cases.id, caseIds));
  });
});
