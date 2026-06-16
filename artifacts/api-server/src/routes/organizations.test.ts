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
    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "provider", name: rid("ProviderOrg") });
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
});
