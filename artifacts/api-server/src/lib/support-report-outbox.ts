import { and, eq, gt, inArray, lt, lte, or, isNull, sql } from "drizzle-orm";
import { db, supportReports, supportReportAttachments } from "@workspace/db";
import { sendMail } from "./mail";
import { logger } from "./logger";
import { readSupportReportAttachment, deleteSupportReportAttachment } from "./support-report-storage";

export const SUPPORT_REPORT_MAX_RETRIES = 3;
export const SUPPORT_REPORT_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
export const SUPPORT_REPORT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const SUPPORT_REPORT_CLAIM_LEASE_MS = 10 * 60_000;
const RETRYABLE = new Set(["send_failed"]);
const SAFE_FAILURE_REASONS = new Set([
  "auth_failed",
  "reserved_domain",
  "smtp_not_configured",
  "undeliverable_domain",
  "send_failed",
  "attachment_unavailable",
  "recipient_rejected",
  "expired",
  "intake_incomplete",
]);

function backoff(attempts: number) {
  return SUPPORT_REPORT_BACKOFF_MS[Math.min(Math.max(0, attempts - 1), SUPPORT_REPORT_BACKOFF_MS.length - 1)]!;
}

export async function processDueSupportReports(now = new Date()): Promise<number> {
  const lease = new Date(now.getTime() - SUPPORT_REPORT_CLAIM_LEASE_MS);
  await db.update(supportReports).set({
    ownerStatus: "permanent_failed",
    copyStatus: "permanent_failed",
    ownerFailureReason: "intake_incomplete",
    copyFailureReason: "intake_incomplete",
    expiresAt: now,
  }).where(and(
    eq(supportReports.ownerStatus, "persisting"),
    lte(supportReports.createdAt, lease),
  ));
  await db.update(supportReports).set({
    ownerStatus: "permanent_failed",
    ownerFailureReason: "expired",
    ownerClaimedAt: null,
  }).where(and(
    inArray(supportReports.ownerStatus, ["pending", "send_failed", "in_flight"]),
    lte(supportReports.expiresAt, now),
    or(isNull(supportReports.ownerClaimedAt), lte(supportReports.ownerClaimedAt, lease)),
  ));
  await db.update(supportReports).set({
    copyStatus: "permanent_failed",
    copyFailureReason: "expired",
    copyClaimedAt: null,
  }).where(and(
    inArray(supportReports.copyStatus, ["pending", "send_failed", "in_flight"]),
    lte(supportReports.expiresAt, now),
    or(isNull(supportReports.copyClaimedAt), lte(supportReports.copyClaimedAt, lease)),
  ));
  // A process may stop after claiming but before recording the transport
  // result. Expired claims can be tried again while budget remains. Claims
  // that already consumed the final attempt become terminal only after their
  // lease expires, never while another worker may still be sending.
  await db.update(supportReports).set({
    ownerStatus: "permanent_failed",
    ownerFailureReason: "send_failed",
    ownerClaimedAt: null,
  }).where(and(
    eq(supportReports.ownerStatus, "in_flight"),
    lte(supportReports.ownerAttempts, SUPPORT_REPORT_MAX_RETRIES),
    lte(supportReports.ownerClaimedAt, lease),
    eq(supportReports.ownerAttempts, SUPPORT_REPORT_MAX_RETRIES),
  ));
  await db.update(supportReports).set({
    copyStatus: "permanent_failed",
    copyFailureReason: "send_failed",
    copyClaimedAt: null,
  }).where(and(
    eq(supportReports.copyStatus, "in_flight"),
    lte(supportReports.copyClaimedAt, lease),
    eq(supportReports.copyAttempts, SUPPORT_REPORT_MAX_RETRIES),
  ));
  const rows = await db.select().from(supportReports).where(or(
    and(gt(supportReports.expiresAt, now), inArray(supportReports.ownerStatus, ["pending", "send_failed"]), lt(supportReports.ownerAttempts, SUPPORT_REPORT_MAX_RETRIES), lte(supportReports.ownerNextAttemptAt, now)),
    and(gt(supportReports.expiresAt, now), eq(supportReports.ownerStatus, "in_flight"), lt(supportReports.ownerAttempts, SUPPORT_REPORT_MAX_RETRIES), lte(supportReports.ownerClaimedAt, lease)),
    and(gt(supportReports.expiresAt, now), inArray(supportReports.copyStatus, ["pending", "send_failed"]), lt(supportReports.copyAttempts, SUPPORT_REPORT_MAX_RETRIES), lte(supportReports.copyNextAttemptAt, now)),
    and(gt(supportReports.expiresAt, now), eq(supportReports.copyStatus, "in_flight"), lt(supportReports.copyAttempts, SUPPORT_REPORT_MAX_RETRIES), lte(supportReports.copyClaimedAt, lease)),
  )).limit(50);
  let attempted = 0;
  for (const row of rows) {
    for (const kind of ["owner", "copy"] as const) {
      const status = kind === "owner" ? row.ownerStatus : row.copyStatus;
      const attempts = kind === "owner" ? row.ownerAttempts : row.copyAttempts;
      const recipient = kind === "owner" ? row.ownerEmail : row.reporterEmail;
      if (!recipient || !["pending", "send_failed", "in_flight"].includes(status) || attempts >= SUPPORT_REPORT_MAX_RETRIES) continue;
      const claim = await db.update(supportReports).set(kind === "owner"
        ? { ownerStatus: "in_flight", ownerClaimedAt: now, ownerAttempts: sql`${supportReports.ownerAttempts} + 1` }
        : { copyStatus: "in_flight", copyClaimedAt: now, copyAttempts: sql`${supportReports.copyAttempts} + 1` })
        .where(and(
          eq(supportReports.id, row.id),
          eq(kind === "owner" ? supportReports.ownerStatus : supportReports.copyStatus, status),
          eq(kind === "owner" ? supportReports.ownerAttempts : supportReports.copyAttempts, attempts),
          ...(status === "in_flight"
            ? [lte(kind === "owner" ? supportReports.ownerClaimedAt : supportReports.copyClaimedAt, lease)]
            : []),
          gt(supportReports.expiresAt, now),
        )).returning();
      const claimed = claim[0];
      if (!claimed) continue;
      const claimedAttempt = attempts + 1;
      attempted++;
      try {
        const attachments = await Promise.all((await db.select().from(supportReportAttachments).where(eq(supportReportAttachments.reportId, row.id))).map(async (a) => {
          const content = await readSupportReportAttachment(a.storageKey);
          if (!content) throw Object.assign(new Error("attachment_unavailable"), { code: "attachment_unavailable" });
          return { filename: a.filename, contentType: a.contentType, content };
        }));
        if (row.expiresAt <= new Date()) {
          throw Object.assign(new Error("expired"), { code: "expired" });
        }
        const result = await sendMail({
          to: recipient,
          replyTo: kind === "owner" ? row.reporterEmail ?? undefined : row.ownerEmail,
          messageId: `<support-report-${row.id}-${kind}@labtrax.local>`,
          classifyRecipientFailure: true,
          subject: kind === "owner" ? `LabTrax support report — ${row.portal}` : `Copy of your LabTrax support report — ${row.portal}`,
          text: row.description,
          html: `<pre>${row.description.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`,
          attachments,
        });
        if (result.sent) {
          await db.update(supportReports).set(kind === "owner"
            ? { ownerStatus: "sent", ownerFailureReason: null, ownerClaimedAt: null }
            : { copyStatus: "sent", copyFailureReason: null, copyClaimedAt: null })
            .where(and(
              eq(supportReports.id, row.id),
              eq(kind === "owner" ? supportReports.ownerStatus : supportReports.copyStatus, "in_flight"),
              eq(kind === "owner" ? supportReports.ownerAttempts : supportReports.copyAttempts, claimedAttempt),
            ));
        } else {
          const reason = SAFE_FAILURE_REASONS.has(result.reason ?? "") ? result.reason! : "send_failed";
          const permanent = !RETRYABLE.has(reason) || claimedAttempt >= SUPPORT_REPORT_MAX_RETRIES;
          await db.update(supportReports).set(kind === "owner"
            ? { ownerStatus: permanent ? "permanent_failed" : "send_failed", ownerFailureReason: reason, ownerNextAttemptAt: new Date(now.getTime() + backoff(claimedAttempt)), ownerClaimedAt: null }
            : { copyStatus: permanent ? "permanent_failed" : "send_failed", copyFailureReason: reason, copyNextAttemptAt: new Date(now.getTime() + backoff(claimedAttempt)), copyClaimedAt: null })
            .where(and(
              eq(supportReports.id, row.id),
              eq(kind === "owner" ? supportReports.ownerStatus : supportReports.copyStatus, "in_flight"),
              eq(kind === "owner" ? supportReports.ownerAttempts : supportReports.copyAttempts, claimedAttempt),
            ));
        }
      } catch (error: any) {
        const reason =
          error?.code === "attachment_unavailable"
            ? "attachment_unavailable"
            : error?.code === "expired"
              ? "expired"
              : "send_failed";
        const permanent = reason !== "send_failed" || claimedAttempt >= SUPPORT_REPORT_MAX_RETRIES;
        await db.update(supportReports).set(kind === "owner"
          ? { ownerStatus: permanent ? "permanent_failed" : "send_failed", ownerFailureReason: reason, ownerNextAttemptAt: new Date(now.getTime() + backoff(claimedAttempt)), ownerClaimedAt: null }
          : { copyStatus: permanent ? "permanent_failed" : "send_failed", copyFailureReason: reason, copyNextAttemptAt: new Date(now.getTime() + backoff(claimedAttempt)), copyClaimedAt: null })
          .where(and(
            eq(supportReports.id, row.id),
            eq(kind === "owner" ? supportReports.ownerStatus : supportReports.copyStatus, "in_flight"),
            eq(kind === "owner" ? supportReports.ownerAttempts : supportReports.copyAttempts, claimedAttempt),
          ));
      }
    }
  }
  return attempted;
}

