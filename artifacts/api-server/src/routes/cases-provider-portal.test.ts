/**
 * Provider-portal foundation tests (Account epic Phase 5).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Proves the Phase 5 guarantees:
 *  - Provider signup issues a platform account number in the `P-...` family.
 *  - Provider signup with createOrganization creates a `provider`-type org.
 *  - GET /api/cases/provider is strictly scoped to the caller's own provider
 *    org(s): a provider sees only their assigned cases, never another
 *    provider's, and a lab user gets an empty list.
 *  - Cross-tenant reads are denied on every surface: the dedicated provider
 *    list, the bare /api/cases list, the `?organizationId=` filter (IDOR), and
 *    case detail.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-provider"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Provider portal foundation (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const providerUserAId = rid("u");
  const providerUserBId = rid("u");

  const labOrgId = rid("lab");
  const providerOrgAId = rid("prov");
  const providerOrgBId = rid("prov");

  const createdCaseIds: string[] = [];
  // Users/orgs created by the register endpoint test, cleaned up in afterAll.
  const registeredUserIds: string[] = [];
  const registeredOrgIds: string[] = [];

  let caseAId = "";
  let caseBId = "";

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

  async function createCase(
    access: string,
    providerOrgId: string,
    patient: string
  ): Promise<string> {
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: patient,
        patientLastName: "Test",
        doctorName: "Dr. Provider",
        status: "received",
      });
    expect(r.status).toBe(201);
    const id = r.body.data.id as string;
    createdCaseIds.push(id);
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-provider";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: labOwnerId, username: `labowner_${labOwnerId}`, password: "x", userType: "lab" },
      {
        id: providerUserAId,
        username: `prova_${providerUserAId}`,
        password: "x",
        userType: "provider",
      },
      {
        id: providerUserBId,
        username: `provb_${providerUserBId}`,
        password: "x",
        userType: "provider",
      },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("ProvTestLab") },
      {
        id: providerOrgAId,
        type: "provider",
        name: rid("PracticeA"),
        parentLabOrganizationId: labOrgId,
      },
      {
        id: providerOrgBId,
        type: "provider",
        name: rid("PracticeB"),
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: labOwnerId,
        role: "owner",
        status: "active",
        approvedByUserId: labOwnerId,
        joinedAt: new Date(),
      },
      {
        id: rid("m"),
        labId: providerOrgAId,
        userId: providerUserAId,
        role: "owner",
        status: "active",
        approvedByUserId: providerUserAId,
        joinedAt: new Date(),
      },
      {
        id: rid("m"),
        labId: providerOrgBId,
        userId: providerUserBId,
        role: "owner",
        status: "active",
        approvedByUserId: providerUserBId,
        joinedAt: new Date(),
      },
    ]);

    // Cases are created by the lab owner (member of the lab) and assigned to
    // each provider org.
    const { access } = await makeSession(labOwnerId);
    caseAId = await createCase(access, providerOrgAId, "AlphaPatient");
    caseBId = await createCase(access, providerOrgBId, "BetaPatient");
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      caseEvents,
      caseNotes,
      caseRestorations,
      invoices,
      cases: casesTable,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    const allUserIds = [
      labOwnerId,
      providerUserAId,
      providerUserBId,
      ...registeredUserIds,
    ];
    const allOrgIds = [
      labOrgId,
      providerOrgAId,
      providerOrgBId,
      ...registeredOrgIds,
    ];

    if (createdCaseIds.length) {
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, createdCaseIds));
      await db.delete(caseNotes).where(inArray(caseNotes.caseId, createdCaseIds));
      await db
        .delete(caseRestorations)
        .where(inArray(caseRestorations.caseId, createdCaseIds));
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds));
    }
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, allOrgIds));
    await db.delete(invoices).where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db.delete(casesTable).where(inArray(casesTable.labOrganizationId, [labOrgId]));
    await db.delete(userSessions).where(inArray(userSessions.userId, allUserIds));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, allUserIds));
    await db.delete(organizations).where(inArray(organizations.id, allOrgIds));
    await db.delete(users).where(inArray(users.id, allUserIds));
  });

  // ── Provider signup ───────────────────────────────────────────────────────

  it("provider signup issues a P- account number and a provider org", async () => {
    const uname = `psig${randomBytes(3).toString("hex")}`;
    const r = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username: uname,
        password: "Sup3rSecret!",
        email: `${uname}@example.com`,
        userType: "provider",
        practiceName: rid("SignupPractice"),
        createOrganization: true,
        clientType: "desktop",
      });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const acct: string = r.body.user?.platformAccountNumber ?? "";
    expect(acct.startsWith("P-")).toBe(true);

    if (r.body.user?.id) registeredUserIds.push(r.body.user.id);
    const orgId: string | undefined = r.body.organization?.id;
    expect(orgId).toBeTruthy();
    if (orgId) {
      registeredOrgIds.push(orgId);
      const { db, organizations } = dbMod as any;
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
      });
      expect(org?.type).toBe("provider");
    }
  });

  // ── GET /api/cases/provider scoping ────────────────────────────────────────

  it("provider A sees only their own assigned cases", async () => {
    const { access } = await makeSession(providerUserAId);
    const r = await request(appMod.default)
      .get("/api/cases/provider")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const ids: string[] = (r.body.data ?? []).map((c: any) => c.id);
    expect(ids).toContain(caseAId);
    expect(ids).not.toContain(caseBId);
  });

  it("provider B sees only their own assigned cases", async () => {
    const { access } = await makeSession(providerUserBId);
    const r = await request(appMod.default)
      .get("/api/cases/provider")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const ids: string[] = (r.body.data ?? []).map((c: any) => c.id);
    expect(ids).toContain(caseBId);
    expect(ids).not.toContain(caseAId);
  });

  it("a lab user gets an empty provider list", async () => {
    const { access } = await makeSession(labOwnerId);
    const r = await request(appMod.default)
      .get("/api/cases/provider")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
  });

  it("unauthenticated GET /api/cases/provider returns 401", async () => {
    const r = await request(appMod.default).get("/api/cases/provider");
    expect(r.status).toBe(401);
  });

  // ── Cross-tenant isolation ─────────────────────────────────────────────────

  it("bare /api/cases for provider A excludes provider B's cases", async () => {
    const { access } = await makeSession(providerUserAId);
    const r = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const ids: string[] = (r.body.data ?? []).map((c: any) => c.id);
    expect(ids).toContain(caseAId);
    expect(ids).not.toContain(caseBId);
  });

  it("provider A cannot read another provider org via ?organizationId (IDOR)", async () => {
    const { access } = await makeSession(providerUserAId);
    const r = await request(appMod.default)
      .get(`/api/cases?organizationId=${providerOrgBId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(403);
  });

  it("provider A cannot read the lab org via ?organizationId (IDOR)", async () => {
    const { access } = await makeSession(providerUserAId);
    const r = await request(appMod.default)
      .get(`/api/cases?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(403);
  });

  it("provider A can read their own org via ?organizationId", async () => {
    const { access } = await makeSession(providerUserAId);
    const r = await request(appMod.default)
      .get(`/api/cases?organizationId=${providerOrgAId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const ids: string[] = (r.body.data ?? []).map((c: any) => c.id);
    expect(ids).toContain(caseAId);
  });

  it("provider A can read their own case detail", async () => {
    const { access } = await makeSession(providerUserAId);
    const r = await request(appMod.default)
      .get(`/api/cases/${caseAId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe(caseAId);
  });

  it("provider A cannot read provider B's case detail", async () => {
    const { access } = await makeSession(providerUserAId);
    const r = await request(appMod.default)
      .get(`/api/cases/${caseBId}`)
      .set("Authorization", `Bearer ${access}`);
    expect([403, 404]).toContain(r.status);
  });
});
