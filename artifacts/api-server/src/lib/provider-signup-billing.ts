import { and, eq, isNull, sql } from "drizzle-orm";
import { db, subscriptions, providerPaymentCustomers } from "@workspace/db";
import type { Subscription } from "@workspace/db";
import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { HttpError } from "./http";
import { PROVIDER_PLANS, type ProviderPlan } from "./entitlement";

export const CARD_REUSE_WORDING = "Do you want to save this for future lab bill payments or other financial transactions within LabTrax?";
export const CARD_REUSE_VERSION = "provider-card-reuse-v1";
export const PROVIDER_TRIAL_DAYS = 30;
const descriptions = {
  free: "Permanent read-only access to cases shared by approved partner labs.",
  basic: "View active cases shared by approved partner labs.",
  standard: "View active cases and view and pay online lab bills.",
  premium: "All provider features, including lab communication.",
};
export function providerPriceId(plan: ProviderPlan): string | undefined {
  return plan === "free" ? undefined : process.env[`STRIPE_PRICE_ID_PROVIDER_${plan.toUpperCase()}_MONTHLY`];
}
export function providerSignupPlans() {
  return Object.entries(PROVIDER_PLANS).map(([id, plan]) => ({
    id, name: id.charAt(0).toUpperCase() + id.slice(1),
    monthlyPriceUsd: plan.monthlyPriceUsd,
    description: descriptions[id as ProviderPlan],
    currency: "usd", interval: id === "free" ? null : "month",
    cardRequired: id !== "free", trialDays: id === "free" ? 0 : PROVIDER_TRIAL_DAYS,
    checkoutConfigured: id === "free" || Boolean(providerPriceId(id as ProviderPlan)),
  }));
}
export function validateProviderPrice(price: Stripe.Price, plan: ProviderPlan) {
  const product = price.product;
  const type = price.metadata?.planType ??
    (typeof product === "object" && !product.deleted ? product.metadata?.planType : undefined);
  if (plan === "free" || price.id !== providerPriceId(plan) || !price.active ||
      price.currency !== "usd" || price.unit_amount !== PROVIDER_PLANS[plan].monthlyPriceUsd * 100 ||
      price.recurring?.interval !== "month" || price.recurring.interval_count !== 1 ||
      price.recurring.usage_type !== "licensed" || type !== "provider") {
    throw new HttpError(503, "This provider plan's Stripe price is not correctly configured. Retry later or explicitly choose Free.");
  }
}
type Attempt = {
  id: string; createdAt: string; plan: ProviderPlan; priceId: string;
  sessionId?: string; params?: Stripe.Checkout.SessionCreateParams;
  verifiedAt?: string; expiredAt?: string;
};
export type ProviderOnboarding = {
  selectedPlan: ProviderPlan; reuseCard: boolean; consentVersion: string;
  consentWording: string; actorUserId: string; selectedAt: string;
  attempt?: Attempt; reuseVerifiedAt?: string;
};
export function onboarding(row: Subscription): ProviderOnboarding | null {
  return row.providerOnboardingJson as ProviderOnboarding | null;
}
const whereSubject = (type: string, id: string) => and(
  eq(subscriptions.subjectType, type), eq(subscriptions.subjectId, id), isNull(subscriptions.deletedAt),
);
export async function findProviderSignup(type: string, id: string) {
  const [row] = await db.select().from(subscriptions).where(whereSubject(type, id)).limit(1);
  return row;
}
export function assertProviderReturnUrl(value: unknown, origin: string, fallback: string): string {
  if (value === undefined) return new URL(fallback, origin).href;
  if (typeof value !== "string") throw new HttpError(400, "Invalid checkout return destination.");
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, "Invalid checkout return destination."); }
  if (url.origin !== origin || !["/desktop/billing", "/api/billing/mobile-return", "/settings/subscriptions"].includes(url.pathname)) {
    throw new HttpError(400, "Invalid checkout return destination.");
  }
  // Return hints never carry processor identifiers or confer authority.
  const result = new URL(url.pathname, origin);
  const checkout = url.searchParams.get("checkout");
  if (checkout === "success" || checkout === "cancel") result.searchParams.set("checkout", checkout);
  if (url.pathname === "/api/billing/mobile-return" && url.searchParams.get("platform") === "web") result.searchParams.set("platform", "web");
  return result.href;
}
export function providerSignupReturnOrigin(requestOrigin: string): string {
  const configured = (process.env.PROVIDER_PAYMENT_RETURN_ORIGINS ?? "").split(",").filter(Boolean);
  const valid = configured.map((value) => {
    try { const url = new URL(value.trim()); return url.protocol === "https:" ? url.origin : null; }
    catch { return null; }
  }).filter((value): value is string => value !== null);
  if (valid.includes(requestOrigin)) return requestOrigin;
  if (valid[0]) return valid[0];
  if (process.env.NODE_ENV === "production") throw new HttpError(503, "Approved subscription return origins are not configured.");
  return requestOrigin;
}
export async function selectProviderSignup(row: Subscription, plan: ProviderPlan, reuseCard: boolean, actorUserId: string, stripe: Stripe | null) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(subscriptions).where(eq(subscriptions.id, row.id)).for("update");
    const state = onboarding(current);
    if (!state || current.stripeSubscriptionId || !["free", "onboarding_pending"].includes(current.status)) {
      throw new HttpError(409, "An existing subscription cannot be changed through signup.");
    }
    if (state.attempt && !state.attempt.expiredAt) {
      if (state.selectedPlan === plan && state.reuseCard === reuseCard) return current;
      if (!stripe || !state.attempt.sessionId) {
        throw new HttpError(409, "A checkout outcome is still uncertain. Retry the selected plan before changing it.");
      }
      const session = await stripe.checkout.sessions.retrieve(state.attempt.sessionId);
      if (session.status === "complete") throw new HttpError(409, "Checkout completed. Refresh to verify it before making changes.");
      if (session.status !== "expired") await stripe.checkout.sessions.expire(session.id);
    }
    const [updated] = await tx.update(subscriptions).set({
      status: plan === "free" ? "free" : "onboarding_pending", providerPlan: plan,
      billingInterval: plan === "free" ? null : "month",
      providerOnboardingJson: {
        selectedPlan: plan, reuseCard: plan !== "free" && reuseCard, consentVersion: CARD_REUSE_VERSION,
        consentWording: CARD_REUSE_WORDING, actorUserId, selectedAt: new Date().toISOString(),
      },
    }).where(eq(subscriptions.id, row.id)).returning();
    return updated;
  });
}

