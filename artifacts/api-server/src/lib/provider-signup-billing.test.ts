import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { Subscription } from "@workspace/db";

const data = vi.hoisted(() => ({
  row: {} as Record<string, any>, binding: null as Record<string, any> | null,
  updates: [] as Array<Record<string, any>>,
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args, eq: (...args: unknown[]) => args,
  isNull: (a: unknown) => a, sql: () => ({}),
}));
vi.mock("@workspace/db", () => {
  const subscriptions = { id: "sub-id", subjectType: "subjectType", subjectId: "subjectId", deletedAt: "deletedAt" };
  const providerPaymentCustomers = { id: "customer-id", providerOrganizationId: "org" };
  const select = () => ({
    from: (table: unknown) => ({
      where: () => ({
        for: async () => table === subscriptions ? [structuredClone(data.row)] : data.binding ? [structuredClone(data.binding)] : [],
        limit: async () => table === subscriptions ? [structuredClone(data.row)] : data.binding ? [structuredClone(data.binding)] : [],
      }),
    }),
  });
  const update = (table: unknown) => ({
    set: (values: any) => ({
      where: () => {
        if (table === subscriptions) Object.assign(data.row, structuredClone(values));
        else if (data.binding) Object.assign(data.binding, structuredClone(values));
        data.updates.push(structuredClone(values));
        return { returning: async () => [structuredClone(data.row)], then: (resolve: (v: unknown) => unknown) => resolve([]) };
      },
    }),
  });
  const tx = { select, update, execute: vi.fn(),
    insert: () => ({ values: async (values: any) => { data.binding = { id: "binding", ...values }; } }),
  };
  return { subscriptions, providerPaymentCustomers, db: { ...tx, transaction: async (fn: any) => fn(tx) } };
});
vi.mock("./entitlement", () => ({
  PROVIDER_PLANS: {
    free: { monthlyPriceUsd: 0 }, basic: { monthlyPriceUsd: 99 },
    standard: { monthlyPriceUsd: 149 }, premium: { monthlyPriceUsd: 199 },
  },
}));
import {
  providerSignupPlans, validateProviderPrice, selectProviderSignup,
  startProviderSignupCheckout, verifyProviderSignupCheckout, assertProviderReturnUrl,
  CARD_REUSE_WORDING,
} from "./provider-signup-billing";

