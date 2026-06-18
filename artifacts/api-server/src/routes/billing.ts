import { Router } from "express";
import express from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { subscriptions, subscriptionEvents } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../middlewares/async-handler";
import { HttpError } from "../lib/http";
import { requireAnyRole, BILLING_ROLES } from "../lib/rbac";
import {
  getSubjectForUser,
  getEntitlement,
  startBillingTrial,
  transitionSubscription,
  appendSubscriptionEvent,
} from "../lib/entitlement";
import type { BillingSubject } from "../lib/entitlement";
import {
  getUncachableStripeClient,
  constructStripeEvent,
  isStripeConfigured,
} from "../lib/stripeClient";
import { logger } from "../lib/logger";
import { writeAuditLog } from "../lib/audit";

const router = Router();

/**
 * Returns the four configured Stripe price IDs from environment variables.
 * Only these IDs are accepted in checkout-session and switch-plan requests.
 * When a variable is unset its slot is omitted — the STRIPE_PRICE_ID fallback
 * is included so a single-plan setup still works.
 */
function getAllowedPriceIds(): Set<string> {
  const ids = new Set<string>();
  const keys = [
    "STRIPE_PRICE_ID_LAB_MONTHLY",
    "STRIPE_PRICE_ID_LAB_ANNUAL",
    "STRIPE_PRICE_ID_PROVIDER_MONTHLY",
    "STRIPE_PRICE_ID_PROVIDER_ANNUAL",
    "STRIPE_PRICE_ID",
  ];
  for (const k of keys) {
    const v = process.env[k];
    if (v) ids.add(v);
  }
  return ids;
}

/**
 * Enforces that the caller has billing-management rights for their subject.
 * - For org subjects (lab_org / provider_org): caller must hold owner, admin,
 *   or billing role in the org.
 * - For user subjects (solo accounts): the user always controls their own billing.
 */
async function requireBillingAdmin(
  userId: string,
  subject: BillingSubject
): Promise<void> {
  if (subject.subjectType === "lab_org" || subject.subjectType === "provider_org") {
    await requireAnyRole(userId, subject.subjectId, BILLING_ROLES);
  }
  // subjectType === "user": sole account — user manages their own billing, no role check needed.
}

/**
 * GET /api/billing/subscription
 * Returns the current billing entitlement for the authenticated user.
 */
router.get(
  "/subscription",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const subject = await getSubjectForUser(userId);
    await requireBillingAdmin(userId, subject);
    const entitlement = await getEntitlement(subject);

    const [subRow] = await db
      .select({
        planType: subscriptions.planType,
        billingInterval: subscriptions.billingInterval,
        stripePriceId: subscriptions.stripePriceId,
        stripeSubscriptionId: subscriptions.stripeSubscriptionId,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.subjectType, subject.subjectType),
          eq(subscriptions.subjectId, subject.subjectId),
          isNull(subscriptions.deletedAt)
        )
      );

    return res.json({
      ok: true,
      entitlement: {
        ...entitlement,
        planType: subRow?.planType ?? null,
        billingInterval: subRow?.billingInterval ?? null,
        stripePriceId: subRow?.stripePriceId ?? null,
        cancelAtPeriodEnd: subRow?.cancelAtPeriodEnd ?? false,
        hasStripeSubscription: !!subRow?.stripeSubscriptionId,
      },
    });
  })
);

/**
 * POST /api/billing/checkout-session
 * Creates a Stripe Checkout session for the authenticated user's billing subject.
 * Body: { priceId?, successUrl?, cancelUrl? }
 */
