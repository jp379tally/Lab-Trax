/**
 * Integration tests for the self-serve "join a lab" flow (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - GET /api/auth/lab-team surfaces pendingJoinRequests (with requester
 *    identity + labName) ONLY to lab admins/owners, and never leaks them to
 *    non-admin members or admins of other tenants.
 *  - POST /:organizationId/join-requests → GET /join-requests/mine/pending →
 *    POST /join-requests/:id/approve grants membership.
 *  - POST /:organizationId/join-requests → DELETE /join-requests/:id cancels
 *    (removes) the pending request.
 *  - Authorization guards: a non-admin cannot approve; a user cannot cancel
 *    another user's request.
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-joinlab"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
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

maybe("Join-a-lab flow (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  // Lab owner/admin who can approve and should see pending requests.
  const ownerId = rid("u");
  // The employee asking to join — no membership in any lab.
  const requesterId = rid("req");
  // A plain (non-admin) member of the owner's lab.
  const plainMemberId = rid("pm");
  // Owner of a completely separate lab (cross-tenant leak guard).
  const otherOwnerId = rid("ou");

  const createdOrgIds: string[] = [];
  const allUserIds = [ownerId, requesterId, plainMemberId, otherOwnerId];

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

  async function createOwnedLab(access: string): Promise<string> {
    const r = await request(appMod.default)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${access}`)
      .send(labBody(rid("JoinLab")));
    expect(r.status).toBe(201);
    const labId = r.body.data.id;
    createdOrgIds.push(labId);
    return labId;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-joinlab";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users } = dbMod as any;
    await db.insert(users).values({
      id: ownerId,
      username: `owner_${ownerId}`,
      password: "x",
    });
    await db.insert(users).values({
      id: requesterId,
      username: `requester_${requesterId}`,
      password: "x",
      firstName: "Riley",
      lastName: "Requester",
      email: `${requesterId}@test.local`,
    });
    await db.insert(users).values({
      id: plainMemberId,
      username: `member_${plainMemberId}`,
      password: "x",
    });
    await db.insert(users).values({
      id: otherOwnerId,
      username: `other_${otherOwnerId}`,
      password: "x",
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      organizationJoinRequests,
      organizationMemberships,
      organizations,
      userSessions,
      users,
    } = dbMod as any;
    if (createdOrgIds.length) {
      await db
        .delete(organizationJoinRequests)
        .where(inArray(organizationJoinRequests.labId, createdOrgIds));
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
    await db
      .delete(organizationJoinRequests)
      .where(inArray(organizationJoinRequests.userId, allUserIds));
    await db.delete(auditLogs).where(inArray(auditLogs.userId, allUserIds));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, allUserIds));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, allUserIds));
    await db.delete(users).where(inArray(users.id, allUserIds));
  });

  // ── create → mine/pending → approve grants membership ─────────────────────

  it("create → mine/pending shows the request → approve grants an active membership", async () => {
    const { access: ownerAccess } = await makeSession(ownerId);
    const labId = await createOwnedLab(ownerAccess);
    const { access: requesterAccess } = await makeSession(requesterId);

    // Requester sends a join request.
    const create = await request(appMod.default)
      .post(`/api/organizations/${labId}/join-requests`)
      .set("Authorization", `Bearer ${requesterAccess}`)
      .send({ requestedRole: "user", message: "Please let me in." });
    expect(create.status).toBe(201);
    const joinRequestId: string = create.body.data.id;
    expect(joinRequestId).toBeTruthy();
    expect(create.body.data.status).toBe("pending");

    // It appears in the requester's own pending list.
    const mine = await request(appMod.default)
      .get("/api/organizations/join-requests/mine/pending")
      .set("Authorization", `Bearer ${requesterAccess}`);
    expect(mine.status).toBe(200);
    const myList: any[] = mine.body.data ?? [];
    const myReq = myList.find((r) => r.id === joinRequestId);
    expect(myReq, "requester must see their own pending request").toBeTruthy();
    expect(myReq.organizationId).toBe(labId);

    // The owner approves it.
    const approve = await request(appMod.default)
      .post(`/api/organizations/join-requests/${joinRequestId}/approve`)
      .set("Authorization", `Bearer ${ownerAccess}`)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.data.membership?.userId).toBe(requesterId);
    expect(approve.body.data.membership?.labId).toBe(labId);
    expect(approve.body.data.membership?.status).toBe("active");
    expect(approve.body.data.request?.status).toBe("approved");

    // The membership is real: it shows up in the member list.
    const members = await request(appMod.default)
      .get(`/api/organizations/${labId}/members`)
      .set("Authorization", `Bearer ${ownerAccess}`);
    expect(members.status).toBe(200);
    const memberUserIds: string[] = (members.body.data ?? []).map(
      (m: any) => m.userId
    );
    expect(memberUserIds).toContain(requesterId);

    // The requester no longer has a pending request.
    const mineAfter = await request(appMod.default)
      .get("/api/organizations/join-requests/mine/pending")
      .set("Authorization", `Bearer ${requesterAccess}`);
    expect(mineAfter.status).toBe(200);
    expect(
      (mineAfter.body.data ?? []).some((r: any) => r.id === joinRequestId)
    ).toBe(false);

    // Cleanup is handled by afterAll (membership rows are removed by labId).
  });

  // ── create → cancel removes the pending request ───────────────────────────

  it("create → cancel marks the request cancelled and removes it from mine/pending", async () => {
    const { access: ownerAccess } = await makeSession(ownerId);
    const labId = await createOwnedLab(ownerAccess);
    const { access: requesterAccess } = await makeSession(requesterId);

    const create = await request(appMod.default)
      .post(`/api/organizations/${labId}/join-requests`)
      .set("Authorization", `Bearer ${requesterAccess}`)
      .send({ requestedRole: "user" });
    expect(create.status).toBe(201);
    const joinRequestId: string = create.body.data.id;

    const cancel = await request(appMod.default)
      .delete(`/api/organizations/join-requests/${joinRequestId}`)
      .set("Authorization", `Bearer ${requesterAccess}`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe("cancelled");

    const mine = await request(appMod.default)
      .get("/api/organizations/join-requests/mine/pending")
      .set("Authorization", `Bearer ${requesterAccess}`);
    expect(mine.status).toBe(200);
    expect(
      (mine.body.data ?? []).some((r: any) => r.id === joinRequestId)
    ).toBe(false);
  });

  // ── create → reject removes the pending request ───────────────────────────

  it("an admin can reject a pending request → it disappears from lab-team and mine/pending; a non-admin cannot reject (403)", async () => {
    const { access: ownerAccess } = await makeSession(ownerId);
    const labId = await createOwnedLab(ownerAccess);
    const { access: requesterAccess } = await makeSession(requesterId);

    const create = await request(appMod.default)
      .post(`/api/organizations/${labId}/join-requests`)
      .set("Authorization", `Bearer ${requesterAccess}`)
      .send({ requestedRole: "user", message: "Let me in." });
    expect(create.status).toBe(201);
    const joinRequestId: string = create.body.data.id;
    expect(create.body.data.status).toBe("pending");

    // A non-admin member of THIS lab cannot reject (role check, not membership).
    const { db, organizationMemberships } = dbMod as any;
    await db.insert(organizationMemberships).values({
      labId,
      userId: plainMemberId,
      role: "user",
      status: "active",
      joinedAt: new Date(),
    });
    const memberSession = await makeSession(plainMemberId);
    const rejectAsMember = await request(appMod.default)
      .post(`/api/organizations/join-requests/${joinRequestId}/reject`)
      .set("Authorization", `Bearer ${memberSession.access}`)
      .send({});
    expect(rejectAsMember.status).toBe(403);

    // The request is still pending and still visible to the admin.
    const labTeamBefore = await request(appMod.default)
      .get("/api/auth/lab-team")
      .set("Authorization", `Bearer ${ownerAccess}`);
    expect(labTeamBefore.status).toBe(200);
    expect(
      (labTeamBefore.body.pendingJoinRequests ?? []).some(
        (p: any) => p.id === joinRequestId
      ),
      "a still-pending request must be visible to the admin"
    ).toBe(true);

    // The admin rejects it.
    const reject = await request(appMod.default)
      .post(`/api/organizations/join-requests/${joinRequestId}/reject`)
      .set("Authorization", `Bearer ${ownerAccess}`)
      .send({});
    expect(reject.status).toBe(200);
    expect(reject.body.data.status).toBe("rejected");

    // It no longer lingers in the admin's pending list.
    const labTeamAfter = await request(appMod.default)
      .get("/api/auth/lab-team")
      .set("Authorization", `Bearer ${ownerAccess}`);
    expect(labTeamAfter.status).toBe(200);
    expect(
      (labTeamAfter.body.pendingJoinRequests ?? []).some(
        (p: any) => p.id === joinRequestId
      ),
      "a rejected request must not linger in the admin's pending list"
    ).toBe(false);

    // It no longer appears in the requester's own pending list.
    const mine = await request(appMod.default)
      .get("/api/organizations/join-requests/mine/pending")
      .set("Authorization", `Bearer ${requesterAccess}`);
    expect(mine.status).toBe(200);
    expect(
      (mine.body.data ?? []).some((r: any) => r.id === joinRequestId)
    ).toBe(false);
  });

  // ── lab-team: pendingJoinRequests visibility ──────────────────────────────

  it("GET /auth/lab-team returns pendingJoinRequests with requester identity + labName to the lab owner", async () => {
    const { access: ownerAccess } = await makeSession(ownerId);
    const labId = await createOwnedLab(ownerAccess);
    const { access: requesterAccess } = await makeSession(requesterId);

    const create = await request(appMod.default)
      .post(`/api/organizations/${labId}/join-requests`)
      .set("Authorization", `Bearer ${requesterAccess}`)
      .send({ requestedRole: "user", message: "Hire me" });
    expect(create.status).toBe(201);
    const joinRequestId: string = create.body.data.id;

    const labTeam = await request(appMod.default)
      .get("/api/auth/lab-team")
      .set("Authorization", `Bearer ${ownerAccess}`);
    expect(labTeam.status).toBe(200);
    const pending: any[] = labTeam.body.pendingJoinRequests ?? [];
    const entry = pending.find((p) => p.id === joinRequestId);
    expect(entry, "owner must see the pending join request").toBeTruthy();
    expect(entry.organizationId).toBe(labId);
    expect(entry.requestedByUserId).toBe(requesterId);
    // Requester identity is resolved for the admin UI.
    expect(entry.requesterName).toBe("Riley Requester");
    expect(entry.requesterUsername).toBe(`requester_${requesterId}`);
    expect(entry.requesterEmail).toBe(`${requesterId}@test.local`);
    // labName is the org's display/name so the admin knows which lab.
    expect(entry.labName).toBeTruthy();

    // Cancel so this request doesn't bleed into the negative cases below.
    await request(appMod.default)
      .delete(`/api/organizations/join-requests/${joinRequestId}`)
      .set("Authorization", `Bearer ${requesterAccess}`);
  });

  it("GET /auth/lab-team does NOT leak pendingJoinRequests to a non-admin member or another tenant's admin", async () => {
    const { access: ownerAccess } = await makeSession(ownerId);
    const labId = await createOwnedLab(ownerAccess);
    const { access: requesterAccess } = await makeSession(requesterId);

    // Add a plain (non-admin) member to the owner's lab.
    const { db, organizationMemberships } = dbMod as any;
    await db.insert(organizationMemberships).values({
      labId,
      userId: plainMemberId,
      role: "user",
      status: "active",
      joinedAt: new Date(),
    });

    // A separate lab owned by a different tenant.
    const { access: otherAccess } = await makeSession(otherOwnerId);
    await createOwnedLab(otherAccess);

    const create = await request(appMod.default)
      .post(`/api/organizations/${labId}/join-requests`)
      .set("Authorization", `Bearer ${requesterAccess}`)
      .send({ requestedRole: "user" });
    expect(create.status).toBe(201);
    const joinRequestId: string = create.body.data.id;

    // Non-admin member: pendingJoinRequests must be present but empty.
    const memberSession = await makeSession(plainMemberId);
    const asMember = await request(appMod.default)
      .get("/api/auth/lab-team")
      .set("Authorization", `Bearer ${memberSession.access}`);
    expect(asMember.status).toBe(200);
    expect(Array.isArray(asMember.body.pendingJoinRequests)).toBe(true);
    expect(
      (asMember.body.pendingJoinRequests ?? []).some(
        (p: any) => p.id === joinRequestId
      ),
      "a non-admin member must not see join requests"
    ).toBe(false);

    // Other tenant's admin: must not see this lab's request.
    const asOther = await request(appMod.default)
      .get("/api/auth/lab-team")
      .set("Authorization", `Bearer ${otherAccess}`);
    expect(asOther.status).toBe(200);
    expect(
      (asOther.body.pendingJoinRequests ?? []).some(
        (p: any) => p.id === joinRequestId
      ),
      "a different tenant's admin must not see this lab's join requests"
    ).toBe(false);
  });

  // ── authorization guards ──────────────────────────────────────────────────

  it("a non-admin member cannot approve a join request (403)", async () => {
    const { access: ownerAccess } = await makeSession(ownerId);
    const labId = await createOwnedLab(ownerAccess);
    const { access: requesterAccess } = await makeSession(requesterId);

    // plainMemberId is already a member of an earlier lab, but membership is
    // lab-scoped — add them to THIS lab as a non-admin so the role check (not a
    // missing-membership check) is what rejects the approval.
    const { db, organizationMemberships } = dbMod as any;
    await db.insert(organizationMemberships).values({
      labId,
      userId: plainMemberId,
      role: "user",
      status: "active",
      joinedAt: new Date(),
    });

    const create = await request(appMod.default)
      .post(`/api/organizations/${labId}/join-requests`)
      .set("Authorization", `Bearer ${requesterAccess}`)
      .send({ requestedRole: "user" });
    expect(create.status).toBe(201);
    const joinRequestId: string = create.body.data.id;

    const memberSession = await makeSession(plainMemberId);
    const approve = await request(appMod.default)
      .post(`/api/organizations/join-requests/${joinRequestId}/approve`)
      .set("Authorization", `Bearer ${memberSession.access}`)
      .send({});
    expect(approve.status).toBe(403);
  });

  it("a user cannot cancel another user's join request (403)", async () => {
    const { access: ownerAccess } = await makeSession(ownerId);
    const labId = await createOwnedLab(ownerAccess);
    const { access: requesterAccess } = await makeSession(requesterId);

    const create = await request(appMod.default)
      .post(`/api/organizations/${labId}/join-requests`)
      .set("Authorization", `Bearer ${requesterAccess}`)
      .send({ requestedRole: "user" });
    expect(create.status).toBe(201);
    const joinRequestId: string = create.body.data.id;

    // The owner (a different user) tries to DELETE the requester's request.
    const cancel = await request(appMod.default)
      .delete(`/api/organizations/join-requests/${joinRequestId}`)
      .set("Authorization", `Bearer ${ownerAccess}`);
    expect(cancel.status).toBe(403);

    // Clean up the still-pending request.
    await request(appMod.default)
      .delete(`/api/organizations/join-requests/${joinRequestId}`)
      .set("Authorization", `Bearer ${requesterAccess}`);
  });
});
