import { finalizedInvoiceSql } from "./recovery-billing-hold";
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import {
  bankAccounts,
  bankTransactions,
  invoices,
  notifications,
  organizationMemberships,
  organizations,
  providerAutoPayAttempts,
  providerAutopayAuthorizations,
  providerAutopayAuthorizationLabs,
  providerPaymentAllocations,
  providerPaymentCheckouts,
  providerPaymentCustomers,
  subscriptions,
  users,
} from "@workspace/db";
import { ADMIN_ROLES } from "./rbac";
import {
  appendSubscriptionEvent,
  expiredTrialTransition,
  transitionSubscription,
} from "./entitlement";
import { sendMail } from "./mail";
import { logger } from "./logger";
import {
  checkAndAlertBackupStaleness,
} from "./backup";
import { checkEmailPref } from "./email-prefs";
import {
  checkAndAlertInstallerHealth,
  startInstallerHealthCheckJob,
} from "./installer-health-job";
import { cleanupAiMemoryCandidates } from "./ai-memory-cleanup";
import {
  chargeProviderAutoPayCheckout,
  completeProviderAutoPayAttempt,
  getProviderDefaultCard,
} from "./provider-invoice-payments";
import { getUncachableStripeClient } from "./stripeClient";

const GRACE_DAYS = () =>
  Math.max(1, parseInt(process.env.SUBSCRIPTION_GRACE_DAYS ?? "7", 10));

const TRIAL_REMINDER_DAYS = [7, 3, 1];

/**
 * Resolve a display name and email for a billing subject so we can send
 * reminder emails.
 */
async function resolveSubjectContact(
  subjectType: string,
  subjectId: string
): Promise<{ name: string; email: string | null }> {
  if (subjectType === "lab_org" || subjectType === "provider_org") {
    const [org] = await db
      .select({
        name: organizations.displayName,
        billingEmail: organizations.billingEmail,
      })
      .from(organizations)
      .where(and(eq(organizations.id, subjectId), isNull(organizations.deletedAt)));
    if (org) {
      return {
        name: org.name ?? "Your organization",
        email: org.billingEmail ?? null,
      };
    }
  } else {
    const [user] = await db
      .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
      .from(users)
      .where(eq(users.id, subjectId));
    if (user) {
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "there";
      return { name, email: user.email ?? null };
    }
  }
  return { name: "there", email: null };
}

function billingUrl(): string {
  const domains = (process.env.REPLIT_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  const base = domains[0] ? `https://${domains[0]}` : "https://app.labtrax.com";
  return `${base}/billing`;
}

async function sendTrialReminderEmail(
  email: string,
  name: string,
  daysLeft: number
) {
  const url = billingUrl();
  return sendMail({
    to: email,
    subject: `LabTrax trial ends in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}`,
    html: `
      <p>Hi ${name},</p>
      <p>Your LabTrax free trial ends in <strong>${daysLeft} day${daysLeft !== 1 ? "s" : ""}</strong>.</p>
      <p>To keep full access to LabTrax, please add a payment method before your trial ends.</p>
      <p><a href="${url}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">Manage Subscription →</a></p>
      <p>If you have any questions, reply to this email — we're happy to help.</p>
      <p>— The LabTrax Team</p>
    `,
    text: `Hi ${name},\n\nYour LabTrax free trial ends in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}.\n\nAdd a payment method at: ${url}\n\n— The LabTrax Team`,
  });
}

async function sendGraceWarningEmail(
  email: string,
  name: string,
  daysLeft: number
) {
  const url = billingUrl();
  return sendMail({
    to: email,
    subject: "LabTrax — Your account is now read-only",
    html: `
      <p>Hi ${name},</p>
      <p>Your LabTrax trial has ended. Your account is now read-only, so you can keep viewing your existing data without making changes.</p>
      <p>Renew now to restore full access.</p>
      <p><a href="${url}" style="background:#dc2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">Reactivate Now →</a></p>
      <p>— The LabTrax Team</p>
    `,
    text: `Hi ${name},\n\nYour LabTrax trial has ended. Your account remains available in read-only mode. Renew to restore full access at: ${url}\n\n— The LabTrax Team`,
  });
}

async function sendLockedEmail(email: string, name: string) {
  const url = billingUrl();
  return sendMail({
    to: email,
    subject: "LabTrax — Read-only access continues",
    html: `
      <p>Hi ${name},</p>
      <p>Your LabTrax account remains available in read-only mode because the subscription was not renewed.</p>
      <p>Your data is safe and still viewable. Renew to restore full access.</p>
      <p><a href="${url}" style="background:#dc2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">Restore Access →</a></p>
      <p>— The LabTrax Team</p>
    `,
    text: `Hi ${name},\n\nYour LabTrax account remains available in read-only mode. Renew at: ${url}\n\n— The LabTrax Team`,
  });
}

/**
 * Run all billing state-machine transitions:
 *   trialing → grace when trial expires until payment is confirmed
 *   grace    → deactivated when grace period expires (read-only, never a
 *              login lockout)
 */
export async function runBillingTransitions(): Promise<void> {
  const now = new Date();
  const stripe = await getUncachableStripeClient();

  const trialExpired = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "trialing"),
        lt(subscriptions.trialEndAt, now),
        isNull(subscriptions.deletedAt)
      )
    );

  for (const sub of trialExpired) {
    // Hosted signup renewal belongs to Stripe, not the separate invoice
    // auto-pay preference or the local trial-without-card grace transition.
    if (sub.stripeSubscriptionId && (sub.providerOnboardingJson as any)?.attempt?.verifiedAt) continue;
    // Do not let the local grace transition suppress the first prepaid
    // renewal.  Stripe remains authoritative for entitlement; this merely
    // attempts the already-authorized invoice before entering grace.
    if (sub.autoPayEnabled) {
      try {
        await runProviderSubscriptionAutoPay(stripe, sub, now);
      } catch (error: any) {
        logger.warn({ err: error?.message, subscriptionId: sub.id },
          "[billing] Trial renewal payment attempt was inconclusive");
      }
    }
    const [current] = await db.select({ status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.id, sub.id))
      .limit(1);
    if (current?.status !== "trialing") {
      // A processor webhook may have restored active access while the local
      // transition was running. Never overwrite authoritative success.
      continue;
    }
    const scheduledFor = subscriptionChargeDate(now, sub);
    const [renewalAttempt] = await db.select({ status: providerAutoPayAttempts.status })
      .from(providerAutoPayAttempts)
      .where(and(
        eq(providerAutoPayAttempts.subscriptionId, sub.id),
        eq(providerAutoPayAttempts.kind, "subscription"),
        eq(providerAutoPayAttempts.scheduledFor, scheduledFor),
      ))
      .limit(1);
    if (renewalAttempt?.status === "processing" || renewalAttempt?.status === "succeeded") {
      // A confirmed payment or an ambiguous/no-invoice outcome remains under
      // durable reconciliation. Do not send a false grace warning while the
      // processor result is successful or still recoverable.
      continue;
    }
    // A saved payment method is not proof that the first subscription charge
    // settled. Only an authoritative processor success event may restore full
    // access after the trial ends.
    const transition = expiredTrialTransition(sub.paymentMethodOnFile);
    const transitioned = await transitionSubscription(sub.id, transition.status, undefined, {
      reason: transition.reason,
    }, "trialing");
    if (!transitioned) continue;
    const contact = await resolveSubjectContact(sub.subjectType, sub.subjectId);
    if (contact.email) {
      const allowed = await checkEmailPref(contact.email, "billingReminders");
      if (allowed) {
        await sendGraceWarningEmail(contact.email, contact.name, GRACE_DAYS());
      }
    }
  }

  const graceExpired = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "grace"),
        isNull(subscriptions.deletedAt)
      )
    );

  for (const sub of graceExpired) {
    if (!sub.gracePeriodStartAt) continue;
    const graceEndMs =
      sub.gracePeriodStartAt.getTime() + GRACE_DAYS() * 86_400_000;
    if (now.getTime() >= graceEndMs) {
      await transitionSubscription(sub.id, "deactivated", undefined, {
        reason: "grace_period_expired",
      });
      const contact = await resolveSubjectContact(sub.subjectType, sub.subjectId);
      if (contact.email) {
        const allowed = await checkEmailPref(contact.email, "billingReminders");
        if (allowed) {
          await sendLockedEmail(contact.email, contact.name);
        }
      }
    }
  }

  if (trialExpired.length > 0 || graceExpired.length > 0) {
    logger.info(
      {
        trialExpired: trialExpired.length,
        graceExpired: graceExpired.length,
      },
      "[billing] Transitions processed"
    );
  }
}

