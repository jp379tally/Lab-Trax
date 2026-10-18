/**
 * Focused contract tests for human-only provider subscription administration.
 * Neither legacy nor provider administration may be reached with a CI secret
 * alone; the production guard is exercised by the route integration suite.
 */
import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: null as any,
  subscription: {
    id: "sub-provider",
    subjectType: "provider_org",
    subjectId: "org-provider",
    provider: "stripe",
    providerPlan: "basic",
    status: "active",
    waiverReason: null as string | null,
    waiverStartsAt: null as Date | null,
    waiverEndsAt: null as Date | null,
    waiverGrantedAt: null as Date | null,
    waiverGrantedByUserId: null as string | null,
    currentPeriodEnd: null,
    trialEndAt: null,
    canceledAt: null,
    cancelAtPeriodEnd: false,
    paymentMethodOnFile: true,
    stripeCustomerId: "cus_test",
    stripeSubscriptionId: "sub_test",
    revenueCatAppUserId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  } as any,
  organization: {
    id: "org-provider", name: "Provider", type: "provider",
    accountNumber: "old", parentLabOrganizationId: "lab-1",
    addressLine1: "123 Main St", city: "Austin", state: "TX", zip: "78701",
  } as any,
  conflict: false,
  events: [] as any[],
  audits: [] as any[],
  appendSubscriptionEvent: vi.fn(async (event) => state.events.push(event)),
  writeAuditLog: vi.fn(async (entry) => state.audits.push(entry)),
  assertCustomAccountNumberAvailable: vi.fn(async (_lab, number) => number),
}));

vi.mock("@workspace/db", () => {
  const table = (name: string) => new Proxy({ __table: name }, { get: (target, key) => key in target ? (target as any)[key] : { name: String(key) } });
  const subscriptions = table("subscriptions");
  const organizations = table("organizations");
  const subscriptionEvents = table("subscriptionEvents");
  const auditLogs = table("auditLogs");
  const users = table("users");
  const organizationMemberships = table("organizationMemberships");
  const readChain = (rows: any[]) => {
    const chain: any = { then: (resolve: any, reject?: any) => Promise.resolve(rows).then(resolve, reject) };
    for (const method of ["where", "orderBy", "limit", "offset"]) chain[method] = () => chain;
    return chain;
  };
  const db: any = {
    execute: async () => ({ rows: [] }),
    select: (fields?: any) => ({
      from: (source: any) => {
        if (fields?.total) return readChain([{ total: 1 }]);
        if (source.__table === "subscriptions") return readChain([state.subscription]);
        if (source.__table === "organizations") return readChain(state.conflict ? [{ id: "other" }] : [state.organization]);
        if (source.__table === "subscriptionEvents") return readChain(state.events);
        if (source.__table === "auditLogs") return readChain(state.audits);
        return readChain([]);
      },
    }),
    update: (source: any) => ({
      set: (values: any) => ({
        where: () => ({
          returning: async () => {
            if (source.__table === "subscriptions") {
              Object.assign(state.subscription, values);
              return [state.subscription];
            }
            Object.assign(state.organization, values);
            return [state.organization];
          },
        }),
      }),
    }),
  };
  state.db = db;
  return { db, subscriptions, organizations, organizationMemberships, subscriptionEvents, auditLogs, users };
});

vi.mock("./lib/entitlement", () => ({
  PROVIDER_PLANS: {
    basic: { monthlyPriceUsd: 99, capabilities: ["active_case_view"] },
    standard: { monthlyPriceUsd: 149, capabilities: ["active_case_view", "billing_view_pay"] },
    premium: { monthlyPriceUsd: 199, capabilities: ["active_case_view", "billing_view_pay", "lab_communication"] },
  },
  appendSubscriptionEvent: state.appendSubscriptionEvent,
}));
vi.mock("./lib/audit", () => ({ writeAuditLog: state.writeAuditLog }));
vi.mock("./lib/provider-account-number", () => ({
  withAccountNumberLock: async (_lab: string, fn: any) => fn(state.db),
  assertCustomAccountNumberAvailable: state.assertCustomAccountNumberAvailable,
}));

import { createAdminProviderSubscriptionRouter } from "./routes/admin-provider-subscriptions";

function appFor(guard: RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/provider-subscriptions", createAdminProviderSubscriptionRouter(guard));
  return app;
}

const authenticatedCreator: RequestHandler = (req: any, _res, next) => {
  req.auth = { userId: "creator-1" };
  req.user = { id: "creator-1", role: "admin" };
  next();
};
const denied: RequestHandler = (_req, res) => res.status(403).json({ error: "Platform creator/admin access required." });