const row = () => data.row as Subscription;
const price = () => ({
  id: "price_basic", active: true, currency: "usd", unit_amount: 9900,
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  metadata: { planType: "provider" }, product: "prod_provider",
});
function processor() {
  const paymentMethod = { id: "pm_new", type: "card", customer: "cus_subscription", card: { brand: "visa", last4: "4242", exp_month: 1, exp_year: 2030 } };
  const subscription = { id: "sub_stripe", customer: "cus_subscription", status: "trialing", trial_start: 1_800_000_000, trial_end: 1_802_592_000,
    items: { data: [{ price: price(), quantity: 1 }] }, default_payment_method: paymentMethod };
  const session = { id: "cs_signup", url: "https://checkout.stripe.com/test", mode: "subscription", status: "open",
    customer: "cus_subscription", subscription: "sub_stripe",
    metadata: { providerSignupAttempt: "", subjectType: "provider_org", subjectId: "org_provider" } };
  const stripe = {
    prices: { retrieve: vi.fn(async () => price()) },
    customers: { create: vi.fn(async () => ({ id: "cus_subscription" })), retrieve: vi.fn(async () => ({ id: "cus_subscription", invoice_settings: { default_payment_method: "pm_existing" } })), update: vi.fn(async () => ({})) },
    checkout: { sessions: { create: vi.fn(async (params: any) => { session.metadata = params.metadata; return { ...session }; }),
      retrieve: vi.fn(async () => ({ ...session })), expire: vi.fn(async () => { session.status = "expired"; return session; }) } },
    subscriptions: { retrieve: vi.fn(async () => subscription) },
    paymentMethods: { retrieve: vi.fn(async () => paymentMethod) },
  };
  return { stripe: stripe as unknown as Stripe, mock: stripe, session, subscription, paymentMethod };
}
async function launch(stripe: Stripe) {
  return startProviderSignupCheckout({ row: row(), stripe, actorUserId: "actor", successUrl: "https://app.test/desktop/billing?checkout=success", cancelUrl: "https://app.test/desktop/billing?checkout=cancel" });
}
beforeEach(() => {
  vi.stubEnv("STRIPE_PRICE_ID_PROVIDER_BASIC_MONTHLY", "price_basic");
  data.row = { id: "signup_row", subjectType: "provider_org", subjectId: "org_provider",
    status: "onboarding_pending", providerPlan: "basic", planType: "provider", stripeCustomerId: null, stripeSubscriptionId: null,
    providerOnboardingJson: { selectedPlan: "basic", reuseCard: false, actorUserId: "actor",
      consentVersion: "provider-card-reuse-v1", consentWording: CARD_REUSE_WORDING, selectedAt: new Date().toISOString() } };
  data.binding = null; data.updates = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("provider signup billing", () => {
  it("keeps all four descriptions and prices when Stripe mappings are missing", () => {
    vi.stubEnv("STRIPE_PRICE_ID_PROVIDER_BASIC_MONTHLY", "");
    const plans = providerSignupPlans();
    expect(plans.map((p) => [p.id, p.monthlyPriceUsd])).toEqual([["free", 0], ["basic", 99], ["standard", 149], ["premium", 199]]);
    expect(plans.every((p) => p.description.length > 10)).toBe(true);
    expect(plans[0]).toMatchObject({ cardRequired: false, trialDays: 0, checkoutConfigured: true });
    expect(plans[1].checkoutConfigured).toBe(false);
  });
  it.each([
    { change: { currency: "eur" } }, { change: { unit_amount: 100 } },
    { change: { recurring: { interval: "year", interval_count: 1, usage_type: "licensed" } } },
    { change: { recurring: { interval: "month", interval_count: 2, usage_type: "licensed" } } },
    { change: { metadata: { planType: "lab" } } }, { change: { active: false } },
    { change: { id: "price_arbitrary" } },
  ])("rejects an incompatible or arbitrary price: $change", ({ change }) => {
    expect(() => validateProviderPrice({ ...price(), ...change } as unknown as Stripe.Price, "basic")).toThrow("not correctly configured");
  });
  it("creates mandatory hosted card collection with one exact 30-day trial", async () => {
    const { stripe, mock } = processor();
    await launch(stripe);
    const [params] = mock.checkout.sessions.create.mock.calls[0]!;
    expect(params).toMatchObject({ mode: "subscription", payment_method_collection: "always", payment_method_types: ["card"],
      subscription_data: { trial_period_days: 30 }, line_items: [{ price: "price_basic", quantity: 1 }] });
    expect(data.row.status).toBe("onboarding_pending");
    await launch(stripe);
    expect(mock.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });
  it("retries ambiguous creation with the same immutable parameters and idempotency key", async () => {
    const { stripe, mock } = processor();
    mock.checkout.sessions.create.mockRejectedValueOnce(new Error("network timeout"));
    await expect(launch(stripe)).rejects.toThrow("network timeout");
    const saved = structuredClone(data.row.providerOnboardingJson);
    await launch(stripe);
    expect(mock.checkout.sessions.create.mock.calls[0]).toEqual(mock.checkout.sessions.create.mock.calls[1]);
    expect(data.row.providerOnboardingJson.attempt.id).toBe(saved.attempt.id);
  });
  it("never discards an uncertain attempt to silently select Free", async () => {
    const { stripe, mock } = processor();
    mock.checkout.sessions.create.mockRejectedValueOnce(new Error("timeout"));
    await expect(launch(stripe)).rejects.toThrow();
    await expect(selectProviderSignup(row(), "free", false, "actor", stripe)).rejects.toThrow("uncertain");
    expect(data.row.status).toBe("onboarding_pending");
  });
  it("requires confirmed card collection, not a return URL or open session", async () => {
    const { stripe, session } = processor();
    await launch(stripe);
    expect(await verifyProviderSignupCheckout(row(), stripe)).toBe(false);
    session.status = "complete";
    session.customer = "cus_other";
    await expect(verifyProviderSignupCheckout(row(), stripe)).rejects.toThrow("does not belong");
    expect(data.row.status).toBe("onboarding_pending");
  });
  it("records the verified tier/dates without exposing an opted-out card", async () => {
    const { stripe, session, mock } = processor();
    await launch(stripe); session.status = "complete";
    expect(await verifyProviderSignupCheckout(row(), stripe)).toBe(true);
    expect(data.row).toMatchObject({ status: "trialing", providerPlan: "basic", paymentMethodOnFile: true, stripeSubscriptionId: "sub_stripe" });
    expect(data.row.trialEndAt.getTime() - data.row.trialStartAt.getTime()).toBe(30 * 86_400_000);
    expect(data.binding).toBeNull();
    expect(mock.customers.update).not.toHaveBeenCalled();
    await verifyProviderSignupCheckout(row(), stripe);
    expect(mock.customers.update).not.toHaveBeenCalled();
    await expect(selectProviderSignup(row(), "free", false, "actor", stripe)).rejects.toThrow("existing subscription");
  });
  it("opt-in publishes only safe masked details and never enables auto-pay", async () => {
    data.row.providerOnboardingJson.reuseCard = true;
    const { stripe, session, mock } = processor();
    await launch(stripe); session.status = "complete";
    await verifyProviderSignupCheckout(row(), stripe);
    expect(data.binding).toMatchObject({ authorizedPaymentMethodId: "pm_new", cardLast4: "4242", cardBrand: "visa" });
    expect(data.binding).not.toHaveProperty("invoiceAutoPayEnabled");
    expect(data.row.providerOnboardingJson).toMatchObject({ consentWording: CARD_REUSE_WORDING, actorUserId: "actor", consentVersion: "provider-card-reuse-v1", reuseVerifiedAt: expect.any(String) });
    await verifyProviderSignupCheckout(row(), stripe);
    expect(mock.customers.update).toHaveBeenCalledTimes(1);
  });
  it("opt-out preserves an existing authorized provider card even on the shared customer", async () => {
    data.binding = { id: "binding", stripeCustomerId: "cus_subscription", authorizedPaymentMethodId: null, cardLast4: "1111" };
    const { stripe, session } = processor();
    await launch(stripe);
    expect(data.binding.authorizedPaymentMethodId).toBe("pm_existing");
    session.status = "complete"; await verifyProviderSignupCheckout(row(), stripe);
    expect(data.binding).toMatchObject({ authorizedPaymentMethodId: "pm_existing", cardLast4: "1111" });
  });
  it("rejects mismatched trial dates and unattached cards", async () => {
    const { stripe, session, subscription, paymentMethod } = processor();
    await launch(stripe); session.status = "complete";
    subscription.trial_end += 1;
    await expect(verifyProviderSignupCheckout(row(), stripe)).rejects.toThrow("expected provider trial");
    subscription.trial_end -= 1; paymentMethod.customer = "cus_other";
    expect(await verifyProviderSignupCheckout(row(), stripe)).toBe(false);
  });
  it("expires known open checkout before explicitly switching to Free", async () => {
    const { stripe, mock } = processor();
    await launch(stripe);
    await selectProviderSignup(row(), "free", false, "actor", stripe);
    expect(mock.checkout.sessions.expire).toHaveBeenCalledTimes(1);
    expect(data.row).toMatchObject({ status: "free", providerPlan: "free", billingInterval: null });
    expect(data.row.providerOnboardingJson.attempt).toBeUndefined();
  });
  it("rejects external and sensitive return destinations", () => {
    expect(() => assertProviderReturnUrl("https://evil.test/desktop/billing", "https://app.test", "/desktop/billing")).toThrow();
    expect(() => assertProviderReturnUrl("labtrax://settings/subscriptions", "https://app.test", "/desktop/billing")).toThrow();
    expect(assertProviderReturnUrl("https://app.test/api/billing/mobile-return?checkout=success&session_id=secret", "https://app.test", "/desktop/billing")).toBe("https://app.test/api/billing/mobile-return?checkout=success");
    expect(assertProviderReturnUrl("https://app.test/api/billing/mobile-return?checkout=cancel&platform=web&session_id=secret", "https://app.test", "/desktop/billing")).toBe("https://app.test/api/billing/mobile-return?checkout=cancel&platform=web");
  });
});
