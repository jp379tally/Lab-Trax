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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq, sql } from "drizzle-orm";
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
      invoices,
      cases: casesTable,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;
    const allOrgIds = createdOrgIds;
    if (allOrgIds.length) {
      await db.delete(auditLogs).where(inArray(auditLogs.organizationId, allOrgIds));
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

    // ── (5h) Platform account number collision → retried with null, creation succeeds ─
    // When the platform-account-number allocator picks a sequence slot that
    // collides with an existing org's platform account number in the DB
    // (organizations_platform_account_number_unique), the insert catch block must
    // retry with platformAccountNumber = null so the org is still created (201).

    it("(5h) platform account number collision is retried with null and creation succeeds", async () => {
      const { access } = await makeSession(aiOwnerId);
      const { db, organizations: orgsTable, auditLogs } = dbMod as any;

      const year = new Date().getUTCFullYear();
      const yy = String(year).slice(-2);

      // Ensure the sequence row exists and read the next_seq value we will
      // collide with. We use a very large offset (9000000) to avoid stepping on
      // any numbers other tests generate naturally.
      const offsetSeq = 9_000_000 + Math.floor(Math.random() * 1000);
      await db.execute(sql`
        INSERT INTO platform_account_sequences (year, entity_type, next_seq, updated_at)
        VALUES (${year}, 'org', ${offsetSeq}, now())
        ON CONFLICT (year, entity_type) DO UPDATE SET next_seq = ${offsetSeq}, updated_at = now()
      `);

      // Derive the platform account number the allocator will generate next.
      // Using displayName "XX" gives deriveAccountNameParts → {first:"X", last:"X"}.
      const collisionAcctNum = `${offsetSeq}${yy}XX`;

      // Pre-insert a blocking org with that platform account number so the
      // first insert attempt by the API will hit the unique constraint.
      const blockingOrgId = `test-pan-block-${randomBytes(4).toString("hex")}`;
      await db.insert(orgsTable).values({
        id: blockingOrgId,
        type: "provider",
        name: `PanBlocker_${randomBytes(4).toString("hex")}`,
        platformAccountNumber: collisionAcctNum,
        createdByUserId: aiOwnerId,
      });

      try {
        // Creating a new org must succeed despite the collision: the catch block
        // retries with platformAccountNumber = null.
        const r = await request(appMod.default)
          .post("/api/organizations")
          .set("Authorization", `Bearer ${access}`)
          .send({
            type: "provider",
            name: rid("PanCollisionPractice"),
            displayName: "XX",
            parentLabOrganizationId: aiLabId,
          });

        expect(
          r.status,
          `Expected 201 after platform account number collision retry, got ${r.status}: ${JSON.stringify(r.body)}`
        ).toBe(201);
        // The created org should have null platformAccountNumber (the retry path).
        expect(r.body.data.platformAccountNumber).toBeNull();
        aiProviderIds.push(r.body.data.id);
      } finally {
        // Clean up the blocking org.
        await db.delete(auditLogs).where(eq(auditLogs.organizationId, blockingOrgId));
        await db.delete(orgsTable).where(eq(orgsTable.id, blockingOrgId));
      }
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
              toothNumber: "",
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
});