describe("provider subscription administration", () => {
  beforeEach(() => {
    state.conflict = false;
    state.events.length = 0;
    state.audits.length = 0;
    state.subscription.providerPlan = "basic";
    state.subscription.status = "active";
    state.subscription.waiverReason = null;
    state.subscription.waiverStartsAt = null;
    state.subscription.waiverEndsAt = null;
    state.subscription.canceledAt = null;
    state.subscription.cancelAtPeriodEnd = false;
    state.appendSubscriptionEvent.mockClear();
    state.writeAuditLog.mockClear();
    state.assertCustomAccountNumberAvailable.mockClear();
  });

  it("allows an authenticated creator and exposes fixed plan definitions", async () => {
    const res = await request(appFor(authenticatedCreator)).get("/api/admin/provider-subscriptions");
    expect(res.status).toBe(200);
    expect(res.body.plans.map((p: any) => p.id)).toEqual(["basic", "standard", "premium"]);
    expect(res.body.items[0]).toMatchObject({
      id: "sub-provider",
      providerPlan: "basic",
      formattedAddress: "123 Main St, Austin, TX, 78701",
    });
  });

  it("denies a non-admin/secret-only caller through the injected production-equivalent guard", async () => {
    const res = await request(appFor(denied)).get("/api/admin/provider-subscriptions").set("X-Platform-Admin-Secret", "ci-secret");
    expect(res.status).toBe(403);
  });

  it("rejects non-fixed plans and invalid statuses", async () => {
    const app = appFor(authenticatedCreator);
    expect((await request(app).patch("/api/admin/provider-subscriptions/sub-provider").send({ providerPlan: "unlimited" })).status).toBe(400);
    expect((await request(app).patch("/api/admin/provider-subscriptions/sub-provider").send({ status: "made_up" })).status).toBe(400);
  });

  it("requires a waiver reason and returns the expiry and active state", async () => {
    const app = appFor(authenticatedCreator);
    expect((await request(app).put("/api/admin/provider-subscriptions/sub-provider/waiver").send({ endsAt: "2027-01-02T00:00:00Z" })).status).toBe(400);
    const res = await request(app).put("/api/admin/provider-subscriptions/sub-provider/waiver").send({
      reason: "Provider migration", startsAt: "2026-01-01T00:00:00Z", endsAt: "2027-01-02T00:00:00Z",
    });
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ waiverReason: "Provider migration", waiverActive: true, waiverEndsAt: "2027-01-02T00:00:00.000Z" });
  });

  it("propagates account-number uniqueness conflicts", async () => {
    state.assertCustomAccountNumberAvailable.mockRejectedValueOnce(Object.assign(new Error("Account number is already assigned."), { status: 409 }));
    const res = await request(appFor(authenticatedCreator))
      .patch("/api/admin/provider-subscriptions/sub-provider/account-number")
      .send({ accountNumber: "P-2026-1-5551234567" });
    // The account-number helper's conflict must be surfaced rather than hidden.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already assigned/i);
  });

  it("corrects the Customer Center number without changing provider identity", async () => {
    const providerOrganizationId = state.organization.id;
    const res = await request(appFor(authenticatedCreator))
      .patch("/api/admin/provider-subscriptions/sub-provider/account-number")
      .send({ accountNumber: "LAB-2603-BC-2" });

    expect(res.status).toBe(200);
    expect(res.body.organization).toEqual({
      id: providerOrganizationId,
      accountNumber: "LAB-2603-BC-2",
    });
    expect(state.subscription.subjectId).toBe(providerOrganizationId);
    expect(state.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "provider_subscription_account_number_corrected",
        beforeJson: expect.objectContaining({ organizationId: providerOrganizationId }),
        afterJson: expect.objectContaining({ organizationId: providerOrganizationId }),
      }),
    );
  });

  it("writes actor before/after subscription events and audit logs for mutations", async () => {
    const res = await request(appFor(authenticatedCreator))
      .patch("/api/admin/provider-subscriptions/sub-provider")
      .send({ providerPlan: "standard", status: "grace" });
    expect(res.status).toBe(200);
    expect(state.appendSubscriptionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "provider_subscription_updated",
      rawPayloadJson: expect.objectContaining({ actorUserId: "creator-1", before: expect.any(Object), after: expect.any(Object) }),
    }));
    expect(state.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      userId: "creator-1", beforeJson: expect.any(Object), afterJson: expect.any(Object),
    }));
  });

  it("keeps cancellation lifecycle fields coherent when status changes", async () => {
    const app = appFor(authenticatedCreator);
    const canceled = await request(app)
      .patch("/api/admin/provider-subscriptions/sub-provider")
      .send({ status: "canceled" });
    expect(canceled.status).toBe(200);
    expect(canceled.body.subscription).toMatchObject({
      status: "canceled",
      cancelAtPeriodEnd: false,
    });
    expect(canceled.body.subscription.canceledAt).toBeTruthy();

    const reactivated = await request(app)
      .patch("/api/admin/provider-subscriptions/sub-provider")
      .send({ status: "active" });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.subscription).toMatchObject({
      status: "active",
      canceledAt: null,
      cancelAtPeriodEnd: false,
    });
  });
});