/**
 * Real-transaction regression guard: partnerships must never replace practice
 * identity, grant access, or survive a failed account-creation transaction.
 * Fixtures are scoped to this suite; no database-wide cleanup.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { createLabLookupToken } from "../lib/lab-lookup-token";

const fault = vi.hoisted(() => ({
  auditCountdown: 0, failDelivery: false, queued: [] as string[],
}));
vi.mock("../lib/join-request-notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/join-request-notifications")>();
  return { ...actual, enqueueJoinRequestNotification: async (...args: Parameters<typeof actual.enqueueJoinRequestNotification>) => {
    fault.queued.push(args[1]);
    return actual.enqueueJoinRequestNotification(...args);
  } };
});
vi.mock("../lib/in-app-notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/in-app-notifications")>();
  return { ...actual, deliverInAppNotification: async (...args: Parameters<typeof actual.deliverInAppNotification>) => {
    await actual.deliverInAppNotification(...args);
    if (fault.failDelivery) {
      fault.failDelivery = false;
      throw new Error("injected delivery failure after insertion");
    }
  } };
});
vi.mock("../lib/entitlement", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/entitlement")>(),
  startBillingTrial: vi.fn(async () => undefined),
}));
vi.mock("../lib/match-and-invite", () => ({
  matchAndInviteCrossLabDoctors: vi.fn(async () => undefined),
  resolveLabNameForUser: vi.fn(async () => null),
}));
vi.mock("../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/audit")>();
  return { ...actual, writeAuditLogTx: async (...args: Parameters<typeof actual.writeAuditLogTx>) => {
    if (fault.auditCountdown > 0 && --fault.auditCountdown === 0) throw new Error("injected partner audit failure");
    return actual.writeAuditLogTx(...args);
  } };
});

const maybe = process.env.DATABASE_URL ? describe : describe.skip;
const unique = () => `ps${randomBytes(5).toString("hex")}`;

maybe("provider signup lab partnerships (real transactions)", () => {
  let dbMod: typeof import("@workspace/db");
  const app = express();
  const usernames: string[] = [];
  const fixtureOrgs: string[] = [];
  let lab1: string;
  let lab2: string;
  let inactiveLab: string;
  let deletedLab: string;
  let practice: string;
  let owner1: string;
  let admin2: string;
  let excluded: string[];
  let optedOut: string;
  let adminAccess: string;
  let memberAccess: string;
  const reviewUserIds: string[] = [];

  async function accessForMemberships(memberships: { labId: string; role: string }[]) {
    const { signRefreshToken, signAccessToken } = await import("../lib/auth");
    const username = unique();
    usernames.push(username);
    const [user] = await dbMod.db.insert(dbMod.users).values({
      username, password: "x", userType: "lab",
    }).returning();
    reviewUserIds.push(user.id);
    for (const membership of memberships) {
      await dbMod.db.insert(dbMod.organizationMemberships).values({
        ...membership, userId: user.id, status: "active",
      });
    }
    // Review fixtures are separate from delivery fixtures and opt out of alerts.
    await dbMod.db.insert(dbMod.systemSettings).values({
      key: `notif_prefs:${user.id}`, value: JSON.stringify({ inAppDoctorPracticeMessage: false }),
    });
    const sessionId = unique();
    await dbMod.db.insert(dbMod.userSessions).values({
      id: sessionId, userId: user.id,
      tokenHash: createHash("sha256").update(signRefreshToken(user.id, sessionId)).digest("hex"),
      expiresAt: new Date(Date.now() + 86400_000),
    });
    return signAccessToken(user.id, sessionId);
  }

  beforeAll(async () => {
    dbMod = await import("@workspace/db");
    const { default: auth } = await import("./auth");
    const { default: organizationsRouter } = await import("./organizations");
    app.use(express.json());
    app.use("/api/auth", auth);
    app.use("/api/organizations", organizationsRouter);
    app.use((err: any, _req: any, res: any, _next: any) =>
      res.status(err.statusCode ?? (err.name === "ZodError" ? 400 : 500)).json({ message: err.message }));
    for (const [type, isActive, deletedAt] of [
      ["lab", true, null], ["lab", true, null], ["lab", false, null],
      ["lab", true, new Date()], ["provider", true, null],
    ] as const) {
      const [org] = await dbMod.db.insert(dbMod.organizations).values({
        type, name: unique(), isActive, deletedAt,
      }).returning();
      fixtureOrgs.push(org.id);
    }
    [lab1, lab2, inactiveLab, deletedLab, practice] = fixtureOrgs;
    const adminIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const username = unique();
      usernames.push(username);
      const [user] = await dbMod.db.insert(dbMod.users).values({
        username, password: "unused-test-password", userType: "lab",
      }).returning();
      adminIds.push(user.id);
    }
    [owner1, admin2, optedOut] = adminIds;
    excluded = adminIds.slice(3);
    await dbMod.db.insert(dbMod.organizationMemberships).values([
      { labId: lab1, userId: owner1, role: "owner", status: "active" },
      { labId: lab2, userId: admin2, role: "admin", status: "active" },
      { labId: lab1, userId: optedOut, role: "admin", status: "active" },
      { labId: lab1, userId: excluded[0], role: "user", status: "active" },
      { labId: lab1, userId: excluded[1], role: "admin", status: "pending" },
      { labId: lab1, userId: excluded[2], role: "admin", status: "active", deletedAt: new Date() },
      { labId: practice, userId: excluded[3], role: "owner", status: "active" },
    ]);
    await dbMod.db.insert(dbMod.systemSettings).values({
      key: `notif_prefs:${optedOut}`, value: JSON.stringify({ inAppDoctorPracticeMessage: false }),
    });
    adminAccess = await accessForMemberships([{ labId: lab1, role: "owner" }, { labId: lab2, role: "admin" }]);
    // Elevated in another lab must never widen the selected lab's permission.
    memberAccess = await accessForMemberships([{ labId: lab1, role: "user" }, { labId: lab2, role: "owner" }]);
  });

  function payload(extra: Record<string, unknown> = {}) {
    const username = unique();
    usernames.push(username);
    return {
      username, email: `${username}@example.com`, password: "Password1!",
      userType: "provider", clientType: "mobile",
      createOrganization: true, practiceName: `Intended ${username}`,
      doctorName: "Dr. Example", practicePhone: "3035550100",
      address: { line1: "123 Main St", city: "Denver", state: "CO", zip: "80201" },
      ...extra,
    };
  }

  async function assertNoAccount(body: ReturnType<typeof payload>) {
    const found = await dbMod.db.select().from(dbMod.users).where(eq(dbMod.users.username, body.username));
    expect(found).toEqual([]);
    const orgs = await dbMod.db.select().from(dbMod.organizations).where(eq(dbMod.organizations.name, body.practiceName as string));
    expect(orgs).toEqual([]);
  }

  afterAll(async () => {
    if (!dbMod) return;
    const { db, users, organizations, organizationJoinRequests, organizationMemberships, auditLogs, userSessions } = dbMod;
    const registered = await db.select({ id: users.id }).from(users).where(inArray(users.username, usernames));
    const ids = registered.map((u) => u.id);
    const settingKeys = [
      ...fault.queued.map((id) => `join_request_notification:${id}`),
      ...ids.map((id) => `notif_prefs:${id}`),
    ];
    if (settingKeys.length) await db.delete(dbMod.systemSettings).where(inArray(dbMod.systemSettings.key, settingKeys));
    if (ids.length) {
      const createdOrgs = await db.select({ id: organizations.id }).from(organizations).where(inArray(organizations.createdByUserId, ids));
      const subjectIds = [...ids, ...createdOrgs.map((org) => org.id)];
      await db.delete(dbMod.subscriptionEvents).where(inArray(dbMod.subscriptionEvents.subjectId, subjectIds));
      await db.delete(dbMod.subscriptions).where(inArray(dbMod.subscriptions.subjectId, subjectIds));
      await db.delete(organizationJoinRequests).where(inArray(organizationJoinRequests.userId, ids));
      await db.delete(auditLogs).where(inArray(auditLogs.userId, ids));
      await db.delete(organizationMemberships).where(inArray(organizationMemberships.userId, ids));
      await db.delete(userSessions).where(inArray(userSessions.userId, ids));
      await db.delete(organizations).where(inArray(organizations.createdByUserId, ids));
      await db.delete(users).where(inArray(users.id, ids));
    }
    if (fixtureOrgs.length) await db.delete(organizations).where(inArray(organizations.id, fixtureOrgs));
  });

  it.each([0, 1, 2])("creates the intended practice with %i pending lab requests and no lab access", async (count) => {
    const selected = [lab1, lab2].slice(0, count);
    const body = payload({ partnerLabSelections: selected.map(createLabLookupToken) });
    const result = await request(app).post("/api/auth/register").send(body);
    expect(result.status).toBe(200);
    const { db, organizationJoinRequests, organizationMemberships, organizations, auditLogs } = dbMod;
    const requests = await db.select().from(organizationJoinRequests).where(eq(organizationJoinRequests.userId, result.body.user.id));
    expect(requests.map((r) => r.labId).sort()).toEqual(selected.sort());
    expect(requests.every((r) => r.status === "pending" && r.requestedRole === "user")).toBe(true);
    const memberships = await db.select().from(organizationMemberships).where(eq(organizationMemberships.userId, result.body.user.id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0].labId).toBe(result.body.organization.id);
    expect(selected).not.toContain(memberships[0].labId);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, result.body.organization.id));
    expect(org).toMatchObject({ type: "provider", name: body.practiceName, city: "Denver" });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.userId, result.body.user.id));
    expect(audits.filter((a) => a.action === "provider_partner_requested")).toHaveLength(count);
    for (const labId of [lab1, lab2]) {
      const listed = await request(app).get(`/api/auth/lab-team?orgId=${labId}`)
        .set("Authorization", `Bearer ${adminAccess}`);
      expect(listed.status).toBe(200);
      const pending = listed.body.pendingJoinRequests;
      expect(pending.every((r: any) => r.organizationId === labId)).toBe(true);
      const entry = pending.find((r: any) => r.requestedByUserId === result.body.user.id);
      if (selected.includes(labId)) {
        expect(entry).toMatchObject({
          id: requests.find((r) => r.labId === labId)!.id,
          requesterUsername: body.username, requesterEmail: body.email,
          requesterUserType: "provider", requesterDoctorName: body.doctorName,
          requesterPracticeName: body.practiceName, organizationType: "lab",
        });
        expect(entry.createdAt).toBeTruthy();
        expect(entry.message).toContain("partner");
      } else expect(entry).toBeUndefined();
    }
  });

  it("lists previously persisted requests without a signup replay, while enforcing selected-lab roles and unrelated-lab denial", async () => {
    const first = await request(app).get(`/api/auth/lab-team?orgId=${lab1}`)
      .set("Authorization", `Bearer ${adminAccess}`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.pendingJoinRequests.length).toBeGreaterThan(0);
    const again = await request(app).get(`/api/auth/lab-team?orgId=${lab1}`)
      .set("Authorization", `Bearer ${adminAccess}`);
    expect(again.body.pendingJoinRequests).toEqual(first.body.pendingJoinRequests);
    const member = await request(app).get(`/api/auth/lab-team?orgId=${lab1}`)
      .set("Authorization", `Bearer ${memberAccess}`);
    expect(member.status).toBe(200);
    expect(member.body.callerRole).toBe("user");
    expect(member.body.pendingJoinRequests).toEqual([]);
    const unrelated = await request(app).get(`/api/auth/lab-team?orgId=${practice}`)
      .set("Authorization", `Bearer ${adminAccess}`);
    expect(unrelated.status).toBe(403);
  });

  it("deduplicates independent lookup tokens and IDs for the same lab", async () => {
    const result = await request(app).post("/api/auth/register").send(payload({
      partnerLabSelections: [createLabLookupToken(lab1), createLabLookupToken(lab1), lab1],
    }));
    expect(result.status).toBe(200);
    const requests = await dbMod.db.select().from(dbMod.organizationJoinRequests).where(eq(dbMod.organizationJoinRequests.userId, result.body.user.id));
    expect(requests).toHaveLength(1);
    expect(requests[0].labId).toBe(lab1);
  });
  it.each(["free", "basic", "standard", "premium"])("persists %s signup without granting partner access or starting an unverified trial", async (providerPlan) => {
    const result = await request(app).post("/api/auth/register").send(payload({
      providerPlan, reuseSubscriptionCard: providerPlan === "standard",
      partnerLabSelections: [createLabLookupToken(lab1)],
    }));
    expect(result.status).toBe(200);
    const [sub] = await dbMod.db.select().from(dbMod.subscriptions).where(eq(dbMod.subscriptions.subjectId, result.body.organization.id));
    expect(sub).toMatchObject({
      subjectType: "provider_org", providerPlan, planType: "provider",
      status: providerPlan === "free" ? "free" : "onboarding_pending",
      trialStartAt: null, trialEndAt: null, stripeSubscriptionId: null, paymentMethodOnFile: false,
    });
    expect(sub.providerOnboardingJson).toMatchObject({
      actorUserId: result.body.user.id, selectedPlan: providerPlan,
      reuseCard: providerPlan === "standard", consentVersion: "provider-card-reuse-v1",
    });
    const memberships = await dbMod.db.select().from(dbMod.organizationMemberships).where(eq(dbMod.organizationMemberships.userId, result.body.user.id));
    expect(memberships.map((m) => m.labId)).not.toContain(lab1);
    const cards = await dbMod.db.select().from(dbMod.providerPaymentCustomers).where(eq(dbMod.providerPaymentCustomers.providerOrganizationId, result.body.organization.id));
    expect(cards).toEqual([]);
  });

  it("preserves matched-practice approval while saving separate lab requests", async () => {
    const result = await request(app).post("/api/auth/register").send(payload({
      createOrganization: false, joinOrganizationId: practice,
      partnerLabSelections: [createLabLookupToken(lab1), createLabLookupToken(lab2)],
    }));
    expect(result.status).toBe(200);
    expect(result.body.organization.id).toBe(practice);
    const requests = await dbMod.db.select().from(dbMod.organizationJoinRequests).where(eq(dbMod.organizationJoinRequests.userId, result.body.user.id));
    expect(requests.map((r) => r.labId).sort()).toEqual([practice, lab1, lab2].sort());
    const memberships = await dbMod.db.select().from(dbMod.organizationMemberships).where(eq(dbMod.organizationMemberships.userId, result.body.user.id));
    expect(memberships).toEqual([]);
  });

  it.each(["missing", "inactive", "deleted", "practice", "tampered", "expired"])("rejects %s targets without partially creating an account", async (kind) => {
    let selection = ({ missing: "missing-partner", inactive: inactiveLab, deleted: deletedLab, practice, tampered: "v1.invalid" } as Record<string, string>)[kind];
    if (kind === "expired") {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now - 25 * 60 * 60 * 1000);
      selection = createLabLookupToken(lab1);
      clock.mockRestore();
    }
    const body = payload({ partnerLabSelections: [createLabLookupToken(lab2), selection] });
    const result = await request(app).post("/api/auth/register").send(body);
    expect(result.status).toBe(400);
    expect(result.body.message).toMatch(/selected partner lab.*search again/i);
    await assertNoAccount(body);
  });

  it("rolls back user, practice and all requests if the second request audit fails", async () => {
    const body = payload({ partnerLabSelections: [lab1, lab2] });
    const queueStart = fault.queued.length;
    fault.auditCountdown = 2;
    const result = await request(app).post("/api/auth/register").send(body);
    expect(result.status).toBe(500);
    await assertNoAccount(body);
    const rolledBackIds = fault.queued.slice(queueStart);
    expect(rolledBackIds).toHaveLength(2);
    const outbox = await dbMod.db.select().from(dbMod.systemSettings).where(
      inArray(dbMod.systemSettings.key, rolledBackIds.map((id) => `join_request_notification:${id}`)),
    );
    expect(outbox).toEqual([]);
    const { processJoinRequestNotifications } = await import("../lib/join-request-notifications");
    expect(await processJoinRequestNotifications(rolledBackIds)).toBe(0);
    // A retry with the same credentials succeeds rather than hitting a partial user.
    const retry = await request(app).post("/api/auth/register").send(body);
    expect(retry.status).toBe(200);
    const requests = await dbMod.db.select().from(dbMod.organizationJoinRequests).where(eq(dbMod.organizationJoinRequests.userId, retry.body.user.id));
    expect(requests).toHaveLength(2);
  });

  it("delivers each lab only to its active owner/admin, honoring preferences and retrying atomically", async () => {
    const result = await request(app).post("/api/auth/register").send(payload({ partnerLabSelections: [lab1, lab2] }));
    expect(result.status).toBe(200);
    const { db, organizationJoinRequests, notifications, systemSettings } = dbMod;
    const requests = await db.select().from(organizationJoinRequests).where(eq(organizationJoinRequests.userId, result.body.user.id));
    const ids = requests.map((r) => r.id);
    const keys = [owner1, admin2, optedOut, ...excluded, ...reviewUserIds].flatMap((userId) => ids.map((id) => `join_request_pending:${id}:${userId}`));
    const alerts = () => db.select().from(notifications).where(inArray(notifications.dedupeKey, keys));
    expect(await alerts()).toEqual([]); // No delivery inside the signup transaction.
    const { processJoinRequestNotifications, enqueueJoinRequestNotification } = await import("../lib/join-request-notifications");
    const first = requests.find((r) => r.labId === lab1)!;
    fault.failDelivery = true;
    expect(await processJoinRequestNotifications([first.id])).toBe(0);
    expect(await alerts()).toEqual([]); // Partial insert rolls back with completion.
    expect(await db.select().from(systemSettings).where(eq(systemSettings.key, `join_request_notification:${first.id}`)))
      .toMatchObject([{ value: "pending" }]);
    await Promise.all([processJoinRequestNotifications(ids), processJoinRequestNotifications(ids)]);
    const delivered = await alerts();
    expect(delivered).toHaveLength(2);
    expect(delivered.map((n) => n.userId).sort()).toEqual([owner1, admin2].sort());
    for (const alert of delivered) {
      expect(alert.dataJson).toMatchObject({
        labOrganizationId: alert.userId === owner1 ? lab1 : lab2,
        reviewUrl: "/settings?tab=profile",
      });
    }
    await db.transaction(async (tx) => {
      for (const id of ids) await enqueueJoinRequestNotification(tx, id);
    });
    expect(await processJoinRequestNotifications(ids)).toBe(0);
    expect(await alerts()).toHaveLength(2);
    expect((await db.select().from(organizationJoinRequests).where(inArray(organizationJoinRequests.id, ids)))
      .every((r) => r.status === "pending")).toBe(true);
  });

  it("queues the existing join-request route and does not duplicate on repeated POST", async () => {
    const signup = await request(app).post("/api/auth/register").send(payload());
    expect(signup.status).toBe(200);
    const result = await request(app).post(`/api/organizations/${lab1}/join-requests`)
      .set("Authorization", `Bearer ${signup.body.accessToken}`)
      .send({ requestedRole: "user", message: "Please partner with my practice" });
    expect(result.status).toBe(201);
    const joinRequestId = result.body.data.id;
    expect(joinRequestId).toEqual(expect.any(String));
    const { processJoinRequestNotifications } = await import("../lib/join-request-notifications");
    expect(await processJoinRequestNotifications([joinRequestId])).toBe(1);
    const repeated = await request(app).post(`/api/organizations/${lab1}/join-requests`)
      .set("Authorization", `Bearer ${signup.body.accessToken}`).send({ requestedRole: "user" });
    expect(repeated.status).toBe(409);
    const alerts = await dbMod.db.select().from(dbMod.notifications).where(and(
      eq(dbMod.notifications.userId, owner1),
      eq(dbMod.notifications.dedupeKey, `join_request_pending:${joinRequestId}:${owner1}`),
    ));
    expect(alerts).toHaveLength(1);
  });

  it("rejects employee partner intent and oversized collections before account creation", async () => {
    for (const extra of [{ userType: "lab", partnerLabSelections: [lab1] }, { partnerLabSelections: Array(21).fill(lab1) }]) {
      const body = payload(extra);
      const result = await request(app).post("/api/auth/register").send(body);
      expect(result.status).toBe(400);
      await assertNoAccount(body);
    }
  });
});