router.post(
  "/checkout-session",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const stripe = await getUncachableStripeClient();
    if (!stripe) {
      throw new HttpError(
        503,
        "Stripe billing is not configured. Please contact support."
      );
    }

    const subject = await getSubjectForUser(userId);
    await requireBillingAdmin(userId, subject);

    const entitlement = await getEntitlement(subject);

    if (entitlement.status === "active") {
      throw new HttpError(400, "Subscription is already active.");
    }

    const priceId =
      req.body?.priceId ?? process.env.STRIPE_PRICE_ID;
    if (!priceId) {
      throw new HttpError(400, "No Stripe price configured. Set STRIPE_PRICE_ID.");
    }

    const allowedPriceIds = getAllowedPriceIds();
    if (allowedPriceIds.size > 0 && !allowedPriceIds.has(priceId)) {
      throw new HttpError(400, "Invalid plan selected. Please choose an available plan.");
    }

    const origin =
      req.body?.successUrl
        ? undefined
        : (() => {
            const domains = (process.env.REPLIT_DOMAINS ?? "")
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean);
            return domains[0]
              ? `https://${domains[0]}`
              : `${req.protocol}://${req.get("host")}`;
          })();
    const successUrl =
      req.body?.successUrl ?? `${origin}/billing?checkout=success`;
    const cancelUrl =
      req.body?.cancelUrl ?? `${origin}/billing?checkout=cancel`;

    let [subRow] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.subjectType, subject.subjectType),
          eq(subscriptions.subjectId, subject.subjectId),
          isNull(subscriptions.deletedAt)
        )
      );

    let stripeCustomerId = subRow?.stripeCustomerId ?? undefined;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        metadata: {
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          userId,
        },
      });
      stripeCustomerId = customer.id;

      if (subRow) {
        await db
          .update(subscriptions)
          .set({ stripeCustomerId })
          .where(eq(subscriptions.id, subRow.id));
      } else {
        const started = await startBillingTrial(
          subject.subjectType,
          subject.subjectId,
          userId
        );
        await db
          .update(subscriptions)
          .set({ stripeCustomerId })
          .where(eq(subscriptions.id, started.id));
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        userId,
        priceId,
      },
    });

    await writeAuditLog({
      req,
      userId,
      action: "billing_checkout_session_created",
      entityType: "subscription",
      entityId: subRow?.id ?? null,
    });

    return res.json({ ok: true, url: session.url });
  })
);

/**
 * POST /api/billing/portal-session
 * Creates a Stripe Customer Portal session for managing the subscription.
 */
router.post(
  "/portal-session",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const stripe = await getUncachableStripeClient();
    if (!stripe) {
      throw new HttpError(503, "Stripe billing is not configured.");
    }

    const subject = await getSubjectForUser(userId);
    await requireBillingAdmin(userId, subject);

    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.subjectType, subject.subjectType),
          eq(subscriptions.subjectId, subject.subjectId),
          isNull(subscriptions.deletedAt)
        )
      );

    if (!subRow?.stripeCustomerId) {
      throw new HttpError(
        400,
        "No Stripe customer found. Start a checkout session first."
      );
    }

    const origin = (() => {
      const domains = (process.env.REPLIT_DOMAINS ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
      return domains[0]
        ? `https://${domains[0]}`
        : `${req.protocol}://${req.get("host")}`;
    })();
    const returnUrl = req.body?.returnUrl ?? `${origin}/billing`;

    const session = await stripe.billingPortal.sessions.create({
      customer: subRow.stripeCustomerId,
      return_url: returnUrl,
    });

    return res.json({ ok: true, url: session.url });
  })
);

/**
 * GET /api/billing/plans
 * Returns available Stripe plans (public; no auth required).
 * Includes planType from product metadata ("lab" | "provider").
 */
router.get(
  "/plans",
  asyncHandler(async (_req, res) => {
    const configured = await isStripeConfigured();
    if (!configured) {
      return res.json({ ok: true, plans: [] });
    }
    const stripe = await getUncachableStripeClient();
    if (!stripe) return res.json({ ok: true, plans: [] });

    const allowedIds = getAllowedPriceIds();

    const prices = await stripe.prices.list({
      active: true,
      type: "recurring",
      expand: ["data.product"],
      limit: 20,
    });

    const plans = prices.data
      .filter(
        (p) =>
          typeof p.product === "object" &&
          p.product !== null &&
          !(p.product as any).deleted &&
          (allowedIds.size === 0 || allowedIds.has(p.id))
      )
      .map((p) => {
        const product = p.product as any;
        return {
          id: p.id,
          currency: p.currency,
          unitAmount: p.unit_amount,
          interval: p.recurring?.interval ?? null,
          intervalCount: p.recurring?.interval_count ?? null,
          productName: product?.name ?? null,
          productDescription: product?.description ?? null,
          planType: (product?.metadata?.planType as string | null) ?? null,
          nickname: p.nickname ?? null,
        };
      });

    return res.json({ ok: true, plans });
  })
);