/** Retention cleanup never touches pending or in-flight reports. */
export async function cleanupExpiredSupportReports(now = new Date()): Promise<number> {
  const rows = await db.select().from(supportReports).where(and(
    lte(supportReports.expiresAt, now),
    inArray(supportReports.ownerStatus, ["sent", "permanent_failed", "not_applicable"]),
    inArray(supportReports.copyStatus, ["sent", "permanent_failed", "not_applicable"]),
    isNull(supportReports.deletedAt),
  )).limit(100);
  let cleaned = 0;
  for (const row of rows) {
    const attachments = await db.select().from(supportReportAttachments).where(eq(supportReportAttachments.reportId, row.id));
    // Content retention is independent from storage availability. Redact all
    // readable DB content at expiry before attempting object deletion. Random
    // storage keys remain only so a later sweep can retry deletion.
    await db.update(supportReports).set({
      description: "",
      reporterEmail: null,
      ownerEmail: null,
    }).where(and(eq(supportReports.id, row.id), isNull(supportReports.deletedAt)));
    await db.update(supportReportAttachments).set({
      filename: "",
      contentType: "application/octet-stream",
      size: 0,
    }).where(eq(supportReportAttachments.reportId, row.id));
    try {
      for (const attachment of attachments) await deleteSupportReportAttachment(attachment.storageKey);
      await db.update(supportReports).set({ deletedAt: now })
        .where(and(eq(supportReports.id, row.id), isNull(supportReports.deletedAt)));
      await db.delete(supportReportAttachments).where(eq(supportReportAttachments.reportId, row.id));
      cleaned++;
    } catch {
      // Keep only random storage keys so a later sweep can retry deletion.
    }
  }
  return cleaned;
}

export function startSupportReportScheduler() {
  if (process.env.VITEST) return;
  const interval = Math.max(60_000, Number(process.env.SUPPORT_REPORT_INTERVAL_MS) || 300_000);
  const tick = async () => {
    try {
      await processDueSupportReports();
      await cleanupExpiredSupportReports();
    } catch (err) {
      logger.error({ err }, "support report outbox sweep failed");
    } finally {
      setTimeout(tick, interval);
    }
  };
  setTimeout(tick, Math.min(interval, 60_000));
  logger.info({ interval }, "support report outbox scheduler armed");
}