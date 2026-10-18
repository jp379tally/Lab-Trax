import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbRows: [] as Array<Record<string, unknown>>,
  dbSelect: vi.fn(),
  dbUpdate: vi.fn(),
  checkoutCreate: vi.fn(),
  portalCreate: vi.fn(),
  invoiceList: vi.fn(),
  subscriptionCancel: vi.fn(),
  subscriptionUpdate: vi.fn(),
  getEntitlement: vi.fn(),
  transitionSubscription: vi.fn(),
  appendSubscriptionEvent: vi.fn(),
  writeAuditLog: vi.fn(),
  markProviderPaymentCheckoutFailed: vi.fn(),
  providerOrganizations: [] as Array<{ id: string }>,
}));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  desc: (value: unknown) => value,
  eq: (left: unknown, right: unknown) => ({ left, right }),
  isNull: (value: unknown) => ({ isNull: value }),
}));

vi.mock("@workspace/db", () => {
  const column = (name: string) => name;
  const subscriptions = {
    id: column("id"),
    subjectType: column("subjectType"),
    subjectId: column("subjectId"),
    deletedAt: column("deletedAt"),
    planType: column("planType"),
    billingInterval: column("billingInterval"),
    stripePriceId: column("stripePriceId"),
    stripeSubscriptionId: column("stripeSubscriptionId"),
    stripeCustomerId: column("stripeCustomerId"),
    revenueCatAppUserId: column("revenueCatAppUserId"),
    cancelAtPeriodEnd: column("cancelAtPeriodEnd"),
  };
  const subscriptionEvents = {
    id: column("eventId"),
    subscriptionId: column("subscriptionId"),
    eventType: column("eventType"),
    statusBefore: column("statusBefore"),
    statusAfter: column("statusAfter"),
    provider: column("provider"),
    createdAt: column("createdAt"),
  };
  const providerPaymentCustomers = {
    providerOrganizationId: column("providerOrganizationId"),
    stripeCustomerId: column("providerStripeCustomerId"),
  };

  const db = {
    select: mocks.dbSelect,
    update: mocks.dbUpdate,
  };

  return {
    db,
    subscriptions,
    subscriptionEvents,
    providerPaymentCustomers,
  };
});

vi.mock("../middlewares/auth.js", () => ({
  requireAuth: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    (req as express.Request & { auth: { userId: string } }).auth = {
      userId: "user_test",
    };
    next();
  },
}));
vi.mock("../lib/provider-signup-billing", () => ({
  findProviderSignup: vi.fn().mockResolvedValue(undefined),
  onboarding: () => null,
  providerSignupPlans: () => [],
}));

vi.mock("../lib/rbac.js", () => ({
  BILLING_ROLES: ["owner", "admin", "billing"],
  requireAnyRole: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/entitlement.js", () => ({
  getSubjectForUser: vi.fn().mockResolvedValue({
    subjectType: "user",
    subjectId: "user_test",
  }),
  getEntitlement: mocks.getEntitlement,
  startBillingTrial: vi.fn(),
  transitionSubscription: mocks.transitionSubscription,
  appendSubscriptionEvent: mocks.appendSubscriptionEvent,
}));

vi.mock("../lib/stripeClient.js", () => ({
  getUncachableStripeClient: vi.fn().mockResolvedValue({
    customers: { create: vi.fn() },
    checkout: { sessions: { create: mocks.checkoutCreate } },
    billingPortal: { sessions: { create: mocks.portalCreate } },
    invoices: { list: mocks.invoiceList },
    subscriptions: {
      cancel: mocks.subscriptionCancel,
      update: mocks.subscriptionUpdate,
    },
  }),
  constructStripeEvent: vi.fn(),
  isStripeConfigured: vi.fn().mockResolvedValue(true),
}));

vi.mock("../lib/audit.js", () => ({
  writeAuditLog: mocks.writeAuditLog,
}));

vi.mock("../lib/provider-invoice-payments.js", () => ({
  completeProviderAutoPayAttempt: vi.fn(),
  markProviderPaymentCheckoutFailed: mocks.markProviderPaymentCheckoutFailed,
  settleProviderPaymentCheckout: vi.fn(),
}));

vi.mock("../lib/provider-selection.js", () => ({
  getActiveProviderOrganizations: vi.fn(
    async () => mocks.providerOrganizations,
  ),
  chooseProviderOrganization: (
    organizations: Array<{ id: string }>,
    requestedId?: string | null,
  ) => {
    const selected = organizations.find(({ id }) => id === requestedId);
    if (!selected) {
      const error = new Error("That provider organization is not assigned to this account.") as Error & {
        statusCode: number;
      };
      error.statusCode = 403;
      throw error;
    }
    return selected;
  },
}));

import billingRouter, {
  configuredPlanTypeForPrice,
  processStripeEvent,
} from "./billing.js";