/**
 * GET /api/billing/invoices
 * Returns the Stripe invoice history for the current billing subject.
 */
router.get(
  "/invoices",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const stripe = await getUncachableStripeClient();
    if (!stripe) {
      return res.json({ ok: true, invoices: [] });
    }

    const subject = await getSubjectForUser(userId);
    await requireBillingAdmin(userId, subject);

    const [subRow] = await db
      .select({ stripeCustomerId: subscriptions.stripeCustomerId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.subjectType, subject.subjectType),
          eq(subscriptions.subjectId, subject.subjectId),
          isNull(subscriptions.deletedAt)
        )
      );

    if (!subRow?.stripeCustomerId) {
      return res.json({ ok: true, invoices: [] });
    }

    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) ?? "12", 10), 1),
      50
    );

    const stripeInvoices = await stripe.invoices.list({
      customer: subRow.stripeCustomerId,
      limit,
    });

    const invoices = stripeInvoices.data.map((inv) => ({
      id: inv.id,
      number: inv.number ?? null,
      status: inv.status ?? null,
      amountPaid: inv.amount_paid,
      amountDue: inv.amount_due,
      currency: inv.currency,
      periodStart: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
      periodEnd: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
      createdAt: new Date(inv.created * 1000).toISOString(),
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      pdfUrl: (inv as any).invoice_pdf ?? null,
      description: inv.description ?? null,
    }));

    return res.json({ ok: true, invoices });
  })
);

/**
 * GET /api/billing/history
 * Returns subscription event history for the current billing subject.
 */
router.get(
  "/history",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const subject = await getSubjectForUser(userId);
    await requireBillingAdmin(userId, subject);

    const [subRow] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.subjectType, subject.subjectType),
          eq(subscriptions.subjectId, subject.subjectId),
          isNull(subscriptions.deletedAt)
        )
      );

    if (!subRow) {
      return res.json({ ok: true, events: [] });
    }

    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) ?? "20", 10), 1),
      100
    );

    const events = await db
      .select({
        id: subscriptionEvents.id,
        eventType: subscriptionEvents.eventType,
        statusBefore: subscriptionEvents.statusBefore,
        statusAfter: subscriptionEvents.statusAfter,
        provider: subscriptionEvents.provider,
        createdAt: subscriptionEvents.createdAt,
      })
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.subscriptionId, subRow.id))
      .orderBy(desc(subscriptionEvents.createdAt))
      .limit(limit);

    return res.json({
      ok: true,
      events: events.map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  })
);

/**
 * POST /api/billing/switch-plan
 * Upgrade or downgrade to a different Stripe price on the active subscription.
 * Body: { priceId: string }
 */