/**
 * Send trial reminder emails at TRIAL_REMINDER_DAYS milestones.
 * Uses lastReminderKind to avoid sending duplicates.
 */
export async function sendTrialReminders(): Promise<void> {
  const now = new Date();

  const trialing = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "trialing"),
        isNull(subscriptions.deletedAt)
      )
    );

  for (const sub of trialing) {
    if (sub.providerOnboardingJson && sub.stripeSubscriptionId) continue;
    if (!sub.trialEndAt) continue;
    const msLeft = sub.trialEndAt.getTime() - now.getTime();
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

    for (const threshold of TRIAL_REMINDER_DAYS) {
      if (daysLeft <= threshold) {
        const kind = `trial_${threshold}d`;
        if (sub.lastReminderKind === kind) break;

        const contact = await resolveSubjectContact(
          sub.subjectType,
          sub.subjectId
        );
        if (contact.email) {
          const allowed = await checkEmailPref(contact.email, "billingReminders");
          if (allowed) {
            await sendTrialReminderEmail(
              contact.email,
              contact.name,
              daysLeft > 0 ? daysLeft : 1
            );
          }
        }

        await db
          .update(subscriptions)
          .set({ lastReminderSentAt: now, lastReminderKind: kind })
          .where(eq(subscriptions.id, sub.id));

        await appendSubscriptionEvent({
          subscriptionId: sub.id,
          subjectType: sub.subjectType,
          subjectId: sub.subjectId,
          eventType: "trial_reminder_sent",
          rawPayloadJson: { kind, daysLeft, email: contact.email },
        });

        break;
      }
    }
  }
}

/**
 * For every lab that has payments sitting in Undeposited Funds for 2+ days,
 * send an in-app alert notification to all active admin users — at most once
 * per user per day (deduped by checking for an unread notification of this
 * type created today).
 */
async function checkStaleUndepositedPayments(): Promise<void> {
  const ufAccounts = await db.query.bankAccounts.findMany({
    where: and(
      eq(bankAccounts.accountType, "undeposited_funds"),
      eq(bankAccounts.isArchived, false),
    ),
  });
  if (!ufAccounts.length) return;

  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  for (const acct of ufAccounts) {
    const staleTxns = await db.query.bankTransactions.findMany({
      where: and(
        eq(bankTransactions.bankAccountId, acct.id),
        eq(bankTransactions.status, "posted"),
        isNull(bankTransactions.deletedAt),
        lt(bankTransactions.txnDate, twoDaysAgo),
      ),
    });
    if (!staleTxns.length) continue;

    const labId = acct.labOrganizationId;

    const adminMembers = await db.query.organizationMemberships.findMany({
      where: and(
        eq(organizationMemberships.labId, labId),
        eq(organizationMemberships.status, "active"),
        inArray(organizationMemberships.role, ADMIN_ROLES),
      ),
    });
    if (!adminMembers.length) continue;

    const adminUserIds = adminMembers.map((m: any) => m.userId);

    // Skip users who already received this alert today (unread).
    const alreadySent = await db.query.notifications.findMany({
      where: and(
        inArray(notifications.userId, adminUserIds),
        eq(notifications.type, "stale_undeposited_payment"),
        isNull(notifications.readAt),
        gte(notifications.createdAt, todayStart),
      ),
      columns: { userId: true },
    });
    const alreadySentIds = new Set(alreadySent.map((n: any) => n.userId));
    const toNotify = adminMembers.filter((m: any) => !alreadySentIds.has(m.userId));
    if (!toNotify.length) continue;

    const count = staleTxns.length;
    await db.insert(notifications).values(
      toNotify.map((m: any) => ({
        userId: m.userId,
        type: "stale_undeposited_payment",
        title: "Undeposited payments need attention",
        body: `${count} payment${count !== 1 ? "s have" : " has"} been sitting in Undeposited Funds for 2+ days without being deposited.`,
        dataJson: { route: "/finance?tab=deposits" },
      })),
    );
  }
}

const AUTO_PAY_EPSILON = 0.005;
const AUTO_PAY_INVOICE_STATUSES = ["open", "partially_paid", "overdue"] as const;
const CURRENT_AUTOPAY_AGREEMENT_VERSION = "2025-01";

function isAmbiguousProcessorError(error: any): boolean {
  const code = String(error?.code ?? "").toLowerCase();
  const message = String(error?.message ?? "").toLowerCase();
  return ["etimedout", "timeout", "econnreset", "eai_again", "network_error"].some(
    (value) => code.includes(value) || message.includes(value),
  ) || error?.type === "StripeConnectionError";
}

async function hasActiveAutopayAuthorization(
  providerOrganizationId: string,
  kind: "subscription" | "invoice",
  labOrganizationId?: string | null,
  labChargeDay?: number | null,
): Promise<boolean> {
  const [row] = await db
    .select({
      id: providerAutopayAuthorizations.id,
      cardBrand: providerAutopayAuthorizations.cardBrand,
      cardLast4: providerAutopayAuthorizations.cardLast4,
      cardExpMonth: providerAutopayAuthorizations.cardExpMonth,
      cardExpYear: providerAutopayAuthorizations.cardExpYear,
      customerCardBrand: providerPaymentCustomers.cardBrand,
      customerCardLast4: providerPaymentCustomers.cardLast4,
      customerCardExpMonth: providerPaymentCustomers.cardExpMonth,
      customerCardExpYear: providerPaymentCustomers.cardExpYear,
      customerCardStatus: providerPaymentCustomers.cardStatus,
    })
    .from(providerAutopayAuthorizations)
    .innerJoin(
      providerPaymentCustomers,
      eq(providerPaymentCustomers.providerOrganizationId, providerAutopayAuthorizations.providerOrganizationId),
    )
    .leftJoin(
      providerAutopayAuthorizationLabs,
      eq(providerAutopayAuthorizationLabs.authorizationId, providerAutopayAuthorizations.id),
    )
    .where(and(
      eq(providerAutopayAuthorizations.providerOrganizationId, providerOrganizationId),
      eq(providerAutopayAuthorizations.status, "active"),
      eq(providerAutopayAuthorizations.agreementVersion, CURRENT_AUTOPAY_AGREEMENT_VERSION),
      eq(providerAutopayAuthorizations.cardStatus, "active"),
      eq(providerAutopayAuthorizations.consent, true),
      kind === "subscription"
        ? eq(providerAutopayAuthorizations.subscriptionFees, true)
        : eq(providerAutopayAuthorizations.labBills, true),
      labOrganizationId
        ? eq(providerAutopayAuthorizationLabs.labOrganizationId, labOrganizationId)
        : undefined,
      kind === "invoice" && labChargeDay != null
        ? eq(providerAutopayAuthorizations.labChargeDay, labChargeDay)
        : undefined,
    ))
    .limit(1);
  if (!row || row.customerCardStatus !== "active") return false;
  const now = new Date();
  const expired =
    row.cardExpYear < now.getUTCFullYear() ||
    (row.cardExpYear === now.getUTCFullYear() &&
      row.cardExpMonth < now.getUTCMonth() + 1);
  return !expired &&
    row.cardBrand === row.customerCardBrand &&
    row.cardLast4 === row.customerCardLast4 &&
    row.cardExpMonth === row.customerCardExpMonth &&
    row.cardExpYear === row.customerCardExpYear;
}