const app = express();
app.use(express.json());
app.use("/api/billing", billingRouter);
app.use(
  (
    error: Error & { statusCode?: number },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    res.status(error.statusCode ?? 500).json({ message: error.message });
  }
);

describe("subscription billing routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbRows.splice(0);
    mocks.providerOrganizations.splice(0);
    mocks.dbSelect.mockImplementation(() => ({
      from: () => ({
        where: async () => mocks.dbRows,
      }),
    }));
    mocks.dbUpdate.mockImplementation(() => ({
      set: () => ({
        where: async () => undefined,
      }),
    }));
    mocks.getEntitlement.mockResolvedValue({
      status: "trialing",
      canAccess: true,
    });
    mocks.checkoutCreate.mockResolvedValue({
      url: "https://checkout.stripe.test/session",
    });
    mocks.portalCreate.mockResolvedValue({
      url: "https://billing.stripe.test/session",
    });
    mocks.invoiceList.mockResolvedValue({ data: [] });
    mocks.subscriptionCancel.mockResolvedValue({});
    mocks.subscriptionUpdate.mockResolvedValue({});
    mocks.transitionSubscription.mockResolvedValue(undefined);
    mocks.appendSubscriptionEvent.mockResolvedValue(undefined);
    mocks.writeAuditLog.mockResolvedValue(undefined);
  });

  it("returns subscription details without running cancellation logic", async () => {
    mocks.dbRows.push({
      planType: "lab",
      billingInterval: "month",
      stripePriceId: "price_monthly",
      stripeSubscriptionId: "sub_active",
      cancelAtPeriodEnd: false,
    });

    const response = await request(app).get("/api/billing/subscription");

    expect(response.status).toBe(200);
    expect(response.body.entitlement).toMatchObject({
      status: "trialing",
      planType: "lab",
      stripePriceId: "price_monthly",
      hasStripeSubscription: true,
    });
    expect(mocks.subscriptionCancel).not.toHaveBeenCalled();
    expect(mocks.subscriptionUpdate).not.toHaveBeenCalled();
  });

  it("binds billing reads to the selected provider organization", async () => {
    mocks.providerOrganizations.push({ id: "practice-a" }, { id: "practice-b" });
    mocks.dbRows.push({
      planType: "provider",
      billingInterval: "month",
      stripePriceId: "price_provider",
      stripeSubscriptionId: "sub_practice_b",
    });

    const response = await request(app)
      .get("/api/billing/subscription")
      .set("x-provider-organization-id", "practice-b");

    expect(response.status).toBe(200);
    expect(mocks.getEntitlement).toHaveBeenCalledWith({
      subjectType: "provider_org",
      subjectId: "practice-b",
    });
  });

  it("returns mobile checkout through HTTPS without claiming payment success", async () => {
    const response = await request(app).get(
      "/api/billing/mobile-return?checkout=success",
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.text).toContain(
      "labtrax://settings/subscriptions?checkout=success",
    );
    expect(response.text).not.toContain("Subscription activated");
  });

  it("scopes configured Stripe prices to lab or provider subscriptions", () => {
    vi.stubEnv("STRIPE_PRICE_ID_LAB_MONTHLY", "price_lab");
    vi.stubEnv("STRIPE_PRICE_ID_PROVIDER_MONTHLY", "price_provider");
    expect(configuredPlanTypeForPrice("price_lab")).toBe("lab");
    expect(configuredPlanTypeForPrice("price_provider")).toBe("provider");
    expect(configuredPlanTypeForPrice("price_legacy")).toBeNull();
    vi.unstubAllEnvs();
  });

  it("rejects unauthenticated RevenueCat activation attempts", async () => {
    vi.stubEnv("REVENUECAT_WEBHOOK_SECRET", "rc-test-secret");
    const response = await request(app)
      .post("/api/billing/webhook/revenuecat")
      .send({
        event: { type: "RENEWAL", app_user_id: "forged-user" },
      });
    expect(response.status).toBe(401);
    expect(mocks.transitionSubscription).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("creates checkout with the scoped customer and return URLs", async () => {
    mocks.dbRows.push({
      id: "subscription_row",
      stripeCustomerId: "cus_checkout",
    });

    const response = await request(app)
      .post("/api/billing/checkout-session")
      .send({
        priceId: "price_monthly",
        successUrl: "https://app.test/billing/success",
        cancelUrl: "https://app.test/billing/cancel",
      });

    expect(response.status).toBe(200);
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_checkout",
        success_url: "https://app.test/billing/success",
        cancel_url: "https://app.test/billing/cancel",
      })
    );
  });

  it("uses the validated customer and requested portal return URL", async () => {
    mocks.dbRows.push({ stripeCustomerId: "cus_portal" });

    const response = await request(app)
      .post("/api/billing/portal-session")
      .send({ returnUrl: "https://app.test/settings/billing" });

    expect(response.status).toBe(200);
    expect(mocks.portalCreate).toHaveBeenCalledWith({
      customer: "cus_portal",
      return_url: "https://app.test/settings/billing",
    });
  });

  it("rejects a portal session before Stripe when the customer id is null", async () => {
    mocks.dbRows.push({ stripeCustomerId: null });

    const response = await request(app).post("/api/billing/portal-session");

    expect(response.status).toBe(400);
    expect(mocks.portalCreate).not.toHaveBeenCalled();
  });

  it("returns empty invoice history without calling Stripe for a null customer id", async () => {
    mocks.dbRows.push({ stripeCustomerId: null });

    const response = await request(app).get("/api/billing/invoices");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, invoices: [] });
    expect(mocks.invoiceList).not.toHaveBeenCalled();
  });

  it("lists invoices using the validated Stripe customer id", async () => {
    mocks.dbRows.push({ stripeCustomerId: "cus_invoices" });

    const response = await request(app).get("/api/billing/invoices?limit=7");

    expect(response.status).toBe(200);
    expect(mocks.invoiceList).toHaveBeenCalledWith({
      customer: "cus_invoices",
      limit: 7,
    });
  });

  it("uses the cancellation flag only inside the cancellation handler", async () => {
    mocks.dbRows.push({
      id: "subscription_row",
      subjectType: "user",
      subjectId: "user_test",
      stripeSubscriptionId: "sub_cancel",
    });

    const response = await request(app)
      .post("/api/billing/cancel")
      .send({ immediately: true });

    expect(response.status).toBe(200);
    expect(mocks.subscriptionCancel).toHaveBeenCalledWith("sub_cancel");
    expect(mocks.transitionSubscription).toHaveBeenCalledWith(
      "subscription_row",
      "deactivated",
      expect.objectContaining({ canceledAt: expect.any(Date) }),
      { reason: "user_canceled_immediately", userId: "user_test" }
    );
  });

  it("records an expired-trial decline as durable deactivated access", async () => {
    mocks.dbRows.push({
      id: "subscription_row",
      subjectType: "user",
      subjectId: "user_test",
      status: "trialing",
      trialEndAt: new Date(Date.now() - 1_000),
    });

    const response = await request(app).post("/api/billing/decline-renewal");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "deactivated",
      accessLevel: "read_only",
    });
    expect(mocks.transitionSubscription).toHaveBeenCalledWith(
      "subscription_row",
      "deactivated",
      undefined,
      { reason: "renewal_declined", userId: "user_test" },
    );
  });

  it("does not unlock when Stripe only completes checkout", async () => {
    mocks.dbRows.push({
      id: "subscription_row",
      subjectType: "user",
      subjectId: "user_test",
      status: "deactivated",
    });

    await processStripeEvent({
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          customer: "cus_1",
          subscription: "sub_1",
          metadata: { subjectType: "user", subjectId: "user_test" },
        },
      },
    } as any);

    expect(mocks.dbUpdate).toHaveBeenCalled();
    expect(mocks.transitionSubscription).not.toHaveBeenCalled();
  });

  it("releases an inline reservation only after Stripe cancellation", async () => {
    await processStripeEvent({
      id: "evt_payment_intent_canceled",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: "pi_canceled",
          status: "canceled",
          metadata: { providerPaymentCheckoutId: "checkout_pending" },
        },
      },
    } as any);

    expect(mocks.markProviderPaymentCheckoutFailed).toHaveBeenCalledWith(
      "checkout_pending",
      "expired",
      "stripe_payment_intent_canceled",
      "pi_canceled",
    );
  });

  it("does not unlock from an active subscription update without payment", async () => {
    mocks.dbRows.push({
      id: "subscription_row",
      subjectType: "user",
      subjectId: "user_test",
      status: "deactivated",
    });

    await processStripeEvent({
      id: "evt_subscription",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          status: "active",
          items: { data: [] },
          cancel_at_period_end: false,
        },
      },
    } as any);

    expect(mocks.transitionSubscription).not.toHaveBeenCalled();
    expect(mocks.appendSubscriptionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "stripe_subscription_updated" }),
    );
  });

  it("restores active access only after Stripe confirms invoice payment", async () => {
    mocks.dbRows.push({
      id: "subscription_row",
      subjectType: "user",
      subjectId: "user_test",
      status: "deactivated",
    });

    await processStripeEvent({
      id: "evt_invoice",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_1",
          subscription: "sub_1",
          metadata: {},
          lines: { data: [{ period: { end: 1_800_000_000 } }] },
        },
      },
    } as any);

    expect(mocks.transitionSubscription).toHaveBeenCalledWith(
      "subscription_row",
      "active",
      undefined,
      { reason: "invoice_payment_succeeded", invoiceId: "in_1" },
    );
  });
});