router.post(
  "/switch-plan",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const stripe = await getUncachableStripeClient();
    if (!stripe) {
      throw new HttpError(503, "Stripe billing is not configured.");
    }

    const { priceId } = req.body ?? {};
    if (!priceId || typeof priceId !== "string") {
      throw new HttpError(400, "priceId is required.");
    }

    const allowedPriceIds = getAllowedPriceIds();
    if (allowedPriceIds.size > 0 && !allowedPriceIds.has(priceId)) {
      throw new HttpError(400, "Invalid plan selected. Please choose an available plan.");
    }

    const subject = await getSubjectForUser(userId);
    await requireBillingAdmin(userId, subject);

    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.subjectType, subject.subjectType),
          eq(subscriptions.subjectId, subject.subjectId),
          isNull(subscriptions.deletedAt)
        )
      );

    if (!subRow?.stripeSubscriptionId) {
      throw new HttpError(
        400,
        "No active Stripe subscription found. Use checkout to start a subscription."
      );
    }

    const stripeSub = await stripe.subscriptions.retrieve(
      subRow.stripeSubscriptionId,
      { expand: ["items"] }
    );

    const itemId = stripeSub.items.data[0]?.id;
    if (!itemId) {
      throw new HttpError(500, "Could not find subscription item to update.");
    }

    const updated = await stripe.subscriptions.update(
      subRow.stripeSubscriptionId,
      {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: "create_prorations",
      }
    );

    const newPrice = updated.items.data[0]?.price;
    const planType =
      (newPrice?.product as any)?.metadata?.planType ??
      (typeof newPrice?.product === "string"
        ? await stripe.products
            .retrieve(newPrice!.product as string)
            .then((p) => (!p.deleted ? (p as any).metadata?.planType ?? null : null))
            .catch(() => null)
        : null);

    await db
      .update(subscriptions)
      .set({
        stripePriceId: priceId,
        billingInterval: newPrice?.recurring?.interval ?? null,
        planType: planType,
      } as any)
      .where(eq(subscriptions.id, subRow.id));

    await appendSubscriptionEvent({
      subscriptionId: subRow.id,
      subjectType: subRow.subjectType,
      subjectId: subRow.subjectId,
      eventType: "plan_switched",
      provider: "stripe",
      rawPayloadJson: {
        fromPriceId: subRow.stripePriceId,
        toPriceId: priceId,
        userId,
      },
    });

    await writeAuditLog({
      req,
      userId,
      action: "billing_plan_switched",
      entityType: "subscription",
      entityId: subRow.id,
    });

    return res.json({
      ok: true,
      message: "Plan updated successfully.",
      newPriceId: priceId,
      planType,
      billingInterval: newPrice?.recurring?.interval ?? null,
    });
  })
);

/**
 * POST /api/billing/cancel
 * Cancels the subscription at the end of the current billing period.
 * Body: { immediately?: boolean }
 */
router.post(
  "/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const stripe = await getUncachableStripeClient();
    if (!stripe) {
      throw new HttpError(503, "Stripe billing is not configured.");
    }

    const immediately = req.body?.immediately === true;

    const subject = await getSubjectForUser(userId);
    await requireBillingAdmin(userId, subject);

    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.subjectType, subject.subjectType),
          eq(subscriptions.subjectId, subject.subjectId),
          isNull(subscriptions.deletedAt)
        )
      );

    if (!subRow?.stripeSubscriptionId) {
      throw new HttpError(400, "No active Stripe subscription found.");
    }

    if (immediately) {
      await stripe.subscriptions.cancel(subRow.stripeSubscriptionId);
      await transitionSubscription(
        subRow.id,
        "canceled",
        { canceledAt: new Date() },
        { reason: "user_canceled_immediately", userId }
      );
    } else {
      await stripe.subscriptions.update(subRow.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
      await db
        .update(subscriptions)
        .set({ cancelAtPeriodEnd: true } as any)
        .where(eq(subscriptions.id, subRow.id));
      await appendSubscriptionEvent({
        subscriptionId: subRow.id,
        subjectType: subRow.subjectType,
        subjectId: subRow.subjectId,
        eventType: "cancel_scheduled",
        provider: "stripe",
        rawPayloadJson: { immediately: false, userId },
      });
    }

    await writeAuditLog({
      req,
      userId,
      action: immediately
        ? "billing_canceled_immediately"
        : "billing_cancel_scheduled",
      entityType: "subscription",
      entityId: subRow.id,
    });

    return res.json({
      ok: true,
      message: immediately
        ? "Subscription canceled immediately."
        : "Subscription will cancel at the end of the current billing period.",
    });
  })
);

/**
 * POST /api/billing/reactivate
 * Removes a scheduled cancellation (cancel_at_period_end = false).
 */
