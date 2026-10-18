/**
 * Integration tests for the "join an existing practice" sign-up flow
 * (provider counterpart of join-lab-flow.test.ts — regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - GET /api/practices/lookup is public, returns only active non-deleted
 *    provider orgs, includes parentLabName, and never leaks labs or
 *    inactive/deleted practices.
 *  - POST /api/auth/register with joinOrganizationId targeting a practice
 *    creates a pending join request and NO membership.
 *  - Parent-lab admin fallback: an admin of the practice's parent lab can
 *    list/approve/reject its join requests ONLY while the practice has no
 *    active admin/owner member of its own; once it does, the fallback closes.
 *  - Cross-tenant guard: an unrelated lab's admin can never act on the
 *    practice's join requests.
 *  - GET /api/auth/lab-team surfaces adminless child-practice join requests
 *    to the parent-lab admin, labeled organizationType "provider".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-practicejoin"),
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

maybe("Join-a-practice flow (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  // Admin/owner of the parent lab that owns the practices below.
  const labOwnerId = rid("u");
  // The provider asking to join a practice — no membership anywhere.
  const requesterId = rid("req");
  // A user who becomes the practice's own admin (closes the lab fallback).
  const practiceAdminId = rid("pa");
  // Owner of a completely separate lab (cross-tenant guard).
  const otherOwnerId = rid("ou");

  const createdOrgIds: string[] = [];
  const allUserIds = [labOwnerId, requesterId, practiceAdminId, otherOwnerId];
  // Users created through POST /api/auth/register inside tests.
  const registeredUserIds: string[] = [];

  // Unique per-run marker so lookup searches only ever match our own rows.
  const marker = randomBytes(4).toString("hex");

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
      .send(labBody(rid("PJLab")));
    expect(r.status).toBe(201);
    const labId = r.body.data.id;
    createdOrgIds.push(labId);
    return labId;
  }

  // Directly insert a provider (practice) org, the same shape a lab admin
  // creates through the practices page. Keeps the test independent of that
  // route's own validation.
  async function createPractice(opts: {
    name: string;
    parentLabOrganizationId?: string | null;
    isActive?: boolean;
    deletedAt?: Date | null;
  }): Promise<string> {
    const { db, organizations } = dbMod as any;
    const [row] = await db
      .insert(organizations)
      .values({
        type: "provider",
        name: opts.name,
        city: "Testville",
        state: "TS",
        addressLine1: "9 Practice Way",
        phone: "555-333-4444",
        parentLabOrganizationId: opts.parentLabOrganizationId ?? null,
        isActive: opts.isActive ?? true,
        deletedAt: opts.deletedAt ?? null,
      })
      .returning();
    createdOrgIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-practicejoin";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users } = dbMod as any;
    for (const [id, name] of [
      [labOwnerId, "owner"],
      [requesterId, "requester"],
      [practiceAdminId, "padmin"],
      [otherOwnerId, "other"],
    ] as const) {
      await db.insert(users).values({
        id,
        username: `${name}_${id}`.slice(0, 40),
        password: "x",
        email: `${id}@test.local`,
      });
    }
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      notifications,
      organizationJoinRequests,
      organizationMemberships,
      organizations,
      userSessions,
      users,
      emailVerificationCodes,
    } = dbMod as any;
    const cleanupUserIds = [...allUserIds, ...registeredUserIds];
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
    if (cleanupUserIds.length) {
      await db
        .delete(organizationJoinRequests)
        .where(inArray(organizationJoinRequests.userId, cleanupUserIds));
      await db
        .delete(notifications)
        .where(inArray(notifications.userId, cleanupUserIds));
      await db
        .delete(auditLogs)
        .where(inArray(auditLogs.userId, cleanupUserIds));
      await db
        .delete(organizationMemberships)
        .where(inArray(organizationMemberships.userId, cleanupUserIds));
      await db
        .delete(userSessions)
        .where(inArray(userSessions.userId, cleanupUserIds));
      if (emailVerificationCodes) {
        await db
          .delete(emailVerificationCodes)
          .where(
            inArray(emailVerificationCodes.boundUserId, cleanupUserIds)
          )
          .catch(() => {});
      }
      await db.delete(users).where(inArray(users.id, cleanupUserIds));
    }
  });

  // ── public practice lookup ─────────────────────────────────────────────────

  it("GET /practices/lookup is public and returns only active, non-deleted provider orgs with parentLabName", async () => {
    const { access: ownerAccess } = await makeSession(labOwnerId);
    const labId = await createOwnedLab(ownerAccess);

    const activeId = await createPractice({
      name: `Bright Smile ${marker}`,
      parentLabOrganizationId: labId,
    });
    const inactiveId = await createPractice({
      name: `Bright Smile Inactive ${marker}`,
      parentLabOrganizationId: labId,
      isActive: false,
    });
    const deletedId = await createPractice({
      name: `Bright Smile Deleted ${marker}`,
      parentLabOrganizationId: labId,
      deletedAt: new Date(),
    });

    // No auth header — the route is public (used pre-registration).
    const res = await request(appMod.default).get(
      `/api/practices/lookup?q=${encodeURIComponent(`Bright Smile ${marker}`)}`
    );
    expect(res.status).toBe(200);
    const practices: any[] = res.body?.practices ?? [];
    const ids = practices.map((p) => p.id);
    expect(ids).toContain(activeId);
    expect(ids, "inactive practices must not be returned").not.toContain(
      inactiveId
    );
    expect(ids, "soft-deleted practices must not be returned").not.toContain(
      deletedId
    );

    const entry = practices.find((p) => p.id === activeId);
    expect(entry.displayName).toBe(`Bright Smile ${marker}`);
    expect(entry.city).toBe("Testville");
    // The parent lab is resolved so the user can disambiguate.
    expect(entry.parentLabName).toBeTruthy();
  });

  it("GET /practices/lookup never returns lab organizations and requires >= 2 chars", async () => {
    const { access: ownerAccess } = await makeSession(labOwnerId);
    const labId = await createOwnedLab(ownerAccess);
    const { db, organizations } = dbMod as any;
    const { eq } = await import("drizzle-orm");
    // Give the lab a searchable name containing our marker.
    await db
      .update(organizations)
      .set({ name: `LabOnly ${marker}` })
      .where(eq(organizations.id, labId));

    const res = await request(appMod.default).get(
      `/api/practices/lookup?q=${encodeURIComponent(`LabOnly ${marker}`)}`
    );
    expect(res.status).toBe(200);
    expect(
      (res.body?.practices ?? []).some((p: any) => p.id === labId),
      "a lab org must never appear in the practice lookup"
    ).toBe(false);

    const short = await request(appMod.default).get("/api/practices/lookup?q=a");
    expect(short.status).toBe(200);
    expect(short.body?.practices).toEqual([]);
  });

  // ── register with a practice join target ──────────────────────────────────

  it("register with joinOrganizationId = practice creates a pending join request and no membership", async () => {
    const { access: ownerAccess } = await makeSession(labOwnerId);
    const labId = await createOwnedLab(ownerAccess);
    const practiceId = await createPractice({
      name: `Reg Practice ${marker}`,
      parentLabOrganizationId: labId,
    });

    const username = `pj${randomBytes(4).toString("hex")}`.slice(0, 12);
    const reg = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username,
        password: "Str0ngPass!x",
        email: `${username}@test.local`,
        userType: "provider",
        licenseNumber: "DDS-123",
        joinOrganizationId: practiceId,
        createOrganization: false,
        clientType: "mobile",
      });
    expect(reg.status).toBe(200);
    const newUserId: string =
      reg.body?.data?.user?.id ?? reg.body?.user?.id;
    expect(newUserId).toBeTruthy();
    registeredUserIds.push(newUserId);
    const pendingFlag =
      reg.body?.data?.pendingJoinRequest ?? reg.body?.pendingJoinRequest;
    expect(pendingFlag).toBe(true);

    const { db, organizationJoinRequests, organizationMemberships } =
      dbMod as any;
    const { and, eq } = await import("drizzle-orm");
    const jr = await db
      .select()
      .from(organizationJoinRequests)
      .where(
        and(
          eq(organizationJoinRequests.userId, newUserId),
          eq(organizationJoinRequests.labId, practiceId)
        )
      );
    expect(jr.length).toBe(1);
    expect(jr[0].status).toBe("pending");

    const memberships = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.userId, newUserId));
    expect(
      memberships.length,
      "registering with a join target must NOT create a membership"
    ).toBe(0);
  });

  it("register with an inactive practice join target is rejected (404)", async () => {
    const { access: ownerAccess } = await makeSession(labOwnerId);
    const labId = await createOwnedLab(ownerAccess);
    const inactiveId = await createPractice({
      name: `Inactive Target ${marker}`,
      parentLabOrganizationId: labId,
      isActive: false,
    });

    const username = `pj${randomBytes(4).toString("hex")}`.slice(0, 12);
    const reg = await request(appMod.default)
      .post("/api/auth/register")
      .send({
        username,
        password: "Str0ngPass!x",
        email: `${username}@test.local`,
        userType: "provider",
        joinOrganizationId: inactiveId,
        createOrganization: false,
      });
    expect(reg.status).toBe(404);
  });

  // ── parent-lab admin fallback ──────────────────────────────────────────────

  it("a parent-lab admin can list and approve a join request for an adminless practice; approval grants an active practice membership", async () => {
    const { access: ownerAccess } = await makeSession(labOwnerId);
    const labId = await createOwnedLab(ownerAccess);
    const practiceId = await createPractice({
      name: `Fallback Practice ${marker}`,
      parentLabOrganizationId: labId,
    });
    const { access: requesterAccess } = await makeSession(requesterId);

    const create = await request(appMod.default)
      .post(`/api/organizations/${practiceId}/join-requests`)
      .set("Authorization", `Bearer ${requesterAccess}`)
      .send({ requestedRole: "user" });
    expect(create.status).toBe(201);
    const joinRequestId: string = create.body.data.id;

    // The parent-lab admin can list the practice's join requests.
    const list = await request(appMod.default)
      .get(`/api/organizations/${practiceId}/join-requests`)
      .set("Authorization", `Bearer ${ownerAccess}`);
    expect(list.status).toBe(200);
    expect(
      (list.body.data ?? []).some((r: any) => r.id === joinRequestId)
    ).toBe(true);

    // ...and the request also surfaces in the admin's lab-team pending list,
    // labeled as a provider org so the UI can say "practice".
    const labTeam = await request(appMod.default)
      .get("/api/auth/lab-team")
      .set("Authorization", `Bearer ${ownerAccess}`);
    expect(labTeam.status).toBe(200);
    const teamEntry = (labTeam.body.pendingJoinRequests ?? []).find(
      (p: any) => p.id === joinRequestId
    );
    expect(
      teamEntry,
      "an adminless child-practice join request must surface to the parent-lab admin"
    ).toBeTruthy();
    expect(teamEntry.organizationType).toBe("provider");
    expect(teamEntry.organizationId).toBe(practiceId);

    // The parent-lab admin approves it (fallback: practice has no admin).
    const approve = await request(appMod.default)
      .post(`/api/organizations/join-requests/${joinRequestId}/approve`)
      .set("Authorization", `Bearer ${ownerAccess}`)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.data.membership?.userId).toBe(requesterId);
    expect(approve.body.data.membership?.labId).toBe(practiceId);
    expect(approve.body.data.membership?.status).toBe("active");
  });

  it("the parent-lab fallback closes once the practice has its own active admin; the practice admin can still approve", async () => {
    const { access: ownerAccess } = await makeSession(labOwnerId);
    const labId = await createOwnedLab(ownerAccess);
    const practiceId = await createPractice({
      name: `Admined Practice ${marker}`,
      parentLabOrganizationId: labId,
    });

    // Give the practice its own active admin.
    const { db, organizationMemberships } = dbMod as any;
    await db.insert(organizationMemberships).values({
      labId: practiceId,
      userId: practiceAdminId,
      role: "admin",
      status: "active",
      joinedAt: new Date(),
    });

    const { access: requesterAccess } = await makeSession(requesterId);
    const create = await request(appMod.default)
      .post(`/api/organizations/${practiceId}/join-requests`)
      .set("Authorization", `Bearer ${requesterAccess}`)
      .send({ requestedRole: "user" });
    expect(create.status).toBe(201);
    const joinRequestId: string = create.body.data.id;

    // Parent-lab admin can no longer act — the practice has its own admin.
    const listAsLab = await request(appMod.default)
      .get(`/api/organizations/${practiceId}/join-requests`)
      .set("Authorization", `Bearer ${ownerAccess}`);
    expect(listAsLab.status).toBe(403);
    const approveAsLab = await request(appMod.default)
      .post(`/api/organizations/join-requests/${joinRequestId}/approve`)
      .set("Authorization", `Bearer ${ownerAccess}`)
      .send({});
    expect(approveAsLab.status).toBe(403);

    // The practice's own admin approves it.
    const { access: practiceAdminAccess } = await makeSession(practiceAdminId);
    const approve = await request(appMod.default)
      .post(`/api/organizations/join-requests/${joinRequestId}/approve`)
      .set("Authorization", `Bearer ${practiceAdminAccess}`)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.data.membership?.labId).toBe(practiceId);
    expect(approve.body.data.membership?.status).toBe("active");
  });

  it("an unrelated lab's admin can never act on a practice's join requests (403), and the parent-lab admin can reject via the fallback", async () => {
    const { access: ownerAccess } = await makeSession(labOwnerId);
    const labId = await createOwnedLab(ownerAccess);
    const practiceId = await createPractice({
      name: `Guarded Practice ${marker}`,
      parentLabOrganizationId: labId,
    });

    // A separate lab owned by a different tenant.
    const { access: otherAccess } = await makeSession(otherOwnerId);
    await createOwnedLab(otherAccess);

    const { access: requesterAccess } = await makeSession(requesterId);
    const create = await request(appMod.default)
      .post(`/api/organizations/${practiceId}/join-requests`)
      .set("Authorization", `Bearer ${requesterAccess}`)
      .send({ requestedRole: "user" });
    expect(create.status).toBe(201);
    const joinRequestId: string = create.body.data.id;

    // Cross-tenant admin: no list, no approve, no reject.
    const listAsOther = await request(appMod.default)
      .get(`/api/organizations/${practiceId}/join-requests`)
      .set("Authorization", `Bearer ${otherAccess}`);
    expect(listAsOther.status).toBe(403);
    const approveAsOther = await request(appMod.default)
      .post(`/api/organizations/join-requests/${joinRequestId}/approve`)
      .set("Authorization", `Bearer ${otherAccess}`)
      .send({});
    expect(approveAsOther.status).toBe(403);
    const rejectAsOther = await request(appMod.default)
      .post(`/api/organizations/join-requests/${joinRequestId}/reject`)
      .set("Authorization", `Bearer ${otherAccess}`)
      .send({});
    expect(rejectAsOther.status).toBe(403);

    // The parent-lab admin CAN reject via the adminless fallback.
    const reject = await request(appMod.default)
      .post(`/api/organizations/join-requests/${joinRequestId}/reject`)
      .set("Authorization", `Bearer ${ownerAccess}`)
      .send({});
    expect(reject.status).toBe(200);
    expect(reject.body.data.status).toBe("rejected");
  });
});
