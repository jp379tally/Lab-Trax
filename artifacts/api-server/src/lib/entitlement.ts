import { and, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  subscriptions,
  subscriptionEvents,
  organizations,
  organizationMemberships,
  users,
} from "@workspace/db";
import type { Subscription } from "@workspace/db";
import { logger } from "./logger";

export type SubscriptionStatus =
  | "free"
  | "onboarding_pending"
  | "trialing"
  | "active"
  | "past_due"
  | "grace"
  | "deactivated"
  /** Legacy values retained for rows written before durable deactivation. */
  | "locked"
  | "canceled"
  | "legacy_free";

export type AccessLevel = "full" | "read_only" | "locked";

export const PROVIDER_PLANS = {
  free: {
    monthlyPriceUsd: 0,
    capabilities: ["active_case_view"],
  },
  basic: {
    monthlyPriceUsd: 99,
    capabilities: ["active_case_view"],
  },
  standard: {
    monthlyPriceUsd: 149,
    capabilities: ["active_case_view", "billing_view_pay"],
  },
  premium: {
    monthlyPriceUsd: 199,
    capabilities: [
      "active_case_view",
      "billing_view_pay",
      "lab_communication",
    ],
  },
} as const;

export type ProviderPlan = keyof typeof PROVIDER_PLANS;
export type Capability =
  | "active_case_view"
  | "billing_view_pay"
  | "lab_communication";

export const CAPABILITIES: readonly Capability[] = [
  "active_case_view",
  "billing_view_pay",
  "lab_communication",
] as const;

export type CapabilityEntitlements = Record<Capability, boolean>;

export interface Entitlement {
  status: SubscriptionStatus;
  accessLevel: AccessLevel;
  /** Days remaining in trial (null if not trialing) */
  trialDaysRemaining: number | null;
  /** Days remaining in grace period (null if not in grace) */
  graceDaysRemaining: number | null;
  /** ISO string for current period end (null if legacy_free or not set) */
  currentPeriodEnd: string | null;
  /** Whether this is a paying customer */
  hasPaymentMethod: boolean;
  /** Selected provider plan; null for lab and non-provider subjects. */
  providerPlan: ProviderPlan | null;
  /** Centrally-derived application capabilities for this billing subject. */
  capabilities: CapabilityEntitlements;
  /**
   * A currently effective administrative waiver. It only suppresses a payment
   * lockout and never represents a payment method or paid subscription.
   */
  hasActiveWaiver: boolean;
  /** The billing subject */
  subjectType: string;
  subjectId: string;
  /** Subscription row id if present */
  subscriptionId: string | null;
}

export interface BillingSubject {
  subjectType: string;
  subjectId: string;
}

const TRIAL_DAYS = () =>
  Math.max(1, parseInt(process.env.SUBSCRIPTION_TRIAL_DAYS ?? "30", 10));
const GRACE_DAYS = () =>
  Math.max(1, parseInt(process.env.SUBSCRIPTION_GRACE_DAYS ?? "7", 10));

/**
 * Determine the billing subject for a user.
 * - Lab user with active lab org → subjectType="lab_org"
 * - Provider user with active provider org → subjectType="provider_org"
 * - Anyone without an org → subjectType="user"
 */
export async function getSubjectForUser(
  userId: string,
  authenticatedUserType?: string | null,
): Promise<BillingSubject> {
  const memberships = await db
    .select({
      labId: organizationMemberships.labId,
      orgType: organizations.type,
      status: organizationMemberships.status,
    })
    .from(organizationMemberships)
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, organizationMemberships.labId),
        isNull(organizations.deletedAt)
      )
    )
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active")
      )
    );

  const [user] = authenticatedUserType === undefined ? await db
    .select({ userType: users.userType })
    .from(users)
    .where(eq(users.id, userId)) : [{ userType: authenticatedUserType }];

  if (user?.userType === "lab") {
    const labMem = memberships.find((m) => m.orgType === "lab");
    if (labMem) {
      return { subjectType: "lab_org", subjectId: labMem.labId };
    }
  } else {
    const personal = await db.query.subscriptions.findFirst({
      where: and(eq(subscriptions.subjectType, "user"), eq(subscriptions.subjectId, userId), isNull(subscriptions.deletedAt)),
    });
    if (personal?.providerOnboardingJson) return { subjectType: "user", subjectId: userId };
    const providerMem = memberships.find((m) => m.orgType === "provider");
    if (providerMem) {
      return { subjectType: "provider_org", subjectId: providerMem.labId };
    }
  }

  return { subjectType: "user", subjectId: userId };
}

/**
 * Resolve the access entitlement for a billing subject.
 * Missing subscription row → legacy_free (full access, pre-billing accounts).
 */