router.post(
  "/reactivate",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const stripe = await getUncachableStripeClient();
    if (!stripe) {
      throw new HttpError(503, "Stripe billing is not configured.");
    }

    const subject = await getSubjectForUser(userId);
    await requireBillingAdmin(userId, subject);

    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.subjectType, subject.subjectType),
          eq(subscriptions.subjectId, subject.subjectId),
          isNull(subscriptions.deletedAt)
        )
      );

    if (!subRow?.stripeSubscriptionId) {
      throw new HttpError(400, "No active Stripe subscription found.");
    }

    await stripe.subscriptions.update(subRow.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
    await db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: false } as any)
      .where(eq(subscriptions.id, subRow.id));

    await appendSubscriptionEvent({
      subscriptionId: subRow.id,
      subjectType: subRow.subjectType,
      subjectId: subRow.subjectId,
      eventType: "cancel_reversed",
      provider: "stripe",
      rawPayloadJson: { userId },
    });

    return res.json({ ok: true, message: "Cancellation reversed." });
  })
);

/**
 * POST /api/billing/webhook/stripe
 * Raw-body Stripe webhook handler. Must be registered before express.json().
 * This route is added directly in app.ts, not via this router.
 */
export async function handleStripeWebhook(
  rawBody: Buffer,
  signature: string
): Promise<{ received: boolean; error?: string }> {
  const event = await constructStripeEvent(rawBody, signature);
  if (!event) {
    return { received: false, error: "invalid_signature" };
  }

  try {
    await processStripeEvent(event);
    return { received: true };
  } catch (err: any) {
    logger.error({ err: err?.message, eventType: event.type }, "[billing] Stripe event processing failed");
    return { received: false, error: err?.message };
  }
}

/** Derive planType and billingInterval from a Stripe price object. */
async function derivePlanMeta(
  price: import("stripe").default.Price | null | undefined,
  stripe: import("stripe").default
): Promise<{ planType: string | null; billingInterval: string | null }> {
  if (!price) return { planType: null, billingInterval: null };

  const billingInterval = price.recurring?.interval ?? null;

  let planType: string | null = null;
  if (typeof price.product === "object" && price.product !== null) {
    planType = (price.product as any).metadata?.planType ?? null;
  } else if (typeof price.product === "string") {
    try {
      const prod = await stripe.products.retrieve(price.product);
      planType = (prod as any).metadata?.planType ?? null;
    } catch {
      planType = null;
    }
  }

  return { planType, billingInterval };
}