export async function startProviderSignupCheckout(input: {
  row: Subscription; stripe: Stripe; actorUserId: string; successUrl: string; cancelUrl: string;
}) {
  const { stripe, actorUserId } = input;
  let row = input.row;
  let state = onboarding(row)!;
  if (!state || state.selectedPlan === "free") throw new HttpError(400, "Select a paid provider plan first.");
  if (row.subjectType !== "provider_org" || row.planType !== "provider") {
    throw new HttpError(409, "A provider practice billing account must be established before collecting a subscription card. Free remains available.");
  }
  if (row.stripeSubscriptionId) throw new HttpError(409, "Checkout is already confirmed. Refresh your subscription.");
  const priceId = providerPriceId(state.selectedPlan);
  if (!priceId) throw new HttpError(503, "Paid checkout is not configured for this plan. Retry later or explicitly choose Free.");
  validateProviderPrice(await stripe.prices.retrieve(priceId, { expand: ["product"] }), state.selectedPlan);
  // Reserve BEFORE contacting Stripe. An exception is ambiguous, never a
  // terminal failure. Repeated calls use the same immutable Stripe parameters.
  row = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(subscriptions).where(eq(subscriptions.id, row.id)).for("update");
    const selected = onboarding(current)!;
    if (current.stripeSubscriptionId || current.status !== "onboarding_pending") throw new HttpError(409, "Refresh your subscription before retrying checkout.");
    if (selected.selectedPlan !== state.selectedPlan || selected.reuseCard !== state.reuseCard) throw new HttpError(409, "Plan selection changed. Refresh and retry.");
    if (selected.attempt && !selected.attempt.expiredAt) return current;
    const next = { ...selected, attempt: { id: randomUUID(), createdAt: new Date().toISOString(), plan: selected.selectedPlan, priceId } };
    const [updated] = await tx.update(subscriptions).set({ providerOnboardingJson: next }).where(eq(subscriptions.id, row.id)).returning();
    return updated;
  });
  state = onboarding(row)!;
  const attempt = state.attempt!;
  if (attempt.sessionId) {
    const session = await stripe.checkout.sessions.retrieve(attempt.sessionId);
    if (session.status === "complete") {
      await verifyProviderSignupCheckout(row, stripe);
      throw new HttpError(409, "Checkout completed. Refresh your subscription.");
    }
    if (session.status === "expired") {
      await db.update(subscriptions).set({ providerOnboardingJson: { ...state, attempt: { ...attempt, expiredAt: new Date().toISOString() } } }).where(eq(subscriptions.id, row.id));
      throw new HttpError(409, "Checkout expired. Retry to open a new secure checkout.");
    }
    if (!session.url) throw new HttpError(503, "Stripe did not return a checkout link. Retry.");
    return { ok: true, url: session.url, attemptId: attempt.id };
  }
  // Stripe may forget idempotency keys after 24h. Never recreate an ambiguous
  // older attempt with a new subscription; it needs processor reconciliation.
  if (Date.now() - Date.parse(attempt.createdAt) > 23 * 3_600_000) {
    throw new HttpError(409, "This checkout needs support reconciliation before another subscription can be created.");
  }
  row = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(subscriptions).where(eq(subscriptions.id, row.id)).for("update");
    const saved = onboarding(current)!;
    if (saved.attempt?.id !== attempt.id) throw new HttpError(409, "Checkout changed. Refresh and retry.");
    if (saved.attempt.params) return current;
    let customerId = current.stripeCustomerId;
    const [paymentCustomer] = current.subjectType === "provider_org"
      ? await tx.select().from(providerPaymentCustomers).where(eq(providerPaymentCustomers.providerOrganizationId, current.subjectId)).for("update")
      : [];
    if (paymentCustomer) {
      customerId = paymentCustomer.stripeCustomerId;
      const customer = await stripe.customers.retrieve(customerId);
      if (customer.deleted) throw new HttpError(409, "The provider payment customer is unavailable.");
      const defaultId = typeof customer.invoice_settings.default_payment_method === "string"
        ? customer.invoice_settings.default_payment_method : customer.invoice_settings.default_payment_method?.id;
      if (paymentCustomer.authorizedPaymentMethodId === null) {
        await tx.update(providerPaymentCustomers).set({ authorizedPaymentMethodId: defaultId ?? "none" }).where(eq(providerPaymentCustomers.id, paymentCustomer.id));
      }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { subjectType: current.subjectType, subjectId: current.subjectId },
      }, { idempotencyKey: `provider-signup-customer:${current.id}:${attempt.id}` });
      customerId = customer.id;
    }
    const metadata = { providerSignupAttempt: attempt.id, subjectType: current.subjectType, subjectId: current.subjectId, providerPlan: saved.selectedPlan, userId: actorUserId };
    const params: Stripe.Checkout.SessionCreateParams = {
      customer: customerId, mode: "subscription", payment_method_types: ["card"],
      payment_method_collection: "always", line_items: [{ price: priceId, quantity: 1 }],
      success_url: input.successUrl, cancel_url: input.cancelUrl,
      subscription_data: { trial_period_days: PROVIDER_TRIAL_DAYS, metadata },
      metadata,
    };
    const [updated] = await tx.update(subscriptions).set({
      stripeCustomerId: customerId,
      providerOnboardingJson: { ...saved, attempt: { ...saved.attempt, params } },
    }).where(eq(subscriptions.id, row.id)).returning();
    return updated;
  });
  state = onboarding(row)!;
  const session = await stripe.checkout.sessions.create(state.attempt!.params!, {
    idempotencyKey: `provider-signup-checkout:${attempt.id}`,
  });
  if (!session.url) throw new HttpError(503, "Stripe did not return a checkout link. Retry.");
  // Exact attempt compare fences a concurrent confirmed webhook/free selection.
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(subscriptions).where(eq(subscriptions.id, row.id)).for("update");
    const saved = onboarding(current)!;
    if (saved.attempt?.id !== attempt.id) throw new HttpError(409, "Checkout changed. Refresh and retry.");
    await tx.update(subscriptions).set({ providerOnboardingJson: { ...saved, attempt: { ...saved.attempt, sessionId: session.id } } }).where(eq(subscriptions.id, row.id));
  });
  return { ok: true, url: session.url, attemptId: attempt.id };
}