export async function getEntitlement(
  subject: BillingSubject
): Promise<Entitlement> {
  const resolvedSubject = await resolveLegacyProviderSubject(subject);
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.subjectType, resolvedSubject.subjectType),
        eq(subscriptions.subjectId, resolvedSubject.subjectId),
        isNull(subscriptions.deletedAt)
      )
    );

  // Do not strand a provider while its pre-organization subscription record
  // is being migrated. The entitlement is nevertheless reported against the
  // organization so all current callers share one billing subject.
  if (
    !row &&
    resolvedSubject.subjectType === "provider_org" &&
    (subject.subjectType === "provider_user" || subject.subjectType === "user")
  ) {
    const [legacyRow] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.subjectType, subject.subjectType),
          eq(subscriptions.subjectId, subject.subjectId),
          isNull(subscriptions.deletedAt)
        )
      );
    return computeEntitlement(resolvedSubject, legacyRow ?? null);
  }

  return computeEntitlement(resolvedSubject, row ?? null);
}

/**
 * Canonicalize old per-provider-user subjects when the user now belongs to a
 * provider organization. Other subject types are left untouched: resolving a
 * lab or an unknown user here could incorrectly cross a billing boundary.
 */
async function resolveLegacyProviderSubject(
  subject: BillingSubject
): Promise<BillingSubject> {
  if (subject.subjectType !== "provider_user" && subject.subjectType !== "user") {
    return subject;
  }

  const resolved = await getSubjectForUser(subject.subjectId);
  return resolved.subjectType === "provider_org" ? resolved : subject;
}

export function computeEntitlement(
  subject: BillingSubject,
  row: Subscription | null,
  now = new Date()
): Entitlement {
  const providerSubject = row?.planType === "provider" && subject.subjectType === "user"
    ? { ...subject, subjectType: "provider_user" } : subject;
  const providerPlan = getProviderPlan(providerSubject, row);
  const capabilities = getCapabilities(providerSubject, row?.status === "onboarding_pending" ? "free" : providerPlan);

  if (!row) {
    return {
      status: "legacy_free",
      accessLevel: "full",
      trialDaysRemaining: null,
      graceDaysRemaining: null,
      currentPeriodEnd: null,
      hasPaymentMethod: false,
      providerPlan,
      capabilities,
      hasActiveWaiver: false,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      subscriptionId: null,
    };
  }

  const status = row.status as SubscriptionStatus;
  let trialDaysRemaining: number | null = null;
  let graceDaysRemaining: number | null = null;
  const trialExpired =
    status === "trialing" &&
    !!row.trialEndAt &&
    row.trialEndAt.getTime() <= now.getTime();

  if (status === "trialing" && row.trialEndAt) {
    const msLeft = row.trialEndAt.getTime() - now.getTime();
    trialDaysRemaining = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
  }

  if (status === "grace" && row.gracePeriodStartAt) {
    const graceEndMs =
      row.gracePeriodStartAt.getTime() + GRACE_DAYS() * 86_400_000;
    const msLeft = graceEndMs - now.getTime();
    graceDaysRemaining = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
  }

  // locked/canceled are legacy persisted values. They are intentionally
  // interpreted as read-only, never as an authentication lockout.
  const paymentReadOnly =
    status === "locked" || status === "canceled" || status === "deactivated";
  const hasActiveWaiver =
    !!row.waiverReason &&
    !!row.waiverStartsAt &&
    row.waiverStartsAt.getTime() <= now.getTime() &&
    (!row.waiverEndsAt || row.waiverEndsAt.getTime() > now.getTime());
  const permanentReadOnly = row.status === "free" || row.status === "onboarding_pending";
  const accessLevel: AccessLevel = permanentReadOnly
    ? "read_only"
    : hasActiveWaiver
    ? "full"
    : paymentReadOnly || trialExpired
      ? "read_only"
      : status === "grace"
        ? "read_only"
        : "full";

  return {
    status,
    accessLevel,
    trialDaysRemaining,
    graceDaysRemaining,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    hasPaymentMethod: row.paymentMethodOnFile,
    providerPlan,
    capabilities,
    hasActiveWaiver,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    subscriptionId: row.id,
  };
}

export function expiredTrialTransition(paymentMethodOnFile: boolean): {
  status: "grace";
  reason: "trial_ended_awaiting_payment_confirmation" | "trial_ended_no_payment";
} {
  return {
    status: "grace",
    reason: paymentMethodOnFile
      ? "trial_ended_awaiting_payment_confirmation"
      : "trial_ended_no_payment",
  };
}

function getProviderPlan(
  subject: BillingSubject,
  row: Subscription | null
): ProviderPlan | null {
  if (subject.subjectType !== "provider_org" && subject.subjectType !== "provider_user") {
    return null;
  }

  // A missing row is the historical legacy-free state and must retain the
  // complete portal until transition creates its explicit Premium waiver.
  // A real row without a plan is least-privileged until backfill assigns one.
  const plan = row ? (row.providerPlan ?? "basic") : "premium";
  return isProviderPlan(plan) ? plan : "basic";
}