async function processStripeEvent(event: import("stripe").default.Event) {
  logger.info({ eventType: event.type }, "[billing] Processing Stripe event");

  const stripe = await getUncachableStripeClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as import("stripe").default.Checkout.Session;
      const subjectType = session.metadata?.subjectType;
      const subjectId = session.metadata?.subjectId;
      if (!subjectType || !subjectId) break;

      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.subjectType, subjectType),
            eq(subscriptions.subjectId, subjectId),
            isNull(subscriptions.deletedAt)
          )
        );

      if (sub) {
        const updates: Record<string, unknown> = {
          paymentMethodOnFile: true,
          provider: "stripe",
        };
        if (session.subscription) {
          updates.stripeSubscriptionId = session.subscription as string;
        }
        if (session.customer) {
          updates.stripeCustomerId = session.customer as string;
        }

        if (session.metadata?.priceId && stripe) {
          try {
            const price = await stripe.prices.retrieve(session.metadata.priceId, {
              expand: ["product"],
            });
            const { planType, billingInterval } = await derivePlanMeta(price, stripe);
            updates.stripePriceId = session.metadata.priceId;
            if (planType) updates.planType = planType;
            if (billingInterval) updates.billingInterval = billingInterval;
          } catch {
          }
        }

        await db
          .update(subscriptions)
          .set(updates as any)
          .where(eq(subscriptions.id, sub.id));

        if (sub.status !== "active") {
          await transitionSubscription(sub.id, "active", undefined, {
            reason: "checkout_completed",
            stripeSessionId: session.id,
          });
        }
      }
      break;
    }

    case "customer.subscription.updated": {
      const stripeSub = event.data.object as import("stripe").default.Subscription;
      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.stripeSubscriptionId, stripeSub.id),
            isNull(subscriptions.deletedAt)
          )
        );
      if (!sub) break;

      const newStatus =
        stripeSub.status === "active"
          ? "active"
          : stripeSub.status === "past_due"
            ? "past_due"
            : stripeSub.status === "canceled"
              ? "canceled"
              : stripeSub.status === "trialing"
                ? "trialing"
                : null;

      const rawSub = stripeSub as any;
      const periodEnd =
        rawSub.current_period_end
          ? new Date(rawSub.current_period_end * 1000)
          : null;
      const cancelAtPeriodEnd = rawSub.cancel_at_period_end ?? false;

      const currentPrice = stripeSub.items.data[0]?.price;
      const planUpdates: Record<string, unknown> = {};
      if (currentPrice && stripe) {
        const { planType, billingInterval } = await derivePlanMeta(currentPrice, stripe);
        planUpdates.stripePriceId = currentPrice.id;
        if (planType) planUpdates.planType = planType;
        if (billingInterval) planUpdates.billingInterval = billingInterval;
      }

      await db
        .update(subscriptions)
        .set({
          currentPeriodEnd: periodEnd ?? undefined,
          cancelAtPeriodEnd,
          paymentMethodOnFile: true,
          ...planUpdates,
        } as any)
        .where(eq(subscriptions.id, sub.id));

      if (newStatus && newStatus !== sub.status) {
        await transitionSubscription(sub.id, newStatus as any, undefined, {
          reason: "stripe_subscription_updated",
          stripeStatus: stripeSub.status,
        });
      } else {
        await appendSubscriptionEvent({
          subscriptionId: sub.id,
          subjectType: sub.subjectType,
          subjectId: sub.subjectId,
          eventType: "stripe_subscription_updated",
          provider: "stripe",
          externalEventId: event.id,
          rawPayloadJson: { stripeStatus: stripeSub.status },
        });
      }
      break;
    }

    case "customer.subscription.deleted": {
      const stripeSub = event.data.object as import("stripe").default.Subscription;
      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.stripeSubscriptionId, stripeSub.id),
            isNull(subscriptions.deletedAt)
          )
        );
      if (!sub) break;
      await transitionSubscription(
        sub.id,
        "canceled",
        { canceledAt: new Date() },
        { reason: "stripe_subscription_deleted" }
      );
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as import("stripe").default.Invoice;
      const invoiceAny = invoice as any;
      const stripeSubId =
        typeof invoiceAny.subscription === "string"
          ? invoiceAny.subscription
          : null;
      if (!stripeSubId) break;

      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.stripeSubscriptionId, stripeSubId),
            isNull(subscriptions.deletedAt)
          )
        );
      if (!sub) break;

      const periodEnd =
        (invoice as any).lines?.data?.[0]?.period?.end
          ? new Date((invoice as any).lines.data[0].period.end * 1000)
          : null;

      await db
        .update(subscriptions)
        .set({
          paymentMethodOnFile: true,
          ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
        } as any)
        .where(eq(subscriptions.id, sub.id));

      if (sub.status !== "active") {
        await transitionSubscription(sub.id, "active", undefined, {
          reason: "invoice_payment_succeeded",
          invoiceId: invoice.id,
        });
      } else {
        await appendSubscriptionEvent({
          subscriptionId: sub.id,
          subjectType: sub.subjectType,
          subjectId: sub.subjectId,
          eventType: "invoice_payment_succeeded",
          provider: "stripe",
          externalEventId: event.id,
          rawPayloadJson: { invoiceId: invoice.id },
        });
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as import("stripe").default.Invoice;
      const invoiceFailedAny = invoice as any;
      const stripeSubId =
        typeof invoiceFailedAny.subscription === "string"
          ? invoiceFailedAny.subscription
          : null;
      if (!stripeSubId) break;

      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.stripeSubscriptionId, stripeSubId),
            isNull(subscriptions.deletedAt)
          )
        );
      if (!sub) break;

      await transitionSubscription(sub.id, "past_due", undefined, {
        reason: "invoice_payment_failed",
        invoiceId: invoice.id,
      });
      break;
    }

    default:
      break;
  }
}

/**
 * POST /api/billing/webhook/revenuecat
 * RevenueCat server-to-server webhook.
 */