async function getExecutableInvoiceCard(
  providerOrganizationId: string,
  stripe: import("stripe").default,
): Promise<Awaited<ReturnType<typeof getProviderDefaultCard>> | null> {
  const [customer] = await db.select().from(providerPaymentCustomers)
    .where(eq(providerPaymentCustomers.providerOrganizationId, providerOrganizationId)).limit(1);
  const [provider] = await db.select({ parentLabOrganizationId: organizations.parentLabOrganizationId })
    .from(organizations).where(eq(organizations.id, providerOrganizationId)).limit(1);
  if (!customer?.invoiceAutoPayEnabled || !(await hasActiveAutopayAuthorization(
    providerOrganizationId,
    "invoice",
    provider?.parentLabOrganizationId,
    customer.invoiceAutoPayChargeDay,
  ))) return null;
  const card = await getProviderDefaultCard(providerOrganizationId, stripe);
  if (!card || card.cardBrand !== customer.cardBrand || card.cardLast4 !== customer.cardLast4 ||
      card.cardExpMonth !== customer.cardExpMonth || card.cardExpYear !== customer.cardExpYear) {
    return null;
  }
  return card;
}

async function getExecutableSubscriptionCard(
  providerOrganizationId: string,
  stripe: import("stripe").default,
): Promise<Awaited<ReturnType<typeof getProviderDefaultCard>> | null> {
  if (!(await hasActiveAutopayAuthorization(providerOrganizationId, "subscription"))) return null;
  const [customer] = await db.select().from(providerPaymentCustomers)
    .where(eq(providerPaymentCustomers.providerOrganizationId, providerOrganizationId)).limit(1);
  const card = await getProviderDefaultCard(providerOrganizationId, stripe);
  return customer && card &&
    card.cardBrand === customer.cardBrand && card.cardLast4 === customer.cardLast4 &&
    card.cardExpMonth === customer.cardExpMonth && card.cardExpYear === customer.cardExpYear
    ? card
    : null;
}

function utcDateStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function sameUtcDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function nextChargeDate(now: Date, chargeDay: number): Date {
  const today = utcDateStart(now);
  const currentMonthDate = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), chargeDay),
  );
  if (today.getUTCDate() <= chargeDay) return currentMonthDate;
  return new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, chargeDay),
  );
}

function currentMonthChargeDate(now: Date, chargeDay: number): Date {
  const today = utcDateStart(now);
  return new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), chargeDay),
  );
}

// Provider renewals are prepaid: the first charge is due on the first day
// after trial, and every subsequent renewal is exactly 30 days later. Legacy
// rows without a trial end retain their configured calendar-day schedule.
function subscriptionChargeDate(
  now: Date,
  subscription: typeof subscriptions.$inferSelect,
): Date {
  if (!subscription.trialEndAt || now.getTime() < subscription.trialEndAt.getTime()) {
    return currentMonthChargeDate(now, subscription.autoPayChargeDay);
  }
  const first = utcDateStart(subscription.trialEndAt);
  const today = utcDateStart(now);
  const elapsed = Math.max(0, Math.floor((today.getTime() - first.getTime()) / 86_400_000));
  return addUtcDays(first, Math.floor(elapsed / 30) * 30);
}

async function claimProviderAutoPayAttempt(input: {
  providerOrganizationId: string;
  subscriptionId?: string;
  kind: string;
  scheduledFor: Date;
  amount: number;
}) {
  const [attempt] = await db
    .insert(providerAutoPayAttempts)
    .values({
      providerOrganizationId: input.providerOrganizationId,
      subscriptionId: input.subscriptionId,
      kind: input.kind,
      scheduledFor: input.scheduledFor,
      amount: input.amount.toFixed(2),
      status: "processing",
    })
    .onConflictDoNothing({
      target: [
        providerAutoPayAttempts.providerOrganizationId,
        providerAutoPayAttempts.kind,
        providerAutoPayAttempts.scheduledFor,
      ],
    })
    .returning();
  return attempt ?? null;
}

async function sendProviderAutoPayReminder(input: {
  providerOrganizationId: string;
  subscriptionId?: string;
  kind: "subscription" | "invoice";
  scheduledFor: Date;
}) {
  await db.transaction(async (tx) => {
    const [reminderAttempt] = await tx
      .insert(providerAutoPayAttempts)
      .values({
        providerOrganizationId: input.providerOrganizationId,
        subscriptionId: input.subscriptionId,
        kind: `${input.kind}_reminder`,
        scheduledFor: input.scheduledFor,
        amount: "0.00",
        status: "processing",
      })
      .onConflictDoNothing({
        target: [
          providerAutoPayAttempts.providerOrganizationId,
          providerAutoPayAttempts.kind,
          providerAutoPayAttempts.scheduledFor,
        ],
      })
      .returning();
    if (!reminderAttempt) return;

    const [organization] = await tx
      .select({
        name: organizations.name,
        displayName: organizations.displayName,
      })
      .from(organizations)
      .where(eq(organizations.id, input.providerOrganizationId))
      .limit(1);
    const recipients = await tx
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.labId, input.providerOrganizationId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt),
        ),
      );
    if (recipients.length > 0) {
      const providerName =
        organization?.displayName ??
        organization?.name ??
        "Your provider account";
      await tx.insert(notifications).values(
        recipients.map(({ userId }) => ({
          userId,
          type: "provider_auto_pay_reminder",
          title: `${input.kind === "subscription" ? "Subscription" : "Invoice"} auto-pay is coming up`,
          body: `${providerName} will charge the shared card on ${input.scheduledFor.toISOString().slice(0, 10)}.`,
          dataJson: {
            providerOrganizationId: input.providerOrganizationId,
            kind: input.kind,
            scheduledFor: input.scheduledFor.toISOString(),
            autoPayAttemptId: reminderAttempt.id,
          },
        })),
      );
    }
    await tx
      .update(providerAutoPayAttempts)
      .set({
        status: "succeeded",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(providerAutoPayAttempts.id, reminderAttempt.id));
  });
}

