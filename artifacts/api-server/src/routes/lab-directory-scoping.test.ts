/**
 * Task #4849 — a lab's lists must contain only the lab's own records.
 *
 * The production database is shared by more than one tenant, and the
 * 2026-10-06 merge added thousands of imported automated-test accounts to it.
 * Two endpoints read provider/user tables without a lab scope and so showed
 * the lab every one of those rows:
 *
 *   GET /api/auth/users                              (user management, Customer Center directory)
 *   GET /api/organizations/:id/eligible-doctors      (practice editor "add existing doctor" picker)
 *
 * These tests model the exact shape of the contamination — a second lab's
 * accounts, and accounts with no lab affiliation at all (the `revprov_*`
 * fixtures are of that kind) — and assert neither reaches the first lab.
 *
 * Skipped when DATABASE_URL is not configured. Every inserted row is removed
 * in afterAll, scoped to ids this file created, so the suite is safe against
 * the shared dev database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-dirscope"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Lab-scoped directories (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  // Lab A is the lab under test; Lab B stands in for every other tenant
  // sharing the database.
  const adminAId = rid("dsAdminA");
  const adminBId = rid("dsAdminB");
  const providerAId = rid("dsProvA");
  const providerBId = rid("dsProvB");
  // No membership anywhere — the shape of the imported `revprov_*` fixtures,
  // and of the accounts the old duplicate-minting paths produced.
  const unaffiliatedProviderId = rid("dsProvOrphan");

  const createdUserIds = [
    adminAId,
    adminBId,
    providerAId,
    providerBId,
    unaffiliatedProviderId,
  ];
  const createdOrgIds: string[] = [];
  const createdCaseIds: string[] = [];

  let labAId = "";
  let labBId = "";
  let practiceA1Id = "";
  let practiceA2Id = "";
  let practiceB1Id = "";

  const unaffiliatedDoctorName = `Dr. Orphan ${randomBytes(4).toString("hex")}`;
  // A case-history name no account anywhere matches — the positive control
  // that proves the virtual-doctor pipeline is live in this fixture.
  const unmatchedDoctorName = `Dr. Unmatched ${randomBytes(4).toString("hex")}`;

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return authLib.signAccessToken(userId, sessionId);
  }

  function labBody(name: string) {
    return {
      type: "lab" as const,
      name,
      licenseNumber: `LIC-${randomBytes(3).toString("hex")}`,
      phone: "555-111-2222",
      billingEmail: "lab@example.com",
      addressLine1: "123 Test St",
    };
  }

  async function makeLab(access: string): Promise<string> {
    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(rid("ScopeLab")));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    createdOrgIds.push(r.body.data.id);
    return r.body.data.id;
  }

  async function makePractice(
    access: string,
    labId: string,
    name: string
  ): Promise<string> {
    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send({
        type: "provider",
        name,
        parentLabOrganizationId: labId,
        city: "Austin",
        state: "TX",
        zip: "78701",
        addressLine1: "456 Practice Ave",
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    createdOrgIds.push(r.body.data.id);
    return r.body.data.id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-dirscope";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizationMemberships, cases } = dbMod as any;

    await db.insert(users).values([
      {
        id: adminAId,
        username: `dsadmina_${adminAId}`,
        password: "doesnotmatter",
        userType: "lab",
        role: "admin",
        firstName: "Ada",
        lastName: "AdminA",
      },
      {
        id: adminBId,
        username: `dsadminb_${adminBId}`,
        password: "doesnotmatter",
        userType: "lab",
        role: "admin",
        firstName: "Ben",
        lastName: "AdminB",
      },
      {
        id: providerAId,
        username: `dsprova_${providerAId}`,
        password: "doesnotmatter",
        userType: "provider",
        firstName: "Pia",
        lastName: "ProviderA",
      },
      {
        id: providerBId,
        username: `dsprovb_${providerBId}`,
        password: "doesnotmatter",
        userType: "provider",
        firstName: "Paul",
        lastName: "ProviderB",
      },
      {
        id: unaffiliatedProviderId,
        username: `dsorphan_${unaffiliatedProviderId}`,
        password: "doesnotmatter",
        userType: "provider",
        doctorName: unaffiliatedDoctorName,
      },
    ]);

    const accessA = await makeSession(adminAId);
    const accessB = await makeSession(adminBId);

    labAId = await makeLab(accessA);
    labBId = await makeLab(accessB);
    practiceA1Id = await makePractice(accessA, labAId, rid("ScopePracticeA1"));
    practiceA2Id = await makePractice(accessA, labAId, rid("ScopePracticeA2"));
    practiceB1Id = await makePractice(accessB, labBId, rid("ScopePracticeB1"));

    await db.insert(organizationMemberships).values([
      { labId: practiceA1Id, userId: providerAId, role: "member", status: "active" },
      { labId: practiceB1Id, userId: providerBId, role: "member", status: "active" },
    ]);

    // One of Lab A's own cases carries the unaffiliated account's doctor name.
    // Task #4372 requires the picker not to offer that name as a new "virtual"
    // doctor, because adopting it would resolve onto that existing account.
    const coveredCaseId = rid("dsCase");
    const unmatchedCaseId = rid("dsCaseCtl");
    createdCaseIds.push(coveredCaseId, unmatchedCaseId);
    await db.insert(cases).values([
      {
        id: coveredCaseId,
        caseNumber: rid("DSC"),
        labOrganizationId: labAId,
        providerOrganizationId: practiceA1Id,
        patientFirstName: "Scope",
        patientLastName: "Patient",
        doctorName: unaffiliatedDoctorName,
        createdByUserId: adminAId,
      },
      {
        id: unmatchedCaseId,
        caseNumber: rid("DSCC"),
        labOrganizationId: labAId,
        providerOrganizationId: practiceA1Id,
        patientFirstName: "Control",
        patientLastName: "Patient",
        doctorName: unmatchedDoctorName,
        createdByUserId: adminAId,
      },
    ]);
  });

  // A backup-restore TRUNCATE in a sibling suite can drop user_sessions
  // between beforeAll and the test body, so re-mint before every test.
  beforeEach(async () => {
    await makeSession(adminAId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      cases,
      invoices,
      organizationMemberships,
      organizations,
      userSessions,
      users,
    } = dbMod as any;

    if (createdCaseIds.length) {
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds));
      await db.delete(cases).where(inArray(cases.id, createdCaseIds));
    }
    if (createdOrgIds.length) {
      await db
        .delete(auditLogs)
        .where(inArray(auditLogs.organizationId, createdOrgIds));
      await db
        .delete(organizationMemberships)
        .where(inArray(organizationMemberships.labId, createdOrgIds));
      await db
        .delete(organizations)
        .where(inArray(organizations.id, createdOrgIds));
    }
    await db.delete(auditLogs).where(inArray(auditLogs.userId, createdUserIds));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, createdUserIds));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  // ── GET /api/auth/users ───────────────────────────────────────────────────

  async function listUsernames(userId: string): Promise<string[]> {
    const access = await makeSession(userId);
    const r = await request(appMod.default)
      .get("/api/auth/users")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body.users ?? []).map((u: any) => u.id as string);
  }

  it("lists only the administered lab's own people, never another tenant's", async () => {
    const visible = await listUsernames(adminAId);

    expect(visible).toContain(adminAId);
    expect(visible).toContain(providerAId);

    expect(visible).not.toContain(adminBId);
    expect(visible).not.toContain(providerBId);
  });

  it("excludes accounts with no lab affiliation at all", async () => {
    const visible = await listUsernames(adminAId);
    expect(visible).not.toContain(unaffiliatedProviderId);
  });

  it("gives each lab admin their own lab's people and not the other's", async () => {
    const visibleToB = await listUsernames(adminBId);

    expect(visibleToB).toContain(adminBId);
    expect(visibleToB).toContain(providerBId);
    expect(visibleToB).not.toContain(adminAId);
    expect(visibleToB).not.toContain(providerAId);
  });

  // ── GET /api/organizations/:id/eligible-doctors ───────────────────────────

  async function eligibleDoctors(userId: string, practiceId: string) {
    const access = await makeSession(userId);
    const r = await request(appMod.default)
      .get(`/api/organizations/${practiceId}/eligible-doctors`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body.data ?? []) as any[];
  }

  it("offers sibling-practice doctors but no doctor from another lab", async () => {
    const rows = await eligibleDoctors(adminAId, practiceA2Id);
    const ids = rows.map((d) => d.id);

    expect(ids, "a doctor at a sibling practice is still offered").toContain(
      providerAId
    );
    expect(ids, "another lab's doctor must never be offered").not.toContain(
      providerBId
    );
  });

  it("does not offer provider accounts with no lab affiliation", async () => {
    const rows = await eligibleDoctors(adminAId, practiceA2Id);
    expect(rows.map((d) => d.id)).not.toContain(unaffiliatedProviderId);
  });

  it("still suppresses a case-history name an unaffiliated account would be reused for", async () => {
    // Task #4372: the adopt call resolves against the wider matching scope,
    // which includes unaffiliated accounts. Narrowing the listed candidates
    // must not start offering a name that adopting would simply reuse.
    const rows = await eligibleDoctors(adminAId, practiceA2Id);

    // Positive control: without this the assertion below would also pass if
    // the virtual pipeline returned nothing at all.
    expect(
      rows.some((d) => d.virtual && d.doctorName === unmatchedDoctorName),
      "an uncovered case-history name must still be offered as virtual"
    ).toBe(true);

    expect(
      rows.some((d) => d.virtual && d.doctorName === unaffiliatedDoctorName),
      "name covered by an existing matchable account should not be offered as new"
    ).toBe(false);
  });
});
