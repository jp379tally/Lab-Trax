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
  | "trialing"
  | "active"
  | "past_due"
  | "grace"
  | "locked"
  | "canceled"
  | "legacy_free";

export type AccessLevel = "full" | "read_only" | "locked";

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
  Math.max(1, parseInt(process.env.SUBSCRIPTION_TRIAL_DAYS ?? "14", 10));
const GRACE_DAYS = () =>
  Math.max(1, parseInt(process.env.SUBSCRIPTION_GRACE_DAYS ?? "7", 10));

/**
 * Determine the billing subject for a user.
 * - Lab user with active lab org → subjectType="lab_org"
 * - Provider user with active provider org → subjectType="provider_org"
 * - Anyone without an org → subjectType="user"
 */
export async function getSubjectForUser(
  userId: string
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

  const [user] = await db
    .select({ userType: users.userType })
    .from(users)
    .where(eq(users.id, userId));

  if (user?.userType === "lab") {
    const labMem = memberships.find((m) => m.orgType === "lab");
    if (labMem) {
      return { subjectType: "lab_org", subjectId: labMem.labId };
    }
  } else {
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
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.subjectType, subject.subjectType),
        eq(subscriptions.subjectId, subject.subjectId),
        isNull(subscriptions.deletedAt)
      )
    );

  return computeEntitlement(subject, row ?? null);
}

function computeEntitlement(
  subject: BillingSubject,
  row: Subscription | null
): Entitlement {
  const now = new Date();

  if (!row) {
    return {
      status: "legacy_free",
      accessLevel: "full",
      trialDaysRemaining: null,
      graceDaysRemaining: null,
      currentPeriodEnd: null,
      hasPaymentMethod: false,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      subscriptionId: null,
    };
  }

  const status = row.status as SubscriptionStatus;
  let trialDaysRemaining: number | null = null;
  let graceDaysRemaining: number | null = null;

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

  const accessLevel: AccessLevel =
    status === "locked" || status === "canceled"
      ? "locked"
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
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    subscriptionId: row.id,
  };
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
  eventPayload?: Record<string, unknown>
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
    .where(eq(subscriptions.id, subscriptionId))
    .returning();

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

  return updated ?? null;
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