async function recordProviderAutoPayResult(input: {
  attemptId: string;
  providerOrganizationId: string;
  kind: "subscription" | "invoice";
  scheduledFor: Date;
  amount: number;
  status: "succeeded" | "failed" | "skipped";
  stripePaymentIntentId?: string | null;
  failureReason?: string | null;
}) {
  await completeProviderAutoPayAttempt({
    attemptId: input.attemptId,
    status: input.status,
    amount: input.amount,
    stripePaymentIntentId: input.stripePaymentIntentId,
    failureReason: input.failureReason,
  });
}

async function resolveSubscriptionInvoice(
  stripe: import("stripe").default,
  subscription: typeof subscriptions.$inferSelect,
): Promise<{
  id: string;
  customerId: string | null;
  amount: number;
} | null> {
  if (!subscription.stripeSubscriptionId) return null;
  const openInvoices = await stripe.invoices.list({
    customer: subscription.stripeCustomerId ?? undefined,
    subscription: subscription.stripeSubscriptionId,
    status: "open",
    limit: 100,
  });
  const invoice = openInvoices.data.find(
    (candidate) => (candidate.amount_remaining ?? 0) > 0,
  );
  if (!invoice) return null;
  return {
    id: invoice.id,
    customerId:
      typeof invoice.customer === "string"
        ? invoice.customer
        : invoice.customer?.id ?? null,
    amount: (invoice.amount_remaining ?? 0) / 100,
  };
}

async function runProviderSubscriptionAutoPay(
  stripe: import("stripe").default | null,
  subscription: typeof subscriptions.$inferSelect,
  now: Date,
): Promise<void> {
  // Hosted signup subscriptions renew through Stripe itself. The legacy
  // invoice scheduler must not produce a second subscription charge.
  if (subscription.providerOnboardingJson && subscription.stripeSubscriptionId) return;
  if (!(await hasActiveAutopayAuthorization(subscription.subjectId, "subscription"))) return;
  const today = utcDateStart(now);
  const upcomingCharge = subscriptionChargeDate(now, subscription);
  const fixedRenewal = Boolean(subscription.trialEndAt && now.getTime() >= subscription.trialEndAt.getTime());
  if (fixedRenewal) {
    // The 30-day prepaid schedule is date-driven rather than charge-day driven.
    // Once the due date is reached, the durable attempt claim below is the
    // only gate, so restarts and multiple instances remain harmless.
  } else if (today.getUTCDate() < subscription.autoPayChargeDay) {
    if (sameUtcDate(addUtcDays(today, 3), upcomingCharge)) {
      await sendProviderAutoPayReminder({
        providerOrganizationId: subscription.subjectId,
        subscriptionId: subscription.id,
        kind: "subscription",
        scheduledFor: upcomingCharge,
      });
    }
    return;
  }
  const scheduledFor = subscriptionChargeDate(now, subscription);

  const attempt = await claimProviderAutoPayAttempt({
    providerOrganizationId: subscription.subjectId,
    subscriptionId: subscription.id,
    kind: "subscription",
    scheduledFor,
    amount: 0,
  });
  if (!attempt) return;

  if (!stripe) {
    await recordProviderAutoPayResult({
      attemptId: attempt.id,
      providerOrganizationId: subscription.subjectId,
      kind: "subscription",
      scheduledFor,
      amount: 0,
      status: "failed",
      failureReason: "stripe_not_configured",
    });
    return;
  }

  let amount = 0;
  try {
    const stripeInvoice = await resolveSubscriptionInvoice(stripe, subscription);
    amount = stripeInvoice?.amount ?? 0;
    if (!stripeInvoice || amount <= AUTO_PAY_EPSILON) {
      if (fixedRenewal && !stripeInvoice) {
        // Stripe can create the first payable invoice shortly after the trial
        // boundary. Keep the durable claim processing so reconciliation can
        // pay that same schedule once the invoice appears.
        return;
      }
      await recordProviderAutoPayResult({
        attemptId: attempt.id,
        providerOrganizationId: subscription.subjectId,
        kind: "subscription",
        scheduledFor,
        amount,
        status: "skipped",
      });
      return;
    }
    const card = await getExecutableSubscriptionCard(subscription.subjectId, stripe);
    if (!card) throw new Error("shared_card_unavailable");
    if (stripeInvoice.customerId !== card.stripeCustomerId) {
      throw new Error("shared_card_customer_mismatch");
    }
    await db
      .update(providerAutoPayAttempts)
      .set({ amount: amount.toFixed(2), updatedAt: new Date() })
      .where(eq(providerAutoPayAttempts.id, attempt.id));
    await stripe.invoices.update(stripeInvoice.id, {
      metadata: { providerAutoPayAttemptId: attempt.id },
    });
    const paidInvoice = await stripe.invoices.pay(
      stripeInvoice.id,
      { payment_method: card.paymentMethodId },
      { idempotencyKey: `provider-auto-pay-${attempt.id}` },
    );
    const succeeded = paidInvoice.status === "paid";
    await recordProviderAutoPayResult({
      attemptId: attempt.id,
      providerOrganizationId: subscription.subjectId,
      kind: "subscription",
      scheduledFor,
      amount,
      status: succeeded ? "succeeded" : "failed",
      failureReason: succeeded ? "anchor_pending" : `stripe_invoice_${paidInvoice.status}`,
    });
    if (succeeded) {
      await applySubscriptionRenewalAnchor(attempt.id, stripe);
      // Evidence failure must never turn a collected payment into a failed
      // charge/retry. The historical reader can repair the missing receipt.
      if (paidInvoice?.livemode === true) {
        try {
          const { ingestStripeInvoice } = await import("./subscription-evidence");
          await ingestStripeInvoice(paidInvoice, subscription.id);
        } catch (err) {
          logger.error({ err, subscriptionId: subscription.id }, "[billing] Collected subscription receipt awaits reconciliation");
        }
      }
    }
  } catch (error: any) {
    if (isAmbiguousProcessorError(error)) {
      // The processor may have accepted the charge. Keep the durable attempt
      // processing so a webhook or reconciliation pass can settle it.
      logger.warn({ err: error?.message, attemptId: attempt.id },
        "[billing] Subscription charge outcome is ambiguous; awaiting webhook");
      return;
    }
    await recordProviderAutoPayResult({
      attemptId: attempt.id,
      providerOrganizationId: subscription.subjectId,
      kind: "subscription",
      scheduledFor,
      amount,
      status: "failed",
      failureReason: error?.code ?? "stripe_charge_failed",
    });
  }
}

/** Apply the prepaid 30-day anchor only after processor success is durable. */
export async function applySubscriptionRenewalAnchor(
  attemptId: string,
  stripeOverride?: import("stripe").default | null,
): Promise<void> {
  const [attempt] = await db.select().from(providerAutoPayAttempts)
    .where(eq(providerAutoPayAttempts.id, attemptId)).limit(1);
  if (
    !attempt ||
    attempt.kind !== "subscription" ||
    attempt.status !== "succeeded" ||
    attempt.failureReason !== "anchor_pending" ||
    !attempt.subscriptionId
  ) return;
  const [subscription] = await db.select().from(subscriptions)
    .where(eq(subscriptions.id, attempt.subscriptionId!)).limit(1);
  if (!subscription?.stripeSubscriptionId) return;
  const stripe = stripeOverride ?? await getUncachableStripeClient();
  if (!stripe) return;
  const nextAnchor = addUtcDays(utcDateStart(attempt.scheduledFor), 30);
  try {
    await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      billing_cycle_anchor: Math.floor(nextAnchor.getTime() / 1000),
      proration_behavior: "none",
    } as unknown as import("stripe").default.SubscriptionUpdateParams);
    await db.update(providerAutoPayAttempts).set({
      failureReason: null,
      updatedAt: new Date(),
    }).where(eq(providerAutoPayAttempts.id, attempt.id));
  } catch (error) {
    // Payment success is permanent; anchor application is a separately
    // recoverable state and must be retried by reconciliation.
    await db.update(providerAutoPayAttempts).set({
      failureReason: "anchor_pending",
      updatedAt: new Date(),
    }).where(eq(providerAutoPayAttempts.id, attempt.id));
    throw error;
  }
}

