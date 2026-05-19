import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@workspace/db";
import { subscriptions, organizations, users } from "@workspace/db";
import { transitionSubscription, appendSubscriptionEvent } from "./entitlement";
import { sendMail } from "./mail";
import { logger } from "./logger";

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
    subject: `LabTrax — ${daysLeft} day${daysLeft !== 1 ? "s" : ""} until account locks`,
    html: `
      <p>Hi ${name},</p>
      <p>Your LabTrax trial has ended. You have <strong>${daysLeft} day${daysLeft !== 1 ? "s" : ""}</strong> of read-only access remaining before your account is locked.</p>
      <p>Add a payment method now to restore full access and keep your data safe.</p>
      <p><a href="${url}" style="background:#dc2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">Reactivate Now →</a></p>
      <p>— The LabTrax Team</p>
    `,
    text: `Hi ${name},\n\nYour LabTrax account has ${daysLeft} day${daysLeft !== 1 ? "s" : ""} of read-only access remaining.\n\nReactivate at: ${url}\n\n— The LabTrax Team`,
  });
}

async function sendLockedEmail(email: string, name: string) {
  const url = billingUrl();
  return sendMail({
    to: email,
    subject: "LabTrax — Account locked",
    html: `
      <p>Hi ${name},</p>
      <p>Your LabTrax account has been locked because no payment method was added after your trial ended.</p>
      <p>Your data is safe. Add a payment method to restore access immediately.</p>
      <p><a href="${url}" style="background:#dc2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">Restore Access →</a></p>
      <p>— The LabTrax Team</p>
    `,
    text: `Hi ${name},\n\nYour LabTrax account has been locked. Restore access at: ${url}\n\n— The LabTrax Team`,
  });
}

/**
 * Run all billing state-machine transitions:
 *   trialing → grace when trial expires and no payment method on file
 *   grace    → locked when grace period expires
 */
export async function runBillingTransitions(): Promise<void> {
  const now = new Date();

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
    if (sub.paymentMethodOnFile) {
      await transitionSubscription(sub.id, "active", undefined, {
        reason: "trial_ended_with_payment",
      });
    } else {
      await transitionSubscription(sub.id, "grace", undefined, {
        reason: "trial_ended_no_payment",
      });
      const contact = await resolveSubjectContact(sub.subjectType, sub.subjectId);
      if (contact.email) {
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
      await transitionSubscription(sub.id, "locked", undefined, {
        reason: "grace_period_expired",
      });
      const contact = await resolveSubjectContact(sub.subjectType, sub.subjectId);
      if (contact.email) {
        await sendLockedEmail(contact.email, contact.name);
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
          await sendTrialReminderEmail(
            contact.email,
            contact.name,
            daysLeft > 0 ? daysLeft : 1
          );
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

let _billingJobTimer: ReturnType<typeof setTimeout> | null = null;

async function runBillingJobOnce() {
  try {
    await sendTrialReminders();
    await runBillingTransitions();
  } catch (err: any) {
    logger.error({ err: err?.message }, "[billing] Daily billing job failed");
  }
}

/**
 * Start the daily billing job.
 * Fires once 5 minutes after startup, then every 24 hours.
 */
export function startBillingJobs(): void {
  if (_billingJobTimer !== null) return;

  const MS_5MIN = 5 * 60 * 1000;
  const MS_24H = 24 * 60 * 60 * 1000;

  _billingJobTimer = setTimeout(async () => {
    await runBillingJobOnce();
    setInterval(runBillingJobOnce, MS_24H);
  }, MS_5MIN);

  logger.info("[billing] Billing jobs scheduled (first run in 5 min)");
}