function getCapabilities(
  subject: BillingSubject,
  providerPlan: ProviderPlan | null
): CapabilityEntitlements {
  // Lab subscription behavior predates provider tiers; all listed
  // capabilities remain available to lab subjects.
  if (subject.subjectType !== "provider_org" && subject.subjectType !== "provider_user") {
    return {
      active_case_view: true,
      billing_view_pay: true,
      lab_communication: true,
    };
  }

  const included: readonly Capability[] = providerPlan
    ? PROVIDER_PLANS[providerPlan].capabilities
    : [];
  return {
    active_case_view: included.includes("active_case_view"),
    billing_view_pay: included.includes("billing_view_pay"),
    lab_communication: included.includes("lab_communication"),
  };
}

export function isProviderPlan(value: unknown): value is ProviderPlan {
  return typeof value === "string" && Object.hasOwn(PROVIDER_PLANS, value);
}

/**
 * Start a 14-day (configurable) free trial for a new billing subject.
 * Idempotent — if a subscription already exists for this subject, returns
 * the existing one without modification.
 */
export async function startBillingTrial(
  subjectType: string,
  subjectId: string,
  actorUserId?: string | null
): Promise<Subscription> {
  const existing = await db.query.subscriptions.findFirst({
    where: and(
      eq(subscriptions.subjectType, subjectType),
      eq(subscriptions.subjectId, subjectId),
      isNull(subscriptions.deletedAt)
    ),
  });

  if (existing) return existing;

  const now = new Date();
  const trialEndAt = new Date(
    now.getTime() + TRIAL_DAYS() * 24 * 60 * 60 * 1000
  );

  const [sub] = await db
    .insert(subscriptions)
    .values({
      subjectType,
      subjectId,
      provider: "none",
      status: "trialing",
      // New providers begin on the fixed entry plan. Legacy transition access
      // is granted only by the explicit, auditable backfill.
      providerPlan: subjectType === "provider_org" ? "basic" : null,
      trialStartAt: now,
      trialEndAt,
    })
    .returning();

  await appendSubscriptionEvent({
    subscriptionId: sub.id,
    subjectType,
    subjectId,
    eventType: "trial_started",
    provider: "none",
    statusBefore: null,
    statusAfter: "trialing",
    rawPayloadJson: {
      trialDays: TRIAL_DAYS(),
      trialEndAt: trialEndAt.toISOString(),
      actorUserId: actorUserId ?? null,
    },
  });

  logger.info(
    { subjectType, subjectId, trialEndAt },
    "[billing] Trial started"
  );

  return sub;
}

/**
 * Transition a subscription to a new status, recording the event.
 * Returns null if the subscription does not exist.
 */
export async function transitionSubscription(
  subscriptionId: string,
  newStatus: SubscriptionStatus,
  extra?: Partial<typeof subscriptions.$inferInsert>,
  eventPayload?: Record<string, unknown>,
  expectedCurrentStatus?: SubscriptionStatus,
): Promise<Subscription | null> {
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));

  if (!existing) return null;

  const now = new Date();
  const updates: Partial<typeof subscriptions.$inferInsert> = {
    status: newStatus,
    updatedAt: now,
    ...extra,
  };

  if (newStatus === "grace" && !existing.gracePeriodStartAt) {
    updates.gracePeriodStartAt = now;
  }

  const [updated] = await db
    .update(subscriptions)
    .set(updates)
    .where(and(
      eq(subscriptions.id, subscriptionId),
      ...(expectedCurrentStatus
        ? [eq(subscriptions.status, expectedCurrentStatus)]
        : []),
    ))
    .returning();
  if (!updated) return null;

  await appendSubscriptionEvent({
    subscriptionId,
    subjectType: existing.subjectType,
    subjectId: existing.subjectId,
    eventType: `status_changed_to_${newStatus}`,
    statusBefore: existing.status,
    statusAfter: newStatus,
    rawPayloadJson: eventPayload ?? {},
  });

  logger.info(
    {
      subscriptionId,
      subjectType: existing.subjectType,
      subjectId: existing.subjectId,
      from: existing.status,
      to: newStatus,
    },
    "[billing] Subscription status changed"
  );

  return updated;
}

/**
 * Append a subscription event (audit log for billing).
 */
export async function appendSubscriptionEvent(opts: {
  subscriptionId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  eventType: string;
  provider?: string | null;
  externalEventId?: string | null;
  statusBefore?: string | null;
  statusAfter?: string | null;
  rawPayloadJson?: unknown;
}) {
  try {
    await db.insert(subscriptionEvents).values({
      subscriptionId: opts.subscriptionId ?? null,
      subjectType: opts.subjectType ?? null,
      subjectId: opts.subjectId ?? null,
      eventType: opts.eventType,
      provider: opts.provider ?? null,
      externalEventId: opts.externalEventId ?? null,
      statusBefore: opts.statusBefore ?? null,
      statusAfter: opts.statusAfter ?? null,
      rawPayloadJson: opts.rawPayloadJson as any ?? null,
    });
  } catch (err: any) {
    logger.error(
      { err: err?.message, eventType: opts.eventType },
      "[billing] Failed to append subscription event"
    );
  }
}