/**
 * Recover the narrow crash window after an invoice attempt is claimed but
 * before its checkout id is persisted. The advisory lock makes this use the
 * same reservation boundary as manual provider payments.
 */
async function reconstructInvoiceAttemptCheckout(
  attempt: typeof providerAutoPayAttempts.$inferSelect,
): Promise<{ checkoutId: string; amount: number } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${attempt.providerOrganizationId}))`);
    const [current] = await tx.select().from(providerAutoPayAttempts)
      .where(eq(providerAutoPayAttempts.id, attempt.id)).for("update");
    if (!current || current.status !== "processing" || current.providerPaymentCheckoutId) {
      return current?.providerPaymentCheckoutId
        ? { checkoutId: current.providerPaymentCheckoutId, amount: Number(current.amount) }
        : null;
    }
    const [orphan] = await tx.select().from(providerPaymentCheckouts)
      .where(and(
        eq(providerPaymentCheckouts.providerOrganizationId, attempt.providerOrganizationId),
        eq(providerPaymentCheckouts.clientRequestId, `provider-auto-pay-${attempt.id}`),
      )).for("update").limit(1);
    const orphanAllocations = orphan
      ? await tx.select({ id: providerPaymentAllocations.id }).from(providerPaymentAllocations)
        .where(eq(providerPaymentAllocations.checkoutId, orphan.id)).limit(1)
      : [];
    if (orphan && orphanAllocations.length > 0) {
      await tx.update(providerAutoPayAttempts).set({
        providerPaymentCheckoutId: orphan.id,
        amount: orphan.totalAmount,
        updatedAt: new Date(),
      }).where(and(
        eq(providerAutoPayAttempts.id, attempt.id),
        eq(providerAutoPayAttempts.status, "processing"),
      ));
      return { checkoutId: orphan.id, amount: Number(orphan.totalAmount) };
    }
    const [customer] = await tx.select().from(providerPaymentCustomers)
      .where(eq(providerPaymentCustomers.providerOrganizationId, attempt.providerOrganizationId))
      .limit(1);
    if (!customer?.invoiceAutoPayEnabled) return null;
    const [provider] = await tx.select({ parentLabOrganizationId: organizations.parentLabOrganizationId })
      .from(organizations).where(eq(organizations.id, attempt.providerOrganizationId)).limit(1);
    const authorized = await hasActiveAutopayAuthorization(
      attempt.providerOrganizationId,
      "invoice",
      provider?.parentLabOrganizationId,
      customer.invoiceAutoPayChargeDay,
    );
    if (!authorized) return null;
    const eligible = await tx.select().from(invoices).where(and(
      eq(invoices.providerOrganizationId, attempt.providerOrganizationId),
      isNull(invoices.deletedAt),
      inArray(invoices.status, [...AUTO_PAY_INVOICE_STATUSES]),
      finalizedInvoiceSql(),
    )).orderBy(asc(invoices.createdAt)).for("update");
    const payable = eligible.filter((invoice) => Number(invoice.balanceDue) > AUTO_PAY_EPSILON);
    if (!payable.length) return null;
    const amount = payable.reduce((sum, invoice) => sum + Number(invoice.balanceDue), 0);
    const [member] = await tx.select({ userId: organizationMemberships.userId })
      .from(organizationMemberships).where(and(
        eq(organizationMemberships.labId, attempt.providerOrganizationId),
        eq(organizationMemberships.status, "active"),
      )).limit(1);
    if (!member) return null;
    const [createdCheckout] = orphan
      ? [orphan]
      : await tx.insert(providerPaymentCheckouts).values({
      providerOrganizationId: attempt.providerOrganizationId,
      initiatedByUserId: member.userId,
      clientRequestId: `provider-auto-pay-${attempt.id}`,
      totalAmount: amount.toFixed(2),
      currency: "usd",
      savePaymentMethod: false,
      status: "pending",
    }).returning();
    const checkout = createdCheckout!;
    if (orphan) {
      await tx.update(providerPaymentCheckouts).set({
        totalAmount: amount.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(providerPaymentCheckouts.id, orphan.id));
    }
    await tx.insert(providerPaymentAllocations).values(payable.map((invoice) => ({
      checkoutId: checkout.id,
      invoiceId: invoice.id,
      amount: Number(invoice.balanceDue).toFixed(2),
    })));
    await tx.update(providerAutoPayAttempts).set({
      providerPaymentCheckoutId: checkout.id,
      amount: amount.toFixed(2),
      updatedAt: new Date(),
    }).where(and(
      eq(providerAutoPayAttempts.id, attempt.id),
      eq(providerAutoPayAttempts.status, "processing"),
    ));
    return { checkoutId: checkout.id, amount };
  });
}

async function rebuildInvoiceAttemptAllocations(
  attempt: typeof providerAutoPayAttempts.$inferSelect,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${attempt.providerOrganizationId}))`);
    const [customer] = await tx.select().from(providerPaymentCustomers)
      .where(eq(providerPaymentCustomers.providerOrganizationId, attempt.providerOrganizationId))
      .limit(1);
    const [provider] = await tx.select({ parentLabOrganizationId: organizations.parentLabOrganizationId })
      .from(organizations).where(eq(organizations.id, attempt.providerOrganizationId)).limit(1);
    if (!customer?.invoiceAutoPayEnabled || !(await hasActiveAutopayAuthorization(
      attempt.providerOrganizationId,
      "invoice",
      provider?.parentLabOrganizationId,
      customer.invoiceAutoPayChargeDay,
    ))) return null;
    const [checkout] = await tx.select().from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.id, attempt.providerPaymentCheckoutId!))
      .for("update");
    if (!checkout || checkout.status !== "pending") return null;
    const rows = await tx.select().from(invoices).where(and(
      eq(invoices.providerOrganizationId, attempt.providerOrganizationId),
      isNull(invoices.deletedAt),
      inArray(invoices.status, [...AUTO_PAY_INVOICE_STATUSES]),
      finalizedInvoiceSql(),
    )).orderBy(asc(invoices.createdAt)).for("update");
    const eligible = rows.filter((invoice) => Number(invoice.balanceDue) > AUTO_PAY_EPSILON);
    if (!eligible.length) return null;
    await tx.delete(providerPaymentAllocations)
      .where(eq(providerPaymentAllocations.checkoutId, checkout.id));
    const amount = eligible.reduce((total, invoice) => total + Number(invoice.balanceDue), 0);
    await tx.insert(providerPaymentAllocations).values(eligible.map((invoice) => ({
      checkoutId: checkout.id,
      invoiceId: invoice.id,
      amount: Number(invoice.balanceDue).toFixed(2),
    })));
    await tx.update(providerPaymentCheckouts).set({
      totalAmount: amount.toFixed(2),
      updatedAt: new Date(),
    }).where(eq(providerPaymentCheckouts.id, checkout.id));
    await tx.update(providerAutoPayAttempts).set({
      amount: amount.toFixed(2),
      updatedAt: new Date(),
    }).where(and(
      eq(providerAutoPayAttempts.id, attempt.id),
      eq(providerAutoPayAttempts.status, "processing"),
    ));
    return amount;
  });
}

