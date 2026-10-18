/**
 * Integration tests for organization CRUD routes (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/organizations — creates a lab org and an owner membership (201)
 *  - GET /api/organizations/:id — returns the org
 *  - PATCH /api/organizations/:id — updates displayName (200)
 *  - GET /api/organizations/:id/members — lists members including owner
 *  - Unauthenticated requests return 401
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, inArray, eq, isNull, sql } from "drizzle-orm";
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-orgs"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/**
 * Phase 3 lab creation requires license number, phone, billing email, and a
 * street address in addition to a unique name. Helper builds a complete,
 * valid lab payload so CRUD/role tests are not rejected by field validation.
 */
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

maybe("Organizations CRUD (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const ownerId = rid("u");
  // A provider-type user — must NOT be allowed to create a lab environment.
  const providerUserId = rid("pu");
  // IDs for orgs created via the API (collected at runtime).
  const createdOrgIds: string[] = [];

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
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-orgs";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users } = dbMod as any;
    await db.insert(users).values({
      id: ownerId,
      username: `orgowner_${ownerId}`,
      password: "doesnotmatter",
    });
    await db.insert(users).values({
      id: providerUserId,
      username: `provider_${providerUserId}`,
      password: "doesnotmatter",
      userType: "provider",
    });
  });

  // Ensure a fresh session exists before each test; per-test sessions created
  // in each it() body are still the authoritative token for that test.
  beforeEach(async () => {
    await makeSession(ownerId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      practiceStatements,
      invoices,
      cases: casesTable,
      organizationInvites,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;
    const allOrgIds = createdOrgIds;
    if (allOrgIds.length) {
      await db.delete(auditLogs).where(inArray(auditLogs.organizationId, allOrgIds));
      await db
        .delete(practiceStatements)
        .where(inArray(practiceStatements.labOrganizationId, allOrgIds));
      await db.delete(invoices).where(inArray(invoices.labOrganizationId, allOrgIds));
      await db.delete(casesTable).where(inArray(casesTable.labOrganizationId, allOrgIds));
      await db.delete(organizationMemberships).where(
        inArray(organizationMemberships.labId, allOrgIds)
      );
      // Provider orgs first (have parentLabOrganizationId), then labs.
      const providerIds = allOrgIds;
      await db.delete(organizations).where(inArray(organizations.id, providerIds));
    }
    const allUserIds = [ownerId, providerUserId];
    await db.delete(auditLogs).where(inArray(auditLogs.userId, allUserIds));
    await db.delete(organizationInvites).where(
      inArray(organizationInvites.invitedByUserId, allUserIds)
    );
    await db.delete(userSessions).where(inArray(userSessions.userId, allUserIds));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, allUserIds)
    );
    await db.delete(users).where(inArray(users.id, allUserIds));
  });

  // ── POST /api/organizations ───────────────────────────────────────────────

  it("creates a lab org and returns 201 with org data", async () => {
    const { access } = await makeSession(ownerId);
    const name = rid("TestLab");

    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(name));

    expect(r.status).toBe(201);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.name).toBe(name);
    expect(r.body.data.type).toBe("lab");
    expect(r.body.data.id).toBeTruthy();

    createdOrgIds.push(r.body.data.id);
  });

  it("unauthenticated POST /api/organizations returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/organizations")
      .send({ type: "lab", name: "NoAuth Lab" });
    expect(r.status).toBe(401);
  });

  // ── Phase 3: lab creation validation ──────────────────────────────────────

  it("persists licenseNumber and records an organization_created audit entry", async () => {
    const { access } = await makeSession(ownerId);
    const name = rid("LicLab");
    const license = `LIC-${randomBytes(4).toString("hex")}`;

    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send({ ...labBody(name), licenseNumber: license });

    expect(r.status).toBe(201);
    expect(r.body.data.licenseNumber).toBe(license);
    const orgId = r.body.data.id;
    createdOrgIds.push(orgId);

    // License persisted in the DB.
    const { db, organizations, auditLogs } = dbMod as any;
    const [row] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(row?.licenseNumber).toBe(license);

    // Audit entry written for the creation.
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.organizationId, orgId));
    expect(
      logs.some((l: any) => l.action === "organization_created")
    ).toBe(true);
  });

  it("rejects lab creation missing required fields with 400 LAB_FIELDS_REQUIRED", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "lab", name: rid("MissingFields") });
    expect(r.status).toBe(400);
    expect(r.body.details?.code).toBe("LAB_FIELDS_REQUIRED");
  });

  it("rejects a duplicate lab name (case-insensitive) with 409 LAB_NAME_TAKEN", async () => {
    const { access } = await makeSession(ownerId);
    const name = rid("DupLab");

    const first = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(name));
    expect(first.status).toBe(201);
    createdOrgIds.push(first.body.data.id);

    const second = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(name.toUpperCase()));
    expect(second.status).toBe(409);
    expect(second.body.details?.code).toBe("LAB_NAME_TAKEN");
  });

  it("rejects lab creation by a non-lab (provider) account with 403 LAB_USER_REQUIRED", async () => {
    const { access } = await makeSession(providerUserId);
    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(rid("ProviderLab")));
    expect(r.status).toBe(403);
    expect(r.body.details?.code).toBe("LAB_USER_REQUIRED");
  });

  it("creator becomes an active owner of the new lab", async () => {
    const { access } = await makeSession(ownerId);
    const name = rid("OwnerLab");

    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(name));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const { db, organizationMemberships } = dbMod as any;
    const memberships = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.labId, orgId));
    const owner = memberships.find((m: any) => m.userId === ownerId);
    expect(owner?.role).toBe("owner");
    expect(owner?.status).toBe("active");
  });

  // ── POST /api/organizations (provider practice) ───────────────────────────
  // Regression guard for Task #2411: adding a provider practice must succeed
  // with a valid payload, reject a duplicate name with 409 (surfacing the
  // conflicting org so the client can offer it instead), and reject a missing
  // name with 400 so the client never silently no-ops.

  async function makeOwnerLab(): Promise<{ access: string; labId: string }> {
    const { access } = await makeSession(ownerId);
    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(rid("ParentLab")));
    expect(create.status).toBe(201);
    const labId = create.body.data.id;
    createdOrgIds.push(labId);
    return { access, labId };
  }

  function practiceBody(name: string, parentLabOrganizationId: string) {
    return {
      type: "provider" as const,
      name,
      parentLabOrganizationId,
      city: "Austin",
      state: "TX",
      zip: "78701",
      addressLine1: "456 Practice Ave",
    };
  }

  it("creates a provider practice under the caller's lab and returns 201", async () => {
    const { access, labId } = await makeOwnerLab();
    const name = rid("TestPractice");

    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(practiceBody(name, labId));

    expect(r.status).toBe(201);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.type).toBe("provider");
    expect(r.body.data.name).toBe(name);
    expect(r.body.data.parentLabOrganizationId).toBe(labId);
    createdOrgIds.push(r.body.data.id);
  });

  it("rejects provider-preference printing when creating a provider practice", async () => {
    const { access, labId } = await makeOwnerLab();
    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send({
        ...practiceBody(rid("PrintPrefsProvider"), labId),
        printProviderPreferencesOnLabSlips: true,
      });

    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/lab organizations/i);
  });

  it("rejects a duplicate practice name in the same lab with 409 and surfaces the conflicting org", async () => {
    const { access, labId } = await makeOwnerLab();
    const name = rid("DupPractice");

    const first = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(practiceBody(name, labId));
    expect(first.status).toBe(201);
    createdOrgIds.push(first.body.data.id);

    const second = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(practiceBody(name, labId));

    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/already exists/i);
    expect(second.body.details?.conflictingOrg?.id).toBe(first.body.data.id);
    expect(second.body.details?.conflictingOrg?.name).toBe(name);
  });

  it("rejects a provider practice with a missing name with 400", async () => {
    const { access, labId } = await makeOwnerLab();

    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send({
        type: "provider",
        parentLabOrganizationId: labId,
        city: "Austin",
        state: "TX",
        zip: "78701",
      });

    expect(r.status).toBe(400);
  });

  it("manages one provider login across multiple practice accounts safely", async () => {
    const { access, labId } = await makeOwnerLab();
    const first = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send({
        ...practiceBody(rid("AssignmentPracticeA"), labId),
        accountNumber: rid("ACC_A"),
      });
    const secondAccount = rid("ACC_B");
    const second = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send({
        ...practiceBody(rid("AssignmentPracticeB"), labId),
        accountNumber: secondAccount,
      });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    createdOrgIds.push(first.body.data.id, second.body.data.id);

    const {
      db,
      cases: casesTable,
      organizationMemberships,
      organizations,
      practiceStatements,
    } = dbMod as any;
    await db.insert(organizationMemberships).values({
      labId: first.body.data.id,
      userId: providerUserId,
      role: "user",
      status: "active",
      approvedByUserId: ownerId,
      joinedAt: new Date(),
    });

    const assignBoth = await request(appMod.default)
      .put(`/api/organizations/${labId}/doctors/assignments`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        providerOrgId: first.body.data.id,
        userId: providerUserId,
        practiceOrganizationIds: [first.body.data.id, second.body.data.id],
      });
    expect(assignBoth.status).toBe(200);
    expect(
      assignBoth.body.data.assignments
        .filter((a: any) => a.assigned)
        .map((a: any) => a.accountNumber),
    ).toEqual(expect.arrayContaining([
      first.body.data.accountNumber,
      second.body.data.accountNumber,
    ]));

    const removeOwnPractice = await request(appMod.default)
      .put(`/api/organizations/${labId}/doctors/assignments`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        providerOrgId: first.body.data.id,
        userId: providerUserId,
        practiceOrganizationIds: [second.body.data.id],
      });
    expect(removeOwnPractice.status).toBe(400);
    expect(removeOwnPractice.body.details?.code).toBe(
      "SOURCE_PRACTICE_REQUIRED",
    );

    const secondMembershipBefore = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.labId, second.body.data.id),
        eq(organizationMemberships.userId, providerUserId),
        isNull(organizationMemberships.deletedAt),
      ),
    });
    expect(secondMembershipBefore?.status).toBe("active");

    const removeSecond = await request(appMod.default)
      .put(`/api/organizations/${labId}/doctors/assignments`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        providerOrgId: first.body.data.id,
        userId: providerUserId,
        practiceOrganizationIds: [first.body.data.id],
      });
    expect(removeSecond.status).toBe(200);
    expect(
      removeSecond.body.data.assignments.find(
        (a: any) => a.practiceOrganizationId === second.body.data.id,
      )?.assigned,
    ).toBe(false);

    const restoreSecond = await request(appMod.default)
      .put(`/api/organizations/${labId}/doctors/assignments`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        providerOrgId: first.body.data.id,
        userId: providerUserId,
        practiceOrganizationIds: [first.body.data.id, second.body.data.id],
      });
    expect(restoreSecond.status).toBe(200);
    const secondMembershipAfter = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.labId, second.body.data.id),
        eq(organizationMemberships.userId, providerUserId),
        isNull(organizationMemberships.deletedAt),
      ),
    });
    expect(secondMembershipAfter?.id).toBe(secondMembershipBefore?.id);
    expect(secondMembershipAfter?.status).toBe("active");

    const { access: providerAccess } = await makeSession(providerUserId);
    const unauthorizedGet = await request(appMod.default)
      .get(
        `/api/organizations/${labId}/doctors/assignments?providerOrgId=${first.body.data.id}&userId=${providerUserId}`,
      )
      .set("Authorization", `Bearer ${providerAccess}`);
    expect(unauthorizedGet.status).toBe(403);
    const unauthorizedPut = await request(appMod.default)
      .put(`/api/organizations/${labId}/doctors/assignments`)
      .set("Authorization", `Bearer ${providerAccess}`)
      .send({
        providerOrgId: first.body.data.id,
        userId: providerUserId,
        practiceOrganizationIds: [first.body.data.id],
      });
    expect(unauthorizedPut.status).toBe(403);

    const caseIds = [rid("case_a"), rid("case_b")];
    await db.insert(casesTable).values([
      {
        id: caseIds[0],
        caseNumber: rid("CASE_A"),
        labOrganizationId: labId,
        providerOrganizationId: first.body.data.id,
        patientFirstName: "A",
        patientLastName: "Patient",
        doctorName: "Assignment Doctor",
        createdByUserId: ownerId,
      },
      {
        id: caseIds[1],
        caseNumber: rid("CASE_B"),
        labOrganizationId: labId,
        providerOrganizationId: second.body.data.id,
        patientFirstName: "B",
        patientLastName: "Patient",
        doctorName: "Assignment Doctor",
        createdByUserId: ownerId,
      },
    ]);
    await db.insert(practiceStatements).values([
      {
        labOrganizationId: labId,
        providerOrganizationId: first.body.data.id,
        periodStart: new Date("2026-01-01T00:00:00Z"),
        periodEnd: new Date("2026-01-31T00:00:00Z"),
        createdByUserId: ownerId,
      },
      {
        labOrganizationId: labId,
        providerOrganizationId: second.body.data.id,
        periodStart: new Date("2026-02-01T00:00:00Z"),
        periodEnd: new Date("2026-02-28T00:00:00Z"),
        createdByUserId: ownerId,
      },
    ]);
    const unselectedProviderCases = await request(appMod.default)
      .get("/api/cases/provider")
      .set("Authorization", `Bearer ${providerAccess}`);
    expect(unselectedProviderCases.status).toBe(409);
    expect(unselectedProviderCases.body.details?.code).toBe(
      "PROVIDER_ORGANIZATION_REQUIRED",
    );

    const firstProviderCases = await request(appMod.default)
      .get("/api/cases/provider")
      .set("Authorization", `Bearer ${providerAccess}`)
      .set("x-provider-organization-id", first.body.data.id);
    expect(firstProviderCases.status).toBe(200);
    expect(
      firstProviderCases.body.data
        .filter((row: any) => caseIds.includes(row.id))
        .map((row: any) => row.providerOrganizationId),
    ).toEqual([first.body.data.id]);

    const secondProviderCases = await request(appMod.default)
      .get("/api/cases/provider")
      .set("Authorization", `Bearer ${providerAccess}`)
      .set("x-provider-organization-id", second.body.data.id);
    expect(secondProviderCases.status).toBe(200);
    expect(
      secondProviderCases.body.data
        .filter((row: any) => caseIds.includes(row.id))
        .map((row: any) => row.providerOrganizationId),
    ).toEqual([second.body.data.id]);

    const firstProviderStatements = await request(appMod.default)
      .get("/api/provider/statements")
      .set("Authorization", `Bearer ${providerAccess}`)
      .set("x-provider-organization-id", first.body.data.id);
    expect(firstProviderStatements.status).toBe(200);
    expect(
      firstProviderStatements.body.data
        .filter((row: any) =>
          [first.body.data.id, second.body.data.id].includes(
            row.providerOrganizationId,
          ),
        )
        .map((row: any) => row.providerOrganizationId),
    ).toEqual([first.body.data.id]);

    const secondProviderStatements = await request(appMod.default)
      .get("/api/provider/statements")
      .set("Authorization", `Bearer ${providerAccess}`)
      .set("x-provider-organization-id", second.body.data.id);
    expect(secondProviderStatements.status).toBe(200);
    expect(
      secondProviderStatements.body.data
        .filter((row: any) =>
          [first.body.data.id, second.body.data.id].includes(
            row.providerOrganizationId,
          ),
        )
        .map((row: any) => row.providerOrganizationId),
    ).toEqual([second.body.data.id]);

    const unknown = await request(appMod.default)
      .put(`/api/organizations/${labId}/doctors/assignments`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        providerOrgId: first.body.data.id,
        userId: providerUserId,
        practiceOrganizationIds: [first.body.data.id, rid("missing")],
      });
    expect(unknown.status).toBe(400);
    expect(unknown.body.details?.code).toBe("UNKNOWN_PRACTICE");

    const otherLab = await makeOwnerLab();
    const foreign = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${otherLab.access}`)
      .send(practiceBody(rid("ForeignPractice"), otherLab.labId));
    expect(foreign.status).toBe(201);
    createdOrgIds.push(foreign.body.data.id);
    const crossLab = await request(appMod.default)
      .put(`/api/organizations/${labId}/doctors/assignments`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        providerOrgId: first.body.data.id,
        userId: providerUserId,
        practiceOrganizationIds: [first.body.data.id, foreign.body.data.id],
      });
    expect(crossLab.status).toBe(400);
    expect(crossLab.body.details?.code).toBe("PRACTICE_OUTSIDE_LAB");

    const archived = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(practiceBody(rid("ArchivedPractice"), labId));
    expect(archived.status).toBe(201);
    createdOrgIds.push(archived.body.data.id);
    await db
      .update(organizations)
      .set({ deletedAt: new Date(), deletedByUserId: ownerId })
      .where(eq(organizations.id, archived.body.data.id));
    const archivedSelection = await request(appMod.default)
      .put(`/api/organizations/${labId}/doctors/assignments`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        providerOrgId: first.body.data.id,
        userId: providerUserId,
        practiceOrganizationIds: [first.body.data.id, archived.body.data.id],
      });
    expect(archivedSelection.status).toBe(400);
    expect(archivedSelection.body.details?.code).toBe("ARCHIVED_PRACTICE");

    // Practice creation already rejects overlapping account-number segments.
    // Insert a legacy/corrupt row directly so the assignment endpoint's
    // defensive validation is covered without weakening creation safeguards.
    const duplicateSegmentId = rid("duplicate_segment_practice");
    await db.insert(organizations).values({
      id: duplicateSegmentId,
      type: "provider",
      name: rid("DuplicateSegmentPractice"),
      parentLabOrganizationId: labId,
      accountNumber: `${secondAccount}; ${rid("ALT")}`,
      createdByUserId: ownerId,
    });
    createdOrgIds.push(duplicateSegmentId);
    const duplicateSelection = await request(appMod.default)
      .put(`/api/organizations/${labId}/doctors/assignments`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        providerOrgId: first.body.data.id,
        userId: providerUserId,
        practiceOrganizationIds: [
          first.body.data.id,
          second.body.data.id,
          duplicateSegmentId,
        ],
      });
    expect(duplicateSelection.status).toBe(409);
    expect(duplicateSelection.body.details?.code).toBe(
      "DUPLICATE_ACCOUNT_NUMBER",
    );
  });

  // ── GET /api/organizations/:id ────────────────────────────────────────────

  it("GET /api/organizations/:id returns the org", async () => {
    const { access } = await makeSession(ownerId);
    const name = rid("GetLab");

    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(name));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const get = await request(appMod.default)
      .get(`/api/organizations/${orgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(get.status).toBe(200);
    expect(get.body.data.id).toBe(orgId);
    expect(get.body.data.name).toBe(name);
  });

  it("GET /api/organizations/:id for unknown org returns 404", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get("/api/organizations/nonexistent-org-id-xyz")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(404);
  });

  // ── PATCH /api/organizations/:id ──────────────────────────────────────────

  it("PATCH rejects provider-preference printing on a provider practice", async () => {
    const { access, labId } = await makeOwnerLab();
    const practice = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(practiceBody(rid("PatchPrintPrefsProvider"), labId));
    expect(practice.status).toBe(201);
    createdOrgIds.push(practice.body.data.id);

    const patch = await request(appMod.default)
      .patch(`/api/organizations/${practice.body.data.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ printProviderPreferencesOnLabSlips: true });

    expect(patch.status).toBe(400);
    expect(patch.body.message).toMatch(/lab organizations/i);
  });

  it("PATCH /api/organizations/:id updates displayName", async () => {
    const { access } = await makeSession(ownerId);
    const name = rid("PatchLab");

    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(name));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const patch = await request(appMod.default)
      .patch(`/api/organizations/${orgId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ displayName: "Updated Display Name" });
    expect(patch.status).toBe(200);
    expect(patch.body.data.displayName).toBe("Updated Display Name");
  });

  it("PATCH /api/organizations/:id clears billingEmail when sent as empty string", async () => {
    const { access } = await makeSession(ownerId);
    const name = rid("PatchBlankEmail");

    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(name));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    // The desktop edit form posts the whole record back, including an empty
    // billingEmail when the practice has no billing email. This must not fail
    // with "Invalid request." — it should clear the field instead.
    const patch = await request(appMod.default)
      .patch(`/api/organizations/${orgId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ displayName: "Heartland Dental Family Dentistry", billingEmail: "" });
    expect(patch.status).toBe(200);
    expect(patch.body.data.displayName).toBe("Heartland Dental Family Dentistry");
    expect(patch.body.data.billingEmail).toBeNull();
  });

  it("PATCH /api/organizations/:id rejects a malformed billingEmail", async () => {
    const { access } = await makeSession(ownerId);
    const name = rid("PatchBadEmail");

    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(name));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const patch = await request(appMod.default)
      .patch(`/api/organizations/${orgId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ billingEmail: "not-an-email" });
    expect(patch.status).toBe(400);
  });

  // ── GET /api/organizations/:id/members ────────────────────────────────────

  it("GET /api/organizations/:id/members returns member list including owner", async () => {
    const { access } = await makeSession(ownerId);
    const name = rid("MembersLab");

    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(name));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const members = await request(appMod.default)
      .get(`/api/organizations/${orgId}/members`)
      .set("Authorization", `Bearer ${access}`);
    expect(members.status).toBe(200);
    const list: any[] = members.body.data ?? [];
    const ownerEntry = list.find((m: any) => m.userId === ownerId);
    expect(ownerEntry).toBeDefined();
    expect(ownerEntry?.role).toBe("owner");
  });

  it("GET /api/organizations/:id/members for non-member returns 403", async () => {
    const { access } = await makeSession(ownerId);
    const name = rid("MembersLab2");

    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(name));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    // Create a second user who is NOT a member.
    const strangerId = rid("stranger");
    const { db, users } = dbMod as any;
    await db.insert(users).values({
      id: strangerId,
      username: `stranger_${strangerId}`,
      password: "doesnotmatter",
    });
    const { access: strangerAccess } = await makeSession(strangerId);

    const r = await request(appMod.default)
      .get(`/api/organizations/${orgId}/members`)
      .set("Authorization", `Bearer ${strangerAccess}`);
    expect(r.status).toBe(403);

    // Clean up stranger sessions then user.
    await db.delete(dbMod.userSessions).where(eq(dbMod.userSessions.userId, strangerId));
    await db.delete(dbMod.users).where(eq(dbMod.users.id, strangerId));
  });

  // ── Invite lifecycle ──────────────────────────────────────────────────────

  it("POST /:id/invites creates a pending invite; GET lists it; cancel marks it revoked", async () => {
    const { access } = await makeSession(ownerId);
    const orgName = rid("InviteOrg");

    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(orgName));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const inviteEmail = `${rid("inv")}@test.local`;

    const inviteRes = await request(appMod.default)
      .post(`/api/organizations/${orgId}/invites`)
      .set("Authorization", `Bearer ${access}`)
      .send({ email: inviteEmail, roleToAssign: "user", expiresInDays: 1 });
    expect(inviteRes.status).toBe(201);
    const inviteId: string = inviteRes.body.data?.id ?? inviteRes.body.id;

    // Invite should appear in list
    const listRes = await request(appMod.default)
      .get(`/api/organizations/${orgId}/invites`)
      .set("Authorization", `Bearer ${access}`);
    expect(listRes.status).toBe(200);
    const inviteIds: string[] = (listRes.body.data ?? []).map((i: any) => i.id);
    expect(inviteIds).toContain(inviteId);

    // Cancel the invite
    const cancelRes = await request(appMod.default)
      .post(`/api/organizations/invites/${inviteId}/cancel`)
      .set("Authorization", `Bearer ${access}`);
    expect(cancelRes.status).toBe(200);
    const cancelledStatus: string =
      cancelRes.body.data?.status ?? cancelRes.body.status;
    expect(cancelledStatus).toBe("revoked");
  });

  it("POST /invites/:token/accept creates a membership for the email-matched user", async () => {
    const { access: adminAccess } = await makeSession(ownerId);
    const { db, users, userSessions, organizationMemberships } = dbMod as any;

    const orgName = rid("AcceptOrg");
    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${adminAccess}`)
      .send(labBody(orgName));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const inviteeId = rid("invitee");
    const inviteeEmail = `${inviteeId}@test.local`;
    await db.insert(users).values({
      id: inviteeId,
      username: `invitee_${inviteeId}`,
      password: "x",
      email: inviteeEmail,
    });
    const { access: inviteeAccess } = await makeSession(inviteeId);

    try {
      // Admin creates invite for invitee's exact email address
      const inviteRes = await request(appMod.default)
        .post(`/api/organizations/${orgId}/invites`)
        .set("Authorization", `Bearer ${adminAccess}`)
        .send({ email: inviteeEmail, roleToAssign: "user", expiresInDays: 1 });
      expect(inviteRes.status).toBe(201);
      const token: string = inviteRes.body.data?.token ?? inviteRes.body.token;

      // Invitee accepts via the token
      const acceptRes = await request(appMod.default)
        .post(`/api/organizations/invites/${token}/accept`)
        .set("Authorization", `Bearer ${inviteeAccess}`);
      expect(acceptRes.status).toBe(200);

      // Verify invitee now appears in the member list
      const membersRes = await request(appMod.default)
        .get(`/api/organizations/${orgId}/members`)
        .set("Authorization", `Bearer ${adminAccess}`);
      expect(membersRes.status).toBe(200);
      const memberUserIds: string[] = (membersRes.body.data ?? []).map(
        (m: any) => m.userId
      );
      expect(memberUserIds).toContain(inviteeId);
    } finally {
      await db.delete(userSessions).where(eq(userSessions.userId, inviteeId));
      await db.delete(organizationMemberships).where(
        eq(organizationMemberships.userId, inviteeId)
      );
      await db.delete(users).where(eq(users.id, inviteeId));
    }
  });

  // ── Join-request approval (partial-unique-index upsert) ──────────────────
  // Regression guard: the membership upsert must use an ON CONFLICT arbiter
  // that matches the PARTIAL unique index `memberships_org_user_unique`
  // (lab_id, user_id) WHERE deleted_at IS NULL. A mismatched target made
  // Postgres reject the upsert, surfacing as the generic approve error.

  async function activeMembershipRows(orgId: string, userId: string) {
    const { db, organizationMemberships } = dbMod as any;
    return db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.labId, orgId),
          eq(organizationMemberships.userId, userId),
          isNull(organizationMemberships.deletedAt)
        )
      );
  }

  it("approving a pending join request creates an active membership and removes the pending row", async () => {
    const { access } = await makeSession(ownerId);
    const { db, users, userSessions, organizationMemberships, organizationJoinRequests } =
      dbMod as any;

    const orgName = rid("JoinApproveOrg");
    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(orgName));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const joinerId = rid("joiner");
    await db.insert(users).values({
      id: joinerId,
      username: `joiner_${joinerId}`,
      password: "x",
    });
    const reqId = rid("jr");
    await db.insert(organizationJoinRequests).values({
      id: reqId,
      labId: orgId,
      userId: joinerId,
      requestedRole: "user",
      status: "pending",
    });

    try {
      const approve = await request(appMod.default)
        .post(`/api/organizations/join-requests/${reqId}/approve`)
        .set("Authorization", `Bearer ${access}`);
      expect(approve.status).toBe(200);

      const active = await activeMembershipRows(orgId, joinerId);
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe("active");
      expect(active[0].role).toBe("user");

      const pending = await db
        .select()
        .from(organizationJoinRequests)
        .where(
          and(
            eq(organizationJoinRequests.labId, orgId),
            eq(organizationJoinRequests.userId, joinerId),
            eq(organizationJoinRequests.status, "pending")
          )
        );
      expect(pending).toHaveLength(0);
    } finally {
      await db.delete(organizationJoinRequests).where(eq(organizationJoinRequests.userId, joinerId));
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, joinerId));
      await db.delete(userSessions).where(eq(userSessions.userId, joinerId));
      await db.delete(users).where(eq(users.id, joinerId));
    }
  });

  it("approving when an active membership already exists reactivates without creating a duplicate", async () => {
    const { access } = await makeSession(ownerId);
    const { db, users, userSessions, organizationMemberships, organizationJoinRequests } =
      dbMod as any;

    const orgName = rid("JoinDupOrg");
    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(orgName));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const joinerId = rid("joiner");
    await db.insert(users).values({
      id: joinerId,
      username: `joiner_${joinerId}`,
      password: "x",
    });
    // Pre-existing active membership.
    await db.insert(organizationMemberships).values({
      id: rid("memrow"),
      labId: orgId,
      userId: joinerId,
      role: "user",
      status: "active",
      joinedAt: new Date(),
    });
    const reqId = rid("jr");
    await db.insert(organizationJoinRequests).values({
      id: reqId,
      labId: orgId,
      userId: joinerId,
      requestedRole: "admin",
      status: "pending",
    });

    try {
      const approve = await request(appMod.default)
        .post(`/api/organizations/join-requests/${reqId}/approve`)
        .set("Authorization", `Bearer ${access}`);
      expect(approve.status).toBe(200);

      const active = await activeMembershipRows(orgId, joinerId);
      expect(active).toHaveLength(1);
      expect(active[0].role).toBe("admin");
    } finally {
      await db.delete(organizationJoinRequests).where(eq(organizationJoinRequests.userId, joinerId));
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, joinerId));
      await db.delete(userSessions).where(eq(userSessions.userId, joinerId));
      await db.delete(users).where(eq(users.id, joinerId));
    }
  });

  it("approving a user with a soft-deleted historical membership yields a single active membership", async () => {
    const { access } = await makeSession(ownerId);
    const { db, users, userSessions, organizationMemberships, organizationJoinRequests } =
      dbMod as any;

    const orgName = rid("JoinSoftDelOrg");
    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(orgName));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const joinerId = rid("joiner");
    await db.insert(users).values({
      id: joinerId,
      username: `joiner_${joinerId}`,
      password: "x",
    });
    // A historical soft-deleted membership for the same (lab, user).
    await db.insert(organizationMemberships).values({
      id: rid("memrow"),
      labId: orgId,
      userId: joinerId,
      role: "user",
      status: "active",
      joinedAt: new Date(),
      deletedAt: new Date(),
      deletedByUserId: ownerId,
    });
    const reqId = rid("jr");
    await db.insert(organizationJoinRequests).values({
      id: reqId,
      labId: orgId,
      userId: joinerId,
      requestedRole: "user",
      status: "pending",
    });

    try {
      const approve = await request(appMod.default)
        .post(`/api/organizations/join-requests/${reqId}/approve`)
        .set("Authorization", `Bearer ${access}`);
      expect(approve.status).toBe(200);

      const active = await activeMembershipRows(orgId, joinerId);
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe("active");
    } finally {
      await db.delete(organizationJoinRequests).where(eq(organizationJoinRequests.userId, joinerId));
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, joinerId));
      await db.delete(userSessions).where(eq(userSessions.userId, joinerId));
      await db.delete(users).where(eq(users.id, joinerId));
    }
  });

  it("re-approving an already-approved request does not surface a soft-deleted (removed) membership", async () => {
    const { access } = await makeSession(ownerId);
    const { db, users, userSessions, organizationMemberships, organizationJoinRequests } =
      dbMod as any;

    const orgName = rid("ReApproveRemovedOrg");
    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(orgName));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const joinerId = rid("joiner");
    await db.insert(users).values({
      id: joinerId,
      username: `joiner_${joinerId}`,
      password: "x",
    });
    const reqId = rid("jr");
    await db.insert(organizationJoinRequests).values({
      id: reqId,
      labId: orgId,
      userId: joinerId,
      requestedRole: "user",
      status: "pending",
    });

    try {
      // 1) Approve the pending request → creates an active membership and
      //    flips the request to "approved".
      const firstApprove = await request(appMod.default)
        .post(`/api/organizations/join-requests/${reqId}/approve`)
        .set("Authorization", `Bearer ${access}`);
      expect(firstApprove.status).toBe(200);
      expect(firstApprove.body.data.membership).toBeTruthy();

      // 2) The member is later removed (soft-deleted).
      await db
        .update(organizationMemberships)
        .set({ deletedAt: new Date(), deletedByUserId: ownerId })
        .where(
          and(
            eq(organizationMemberships.labId, orgId),
            eq(organizationMemberships.userId, joinerId)
          )
        );

      // 3) Re-approving the already-approved request must NOT surface the
      //    removed (soft-deleted) membership.
      const reApprove = await request(appMod.default)
        .post(`/api/organizations/join-requests/${reqId}/approve`)
        .set("Authorization", `Bearer ${access}`);
      expect(reApprove.status).toBe(200);
      expect(reApprove.body.data.request.status).toBe("approved");
      expect(reApprove.body.data.membership).toBeNull();
    } finally {
      await db.delete(organizationJoinRequests).where(eq(organizationJoinRequests.userId, joinerId));
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, joinerId));
      await db.delete(userSessions).where(eq(userSessions.userId, joinerId));
      await db.delete(users).where(eq(users.id, joinerId));
    }
  });

  it("invite acceptance succeeds when a soft-deleted membership already exists (partial unique index)", async () => {
    const { access: adminAccess } = await makeSession(ownerId);
    const { db, users, userSessions, organizationMemberships } = dbMod as any;

    const orgName = rid("AcceptSoftDelOrg");
    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${adminAccess}`)
      .send(labBody(orgName));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const inviteeId = rid("invitee");
    const inviteeEmail = `${inviteeId}@test.local`;
    await db.insert(users).values({
      id: inviteeId,
      username: `invitee_${inviteeId}`,
      password: "x",
      email: inviteeEmail,
    });
    // Historical soft-deleted membership must not block re-acceptance.
    await db.insert(organizationMemberships).values({
      id: rid("memrow"),
      labId: orgId,
      userId: inviteeId,
      role: "user",
      status: "active",
      joinedAt: new Date(),
      deletedAt: new Date(),
      deletedByUserId: ownerId,
    });
    const { access: inviteeAccess } = await makeSession(inviteeId);

    try {
      const inviteRes = await request(appMod.default)
        .post(`/api/organizations/${orgId}/invites`)
        .set("Authorization", `Bearer ${adminAccess}`)
        .send({ email: inviteeEmail, roleToAssign: "user", expiresInDays: 1 });
      expect(inviteRes.status).toBe(201);
      const token: string = inviteRes.body.data?.token ?? inviteRes.body.token;

      const acceptRes = await request(appMod.default)
        .post(`/api/organizations/invites/${token}/accept`)
        .set("Authorization", `Bearer ${inviteeAccess}`);
      expect(acceptRes.status).toBe(200);

      const active = await activeMembershipRows(orgId, inviteeId);
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe("active");
    } finally {
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, inviteeId));
      await db.delete(userSessions).where(eq(userSessions.userId, inviteeId));
      await db.delete(users).where(eq(users.id, inviteeId));
    }
  });

  // ── Member removal ────────────────────────────────────────────────────────

  it("admin can remove another member via DELETE /api/organizations/memberships/:id", async () => {
    const { access } = await makeSession(ownerId);
    const { db, users, userSessions, organizationMemberships } = dbMod as any;

    const orgName = rid("RemoveOrg");
    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(orgName));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const memberId = rid("tormem");
    await db.insert(users).values({
      id: memberId,
      username: `tormem_${memberId}`,
      password: "x",
    });
    const membershipId = rid("memrow");
    await db.insert(organizationMemberships).values({
      id: membershipId,
      labId: orgId,
      userId: memberId,
      role: "user",
      status: "active",
      joinedAt: new Date(),
    });

    try {
      const r = await request(appMod.default)
        .delete(`/api/organizations/memberships/${membershipId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      expect(r.body.data?.removed ?? r.body.removed).toBe(true);
    } finally {
      // Membership was hard-deleted by the route on success; only clean the user.
      await db.delete(organizationMemberships).where(
        eq(organizationMemberships.id, membershipId)
      );
      await db.delete(userSessions).where(eq(userSessions.userId, memberId));
      await db.delete(users).where(eq(users.id, memberId));
    }
  });

  it("non-admin cannot remove another user's membership (403)", async () => {
    const { access: adminAccess } = await makeSession(ownerId);
    const { db, users, userSessions, organizationMemberships } = dbMod as any;

    const orgName = rid("NoRemOrg");
    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${adminAccess}`)
      .send(labBody(orgName));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const userId1 = rid("nonadm1");
    const userId2 = rid("nonadm2");
    await db.insert(users).values([
      { id: userId1, username: `na1_${userId1}`, password: "x" },
      { id: userId2, username: `na2_${userId2}`, password: "x" },
    ]);
    const memId1 = rid("nm1");
    const memId2 = rid("nm2");
    await db.insert(organizationMemberships).values([
      {
        id: memId1,
        labId: orgId,
        userId: userId1,
        role: "user",
        status: "active",
        joinedAt: new Date(),
      },
      {
        id: memId2,
        labId: orgId,
        userId: userId2,
        role: "user",
        status: "active",
        joinedAt: new Date(),
      },
    ]);
    const { access: nonAdminAccess } = await makeSession(userId1);

    try {
      // userId1 (non-admin) tries to remove userId2's membership → 403
      const r = await request(appMod.default)
        .delete(`/api/organizations/memberships/${memId2}`)
        .set("Authorization", `Bearer ${nonAdminAccess}`);
      expect(r.status).toBe(403);
    } finally {
      await db.delete(userSessions).where(eq(userSessions.userId, userId1));
      await db.delete(userSessions).where(eq(userSessions.userId, userId2));
      await db.delete(organizationMemberships).where(
        eq(organizationMemberships.id, memId1)
      );
      await db.delete(organizationMemberships).where(
        eq(organizationMemberships.id, memId2)
      );
      await db.delete(users).where(eq(users.id, userId1));
      await db.delete(users).where(eq(users.id, userId2));
    }
  });

  // ── Provider org type ─────────────────────────────────────────────────────

  it("POST /api/organizations — provider org type is preserved in the response", async () => {
    const { access } = await makeSession(ownerId);
    // city/state/zip are required for provider orgs under a parent lab.
    // ownerId has lab memberships from earlier test runs, so the route will
    // resolve a parentLabOrganizationId and then check address fields.
    // Supply minimal valid address fields so the assertion stays focused on type.
    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send({
        type: "provider",
        name: rid("ProviderOrg"),
        city: "Tampa",
        state: "FL",
        zip: "33601",
      });
    expect(r.status).toBe(201);
    expect(r.body.data.type).toBe("provider");
    createdOrgIds.push(r.body.data.id);
  });

  // ── Invite decline ────────────────────────────────────────────────────────

  it("POST /organizations/invites/:id/decline — invitee can decline a pending invite", async () => {
    const { access: adminAccess } = await makeSession(ownerId);
    const { db, users, userSessions } = dbMod as any;

    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${adminAccess}`)
      .send(labBody(rid("DeclineOrg")));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const inviteeId = rid("declinee");
    const inviteeEmail = `${inviteeId}@test.local`;
    await db.insert(users).values({
      id: inviteeId,
      username: `declinee_${inviteeId}`,
      password: "x",
      email: inviteeEmail,
    });
    const { access: inviteeAccess } = await makeSession(inviteeId);

    try {
      const inviteRes = await request(appMod.default)
        .post(`/api/organizations/${orgId}/invites`)
        .set("Authorization", `Bearer ${adminAccess}`)
        .send({ email: inviteeEmail, roleToAssign: "user", expiresInDays: 1 });
      expect(inviteRes.status).toBe(201);
      const inviteId: string = inviteRes.body.data?.id ?? inviteRes.body.id;

      const declineRes = await request(appMod.default)
        .post(`/api/organizations/invites/${inviteId}/decline`)
        .set("Authorization", `Bearer ${inviteeAccess}`);
      expect(declineRes.status).toBe(200);
      const declStatus: string = declineRes.body.data?.status ?? declineRes.body.status;
      expect(declStatus).toBe("declined");
    } finally {
      await db.delete(userSessions).where(eq(userSessions.userId, inviteeId));
      await db.delete(users).where(eq(users.id, inviteeId));
    }
  });

  // ── PATCH /memberships/:id — role change ──────────────────────────────────

  it.each(["lab", "provider"])("requires confirmed handoff for Owner assignment in a %s, including legacy invitations", async (type) => {
    const { db, organizations, organizationMemberships, organizationInvites, users } = dbMod;
    const orgId = rid("OwnerGate");
    const membershipId = rid("OwnerGateMember");
    await db.insert(organizations).values({ id: orgId, type, name: orgId, createdByUserId: ownerId });
    createdOrgIds.push(orgId);
    await db.insert(organizationMemberships).values([
      { labId: orgId, userId: ownerId, role: "owner", status: "active" },
      { id: membershipId, labId: orgId, userId: providerUserId, role: "user", status: "active" },
    ]);
    const email = `${providerUserId}@test.local`;
    await db.update(users).set({ email }).where(eq(users.id, providerUserId));
    const { access } = await makeSession(ownerId);
    const promote = await request(appMod.default)
      .patch(`/api/organizations/memberships/${membershipId}`)
      .set("Authorization", `Bearer ${access}`).send({ role: "owner" });
    expect(promote.status).toBe(400);
    expect(JSON.stringify(promote.body)).toMatch(/confirmed ownership transfer/);
    const invite = await request(appMod.default)
      .post(`/api/organizations/${orgId}/invites`)
      .set("Authorization", `Bearer ${access}`).send({ email, roleToAssign: "owner" });
    expect(invite.status).toBe(400);
    expect(await db.select().from(organizationInvites).where(eq(organizationInvites.labId, orgId))).toHaveLength(0);

    const token = rid("LegacyOwnerInvite");
    const [legacyInvite] = await db.insert(organizationInvites).values({
      labId: orgId, email, roleToAssign: "owner", token, status: "pending",
      invitedByUserId: ownerId, expiresAt: new Date(Date.now() + 86_400_000),
    }).returning();
    const recipient = await makeSession(providerUserId);
    const accept = await request(appMod.default)
      .post(`/api/organizations/invites/${token}/accept`)
      .set("Authorization", `Bearer ${recipient.access}`).send({});
    expect(accept.status).toBe(400);
    expect(JSON.stringify(accept.body)).toMatch(/confirmed transfer/);
    const members = await db.select().from(organizationMemberships).where(eq(organizationMemberships.labId, orgId));
    expect(members.find((m) => m.userId === ownerId)?.role).toBe("owner");
    expect(members.find((m) => m.userId === providerUserId)?.role).toBe("user");
    const [unchangedInvite] = await db.select().from(organizationInvites).where(eq(organizationInvites.id, legacyInvite.id));
    expect(unchangedInvite.status).toBe("pending");
  });

  it("PATCH /api/organizations/memberships/:id — admin changes a member's role", async () => {
    const { access } = await makeSession(ownerId);
    const { db, users, organizationMemberships } = dbMod as any;

    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(rid("RolePatchOrg")));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const memberId = rid("rolemem");
    await db.insert(users).values({
      id: memberId,
      username: `rolemem_${memberId}`,
      password: "x",
    });
    const membershipId = rid("roleship");
    await db.insert(organizationMemberships).values({
      id: membershipId,
      userId: memberId,
      labId: orgId,
      role: "user",
      status: "active",
    });

    try {
      const r = await request(appMod.default)
        .patch(`/api/organizations/memberships/${membershipId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ role: "billing" });
      expect(r.status).toBe(200);
      expect(r.body.data.role).toBe("billing");
    } finally {
      await db.delete(organizationMemberships).where(
        eq(organizationMemberships.id, membershipId)
      );
      await db.delete(users).where(eq(users.id, memberId));
    }
  });

  // ── Role escalation prevention ─────────────────────────────────────────────
  // The PATCH /memberships/:id route guards with ADMIN_ROLES. A member with
  // role "user" must receive 403 when attempting to promote any other member.
  // This is the security boundary that prevents non-privileged users from
  // escalating roles for themselves or others.

  it("PATCH /api/organizations/memberships/:id — non-admin (user role) cannot change any role (403)", async () => {
    const escalAccess = await makeSession(ownerId);
    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${escalAccess.access}`)
      .send(labBody(rid("EscalOrg")));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const { db, users, organizationMemberships } = dbMod as any;

    const userId = rid("escaluser");
    const victimId = rid("escalvict");
    const mshipId = rid("escalship");
    const victimMshipId = rid("victship");

    await db.insert(users).values([
      { id: userId, username: `escal_${userId}`, password: "x" },
      { id: victimId, username: `vict_${victimId}`, password: "x" },
    ]);
    await db.insert(organizationMemberships).values([
      { id: mshipId, userId, labId: orgId, role: "user", status: "active" },
      { id: victimMshipId, userId: victimId, labId: orgId, role: "user", status: "active" },
    ]);

    try {
      const { access: userAccess } = await makeSession(userId);
      const r = await request(appMod.default)
        .patch(`/api/organizations/memberships/${victimMshipId}`)
        .set("Authorization", `Bearer ${userAccess}`)
        .send({ role: "admin" });
      expect(r.status).toBe(403);
    } finally {
      await db.delete(organizationMemberships).where(
        inArray(organizationMemberships.id, [mshipId, victimMshipId])
      );
      await db.delete(users).where(inArray(users.id, [userId, victimId]));
    }
  });

  it("PATCH /api/organizations/memberships/:id — admin CAN assign owner role (no role ceiling enforced)", async () => {
    // The PATCH handler only requires ADMIN_ROLES membership (admin or owner).
    // It does NOT enforce a role ceiling — any admin can set any role including
    // owner. This test locks in that behavior so future ceiling checks are
    // an intentional, visible change.
    const escalAccess = await makeSession(ownerId);
    const create = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${escalAccess.access}`)
      .send(labBody(rid("CeilOrg")));
    expect(create.status).toBe(201);
    const orgId = create.body.data.id;
    createdOrgIds.push(orgId);

    const { db, users, organizationMemberships } = dbMod as any;

    const adminId = rid("celadmin");
    const victimId = rid("celvict");
    const adminMshipId = rid("celadship");
    const victimMshipId = rid("celvictship");

    await db.insert(users).values([
      { id: adminId, username: `celadmin_${adminId}`, password: "x" },
      { id: victimId, username: `celvict_${victimId}`, password: "x" },
    ]);
    await db.insert(organizationMemberships).values([
      { id: adminMshipId, userId: adminId, labId: orgId, role: "admin", status: "active" },
      { id: victimMshipId, userId: victimId, labId: orgId, role: "user", status: "active" },
    ]);

    try {
      const { access: adminAccess } = await makeSession(adminId);
      const r = await request(appMod.default)
        .patch(`/api/organizations/memberships/${victimMshipId}`)
        .set("Authorization", `Bearer ${adminAccess}`)
        .send({ role: "owner" });
      // Role ceiling enforced: admin (rank 1) cannot assign owner (rank 0).
      expect(r.status).toBe(403);
    } finally {
      await db.delete(organizationMemberships).where(
        inArray(organizationMemberships.id, [adminMshipId, victimMshipId])
      );
      await db.delete(users).where(inArray(users.id, [adminId, victimId]));
    }
  });

  // ── AI intake: new provider org save regression ───────────────────────────
  //
  // Regression guard for the "save new practice from AI intake" flow.
  // All ten required cases from the task specification are covered here.
  //
  // Setup: a dedicated lab owner + lab org + membership is created directly in
  // the DB so every test can rely on findCallerPrimaryLabId resolving
  // without needing to sequence API calls.

  describe("AI intake: new provider org save regression", () => {
    const aiOwnerId = rid("aiown");
    const aiLabId = rid("ailab");
    const aiMshipId = rid("aimship");
    const aiProviderIds: string[] = [];
    const aiCaseIds: string[] = [];

    beforeAll(async () => {
      const { db, users, organizations: orgsTable, organizationMemberships } =
        dbMod as any;
      await db.insert(users).values({
        id: aiOwnerId,
        username: `aiown_${aiOwnerId}`,
        password: "x",
      });
      await db.insert(orgsTable).values({
        id: aiLabId,
        type: "lab",
        name: rid("AiIntakeOrgLab"),
      });
      await db.insert(organizationMemberships).values({
        id: aiMshipId,
        labId: aiLabId,
        userId: aiOwnerId,
        role: "owner",
        status: "active",
        approvedByUserId: aiOwnerId,
        joinedAt: new Date(),
      });
    });

    afterAll(async () => {
      if (!SHOULD_RUN) return;
      const {
        db,
        auditLogs,
        cases: casesTable,
        invoices,
        invoiceLineItems,
        userSessions,
        organizationMemberships,
        organizations: orgsTable,
        users,
      } = dbMod as any;
      if (aiCaseIds.length) {
        if (invoiceLineItems) {
          const invRows = await db
            .select({ id: invoices.id })
            .from(invoices)
            .where(inArray(invoices.caseId, aiCaseIds));
          const invIds = invRows.map((r: any) => r.id);
          if (invIds.length)
            await db.delete(invoiceLineItems).where(inArray(invoiceLineItems.invoiceId, invIds));
          await db.delete(invoices).where(inArray(invoices.caseId, aiCaseIds));
        }
        await db.delete(casesTable).where(inArray(casesTable.id, aiCaseIds));
      }
      if (aiProviderIds.length) {
        await db
          .delete(auditLogs)
          .where(inArray(auditLogs.organizationId, aiProviderIds));
        await db
          .delete(orgsTable)
          .where(inArray(orgsTable.id, aiProviderIds));
      }
      await db
        .delete(auditLogs)
        .where(inArray(auditLogs.organizationId, [aiLabId]));
      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.id, aiMshipId));
      await db.delete(userSessions).where(eq(userSessions.userId, aiOwnerId));
      await db.delete(orgsTable).where(eq(orgsTable.id, aiLabId));
      await db.delete(users).where(eq(users.id, aiOwnerId));
    });

    // ── (1) Complete AI intake payload saves successfully ──────────────────

    it("(1) new practice save from AI intake succeeds with complete data", async () => {
      const { access } = await makeSession(aiOwnerId);
      const r = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("HeartlandDental"),
          displayName: "Heartland Dental Family Dentistry",
          parentLabOrganizationId: aiLabId,
          phone: "850-555-0101",
          addressLine1: "1234 Oak St",
          city: "Tallahassee",
          state: "FL",
          zip: "32311",
          doctorName: "Dr. James Watson",
        });
      expect(r.status).toBe(201);
      expect(r.body.data.id).toBeTruthy();
      expect(r.body.data.type).toBe("provider");
      aiProviderIds.push(r.body.data.id);
    });

    // ── (2) Optional phone / email missing ────────────────────────────────

    it("(2) new practice save succeeds when optional phone and email are missing", async () => {
      const { access } = await makeSession(aiOwnerId);
      const r = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("NoPhonePractice"),
          parentLabOrganizationId: aiLabId,
          addressLine1: "99 Pine Rd",
          city: "Gainesville",
          state: "FL",
          zip: "32601",
        });
      expect(r.status).toBe(201);
      aiProviderIds.push(r.body.data.id);
    });

    // ── (3) ZIP with dash ─────────────────────────────────────────────────

    it("(3) ZIP with dash (32311-2717) is accepted without error", async () => {
      const { access } = await makeSession(aiOwnerId);
      const r = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("ZipDashPractice"),
          parentLabOrganizationId: aiLabId,
          addressLine1: "500 Elm Ave",
          city: "Jacksonville",
          state: "FL",
          zip: "32311-2717",
        });
      expect(r.status).toBe(201);
      expect(r.body.data.zip).toBe("32311-2717");
      aiProviderIds.push(r.body.data.id);
    });

    // ── (4) Placeholder phone does not crash ──────────────────────────────

    it("(4) placeholder phone 000-000-0000 does not crash the insert", async () => {
      const { access } = await makeSession(aiOwnerId);
      const r = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("PlaceholderPhone"),
          parentLabOrganizationId: aiLabId,
          phone: "000-000-0000",
          addressLine1: "10 Main St",
          city: "Miami",
          state: "FL",
          zip: "33101",
        });
      expect(r.status).toBe(201);
      aiProviderIds.push(r.body.data.id);
    });

    // ── (5) Duplicate practice name → clean 409 (not raw SQL) ────────────
    // Creating two practices with the same name (case-insensitive) under the
    // same lab must return a human-readable 409 message — no raw SQL or
    // Drizzle error string may leak to the caller.

    it("(5) duplicate practice name in same lab returns clean 409 with expected message", async () => {
      const { access } = await makeSession(aiOwnerId);
      const practiceName = rid("DupNamePractice");

      const first = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: practiceName,
          parentLabOrganizationId: aiLabId,
          city: "Orlando",
          state: "FL",
          zip: "32801",
        });
      expect(first.status).toBe(201);
      aiProviderIds.push(first.body.data.id);

      // Same name again — must be rejected with a readable 409.
      // city/state/zip must also be present so the duplicate-name check is
      // reached (city/state/zip validation runs before the name check).
      const second = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: practiceName,
          parentLabOrganizationId: aiLabId,
          city: "Orlando",
          state: "FL",
          zip: "32801",
        });
      expect(second.status).toBe(409);
      // Message must be human-readable, not a raw SQL string.
      const msg: string = second.body.message ?? second.body.error ?? "";
      expect(msg).not.toMatch(/insert into|organizations|drizzle/i);
      expect(msg).toBe(
        "A practice with this name already exists. Select existing practice instead."
      );
    });

    it("(5b) duplicate practice name is rejected case-insensitively", async () => {
      const { access } = await makeSession(aiOwnerId);
      const baseName = rid("CaseDupPractice");

      const first = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: baseName.toLowerCase(),
          parentLabOrganizationId: aiLabId,
          city: "Tampa",
          state: "FL",
          zip: "33601",
        });
      expect(first.status).toBe(201);
      aiProviderIds.push(first.body.data.id);

      // Same name but uppercased — must still be rejected.
      const second = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: baseName.toUpperCase(),
          parentLabOrganizationId: aiLabId,
          city: "Tampa",
          state: "FL",
          zip: "33601",
        });
      expect(second.status).toBe(409);
      const msg: string = second.body.message ?? second.body.error ?? "";
      expect(msg).toBe(
        "A practice with this name already exists. Select existing practice instead."
      );
    });

    // ── (5c) Inactive practice with same name does NOT block creation ───────
    // If a practice is deactivated (isActive = false), a new active practice
    // with the same name should be allowed. The duplicate guard only fires for
    // active provider orgs.

    it("(5c) inactive practice with same name does not block creating a new active one", async () => {
      const { access } = await makeSession(aiOwnerId);
      const practiceName = rid("InactiveDupPractice");

      // Create the first practice.
      const first = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: practiceName,
          parentLabOrganizationId: aiLabId,
        });
      expect(first.status).toBe(201);
      const firstId = first.body.data.id;
      aiProviderIds.push(firstId);

      // Deactivate it via PATCH.
      const patch = await request(appMod.default)
        .patch(`/api/organizations/${firstId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ isActive: false });
      expect(patch.status).toBe(200);

      // Creating a new practice with the same name must now succeed.
      const second = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: practiceName,
          parentLabOrganizationId: aiLabId,
        });
      expect(second.status).toBe(201);
      aiProviderIds.push(second.body.data.id);
    });

    // ── (5d) Soft-deleted practice with same name does NOT block creation ───
    // A soft-deleted org (deleted_at IS NOT NULL) must be excluded from the
    // duplicate-name check so a new active practice can be created.

    it("(5d) soft-deleted practice with same name does not block creating a new active one", async () => {
      const { access } = await makeSession(aiOwnerId);
      const practiceName = rid("SoftDelDupPractice");

      // Create the first practice.
      const first = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: practiceName,
          parentLabOrganizationId: aiLabId,
        });
      expect(first.status).toBe(201);
      const firstId: string = first.body.data.id;
      aiProviderIds.push(firstId);

      // Soft-delete it directly via the db.
      const { db, organizations: orgsTable } = dbMod as any;
      await db
        .update(orgsTable)
        .set({ deletedAt: new Date(), deletedByUserId: aiOwnerId })
        .where(eq(orgsTable.id, firstId));

      // Creating a new practice with the same name must now succeed.
      const second = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: practiceName,
          parentLabOrganizationId: aiLabId,
        });
      expect(
        second.status,
        "creation must succeed when the same-name practice is soft-deleted"
      ).toBe(201);
      aiProviderIds.push(second.body.data.id);
    });

    // ── (5e) Name-duplicate 409 includes the conflicting org's details ───────
    // The 409 response for a name conflict must include id, name, displayName,
    // and accountNumber so the desktop UI can navigate to the conflicting org.

    it("(5e) name-duplicate 409 includes conflicting org id, name, displayName, accountNumber", async () => {
      const { access } = await makeSession(aiOwnerId);
      const practiceName = rid("ConflictDetailPractice");
      const displayName = "Conflict Detail Practice Display";

      const first = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: practiceName,
          displayName,
          parentLabOrganizationId: aiLabId,
        });
      expect(first.status).toBe(201);
      const firstId: string = first.body.data.id;
      const firstAccountNumber: string = first.body.data.accountNumber;
      aiProviderIds.push(firstId);

      // Same name → must 409 with conflict details.
      const second = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: practiceName,
          parentLabOrganizationId: aiLabId,
        });
      expect(second.status).toBe(409);
      const details = second.body.details?.conflictingOrg;
      expect(details, "409 must include details.conflictingOrg").toBeTruthy();
      expect(details.id).toBe(firstId);
      expect(details.name).toBe(practiceName);
      expect(details.displayName).toBe(displayName);
      expect(details.accountNumber).toBe(firstAccountNumber);
    });

    // ── (5f) Same name under a different lab does NOT block creation ─────────
    // The duplicate-name guard is scoped to the parent lab; an identical name
    // under a different lab must be allowed.

    it("(5f) same practice name under a different lab does not block creation", async () => {
      // Create a second independent lab for this test.
      const secondLabOwnerId = rid("u");
      const secondLabId = rid("lab");
      const secondLabMshipId = rid("mship");
      const { db, users, organizations: orgsTable, organizationMemberships } = dbMod as any;

      await db.insert(users).values({
        id: secondLabOwnerId,
        username: `lab2owner_${randomBytes(4).toString("hex")}`,
        password: "x",
        role: "lab",
        email: `lab2_${randomBytes(4).toString("hex")}@example.com`,
      });
      await db.insert(orgsTable).values({
        id: secondLabId,
        type: "lab",
        name: `SecondLab_${randomBytes(4).toString("hex")}`,
        createdByUserId: secondLabOwnerId,
        isActive: true,
      });
      await db.insert(organizationMemberships).values({
        id: secondLabMshipId,
        labId: secondLabId,
        userId: secondLabOwnerId,
        role: "owner",
        status: "active",
        approvedByUserId: secondLabOwnerId,
        joinedAt: new Date(),
      });

      const { access: ownerAccess } = await makeSession(aiOwnerId);
      const { access: lab2Access } = await makeSession(secondLabOwnerId);

      const practiceName = rid("CrossLabPractice");

      // Create in the first lab.
      const first = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${ownerAccess}`)
        .send({
          type: "provider",
          name: practiceName,
          parentLabOrganizationId: aiLabId,
        });
      expect(first.status).toBe(201);
      aiProviderIds.push(first.body.data.id);

      // Same name in the second lab → must succeed.
      const second = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${lab2Access}`)
        .send({
          type: "provider",
          name: practiceName,
          parentLabOrganizationId: secondLabId,
        });
      expect(
        second.status,
        "same name is allowed in a different lab"
      ).toBe(201);

      // Clean up the second lab's provider and the lab itself.
      const provId2: string = second.body.data.id;
      const { auditLogs, userSessions } = dbMod as any;
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, provId2));
      await db.delete(orgsTable).where(eq(orgsTable.id, provId2));
      await db.delete(organizationMemberships).where(eq(organizationMemberships.id, secondLabMshipId));
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, secondLabId));
      await db.delete(orgsTable).where(eq(orgsTable.id, secondLabId));
      await db.delete(userSessions).where(eq(userSessions.userId, secondLabOwnerId));
      await db.delete(users).where(eq(users.id, secondLabOwnerId));
    });

    // ── (5g) Custom account number collision → account-number-specific error ─
    // When a caller supplies a custom account number that is already taken by
    // another active practice in the same lab, the error must be about the
    // account number — not a misleading "practice already exists" message.

    it("(5g) custom account number collision produces an account-number-specific error", async () => {
      const { access } = await makeSession(aiOwnerId);
      const accountNumber = `ACCT-${randomBytes(4).toString("hex")}`;

      const first = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("AcctNumFirst"),
          accountNumber,
          parentLabOrganizationId: aiLabId,
        });
      expect(first.status).toBe(201);
      aiProviderIds.push(first.body.data.id);

      // Different practice name but same account number.
      const second = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("AcctNumSecond"),
          accountNumber,
          parentLabOrganizationId: aiLabId,
        });
      expect(second.status).toBe(409);
      const msg: string = second.body.message ?? second.body.error ?? "";
      // Must reference the account number, not practice name.
      expect(msg).not.toBe(
        "A practice with this name already exists. Select existing practice instead."
      );
      expect(msg).toMatch(/account number/i);
    });

    // ── (5h) Platform account number issuance ────────────────────────────────

    it("(5h) new practices receive the Luhn-checked platform format", async () => {
      const { access } = await makeSession(aiOwnerId);
      const r = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("NumberedPractice"),
          displayName: "Numbered Practice",
          parentLabOrganizationId: aiLabId,
        });

      expect(
        r.status,
        `Expected 201 for numbered practice, got ${r.status}: ${JSON.stringify(r.body)}`
      ).toBe(201);
      expect(r.body.data.platformAccountNumber).toMatch(/^7\d{11}$/);
      aiProviderIds.push(r.body.data.id);
    });

    // ── (5i–5m) Multi-segment account numbers ────────────────────────────────
    // Regression guard for Task #3643: practices may store a semicolon-
    // separated list of account numbers. Each segment is individually unique
    // per lab. The claim flow accepts any segment.

    it("(5i) semicolon-separated account number saves and round-trips as-is", async () => {
      const { access } = await makeSession(aiOwnerId);
      const seg1 = `MSA-${randomBytes(3).toString("hex").toUpperCase()}`;
      const seg2 = `MSB-${randomBytes(3).toString("hex").toUpperCase()}`;
      const multiAcct = `${seg1}; ${seg2}`;

      const r = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("MultiAcctPractice"),
          accountNumber: multiAcct,
          parentLabOrganizationId: aiLabId,
        });
      expect(r.status, `create multi-segment: ${JSON.stringify(r.body)}`).toBe(201);
      expect(r.body.data.accountNumber).toBe(multiAcct);
      aiProviderIds.push(r.body.data.id);
    });

    it("(5j) a segment from a multi-value list collides with another practice's existing segment", async () => {
      const { access } = await makeSession(aiOwnerId);
      const shared = `COLL-${randomBytes(3).toString("hex").toUpperCase()}`;
      const other = `UNIQ-${randomBytes(3).toString("hex").toUpperCase()}`;

      // First practice owns `shared` as its only segment.
      const first = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("CollFirst"),
          accountNumber: shared,
          parentLabOrganizationId: aiLabId,
        });
      expect(first.status).toBe(201);
      aiProviderIds.push(first.body.data.id);

      // Second practice tries to include `shared` as a second segment.
      const second = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("CollSecond"),
          accountNumber: `${other}; ${shared}`,
          parentLabOrganizationId: aiLabId,
        });
      expect(second.status).toBe(409);
      const msg: string = second.body.message ?? second.body.error ?? "";
      expect(msg).toMatch(/account number/i);
    });

    it("(5k) provider claim succeeds when the submitted number matches a secondary segment", async () => {
      const { access } = await makeSession(aiOwnerId);
      const primarySeg = `PRI-${randomBytes(3).toString("hex").toUpperCase()}`;
      const secondarySeg = `SEC-${randomBytes(3).toString("hex").toUpperCase()}`;

      // Create the practice with two segments.
      const create = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("ClaimSecondary"),
          accountNumber: `${primarySeg}; ${secondarySeg}`,
          parentLabOrganizationId: aiLabId,
        });
      expect(create.status, `create: ${JSON.stringify(create.body)}`).toBe(201);
      aiProviderIds.push(create.body.data.id);

      // Register a new provider user claiming via the SECONDARY segment.
      const claimEmail = `claim-sec-${randomBytes(4).toString("hex")}@test-labtrax.invalid`;
      const claimUsername = `cs${randomBytes(4).toString("hex")}`; // 10 chars, within 3-12 limit
      const claim = await request(appMod.default)
        .post("/api/auth/register")
        .send({
          username: claimUsername,
          email: claimEmail,
          password: "ClaimTest123!",
          userType: "provider",
          claimProvider: {
            labId: aiLabId,
            accountNumber: secondarySeg,
          },
        });
      // Registration accepts the practice lookup and records an administrator-
      // reviewed join request; the account number does not grant membership.
      expect(
        [200, 201],
        `claim via secondary segment: ${JSON.stringify(claim.body)}`
      ).toContain(claim.status);

      // Clean up the created user.
      const { db: testDb, users: usersTable, organizationMemberships: memberships } = dbMod as any;
      const createdUser = await testDb.query.users.findFirst({
        where: eq((dbMod as any).users.email, claimEmail),
        columns: { id: true },
      });
      if (createdUser) {
        await testDb.delete(memberships).where(eq(memberships.userId, createdUser.id));
        await testDb.delete(usersTable).where(eq(usersTable.id, createdUser.id));
      }
    });

    it("(5l) duplicate segments within one submitted list are rejected (400)", async () => {
      const { access } = await makeSession(aiOwnerId);
      const seg = `DUP-${randomBytes(3).toString("hex").toUpperCase()}`;

      const r = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("DupSegPractice"),
          accountNumber: `${seg}; ${seg}`,
          parentLabOrganizationId: aiLabId,
        });
      expect(r.status).toBe(400);
      const msg: string = r.body.message ?? r.body.error ?? "";
      expect(msg).toMatch(/duplicate/i);
    });

    it("(5n) custom account number: legacy index constraint returns 409, not 500 and not a silent substitute", async () => {
      // Exercises the transitional catch branch for
      // `organizations_parent_lab_account_number_unique` with a custom input.
      // The old DB index covered all rows (including soft-deleted), so the
      // application-level check (which excludes soft-deleted) could approve a
      // number that the index then rejects. The fix must surface 409 for custom
      // numbers — not 500, and never silently create the org with a different number.
      //
      // The legacy index cannot be recreated reliably on a shared dev DB (other
      // tests have left rows that would cause duplicate-key errors on index creation).
      // Instead we simulate the constraint by making db.transaction throw the exact
      // pg error the old index would have produced.
      const { access } = await makeSession(aiOwnerId);
      const customAcct = `LGX-${randomBytes(3).toString("hex").toUpperCase()}`;

      // Build a synthetic constraint error matching what pg would produce.
      const constraintErr = Object.assign(
        new Error("duplicate key value violates unique constraint"),
        {
          code: "23505",
          constraint: "organizations_parent_lab_account_number_unique",
        }
      );

      const { db: testDb } = dbMod as any;
      // Platform allocation and the organization insert now share the single
      // transaction opened by insertWithAccountNumberLock. Make that transaction
      // throw the synthetic constraint error the legacy index would produce.
      const origTransaction = testDb.transaction.bind(testDb);
      let txCallCount = 0;
      const txSpy = vi.spyOn(testDb, "transaction").mockImplementation(function (...args: any[]) {
        txCallCount++;
        if (txCallCount === 1) {
          throw constraintErr;
        }
        return origTransaction(...args);
      });

      try {
        const r = await request(appMod.default)
          .post("/api/organizations")
          .set("Authorization", `Bearer ${access}`)
          .send({
            type: "provider",
            name: rid("LegacyIndexTest"),
            accountNumber: customAcct,
            parentLabOrganizationId: aiLabId,
          });
        expect(
          r.status,
          `expected 409 (custom account number conflict), got ${r.status}: ${JSON.stringify(r.body)}`
        ).toBe(409);
        const msg: string = r.body.message ?? r.body.error ?? "";
        expect(msg).toMatch(/account number/i);
        // No org should have been created (transaction never committed).
        expect(r.body.data?.id, "no org id on a 409 response").toBeUndefined();
      } finally {
        txSpy.mockRestore();
      }
    });

    it("(5m) PATCH updates account number to a multi-segment value; old segment becomes free", async () => {
      const { access } = await makeSession(aiOwnerId);
      const oldSeg = `OLD-${randomBytes(3).toString("hex").toUpperCase()}`;
      const newSeg1 = `NEW1-${randomBytes(3).toString("hex").toUpperCase()}`;
      const newSeg2 = `NEW2-${randomBytes(3).toString("hex").toUpperCase()}`;

      // Create with a single segment.
      const create = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("PatchMultiAcct"),
          accountNumber: oldSeg,
          parentLabOrganizationId: aiLabId,
        });
      expect(create.status).toBe(201);
      const orgId: string = create.body.data.id;
      aiProviderIds.push(orgId);

      // PATCH to a two-segment value.
      const patch = await request(appMod.default)
        .patch(`/api/organizations/${orgId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ accountNumber: `${newSeg1}; ${newSeg2}` });
      expect(patch.status, `patch: ${JSON.stringify(patch.body)}`).toBe(200);
      expect(patch.body.data.accountNumber).toBe(`${newSeg1}; ${newSeg2}`);

      // Old segment must now be free — another practice can claim it.
      const other = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("ReclaimOldSeg"),
          accountNumber: oldSeg,
          parentLabOrganizationId: aiLabId,
        });
      expect(other.status, `reclaim old segment: ${JSON.stringify(other.body)}`).toBe(201);
      aiProviderIds.push(other.body.data.id);
    });

    it("(5n) PATCH retains existing segment while appending a new one", async () => {
      const { access } = await makeSession(aiOwnerId);
      const existingSeg = `EXIST-${randomBytes(3).toString("hex").toUpperCase()}`;
      const newSeg = `NEW-${randomBytes(3).toString("hex").toUpperCase()}`;

      // Create with a single segment.
      const create = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("RetainAndExtend"),
          accountNumber: existingSeg,
          parentLabOrganizationId: aiLabId,
        });
      expect(create.status).toBe(201);
      const orgId: string = create.body.data.id;
      aiProviderIds.push(orgId);

      // PATCH to retain the existing segment and append a new one.
      const patch = await request(appMod.default)
        .patch(`/api/organizations/${orgId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ accountNumber: `${existingSeg}; ${newSeg}` });
      expect(patch.status, `patch: ${JSON.stringify(patch.body)}`).toBe(200);
      expect(patch.body.data.accountNumber).toBe(`${existingSeg}; ${newSeg}`);

      // New segment must now be taken — another practice cannot claim it.
      const conflict = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("ClaimNewSeg"),
          accountNumber: newSeg,
          parentLabOrganizationId: aiLabId,
        });
      expect(
        conflict.status,
        `conflict on new seg: ${JSON.stringify(conflict.body)}`
      ).toBe(409);
      const conflictMsg: string = conflict.body.message ?? conflict.body.error ?? "";
      expect(conflictMsg).toContain(newSeg);
    });

    // ── (6) Field validation: name required ─────────────────────────────────
    // Missing name → 400 (Zod enforces min(1)).
    // City, state, and ZIP are optional; omitting them must not return an error.

    it("(6) missing name returns 400; omitting city/state/zip is accepted", async () => {
      const { access } = await makeSession(aiOwnerId);

      // Missing name → Zod must reject.
      const noName = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          parentLabOrganizationId: aiLabId,
          city: "Orlando",
          state: "FL",
          zip: "32801",
        });
      expect(noName.status).toBe(400);

      // Name only (no city/state/zip) → must be accepted.
      const nameOnly = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("NameOnlyPractice"),
          parentLabOrganizationId: aiLabId,
        });
      expect(
        nameOnly.status,
        "name-only practice (no city/state/zip) must be accepted"
      ).toBe(201);
      aiProviderIds.push(nameOnly.body.data.id);
    });

    // ── (7) parentLabOrganizationId is persisted on the provider org ───────

    it("(7) created provider org has parentLabOrganizationId set to the active lab", async () => {
      const { access } = await makeSession(aiOwnerId);
      const r = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("ParentLabCheck"),
          parentLabOrganizationId: aiLabId,
          city: "Tampa",
          state: "FL",
          zip: "33601",
        });
      expect(r.status).toBe(201);
      expect(r.body.data.parentLabOrganizationId).toBe(aiLabId);
      aiProviderIds.push(r.body.data.id);
    });

    // ── (8) No owner membership created for the lab user ─────────────────

    it("(8) creating a provider org does NOT create an owner lab_memberships row for the caller", async () => {
      const { access } = await makeSession(aiOwnerId);
      const r = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("NoMembershipCheck"),
          parentLabOrganizationId: aiLabId,
          city: "Tampa",
          state: "FL",
          zip: "33601",
        });
      expect(r.status).toBe(201);
      const provId = r.body.data.id;
      aiProviderIds.push(provId);

      const { db, organizationMemberships } = dbMod as any;
      const memberships = await db
        .select()
        .from(organizationMemberships)
        .where(eq(organizationMemberships.labId, provId));
      const callerEntry = memberships.find(
        (m: any) => m.userId === aiOwnerId
      );
      expect(
        callerEntry,
        "lab user must not gain membership in the new provider org"
      ).toBeUndefined();
    });

    // ── (9) Case creation succeeds immediately after provider org is saved ─

    it("(9) case creation can proceed immediately after new practice is saved", async () => {
      const { access } = await makeSession(aiOwnerId);

      const orgResp = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: rid("CaseReadyPractice"),
          parentLabOrganizationId: aiLabId,
          city: "Pensacola",
          state: "FL",
          zip: "32501",
        });
      expect(orgResp.status).toBe(201);
      const provId = orgResp.body.data.id;
      aiProviderIds.push(provId);

      const caseResp = await request(appMod.default)
        .post("/api/cases")
        .set("Authorization", `Bearer ${access}`)
        .send({
          caseNumber: rid("AICR"),
          labOrganizationId: aiLabId,
          providerOrganizationId: provId,
          patientFirstName: "Case",
          patientLastName: "Ready",
          doctorName: "Dr. Ready",
          status: "received",
        });
      expect(
        caseResp.status,
        "case creation must succeed with the newly saved provider org"
      ).toBe(201);
      aiCaseIds.push(caseResp.body.data.id);
    });

    // ── (10) AI intake data present on case, invoice, and mobile endpoint ────
    // After a full AI intake cycle (org save → case create), the doctor name,
    // practice name, and address must be accessible via the canonical cases
    // endpoint (used by both desktop and mobile). An auto-generated invoice must
    // also exist linked to the new case.

    it("(10) AI intake: practice/doctor/address on case; auto-invoice created; accessible via GET /api/cases/:id (desktop + mobile path)", async () => {
      const { access } = await makeSession(aiOwnerId);
      const practiceName = rid("AiIntakeFull10");

      const orgResp = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send({
          type: "provider",
          name: practiceName,
          displayName: "Heartland Dental Family Dentistry",
          parentLabOrganizationId: aiLabId,
          phone: "000-000-0000",
          addressLine1: "2500 Centennial Dr",
          city: "Tallahassee",
          state: "FL",
          zip: "32311-2717",
          doctorName: "Dr. Sarah Connor",
        });
      expect(orgResp.status).toBe(201);
      const provId = orgResp.body.data.id;
      aiProviderIds.push(provId);

      // Confirm practice address fields were persisted in the CREATE response.
      expect(orgResp.body.data.addressLine1).toBe("2500 Centennial Dr");
      expect(orgResp.body.data.city).toBe("Tallahassee");
      expect(orgResp.body.data.state).toBe("FL");
      expect(orgResp.body.data.zip).toBe("32311-2717");
      expect(orgResp.body.data.type).toBe("provider");
      expect(orgResp.body.data.parentLabOrganizationId).toBe(aiLabId);

      const caseResp = await request(appMod.default)
        .post("/api/cases")
        .set("Authorization", `Bearer ${access}`)
        .send({
          caseNumber: rid("AIDATA10"),
          labOrganizationId: aiLabId,
          providerOrganizationId: provId,
          patientFirstName: "Intake",
          patientLastName: "Patient",
          doctorName: "Dr. Sarah Connor",
          status: "received",
          dueDate: "2026-12-01",
          shade: "A2",
          notes: "Patient has ceramic preference.",
          restorations: [
            {
              toothNumber: "8",
              restorationType: "Crown",
              material: "Zirconia",
              shade: "A2",
              quantity: 1,
              unitPrice: 0,
            },
          ],
        });
      expect(caseResp.status).toBe(201);
      const caseId = caseResp.body.data.id;
      aiCaseIds.push(caseId);

      // (a) Canonical GET /api/cases/:id — used by both desktop and mobile.
      const getResp = await request(appMod.default)
        .get(`/api/cases/${caseId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(getResp.status).toBe(200);
      const c = getResp.body.data ?? getResp.body;

      expect(c.doctorName, "doctorName must survive to GET /api/cases/:id").toBe(
        "Dr. Sarah Connor"
      );
      expect(
        c.providerOrganizationId,
        "providerOrganizationId must link to the AI-saved practice"
      ).toBe(provId);
      expect(c.dueDate, "dueDate must survive").toMatch(/2026-12-01/);

      const rests: any[] = c.restorations ?? [];
      expect(rests.length, "restoration rows must be stored").toBeGreaterThan(0);
      expect(rests[0].shade).toBe("A2");
      expect(rests[0].material).toBe("Zirconia");

      // (b) Verify practice address is accessible via GET /api/organizations/:id.
      // This confirms address fields were actually persisted to the DB, not just
      // echoed from the POST body.
      const getOrgResp = await request(appMod.default)
        .get(`/api/organizations/${provId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(getOrgResp.status).toBe(200);
      const savedOrg = getOrgResp.body.data ?? getOrgResp.body;
      expect(
        savedOrg.addressLine1 ?? savedOrg.address_line1,
        "addressLine1 must be readable via GET /api/organizations/:id"
      ).toBe("2500 Centennial Dr");
      expect(savedOrg.city, "city must be readable via GET").toBe("Tallahassee");
      expect(savedOrg.zip, "ZIP must survive ZIP+4 round-trip").toBe(
        "32311-2717"
      );
      expect(savedOrg.name, "practice name must be readable via GET").toBe(
        practiceName
      );

      // (c) Auto-generated invoice must exist linked to the case and the lab.
      const { db, invoices } = dbMod as any;
      let invoiceRows: any[] = [];
      for (let i = 0; i < 30; i++) {
        await new Promise((res) => setTimeout(res, 100));
        invoiceRows = await db
          .select()
          .from(invoices)
          .where(eq(invoices.caseId, caseId));
        if (invoiceRows.length > 0) break;
      }
      expect(invoiceRows.length, "auto-generated invoice must exist").toBe(1);
      expect(invoiceRows[0].labOrganizationId).toBe(aiLabId);
      // Invoice must be linked to the provider org so statements are routed
      // correctly — this is the critical link that AI intake sets up end-to-end.
      expect(
        invoiceRows[0].providerOrganizationId,
        "invoice must be linked to the AI-saved provider org"
      ).toBe(provId);
    });
  });

  // ── GET /api/organizations — includeLabPractices visibility ───────────────
  // Regression guard for Task #2427: a practice created after the June 18
  // "no membership in created practices" change has no membership, so it is
  // invisible in the membership-scoped list yet still blocks creation via the
  // parent-lab duplicate check. The opt-in includeLabPractices mode realigns
  // list visibility with the duplicate-check scope so blocking practices are
  // findable — WITHOUT re-introducing the practice memberships.
  describe("includeLabPractices visibility", () => {
    it("default mode stays membership-only (Settings → Organizations): lab visible, its child practices hidden", async () => {
      const { access, labId } = await makeOwnerLab();
      const name = rid("HiddenPractice");
      const create = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send(practiceBody(name, labId));
      expect(create.status).toBe(201);
      const practiceId = create.body.data.id;
      createdOrgIds.push(practiceId);

      const list = await request(appMod.default)
        .get("/api/organizations")
        .set("Authorization", `Bearer ${access}`);
      expect(list.status).toBe(200);
      const orgs: any[] = list.body.data ?? [];
      expect(orgs.some((o: any) => o.id === labId)).toBe(true);
      expect(orgs.some((o: any) => o.id === practiceId)).toBe(false);
    });

    it("includeLabPractices=true returns child practices even though the caller has NO membership in them (June 18 behavior preserved)", async () => {
      const { access, labId } = await makeOwnerLab();
      const name = rid("VisiblePractice");
      const create = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send(practiceBody(name, labId));
      expect(create.status).toBe(201);
      const practiceId = create.body.data.id;
      createdOrgIds.push(practiceId);

      // Guard: lab admins must NOT regain a membership in the practice.
      const { db, organizationMemberships } = dbMod as any;
      const practiceMembers = await db
        .select()
        .from(organizationMemberships)
        .where(eq(organizationMemberships.labId, practiceId));
      expect(
        practiceMembers.find((m: any) => m.userId === ownerId),
        "creating a practice must NOT grant the lab admin a membership in it"
      ).toBeUndefined();

      const list = await request(appMod.default)
        .get("/api/organizations?includeLabPractices=true")
        .set("Authorization", `Bearer ${access}`);
      expect(list.status).toBe(200);
      const orgs: any[] = list.body.data ?? [];
      expect(orgs.some((o: any) => o.id === labId)).toBe(true);
      expect(orgs.some((o: any) => o.id === practiceId)).toBe(true);
    });

    it("a duplicate active practice returns 409 AND that blocking practice is now findable/searchable in includeLabPractices mode", async () => {
      const { access, labId } = await makeOwnerLab();
      const name = rid("DupVisible");

      const first = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send(practiceBody(name, labId));
      expect(first.status).toBe(201);
      const firstId = first.body.data.id;
      createdOrgIds.push(firstId);

      const dup = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send(practiceBody(name, labId));
      expect(dup.status).toBe(409);
      expect(dup.body.details?.conflictingOrg?.id).toBe(firstId);

      const list = await request(appMod.default)
        .get("/api/organizations?includeLabPractices=true")
        .set("Authorization", `Bearer ${access}`);
      expect(list.status).toBe(200);
      const orgs: any[] = list.body.data ?? [];
      const found = orgs.find((o: any) => o.id === firstId);
      expect(found, "the blocking practice must be visible in the list").toBeDefined();
      expect(found.name.toLowerCase()).toContain(name.toLowerCase());
    });

    it("includeArchived semantics preserved: a soft-deleted child practice is hidden by default but shown with includeArchived", async () => {
      const { access, labId } = await makeOwnerLab();
      const name = rid("ArchPractice");
      const create = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send(practiceBody(name, labId));
      expect(create.status).toBe(201);
      const practiceId = create.body.data.id;
      createdOrgIds.push(practiceId);

      const { db, organizations } = dbMod as any;
      await db
        .update(organizations)
        .set({ deletedAt: new Date(), isActive: false })
        .where(eq(organizations.id, practiceId));

      const active = await request(appMod.default)
        .get("/api/organizations?includeLabPractices=true")
        .set("Authorization", `Bearer ${access}`);
      expect(active.status).toBe(200);
      expect(
        (active.body.data ?? []).some((o: any) => o.id === practiceId)
      ).toBe(false);

      const archived = await request(appMod.default)
        .get("/api/organizations?includeArchived=true&includeLabPractices=true")
        .set("Authorization", `Bearer ${access}`);
      expect(archived.status).toBe(200);
      expect(
        (archived.body.data ?? []).some((o: any) => o.id === practiceId)
      ).toBe(true);
    });

    it("includeLabPractices ignores labs where the caller is only a non-admin member (no cross-tenant leak)", async () => {
      const { access: ownerAccess, labId } = await makeOwnerLab();
      const name = rid("NonAdminHidden");
      const create = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${ownerAccess}`)
        .send(practiceBody(name, labId));
      expect(create.status).toBe(201);
      const practiceId = create.body.data.id;
      createdOrgIds.push(practiceId);

      // A second user who is a plain "user" member (NOT admin/owner) of the lab.
      const memberId = rid("plainmember");
      const { db, users, organizationMemberships, userSessions } = dbMod as any;
      await db.insert(users).values({
        id: memberId,
        username: `pm_${memberId}`,
        password: "doesnotmatter",
      });
      await db.insert(organizationMemberships).values({
        labId,
        userId: memberId,
        role: "user",
        status: "active",
      });
      const { access: memberAccess } = await makeSession(memberId);

      const list = await request(appMod.default)
        .get("/api/organizations?includeLabPractices=true")
        .set("Authorization", `Bearer ${memberAccess}`);
      expect(list.status).toBe(200);
      const orgs: any[] = list.body.data ?? [];
      expect(orgs.some((o: any) => o.id === labId)).toBe(true);
      expect(orgs.some((o: any) => o.id === practiceId)).toBe(false);

      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.userId, memberId));
      await db.delete(userSessions).where(eq(userSessions.userId, memberId));
      await db.delete(users).where(eq(users.id, memberId));
    });

    it("newly created practice appears immediately under includeArchived=true&includeLabPractices=true (the Customer Center query)", async () => {
      const { access, labId } = await makeOwnerLab();
      const name = rid("ImmediateVisible");
      const create = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send(practiceBody(name, labId));
      expect(create.status).toBe(201);
      const practiceId = create.body.data.id;
      createdOrgIds.push(practiceId);

      const list = await request(appMod.default)
        .get("/api/organizations?includeArchived=true&includeLabPractices=true")
        .set("Authorization", `Bearer ${access}`);
      expect(list.status).toBe(200);
      const orgs: any[] = list.body.data ?? [];
      expect(orgs.some((o: any) => o.id === practiceId)).toBe(true);
    });
  });

  // ── Case-history doctor adoption (Task #2688) ─────────────────────────────
  // Adding a case-history (virtual) doctor to a practice must actually stick:
  // create/reuse a provider account + active membership, MOVE the doctor's
  // cases + invoices from the source practice into the destination, clear any
  // "Unassigned doctors" exclusion, and never duplicate an existing provider.
  // Also: a parent-lab admin must be able to read a provider practice's members.
  describe("case-history doctor adoption", () => {
    // Provider accounts created by the adopt flow aren't tracked by the
    // suite-level cleanup (which only knows about ownerId/providerUserId), so
    // remove them (and their memberships / holding-area rows) here.
    const createdDoctorUserIds: string[] = [];

    async function cleanupDoctorUsers() {
      if (!createdDoctorUserIds.length) return;
      const {
        db,
        organizationMemberships,
        userSessions,
        users,
        labUnassignedDoctors,
      } = dbMod as any;
      for (const uid of createdDoctorUserIds) {
        await db
          .delete(organizationMemberships)
          .where(eq(organizationMemberships.userId, uid));
        await db.delete(userSessions).where(eq(userSessions.userId, uid));
        await db
          .delete(labUnassignedDoctors)
          .where(eq(labUnassignedDoctors.userId, uid));
        await db.delete(users).where(eq(users.id, uid));
      }
      createdDoctorUserIds.length = 0;
    }

    afterEach(async () => {
      if (!SHOULD_RUN) return;
      await cleanupDoctorUsers();
    });

    async function makePractice(
      access: string,
      labId: string,
      name: string
    ): Promise<string> {
      const create = await request(appMod.default)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${access}`)
        .send(practiceBody(name, labId));
      expect(create.status).toBe(201);
      const id = create.body.data.id;
      createdOrgIds.push(id);
      return id;
    }

    async function makeCase(
      access: string,
      labId: string,
      providerId: string,
      doctorName: string
    ): Promise<string> {
      const r = await request(appMod.default)
        .post("/api/cases")
        .set("Authorization", `Bearer ${access}`)
        .send({
          caseNumber: rid("ADOPT"),
          labOrganizationId: labId,
          providerOrganizationId: providerId,
          patientFirstName: "Adopt",
          patientLastName: "Patient",
          doctorName,
          status: "received",
          confirmNewDoctor: true,
        });
      expect(r.status, "case creation should succeed").toBe(201);
      return r.body.data.id;
    }

    it("eligible-doctors surfaces a case-history doctor with its source practice + case count", async () => {
      const { access, labId } = await makeOwnerLab();
      const sourceId = await makePractice(access, labId, rid("AdoptSrcA"));
      const destId = await makePractice(access, labId, rid("AdoptDstA"));
      const doctorName = `Dr. ${rid("Elig")}`;
      await makeCase(access, labId, sourceId, doctorName);
      await makeCase(access, labId, sourceId, doctorName);

      const elig = await request(appMod.default)
        .get(`/api/organizations/${destId}/eligible-doctors`)
        .set("Authorization", `Bearer ${access}`);
      expect(elig.status).toBe(200);
      const row = (elig.body.data ?? []).find(
        (d: any) => d.virtual && d.doctorName === doctorName
      );
      expect(row, "case-history doctor should be listed").toBeDefined();
      expect(row.sourceOrganizationId).toBe(sourceId);
      expect(row.caseCount).toBe(2);
    });

    it("adopting a case-history doctor persists: creates a member and moves cases + invoices", async () => {
      const { access, labId } = await makeOwnerLab();
      const sourceId = await makePractice(access, labId, rid("AdoptSrcB"));
      const destId = await makePractice(access, labId, rid("AdoptDstB"));
      const doctorName = `Dr. ${rid("Move")}`;
      const caseA = await makeCase(access, labId, sourceId, doctorName);
      const caseB = await makeCase(access, labId, sourceId, doctorName);

      const adopt = await request(appMod.default)
        .post(`/api/organizations/${destId}/doctors/adopt`)
        .set("Authorization", `Bearer ${access}`)
        .send({ doctorName, sourceOrganizationId: sourceId });
      expect(adopt.status).toBe(201);
      expect(adopt.body.data.casesMoved).toBe(2);
      expect(adopt.body.data.invoicesMoved).toBeGreaterThanOrEqual(1);
      const doctorUserId = adopt.body.data.userId;
      createdDoctorUserIds.push(doctorUserId);

      // Membership persists on refetch (as the lab admin — see authz test).
      const members = await request(appMod.default)
        .get(`/api/organizations/${destId}/members`)
        .set("Authorization", `Bearer ${access}`);
      expect(members.status).toBe(200);
      expect(
        (members.body.data ?? []).some((m: any) => m.userId === doctorUserId)
      ).toBe(true);

      // Cases + invoices now point at the destination practice.
      const { db, cases: casesTable, invoices } = dbMod as any;
      const movedCases = await db
        .select()
        .from(casesTable)
        .where(inArray(casesTable.id, [caseA, caseB]));
      for (const c of movedCases) {
        expect(c.providerOrganizationId).toBe(destId);
      }
      const movedInvoices = await db
        .select()
        .from(invoices)
        .where(inArray(invoices.caseId, [caseA, caseB]));
      for (const inv of movedInvoices) {
        expect(inv.providerOrganizationId).toBe(destId);
      }

      // Source no longer contributes the doctor to its case-history list.
      const srcElig = await request(appMod.default)
        .get(`/api/organizations/${sourceId}/eligible-doctors`)
        .set("Authorization", `Bearer ${access}`);
      expect(srcElig.status).toBe(200);
      expect(
        (srcElig.body.data ?? []).some(
          (d: any) => d.virtual && d.doctorName === doctorName
        )
      ).toBe(false);
    });

    it("reuses an existing matching provider account instead of duplicating it", async () => {
      const { access, labId } = await makeOwnerLab();
      const sourceId = await makePractice(access, labId, rid("AdoptSrcC"));
      const destId = await makePractice(access, labId, rid("AdoptDstC"));

      // Pre-existing provider account whose name matches the case-history name.
      const existingId = rid("existingdoc");
      const { db, users } = dbMod as any;
      const firstName = rid("First");
      const lastName = rid("Last");
      await db.insert(users).values({
        id: existingId,
        username: `doc_${existingId}`,
        password: "x",
        firstName,
        lastName,
        userType: "provider",
      });
      createdDoctorUserIds.push(existingId);
      const doctorName = `${firstName} ${lastName}`;
      await makeCase(access, labId, sourceId, doctorName);

      const adopt = await request(appMod.default)
        .post(`/api/organizations/${destId}/doctors/adopt`)
        .set("Authorization", `Bearer ${access}`)
        .send({ doctorName, sourceOrganizationId: sourceId });
      expect(adopt.status).toBe(201);
      expect(adopt.body.data.userId).toBe(existingId);
      expect(adopt.body.data.createdNewAccount).toBe(false);

      // No duplicate provider account was created for that name.
      const matches = await db
        .select()
        .from(users)
        .where(
          and(
            eq(users.userType, "provider"),
            eq(users.firstName, firstName),
            eq(users.lastName, lastName)
          )
        );
      expect(matches.length).toBe(1);
    });

    it("rejects a source practice that holds none of the doctor's cases (no silent no-op)", async () => {
      const { access, labId } = await makeOwnerLab();
      const sourceId = await makePractice(access, labId, rid("AdoptSrcE"));
      const wrongId = await makePractice(access, labId, rid("AdoptWrongE"));
      const destId = await makePractice(access, labId, rid("AdoptDstE"));
      const doctorName = `Dr. ${rid("Wrong")}`;
      // Doctor's history lives at sourceId only.
      await makeCase(access, labId, sourceId, doctorName);

      const adopt = await request(appMod.default)
        .post(`/api/organizations/${destId}/doctors/adopt`)
        .set("Authorization", `Bearer ${access}`)
        .send({ doctorName, sourceOrganizationId: wrongId });
      expect(adopt.status).toBe(409);
      expect(adopt.body.details?.code).toBe("INVALID_SOURCE_PRACTICE");

      // No account/membership should have been created by the rejected call.
      const members = await request(appMod.default)
        .get(`/api/organizations/${destId}/members`)
        .set("Authorization", `Bearer ${access}`);
      expect(members.status).toBe(200);
      expect((members.body.data ?? []).length).toBe(0);
    });

    it("a parent-lab admin can read a provider practice's members (authz fix)", async () => {
      const { access, labId } = await makeOwnerLab();
      const destId = await makePractice(access, labId, rid("AdoptSrcD"));
      const doctorName = `Dr. ${rid("Authz")}`;
      await makeCase(access, labId, destId, doctorName);

      const adopt = await request(appMod.default)
        .post(`/api/organizations/${destId}/doctors/adopt`)
        .set("Authorization", `Bearer ${access}`)
        .send({ doctorName, sourceOrganizationId: destId });
      expect(adopt.status).toBe(201);
      createdDoctorUserIds.push(adopt.body.data.userId);

      // The lab owner is NOT a member of the provider practice, yet must be
      // able to read its member roster (parent-lab admin access).
      const members = await request(appMod.default)
        .get(`/api/organizations/${destId}/members`)
        .set("Authorization", `Bearer ${access}`);
      expect(members.status).toBe(200);
      const { db, organizationMemberships } = dbMod as any;
      const ownIn = await db
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.labId, destId),
            eq(organizationMemberships.userId, ownerId),
            eq(organizationMemberships.status, "active")
          )
        );
      expect(ownIn.length, "lab admin must not be a member of the practice").toBe(
        0
      );
    });
  });
});