router.post(
  "/webhook/revenuecat",
  asyncHandler(async (req, res) => {
    const payload = req.body;
    const eventType: string = payload?.event?.type ?? "unknown";
    const appUserId: string | undefined = payload?.event?.app_user_id;

    if (!appUserId) {
      return res.status(400).json({ ok: false, message: "Missing app_user_id" });
    }

    try {
      await handleRevenueCatEvent(eventType, appUserId, payload?.event ?? {});
      return res.json({ ok: true });
    } catch (err: any) {
      logger.error(
        { err: err?.message, eventType, appUserId },
        "[billing] RevenueCat event processing failed"
      );
      return res.status(500).json({ ok: false, message: "Event processing failed" });
    }
  })
);

async function handleRevenueCatEvent(
  eventType: string,
  appUserId: string,
  payload: Record<string, unknown>
) {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.revenueCatAppUserId, appUserId),
        isNull(subscriptions.deletedAt)
      )
    );

  if (!sub) {
    logger.warn({ appUserId, eventType }, "[billing] No subscription for RevenueCat app user");
    await appendSubscriptionEvent({
      eventType: `rc_${eventType.toLowerCase()}`,
      provider: "revenuecat",
      rawPayloadJson: { appUserId, ...payload },
    });
    return;
  }

  const expiresAt = payload?.expiration_at_ms
    ? new Date(payload.expiration_at_ms as number)
    : null;

  switch (eventType) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "PRODUCT_CHANGE": {
      await db
        .update(subscriptions)
        .set({
          paymentMethodOnFile: true,
          provider: "revenuecat",
          ...(expiresAt ? { currentPeriodEnd: expiresAt } : {}),
        } as any)
        .where(eq(subscriptions.id, sub.id));

      if (sub.status !== "active") {
        await transitionSubscription(sub.id, "active", undefined, {
          reason: `rc_${eventType.toLowerCase()}`,
        });
      } else {
        await appendSubscriptionEvent({
          subscriptionId: sub.id,
          subjectType: sub.subjectType,
          subjectId: sub.subjectId,
          eventType: `rc_${eventType.toLowerCase()}`,
          provider: "revenuecat",
          rawPayloadJson: payload,
        });
      }
      break;
    }

    case "CANCELLATION": {
      await transitionSubscription(sub.id, "grace", undefined, {
        reason: "rc_cancellation",
      });
      break;
    }

    case "EXPIRATION": {
      if (sub.status === "active" || sub.status === "past_due") {
        await transitionSubscription(sub.id, "grace", undefined, {
          reason: "rc_expiration",
        });
      }
      break;
    }

    case "BILLING_ISSUE": {
      if (sub.status === "active") {
        await transitionSubscription(sub.id, "past_due", undefined, {
          reason: "rc_billing_issue",
        });
      }
      break;
    }

    default:
      await appendSubscriptionEvent({
        subscriptionId: sub.id,
        subjectType: sub.subjectType,
        subjectId: sub.subjectId,
        eventType: `rc_${eventType.toLowerCase()}`,
        provider: "revenuecat",
        rawPayloadJson: payload,
      });
  }
}

/**
 * POST /api/billing/link-revenuecat
 * Links a RevenueCat App User ID to the caller's billing subject.
 * Called from the mobile app after a purchase.
 */
router.post(
  "/link-revenuecat",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const { appUserId } = req.body;
    if (!appUserId || typeof appUserId !== "string") {
      throw new HttpError(400, "appUserId is required");
    }

    const subject = await getSubjectForUser(userId);
    let [sub] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.subjectType, subject.subjectType),
          eq(subscriptions.subjectId, subject.subjectId),
          isNull(subscriptions.deletedAt)
        )
      );

    if (!sub) {
      sub = await startBillingTrial(
        subject.subjectType,
        subject.subjectId,
        userId
      );
    }

    await db
      .update(subscriptions)
      .set({ revenueCatAppUserId: appUserId, provider: "revenuecat" })
      .where(eq(subscriptions.id, sub.id));

    await appendSubscriptionEvent({
      subscriptionId: sub.id,
      subjectType: sub.subjectType,
      subjectId: sub.subjectId,
      eventType: "rc_user_linked",
      provider: "revenuecat",
      rawPayloadJson: { appUserId, userId },
    });

    return res.json({ ok: true });
  })
);

export default router;