async function runProviderInvoiceAutoPay(
  stripe: import("stripe").default | null,
  customer: typeof providerPaymentCustomers.$inferSelect,
  now: Date,
): Promise<void> {
  const [provider] = await db
    .select({ parentLabOrganizationId: organizations.parentLabOrganizationId })
    .from(organizations)
    .where(eq(organizations.id, customer.providerOrganizationId))
    .limit(1);
  if (!(await hasActiveAutopayAuthorization(
    customer.providerOrganizationId,
    "invoice",
    provider?.parentLabOrganizationId,
    customer.invoiceAutoPayChargeDay,
  ))) return;
  const today = utcDateStart(now);
  const upcomingCharge = nextChargeDate(now, customer.invoiceAutoPayChargeDay);
  if (today.getUTCDate() < customer.invoiceAutoPayChargeDay) {
    if (sameUtcDate(addUtcDays(today, 3), upcomingCharge)) {
      await sendProviderAutoPayReminder({
        providerOrganizationId: customer.providerOrganizationId,
        kind: "invoice",
        scheduledFor: upcomingCharge,
      });
    }
    return;
  }
  const scheduledFor = currentMonthChargeDate(
    now,
    customer.invoiceAutoPayChargeDay,
  );

  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.providerOrganizationId, customer.providerOrganizationId),
        isNull(invoices.deletedAt),
        inArray(invoices.status, [...AUTO_PAY_INVOICE_STATUSES]),
        finalizedInvoiceSql(),
      ),
    )
    .orderBy(asc(invoices.createdAt));
  const eligible = invoiceRows.filter(
    (invoice) => Number(invoice.balanceDue) > AUTO_PAY_EPSILON,
  );
  const amount = eligible.reduce(
    (total, invoice) => total + Number(invoice.balanceDue),
    0,
  );
  const attempt = await claimProviderAutoPayAttempt({
    providerOrganizationId: customer.providerOrganizationId,
    kind: "invoice",
    scheduledFor,
    amount,
  });
  if (!attempt) return;
  if (eligible.length === 0) {
    await recordProviderAutoPayResult({
      attemptId: attempt.id,
      providerOrganizationId: customer.providerOrganizationId,
      kind: "invoice",
      scheduledFor,
      amount: 0,
      status: "skipped",
    });
    return;
  }
  if (!stripe) {
    await recordProviderAutoPayResult({
      attemptId: attempt.id,
      providerOrganizationId: customer.providerOrganizationId,
      kind: "invoice",
      scheduledFor,
      amount,
      status: "failed",
      failureReason: "stripe_not_configured",
    });
    return;
  }

  let checkoutId: string | null = null;
  try {
    const [member] = await db
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.labId, customer.providerOrganizationId),
          eq(organizationMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (!member) throw new Error("provider_membership_unavailable");

    const [checkout] = await db
      .insert(providerPaymentCheckouts)
      .values({
        providerOrganizationId: customer.providerOrganizationId,
        initiatedByUserId: member.userId,
        clientRequestId: `provider-auto-pay-${attempt.id}`,
        totalAmount: amount.toFixed(2),
        currency: "usd",
        savePaymentMethod: false,
        status: "pending",
      })
      .returning();
    checkoutId = checkout.id;
    await db
      .update(providerAutoPayAttempts)
      .set({
        providerPaymentCheckoutId: checkout.id,
        updatedAt: new Date(),
      })
      .where(eq(providerAutoPayAttempts.id, attempt.id));
    await db.insert(providerPaymentAllocations).values(
      eligible.map((invoice) => ({
        checkoutId: checkout.id,
        invoiceId: invoice.id,
        amount: Number(invoice.balanceDue).toFixed(2),
      })),
    );

    const card = await getExecutableInvoiceCard(customer.providerOrganizationId, stripe);
    if (!card) throw new Error("shared_card_unavailable");
    const paymentIntent = await chargeProviderAutoPayCheckout(stripe, {
      checkoutId: checkout.id,
      providerOrganizationId: customer.providerOrganizationId,
      attemptId: attempt.id,
      stripeCustomerId: card.stripeCustomerId,
      paymentMethodId: card.paymentMethodId,
      amountCents: Math.round(amount * 100),
    });
    await recordProviderAutoPayResult({
      attemptId: attempt.id,
      providerOrganizationId: customer.providerOrganizationId,
      kind: "invoice",
      scheduledFor,
      amount,
      status: "succeeded",
      stripePaymentIntentId: paymentIntent.id,
    });
  } catch (error: any) {
    if (checkoutId) {
      if (!isAmbiguousProcessorError(error)) {
        await db
          .update(providerPaymentCheckouts)
          .set({
            status: "failed",
            failureReason: error?.code ?? "stripe_charge_failed",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(providerPaymentCheckouts.id, checkoutId),
              eq(providerPaymentCheckouts.status, "pending"),
            ),
          );
      }
    }
    if (isAmbiguousProcessorError(error)) {
      logger.warn({ err: error?.message, attemptId: attempt.id },
        "[billing] Invoice charge outcome is ambiguous; awaiting webhook");
      return;
    }
    await recordProviderAutoPayResult({
      attemptId: attempt.id,
      providerOrganizationId: customer.providerOrganizationId,
      kind: "invoice",
      scheduledFor,
      amount,
      status: "failed",
      failureReason: error?.code ?? "stripe_charge_failed",
    });
  }
}