export async function verifyProviderSignupCheckout(row: Subscription, stripe: Stripe, suppliedSessionId?: string) {
  const state = onboarding(row);
  const attempt = state?.attempt;
  const sessionId = suppliedSessionId ?? attempt?.sessionId;
  if (!attempt || !sessionId) return false;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.status !== "complete" || session.mode !== "subscription") return false;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (customerId !== row.stripeCustomerId || !subscriptionId ||
      session.metadata?.providerSignupAttempt !== attempt.id ||
      session.metadata?.subjectType !== row.subjectType || session.metadata?.subjectId !== row.subjectId) {
    throw new HttpError(409, "Checkout does not belong to this provider signup.");
  }
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["default_payment_method", "latest_invoice"] });
  const subCustomer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const price = subscription.items.data[0]?.price;
  if (subCustomer !== customerId || !price || subscription.items.data.length !== 1 ||
      subscription.items.data[0]?.quantity !== 1 || price.id !== attempt.priceId ||
      !subscription.trial_start || !subscription.trial_end ||
      subscription.trial_end - subscription.trial_start !== PROVIDER_TRIAL_DAYS * 86_400 ||
      !["trialing", "active", "past_due"].includes(subscription.status)) {
    throw new HttpError(409, "Stripe has not confirmed the expected provider trial.");
  }
  validateProviderPrice(await stripe.prices.retrieve(price.id, { expand: ["product"] }), attempt.plan);
  const methodId = typeof subscription.default_payment_method === "string"
    ? subscription.default_payment_method : subscription.default_payment_method?.id;
  if (!methodId) return false;
  const method = await stripe.paymentMethods.retrieve(methodId);
  const methodCustomer = typeof method.customer === "string" ? method.customer : method.customer?.id;
  if (methodCustomer !== customerId || method.type !== "card" || !method.card) return false;
  const latestInvoice = typeof subscription.latest_invoice === "object" ? subscription.latest_invoice : null;
  if (subscription.status === "active" && (!latestInvoice || latestInvoice.status !== "paid")) return false;
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(subscriptions).where(eq(subscriptions.id, row.id)).for("update");
    const saved = onboarding(current)!;
    if (saved.attempt?.id !== attempt.id) throw new HttpError(409, "Checkout is no longer current.");
    if (saved.attempt.verifiedAt) return true;
    const now = new Date().toISOString();
    if (saved.reuseCard && row.subjectType === "provider_org") {
      // Serialize with existing card setup. No auto-pay preferences or signed
      // authorization are created by this optional reuse consent.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`provider-payment-customer:${row.subjectId}`}))`);
      const [paymentCustomer] = await tx.select().from(providerPaymentCustomers).where(eq(providerPaymentCustomers.providerOrganizationId, row.subjectId)).for("update");
      if (paymentCustomer && paymentCustomer.stripeCustomerId !== customerId) {
        throw new HttpError(409, "The provider's saved-card customer changed. Contact support to finish card reuse.");
      }
      await stripe.customers.update(customerId!, { invoice_settings: { default_payment_method: methodId } });
      const values = {
        authorizedPaymentMethodId: methodId, cardBrand: method.card!.brand,
        cardLast4: method.card!.last4, cardExpMonth: method.card!.exp_month, cardExpYear: method.card!.exp_year,
        cardStatus: "active", cardUpdatedAt: new Date(),
      };
      if (paymentCustomer) await tx.update(providerPaymentCustomers).set(values).where(eq(providerPaymentCustomers.id, paymentCustomer.id));
      else await tx.insert(providerPaymentCustomers).values({ providerOrganizationId: row.subjectId, stripeCustomerId: customerId!, ...values });
    }
    await tx.update(subscriptions).set({
      status: subscription.status === "trialing" ? "trialing" : subscription.status === "active" ? "active" : "past_due",
      providerPlan: attempt.plan, provider: "stripe", planType: "provider", billingInterval: "month",
      stripeSubscriptionId: subscriptionId, stripePriceId: attempt.priceId, paymentMethodOnFile: true,
      trialStartAt: new Date(subscription.trial_start! * 1000),
      trialEndAt: new Date(subscription.trial_end! * 1000),
      currentPeriodEnd: new Date(subscription.trial_end! * 1000),
      providerOnboardingJson: { ...saved, ...(saved.reuseCard ? { reuseVerifiedAt: now } : {}),
        attempt: { ...saved.attempt, sessionId, verifiedAt: now } },
    }).where(eq(subscriptions.id, row.id));
    return true;
  });
}
