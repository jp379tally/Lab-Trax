import { and, eq, inArray, lt, lte, gt, isNull, or, sql } from "drizzle-orm";
import { db, organizationInvites } from "@workspace/db";
import { logger } from "./logger";
import { deliverInviteEmail } from "../routes/organizations";

// Automatic retry configuration for failed invite emails.
// The initial send happens on invite create/resend; the sweep performs up to
// MAX_AUTO_RETRIES additional attempts, so an invite email is attempted at
// most (1 + MAX_AUTO_RETRIES) times per manual send.
export const INVITE_EMAIL_MAX_AUTO_RETRIES = 2;

// Backoff (ms) before retry N — indexed by the number of automatic retries
// already performed (emailRetryCount): first retry ~5 min after the failed
// attempt, second retry ~30 min after the first retry failed.
export const INVITE_EMAIL_RETRY_BACKOFF_MS: number[] = [
  5 * 60 * 1000,
  30 * 60 * 1000,
];

// Only transient transport failures are retried. Deterministic outcomes —
// skipped/opted-out recipients, reserved or undeliverable domains, missing
// SMTP config, incomplete invites — will fail identically on every attempt,
// so retrying them is pure noise (and, for opted-out recipients, a consent
// violation).
export const RETRYABLE_INVITE_EMAIL_REASONS = new Set(["send_failed"]);

function backoffMsFor(retryCount: number): number {
  const idx = Math.min(retryCount, INVITE_EMAIL_RETRY_BACKOFF_MS.length - 1);
  return INVITE_EMAIL_RETRY_BACKOFF_MS[idx]!;
}

/**
 * One sweep of the automatic invite-email retry loop.
 *
 * Picks pending, non-expired invites whose last email attempt failed with a
 * retryable (transient) reason, that still have retry budget left, and whose
 * backoff has elapsed — then re-delivers each through the exact same
 * `deliverInviteEmail` path used by create/resend so the attempt is recorded
 * on the row (lastEmailAttemptAt / lastEmailStatus / lastEmailError).
 *
 * Duplicate-send safety: each candidate is claimed with an atomic
 * compare-and-swap on (lastEmailStatus = 'failed', emailRetryCount = seen
 * value) before any email is sent. If a concurrent manual resend or another
 * sweep already acted on the invite, the claim matches zero rows and the
 * invite is skipped. Invites whose last send succeeded are never selected.
 *
 * Returns the number of retries attempted (for logging/tests).
 */
export async function processDueInviteEmailRetries(
  now: Date = new Date(),
  opts?: {
    /**
     * Test-only scoping: restricts the sweep to specific invite ids so DB
     * integration tests are hermetic on a shared dev database. Production
     * callers must not pass this.
     */
    onlyInviteIds?: string[];
  }
): Promise<number> {
  const minBackoffMs = INVITE_EMAIL_RETRY_BACKOFF_MS[0]!;
  const candidates = await db
    .select()
    .from(organizationInvites)
    .where(
      and(
        ...(opts?.onlyInviteIds
          ? [inArray(organizationInvites.id, opts.onlyInviteIds)]
          : []),
        eq(organizationInvites.status, "pending"),
        eq(organizationInvites.lastEmailStatus, "failed"),
        lt(organizationInvites.emailRetryCount, INVITE_EMAIL_MAX_AUTO_RETRIES),
        // Coarse cutoff — the exact per-count backoff is enforced below.
        lte(
          organizationInvites.lastEmailAttemptAt,
          new Date(now.getTime() - minBackoffMs)
        ),
        or(
          isNull(organizationInvites.expiresAt),
          gt(organizationInvites.expiresAt, now)
        )
      )
    )
    .limit(50);

  let attempted = 0;
  for (const invite of candidates) {
    if (
      !invite.lastEmailError ||
      !RETRYABLE_INVITE_EMAIL_REASONS.has(invite.lastEmailError)
    ) {
      continue;
    }
    const lastAttempt = invite.lastEmailAttemptAt;
    if (
      !lastAttempt ||
      now.getTime() - lastAttempt.getTime() <
        backoffMsFor(invite.emailRetryCount)
    ) {
      continue;
    }

    // Atomic claim: bump the retry counter only if the row still looks
    // exactly like the failed candidate we selected. A concurrent manual
    // resend (counter reset) or successful send (status flip) makes this
    // match zero rows, so we never double-send.
    const [claimed] = await db
      .update(organizationInvites)
      .set({ emailRetryCount: sql`${organizationInvites.emailRetryCount} + 1` })
      .where(
        and(
          eq(organizationInvites.id, invite.id),
          eq(organizationInvites.status, "pending"),
          eq(organizationInvites.lastEmailStatus, "failed"),
          eq(organizationInvites.emailRetryCount, invite.emailRetryCount)
        )
      )
      .returning();
    if (!claimed) continue;

    attempted += 1;
    const { delivery } = await deliverInviteEmail({ log: logger }, claimed);
    logger.info(
      {
        inviteId: invite.id,
        retryNumber: claimed.emailRetryCount,
        maxRetries: INVITE_EMAIL_MAX_AUTO_RETRIES,
        status: delivery.status,
        reason: delivery.reason,
      },
      delivery.sent
        ? "invite email retry succeeded"
        : "invite email retry failed"
    );
  }
  return attempted;
}

/**
 * Arm the periodic invite-email retry sweep. No-ops under the test runner —
 * tests exercise `processDueInviteEmailRetries` directly.
 */
export function startInviteEmailRetryScheduler(): void {
  if (process.env.VITEST) return;
  const intervalMs = Math.max(
    60 * 1000,
    parseInt(process.env.INVITE_EMAIL_RETRY_INTERVAL_MS || "", 10) ||
      5 * 60 * 1000
  );
  const tick = async () => {
    try {
      const attempted = await processDueInviteEmailRetries(new Date());
      if (attempted > 0) {
        logger.info({ attempted }, "Invite email retry sweep completed");
      }
    } catch (err: unknown) {
      logger.error({ err }, "Invite email retry sweep failed");
    } finally {
      setTimeout(tick, intervalMs);
    }
  };
  // Stagger the first sweep a bit after boot so startup work settles first.
  setTimeout(tick, Math.min(intervalMs, 60 * 1000));
  logger.info({ intervalMs }, "Invite email retry scheduler armed");
}