/** Reconcile work abandoned by a crashed worker before the next schedule run. */
export async function reconcileStaleProviderAutoPayAttempts(
  now = new Date(),
  maxAgeMs = 15 * 60 * 1000,
): Promise<void> {
  const stripe = await getUncachableStripeClient();
  const stale = await db.select().from(providerAutoPayAttempts).where(
    and(
      or(
        eq(providerAutoPayAttempts.status, "processing"),
        and(
          eq(providerAutoPayAttempts.status, "succeeded"),
          eq(providerAutoPayAttempts.failureReason, "anchor_pending"),
        ),
      ),
      lt(providerAutoPayAttempts.updatedAt, new Date(now.getTime() - maxAgeMs)),
    ),
  );
  for (const originalAttempt of stale) {
    let attempt = originalAttempt;
    if (attempt.status === "succeeded" && attempt.failureReason === "anchor_pending") {
      try {
        await applySubscriptionRenewalAnchor(attempt.id, stripe);
      } catch {
        continue;
      }
      continue;
    }
    if (stripe && attempt.stripePaymentIntentId) {
      try {
        const intent = await stripe.paymentIntents.retrieve(attempt.stripePaymentIntentId);
        if (intent.status === "succeeded") {
          await completeProviderAutoPayAttempt({
            attemptId: attempt.id,
            status: "succeeded",
            stripePaymentIntentId: intent.id,
          });
          continue;
        }
        if (["canceled", "requires_payment_method"].includes(intent.status)) {
          await completeProviderAutoPayAttempt({
            attemptId: attempt.id,
            status: "failed",
            failureReason: `stripe_${intent.status}`,
          });
          continue;
        }
      } catch {
        // Keep ambiguous processor state pending for a later webhook/retry.
        continue;
      }
    }
    // A worker can die before Stripe returns an intent id. Replay the exact
    // operation using the attempt idempotency key; Stripe will return the
    // original intent instead of creating a second charge.
    if (attempt.kind === "invoice" && !attempt.providerPaymentCheckoutId) {
      try {
        const reconstructed = await reconstructInvoiceAttemptCheckout(attempt);
        if (!reconstructed) continue;
        attempt = {
          ...attempt,
          providerPaymentCheckoutId: reconstructed.checkoutId,
          amount: reconstructed.amount.toFixed(2),
        };
      } catch {
        continue;
      }
    }
    if (stripe && attempt.kind === "invoice" && attempt.providerPaymentCheckoutId) {
      try {
        const [checkout] = await db.select().from(providerPaymentCheckouts)
          .where(eq(providerPaymentCheckouts.id, attempt.providerPaymentCheckoutId))
          .limit(1);
        const [customer] = await db.select().from(providerPaymentCustomers)
          .where(eq(providerPaymentCustomers.providerOrganizationId, attempt.providerOrganizationId))
          .limit(1);
        if (checkout?.status === "succeeded") {
          await completeProviderAutoPayAttempt({
            attemptId: attempt.id,
            status: "succeeded",
            stripePaymentIntentId: checkout.stripePaymentIntentId,
          });
          continue;
        }
        if (checkout?.status === "pending" && customer) {
          const card = await getExecutableInvoiceCard(attempt.providerOrganizationId, stripe);
          if (card) {
            const replayed = await chargeProviderAutoPayCheckout(stripe, {
              checkoutId: checkout.id,
              providerOrganizationId: attempt.providerOrganizationId,
              attemptId: attempt.id,
              stripeCustomerId: card.stripeCustomerId,
              paymentMethodId: card.paymentMethodId,
              amountCents: Math.round(Number(attempt.amount) * 100),
            });
            await completeProviderAutoPayAttempt({
              attemptId: attempt.id,
              status: "succeeded",
              stripePaymentIntentId: replayed.id,
            });
            continue;
          }
          await recordProviderAutoPayResult({
            attemptId: attempt.id,
            providerOrganizationId: attempt.providerOrganizationId,
            kind: "invoice",
            scheduledFor: attempt.scheduledFor,
            amount: Number(attempt.amount),
            status: "skipped",
            failureReason: "authorization_revoked_or_card_changed",
          });
          continue;
        }
      } catch (error: any) {
        if (isAmbiguousProcessorError(error)) {
          // Stripe may have accepted the original idempotent request.
          continue;
        }
        // A 409 from invoice/payment locks is deterministic: refresh the
        // reservation under the same lock and retry exactly once.
        try {
          const amount = await rebuildInvoiceAttemptAllocations(attempt);
          if (amount == null) {
            await recordProviderAutoPayResult({
              attemptId: attempt.id,
              providerOrganizationId: attempt.providerOrganizationId,
              kind: "invoice",
              scheduledFor: attempt.scheduledFor,
              amount: 0,
              status: "skipped",
              failureReason: "no_eligible_balance_after_race",
            });
            continue;
          }
          const card = await getExecutableInvoiceCard(attempt.providerOrganizationId, stripe);
          if (!card) {
            await recordProviderAutoPayResult({
              attemptId: attempt.id,
              providerOrganizationId: attempt.providerOrganizationId,
              kind: "invoice",
              scheduledFor: attempt.scheduledFor,
              amount,
              status: "failed",
              failureReason: "shared_card_unavailable",
            });
            continue;
          }
          const replayed = await chargeProviderAutoPayCheckout(stripe, {
            checkoutId: attempt.providerPaymentCheckoutId!,
            providerOrganizationId: attempt.providerOrganizationId,
            attemptId: attempt.id,
            stripeCustomerId: card.stripeCustomerId,
            paymentMethodId: card.paymentMethodId,
            amountCents: Math.round(amount * 100),
          });
          await completeProviderAutoPayAttempt({
            attemptId: attempt.id,
            status: "succeeded",
            amount,
            stripePaymentIntentId: replayed.id,
          });
        } catch (retryError: any) {
          if (!isAmbiguousProcessorError(retryError)) {
            await recordProviderAutoPayResult({
              attemptId: attempt.id,
              providerOrganizationId: attempt.providerOrganizationId,
              kind: "invoice",
              scheduledFor: attempt.scheduledFor,
              amount: Number(attempt.amount),
              status: "failed",
              failureReason: retryError?.code ?? "invoice_reservation_conflict",
            });
          }
        }
      }
    }
    if (stripe && attempt.kind === "subscription" && attempt.subscriptionId) {
      try {
        const [sub] = await db.select().from(subscriptions)
          .where(eq(subscriptions.id, attempt.subscriptionId)).limit(1);
        if (sub?.stripeSubscriptionId) {
          const invoices = await stripe.invoices.list({
            subscription: sub.stripeSubscriptionId,
            limit: 100,
          });
          const matched = invoices.data.find(
            (invoice) => invoice.metadata?.providerAutoPayAttemptId === attempt.id,
          );
          if (matched?.status === "paid") {
            await completeProviderAutoPayAttempt({
              attemptId: attempt.id,
              status: "succeeded",
              failureReason: "anchor_pending",
            });
            await applySubscriptionRenewalAnchor(attempt.id, stripe);
            continue;
          }
          // Crash before invoices.pay: recover the tagged open invoice with
          // the original attempt idempotency key, never a new attempt.
          const open = matched ?? (await resolveSubscriptionInvoice(stripe, sub));
          const openCustomerId = open && typeof (open as any).customer === "string"
            ? (open as any).customer
            : (open as any)?.customerId;
          if (open && (open as any).status !== "paid") {
            if (
              !sub.autoPayEnabled ||
              (sub.status !== "active" && sub.status !== "grace" && sub.status !== "trialing")
            ) {
              await db.update(providerAutoPayAttempts).set({
                status: "skipped",
                failureReason: "subscription_autopay_disabled",
                completedAt: now,
                updatedAt: now,
              }).where(and(
                eq(providerAutoPayAttempts.id, attempt.id),
                eq(providerAutoPayAttempts.status, "processing"),
              ));
              continue;
            }
            const card = await getExecutableSubscriptionCard(sub.subjectId, stripe);
            if (!card) {
              await db.update(providerAutoPayAttempts).set({
                status: "skipped",
                failureReason: "authorization_revoked_or_card_changed",
                completedAt: now,
                updatedAt: now,
              }).where(and(
                eq(providerAutoPayAttempts.id, attempt.id),
                eq(providerAutoPayAttempts.status, "processing"),
              ));
              continue;
            }
            if (openCustomerId !== card.stripeCustomerId) continue;
            const paid = await stripe.invoices.pay(
              (open as any).id,
              { payment_method: card.paymentMethodId },
              { idempotencyKey: `provider-auto-pay-${attempt.id}` },
            );
            if (paid.status === "paid") {
              await db.update(providerAutoPayAttempts).set({
                status: "succeeded",
                stripePaymentIntentId: (paid as any).payment_intent ?? null,
                completedAt: now,
                updatedAt: now,
                failureReason: "anchor_pending",
              }).where(and(
                eq(providerAutoPayAttempts.id, attempt.id),
                eq(providerAutoPayAttempts.status, "processing"),
              ));
              await applySubscriptionRenewalAnchor(attempt.id, stripe);
              continue;
            }
          }
          if (!open) {
            await db.update(providerAutoPayAttempts).set({
              failureReason: "awaiting_stripe_invoice",
              updatedAt: now,
            }).where(and(
              eq(providerAutoPayAttempts.id, attempt.id),
              eq(providerAutoPayAttempts.status, "processing"),
            ));
            continue;
          }
        }
      } catch {
        continue;
      }
    }
    // A crash can occur before the checkout row is linked. Do not convert
    // that recoverable claim into a terminal failure; the next reconciliation
    // can reconstruct it once the provider/card is available.
    await db.update(providerAutoPayAttempts).set({
      status: "failed",
      failureReason: "stale_processing_reconciled",
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(providerAutoPayAttempts.id, attempt.id),
      eq(providerAutoPayAttempts.status, "processing"),
    ));
  }
}

/**
 * Process provider subscription and invoice auto-pay schedules for one UTC
 * calendar day. The attempt unique key is claimed before Stripe is called,
 * which is the cross-instance idempotency boundary.
 */
export async function runProviderAutoPayJob(now = new Date()): Promise<void> {
  const [subscriptionsDue, invoiceAutoPayCustomers] = await Promise.all([
    db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.subjectType, "provider_org"),
          eq(subscriptions.autoPayEnabled, true),
          eq(subscriptions.status, "active"),
          eq(subscriptions.cancelAtPeriodEnd, false),
          isNull(subscriptions.deletedAt),
        ),
      ),
    db
      .select()
      .from(providerPaymentCustomers)
      .where(eq(providerPaymentCustomers.invoiceAutoPayEnabled, true)),
  ]);
  if (subscriptionsDue.length === 0 && invoiceAutoPayCustomers.length === 0) return;
  const stripe = await getUncachableStripeClient();

  for (const subscription of subscriptionsDue) {
    try {
      await runProviderSubscriptionAutoPay(stripe, subscription, now);
    } catch (error: any) {
      logger.error(
        { err: error?.message, subscriptionId: subscription.id },
        "[billing] Provider subscription auto-pay failed",
      );
    }
  }
  for (const customer of invoiceAutoPayCustomers) {
    try {
      await runProviderInvoiceAutoPay(stripe, customer, now);
    } catch (error: any) {
      logger.error(
        { err: error?.message, providerOrganizationId: customer.providerOrganizationId },
        "[billing] Provider invoice auto-pay failed",
      );
    }
  }
}

const INLINE_CARD_RECONCILIATION_LOCK = "labtrax:inline-card-reconciliation";
const INLINE_CARD_RECONCILIATION_INITIAL_DELAY_MS = 5 * 60 * 1000;
const INLINE_CARD_RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000;

let _billingJobTimer: ReturnType<typeof setTimeout> | null = null;
let _inlineCardReconciliationRunning = false;

/**
 * Reconcile abandoned inline card reservations without allowing overlapping
 * work in this process or across API instances. The session advisory lock is
 * held for the complete reconciliation pass because the pass may contact
 * Stripe before it settles a checkout.
 */
export async function runExpiredInlineCardReconciliationOnce(): Promise<void> {
  if (_inlineCardReconciliationRunning) return;
  _inlineCardReconciliationRunning = true;

  let client: any = null;
  let ownsClient = false;
  let lockAcquired = false;
  try {
    client = await pool.connect();
    ownsClient = true;
    const lockResult = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [INLINE_CARD_RECONCILIATION_LOCK],
    );
    lockAcquired = Boolean(lockResult.rows[0]?.acquired);
    if (!lockAcquired) {
      logger.debug(
        "[billing] Inline card reconciliation already running on another API instance",
      );
      return;
    }

    const { reconcileExpiredInlineCardReservations } =
      await import("../routes/payment-sessions.js");
    const inlineResults = await reconcileExpiredInlineCardReservations();
    if (inlineResults.found > 0) {
      logger.info({ inlineResults }, "[billing] Expired inline card reservations reconciled");
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "[billing] Inline card reconciliation failed");
  } finally {
    let releaseError: unknown = null;
    if (lockAcquired && client) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext($1))",
          [INLINE_CARD_RECONCILIATION_LOCK],
        );
      } catch (error) {
        releaseError = error;
      }
    }
    if (ownsClient && client) {
      // Do not return a connection that may still hold the scheduler lock.
      client.release(releaseError !== null);
    }
    _inlineCardReconciliationRunning = false;
    if (releaseError) {
      logger.error(
        { err: releaseError instanceof Error ? releaseError.message : releaseError },
        "[billing] Failed to release inline card reconciliation lock",
      );
    }
  }
}

async function runBillingJobOnce() {
  try {
    await sendTrialReminders();
    await runBillingTransitions();
    await runProviderAutoPayJob();
    await reconcileStaleProviderAutoPayAttempts();
    await runExpiredInlineCardReconciliationOnce();
  } catch (err: any) {
    logger.error({ err: err?.message }, "[billing] Daily billing job failed");
  }
  try {
    await checkAndAlertBackupStaleness();
  } catch (err: any) {
    logger.error({ err: err?.message }, "[billing] Backup staleness check failed");
  }
  try {
    await checkAndAlertInstallerHealth();
  } catch (err: any) {
    logger.error(
      { err: err?.message },
      "[billing] Installer health check failed",
    );
  }
  try {
    await cleanupAiMemoryCandidates();
  } catch (err: any) {
    logger.error(
      { err: err?.message },
      "[billing] AI memory candidate cleanup failed",
    );
  }
  try {
    await checkStaleUndepositedPayments();
  } catch (err: any) {
    logger.error(
      { err: err?.message },
      "[billing] Stale undeposited payments check failed",
    );
  }
}

/**
 * Start the daily billing job.
 * Fires once 5 minutes after startup, then every 24 hours.
 *
 * Also starts the nightly installer health check via
 * startInstallerHealthCheckJob() (first run at INSTALLER_HEALTH_CHECK_HOUR_UTC,
 * default 06:00 UTC).
 */
export function startBillingJobs(): void {
  if (_billingJobTimer !== null) return;

  const MS_5MIN = 5 * 60 * 1000;
  const MS_24H = 24 * 60 * 60 * 1000;

  _billingJobTimer = setTimeout(async () => {
    await runBillingJobOnce();
    setInterval(runBillingJobOnce, MS_24H);
  }, MS_5MIN);
  setTimeout(async () => {
    await runExpiredInlineCardReconciliationOnce();
    setInterval(runExpiredInlineCardReconciliationOnce, INLINE_CARD_RECONCILIATION_INTERVAL_MS);
  }, INLINE_CARD_RECONCILIATION_INITIAL_DELAY_MS);

  startInstallerHealthCheckJob();
  void import("./subscription-history.js")
    .then(m => m.startSubscriptionEvidenceJob())
    .catch(err => logger.error({ err }, "[billing] Subscription evidence scheduler unavailable"));

  // Loaded lazily so the duplicate-account consolidation module (and the
  // protected-table registry it pulls in) stays out of the static import
  // graph of every route that reaches billing-jobs.
  void import("./doctor-account-consolidation.js")
    .then((m) => m.startProviderAccountConsolidationJob())
    .catch((err) =>
      logger.error(
        { err },
        "[doctor-accounts] Failed to schedule consolidation job"
      )
    );

  logger.info("[billing] Billing jobs scheduled (first run in 5 min)");
}
