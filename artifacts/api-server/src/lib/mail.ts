import type {
  SendMailOptions as NodemailerSendMailOptions,
  Transporter,
} from "nodemailer";
import { promises as dns } from "node:dns";
import { logger } from "./logger";
import { backupErrorMessage, partialBackupMessage } from "./backup-error-copy";
import {
  createTransport,
  getMailerConfig,
  type MailerConfig,
} from "./mailer";
import { classifySmtpError } from "./smtp-error";
import { formatNumericDate, formatNumericDateTime } from "./date-format";

type MailAttachment = NonNullable<
  NodemailerSendMailOptions["attachments"]
>[number];

let cachedTransport: { key: string; transporter: Transporter } | null = null;

const EMAIL_RE = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;
const mxCache = new Map<
  string,
  { result: "deliverable" | "undeliverable"; ts: number }
>();
const MX_TTL_MS = 60 * 60 * 1000;
const MX_NEG_TTL_MS = 10 * 60 * 1000;

// RFC 2606 / 6761 / 6762 reserved + documentation domains that can never receive
// real mail. Dispatching verification or recovery codes to these (e.g. the
// `@test.local` fixtures used throughout the suite) produces a flood of bounce
// non-delivery notices back to the SMTP_FROM inbox, so we never send to them.
const RESERVED_EMAIL_TLDS = new Set([
  "local",
  "test",
  "example",
  "invalid",
  "localhost",
]);
const RESERVED_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
]);

export function isReservedEmailDomain(email: string): boolean {
  const m = EMAIL_RE.exec(email.trim());
  if (!m) return true;
  const domain = m[1].toLowerCase();
  if (RESERVED_EMAIL_DOMAINS.has(domain)) return true;
  const tld = domain.split(".").pop() ?? "";
  return RESERVED_EMAIL_TLDS.has(tld);
}

/**
 * DNS error codes that mean the lookup itself completed and the domain
 * definitively has no such records. Anything else (timeouts, SERVFAIL,
 * EAI_AGAIN, sandboxed/blocked DNS runtimes, …) is an inconclusive lookup —
 * SMTP remains the authority in that case and we must NOT refuse the send.
 */
const DNS_DEFINITIVE_NEGATIVE_CODES = new Set([
  "ENOTFOUND",
  "ENODATA",
  "NXDOMAIN",
]);

export type DomainDeliverability =
  | "deliverable"
  | "undeliverable"
  | "unknown";

/**
 * Best-effort MX/A preflight. Returns:
 *  - "deliverable"   — lookup succeeded and found MX or A records
 *  - "undeliverable" — lookup succeeded and definitively found no MX/A records
 *  - "unknown"       — the lookup itself errored (runtime/DNS restriction);
 *                      never cached, callers should fall through to SMTP
 */
export async function resolveDomainDeliverability(
  email: string
): Promise<DomainDeliverability> {
  const m = EMAIL_RE.exec(email.trim());
  if (!m) return "undeliverable";
  const domain = m[1].toLowerCase();
  const now = Date.now();
  const cached = mxCache.get(domain);
  if (
    cached &&
    now - cached.ts <
      (cached.result === "deliverable" ? MX_TTL_MS : MX_NEG_TTL_MS)
  ) {
    return cached.result;
  }
  let result: DomainDeliverability;
  try {
    const mx = await dns.resolveMx(domain);
    result = Array.isArray(mx) && mx.length > 0 ? "deliverable" : "undeliverable";
  } catch (mxErr: any) {
    try {
      const a = await dns.resolve(domain);
      result = Array.isArray(a) && a.length > 0 ? "deliverable" : "undeliverable";
    } catch (aErr: any) {
      // Only a definitive "no such records" answer on BOTH lookups counts as
      // undeliverable. Any other error means the lookup itself failed.
      const mxCode = mxErr?.code ?? "";
      const aCode = aErr?.code ?? "";
      if (
        DNS_DEFINITIVE_NEGATIVE_CODES.has(mxCode) &&
        DNS_DEFINITIVE_NEGATIVE_CODES.has(aCode)
      ) {
        result = "undeliverable";
      } else {
        result = "unknown";
      }
    }
  }
  // Never cache inconclusive lookups — a transient DNS failure must not
  // block a domain for the negative-cache TTL.
  if (result !== "unknown") {
    mxCache.set(domain, { result, ts: now });
  }
  return result;
}

/** Test-only: reset the module-level MX cache between unit tests. */
export function __clearMxCacheForTests() {
  mxCache.clear();
}

function getTransporter(cfg: MailerConfig): Transporter {
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  if (cachedTransport && cachedTransport.key === key) {
    return cachedTransport.transporter;
  }
  const transporter = createTransport(cfg);
  cachedTransport = { key, transporter };
  return transporter;
}

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string | string[] | null;
  replyTo?: string | null;
  fromName?: string | null;
  attachments?: MailAttachment[];
  messageId?: string;
  classifyRecipientFailure?: boolean;
}

export interface SendMailResult {
  sent: boolean;
  reason?: string;
}

export async function sendMail(opts: SendMailOptions): Promise<SendMailResult> {
  // Never dispatch real mail from the test runner. The suite exercises the
  // verification/recovery endpoints with fixture addresses; without this guard a
  // configured SMTP in the environment turns every test run into real bounce spam.
  if (process.env.VITEST) {
    return { sent: false, reason: "disabled_in_test" };
  }
  const cfg = getMailerConfig();
  if (!cfg) {
    logger.warn(
      "[mail] SMTP not configured; skipping send"
    );
    return { sent: false, reason: "smtp_not_configured" };
  }
  if (isReservedEmailDomain(opts.to)) {
    logger.warn(
      "[mail] recipient is a reserved/undeliverable test domain; skipping send"
    );
    return { sent: false, reason: "reserved_domain" };
  }
  const deliverability = await resolveDomainDeliverability(opts.to);
  if (deliverability === "undeliverable") {
    logger.warn(
      "[mail] recipient domain has no MX/A record; skipping send"
    );
    return { sent: false, reason: "undeliverable_domain" };
  }
  if (deliverability === "unknown") {
    // The DNS lookup itself failed (runtime restriction / transient DNS
    // outage). SMTP is the authority for real domains — proceed to send.
    logger.warn(
      "[mail] MX/A preflight lookup errored; proceeding to SMTP"
    );
  }
  try {
    const transporter = getTransporter(cfg);
    await transporter.sendMail({
      from: opts.fromName?.trim()
        ? `${opts.fromName.trim()} <${cfg.from}>`
        : cfg.from,
      to: opts.to,
      ...(opts.cc?.length ? { cc: opts.cc } : {}),
      ...(opts.replyTo?.trim() ? { replyTo: opts.replyTo.trim() } : {}),
      subject: opts.subject,
      ...(opts.messageId ? { messageId: opts.messageId } : {}),
      html: opts.html,
      text: opts.text,
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    });
    return { sent: true };
  } catch (err: any) {
    const classified = classifySmtpError(err);
    logger.error(
      {
        smtpCategory: classified.category,
      },
      "[mail] failed to send"
    );
    // Return only stable, client-safe reason strings — never raw provider
    // text, which can echo credentials or account details. An auth rejection
    // gets its own reason so callers can tell "credentials are wrong" apart
    // from a transient outage (and skip pointless retries).
    return {
      sent: false,
      reason:
        classified.category === "auth"
          ? "auth_failed"
          : classified.category === "recipient" && opts.classifyRecipientFailure
            ? "recipient_rejected"
            : "send_failed",
    };
  }
}

export function getAppBaseUrl(): string {
  const domains = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const first = domains[0];
  if (first) return `https://${first}`;
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (dev) return `https://${dev}`;
  return "http://localhost:5000";
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Administrator",
  user: "Team Member",
  billing: "Billing",
  read_only: "Read Only",
};

export function formatRoleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/** Stable CID shared by the statement and invite inline-logo templates. */
export const LAB_LOGO_CID = "lab-logo@labtrax";

export interface InviteEmailParams {
  to: string;
  organizationName: string;
  roleToAssign: string;
  token: string;
  inviterName?: string | null;
  expiresAt?: Date | null;
  /** Uploaded logo bytes to embed in the email as an inline MIME image. */
  labLogo?: { content: Buffer; contentType: string } | null;
}

export async function sendInviteEmail(
  params: InviteEmailParams
): Promise<SendMailResult> {
  const roleLabel = formatRoleLabel(params.roleToAssign);
  const acceptUrl = `${getAppBaseUrl()}/desktop/accept-invite?token=${encodeURIComponent(
    params.token
  )}`;
  const expires = params.expiresAt ? formatNumericDate(params.expiresAt) : null;
  const inviter = params.inviterName?.trim();

  const greetingHtml = inviter
    ? `${escapeHtml(inviter)} has invited you to join`
    : `You have been invited to join`;
  const greetingText = inviter
    ? `${inviter} has invited you to join`
    : `You have been invited to join`;

  const logoHtml = params.labLogo
    ? `<div style="margin-bottom: 10px;"><img src="cid:${LAB_LOGO_CID}" alt="Lab logo" style="max-height: 44px; max-width: 140px; object-fit: contain; display: block;" /></div>`
    : "";

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      ${logoHtml}<h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.85;">You've been invited</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <p>${greetingHtml} <strong>${escapeHtml(params.organizationName)}</strong> on LabTrax as <strong>${escapeHtml(roleLabel)}</strong>.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${acceptUrl}" style="display: inline-block; background: #4A6CF7; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Accept Invite</a>
      </p>
      <p style="color: #666; font-size: 13px;">Or paste this link into your browser:<br/><span style="word-break: break-all;">${acceptUrl}</span></p>
      ${expires ? `<p style="color: #666; font-size: 13px;">This invite expires on ${escapeHtml(expires)}.</p>` : ""}
    </div>
  </div>`;

  const text = `${greetingText} ${params.organizationName} on LabTrax as ${roleLabel}.\n\nAccept your invite: ${acceptUrl}\n${expires ? `This invite expires on ${expires}.\n` : ""}`;

  return sendMail({
    to: params.to,
    subject: `You're invited to join ${params.organizationName} on LabTrax`,
    html,
    text,
    ...(params.labLogo
      ? {
          attachments: [
            {
              filename: "lab-logo",
              content: params.labLogo.content,
              contentType: params.labLogo.contentType,
              cid: LAB_LOGO_CID,
              contentDisposition: "inline" as const,
            },
          ],
        }
      : {}),
  });
}

export interface CleanupAlertParams {
  adminEmails: string[];
  /** Who triggered the run: "scheduler" for automatic runs, "admin:<name>" for manual ones. */
  triggeredBy?: string;
  report: {
    ranAt: string;
    /** Set when the cleanup run itself threw a fatal error before producing a report. */
    fatalError?: string;
    scannedFiles?: number;
    orphanCount?: number;
    removedCount?: number;
    freedBytes?: number;
    errorCount?: number;
    errors?: Array<{ fileName: string; error: string }>;
  };
}

export interface InviteResultEmailParams {
  /** Inviting admin's email address. */
  to: string;
  inviterName?: string | null;
  organizationName: string;
  roleAssigned: string;
  /** The invitee's own contact email (not PHI). */
  inviteeEmail: string;
  outcome: "accepted" | "declined";
}

/**
 * Notify the inviting admin that their invitation was accepted or declined.
 * Contains no PHI — only org name, assigned role, the invitee's own email,
 * and the outcome.
 */
export async function sendInviteResultEmail(
  params: InviteResultEmailParams
): Promise<SendMailResult> {
  const roleLabel = formatRoleLabel(params.roleAssigned);
  const accepted = params.outcome === "accepted";
  const greeting = params.inviterName?.trim()
    ? `Hi ${params.inviterName.trim()},`
    : "Hi,";
  const verb = accepted ? "accepted" : "declined";
  const accentColor = accepted ? "#16A34A" : "#B45309";
  const settingsUrl = `${getAppBaseUrl()}/desktop/settings`;
  const inviteeLabel = params.inviteeEmail
    ? escapeHtml(params.inviteeEmail)
    : "An invited user";

  const detailHtml = accepted
    ? `<strong>${inviteeLabel}</strong> accepted your invitation to join <strong>${escapeHtml(params.organizationName)}</strong> as <strong>${escapeHtml(roleLabel)}</strong> and now has access.`
    : `<strong>${inviteeLabel}</strong> declined your invitation to join <strong>${escapeHtml(params.organizationName)}</strong> as <strong>${escapeHtml(roleLabel)}</strong>. No access was granted.`;
  const detailText = accepted
    ? `${params.inviteeEmail || "An invited user"} accepted your invitation to join ${params.organizationName} as ${roleLabel} and now has access.`
    : `${params.inviteeEmail || "An invited user"} declined your invitation to join ${params.organizationName} as ${roleLabel}. No access was granted.`;

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: ${accentColor}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.85;">Invitation ${verb}</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <p>${escapeHtml(greeting)}</p>
      <p>${detailHtml}</p>
      <p style="color: #666; font-size: 13px;">Manage your team in <a href="${settingsUrl}">LabTrax settings</a>.</p>
    </div>
  </div>`;

  const text = `${greeting}\n\n${detailText}\n\nManage your team: ${settingsUrl}\n`;

  return sendMail({
    to: params.to,
    subject: `Invitation ${verb}: ${params.organizationName}`,
    html,
    text,
  });
}

function formatTriggeredByLabel(triggeredBy: string | undefined): string {
  if (!triggeredBy || triggeredBy === "scheduler") return "Scheduled";
  if (triggeredBy.startsWith("admin:")) {
    const name = triggeredBy.slice("admin:".length).trim();
    return name ? `Manual (${name})` : "Manual";
  }
  return triggeredBy;
}

export async function sendCleanupAlertEmail(
  params: CleanupAlertParams
): Promise<void> {
  if (params.adminEmails.length === 0) return;

  const { report } = params;
  const isFatal = Boolean(report.fatalError);
  const removedCount = report.removedCount ?? 0;
  const errorCount = report.errorCount ?? 0;
  const hasIssues = isFatal || removedCount > 0 || errorCount > 0;
  if (!hasIssues) return;

  const dateStr = formatNumericDate(report.ranAt);
  const subject = isFatal
    ? `LabTrax Media Cleanup FAILED on ${dateStr}`
    : errorCount > 0
      ? `LabTrax Media Cleanup: ${errorCount} error(s) on ${dateStr}`
      : `LabTrax Media Cleanup: ${removedCount} file(s) removed on ${dateStr}`;

  const fatalBannerHtml = isFatal
    ? `<div style="background:#c0392b;color:white;padding:12px 16px;border-radius:4px;margin-bottom:16px;"><strong>Fatal error — cleanup did not complete:</strong><br/><code style="word-break:break-all;">${escapeHtml(report.fatalError!)}</code></div>`
    : "";
  const fatalBannerText = isFatal
    ? `FATAL ERROR — cleanup did not complete:\n  ${report.fatalError}\n\n`
    : "";

  const errors = report.errors ?? [];
  const freedMb = ((report.freedBytes ?? 0) / 1024 / 1024).toFixed(2);
  const triggeredByLabel = formatTriggeredByLabel(params.triggeredBy);

  const statsHtml = isFatal ? "" : `<table style="border-collapse: collapse; width: 100%; font-size: 14px;">
        <tr style="background: #f5f5f5;"><td style="padding: 8px 12px; font-weight: bold;">Triggered by</td><td style="padding: 8px 12px;">${escapeHtml(triggeredByLabel)}</td></tr>
        <tr><td style="padding: 8px 12px; font-weight: bold;">Scanned files</td><td style="padding: 8px 12px;">${report.scannedFiles ?? 0}</td></tr>
        <tr style="background: #f5f5f5;"><td style="padding: 8px 12px; font-weight: bold;">Orphaned files found</td><td style="padding: 8px 12px;">${report.orphanCount ?? 0}</td></tr>
        <tr><td style="padding: 8px 12px; font-weight: bold;">Files removed</td><td style="padding: 8px 12px;">${removedCount}</td></tr>
        <tr style="background: #f5f5f5;"><td style="padding: 8px 12px; font-weight: bold;">Space freed</td><td style="padding: 8px 12px;">${freedMb} MB</td></tr>
        <tr><td style="padding: 8px 12px; font-weight: bold;">Errors</td><td style="padding: 8px 12px; color: ${errorCount > 0 ? "#c0392b" : "inherit"};">${errorCount}</td></tr>
      </table>`;

  const statsText = isFatal ? "" : `Triggered by: ${triggeredByLabel}\nScanned files: ${report.scannedFiles ?? 0}\nOrphaned files found: ${report.orphanCount ?? 0}\nFiles removed: ${removedCount}\nSpace freed: ${freedMb} MB\nErrors: ${errorCount}`;

  const fatalTriggeredByHtml = isFatal
    ? `<p style="font-size: 14px;"><strong>Triggered by:</strong> ${escapeHtml(triggeredByLabel)}</p>`
    : "";
  const fatalTriggeredByText = isFatal ? `Triggered by: ${triggeredByLabel}\n` : "";

  const errorRowsHtml = errors.length > 0
    ? `<h3 style="color:#c0392b;">File-level errors</h3><ul>${errors.map((e) => `<li><code>${escapeHtml(e.fileName)}</code>: ${escapeHtml(e.error)}</li>`).join("")}</ul>`
    : "";
  const errorRowsText = errors.length > 0
    ? `\nFile-level errors:\n${errors.map((e) => `  - ${e.fileName}: ${e.error}`).join("\n")}`
    : "";

  const maintenanceUrl = `${getAppBaseUrl()}/desktop/maintenance`;
  const maintenanceLinkHtml = `<p style="margin-top: 20px; font-size: 13px;">View the full run history on the <a href="${maintenanceUrl}" style="color: #4A6CF7;">Maintenance page</a>.</p>`;
  const maintenanceLinkText = `\nView the full run history: ${maintenanceUrl}`;

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.85;">Nightly Media Cleanup Report</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <p style="color: #555; font-size: 13px;">Run at: ${escapeHtml(formatNumericDateTime(report.ranAt))}</p>
      ${fatalBannerHtml}${fatalTriggeredByHtml}${statsHtml}${errorRowsHtml}${maintenanceLinkHtml}
    </div>
  </div>`;

  const text = `LabTrax Nightly Media Cleanup Report\nRun at: ${formatNumericDateTime(report.ranAt)}\n\n${fatalBannerText}${fatalTriggeredByText}${statsText}${errorRowsText}${maintenanceLinkText}`;

  for (const email of params.adminEmails) {
    await sendMail({ to: email, subject, html, text });
  }
}

export interface CleanupRecoveryAlertParams {
  adminEmails: string[];
  recoveredCount: number;
}

export async function sendCleanupRecoveryAlertEmail(
  params: CleanupRecoveryAlertParams
): Promise<void> {
  if (params.adminEmails.length === 0) return;

  const { recoveredCount } = params;
  const runWord = recoveredCount === 1 ? "run" : "runs";
  const dateStr = formatNumericDate(new Date());
  const subject = `LabTrax Media Cleanup: ${recoveredCount} interrupted ${runWord} recovered on ${dateStr}`;

  const maintenanceUrl = `${getAppBaseUrl()}/desktop/maintenance`;
  const maintenanceLinkHtml = `<p style="margin-top: 20px; font-size: 13px;">You can trigger a fresh cleanup run from the <a href="${maintenanceUrl}" style="color: #4A6CF7;">Maintenance page</a>.</p>`;
  const maintenanceLinkText = `\nTrigger a fresh cleanup run from the Maintenance page: ${maintenanceUrl}`;

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.85;">Nightly Media Cleanup — Recovery Notice</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#f0ad4e;color:#fff;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        <strong>Warning:</strong> ${recoveredCount} cleanup ${runWord} ${recoveredCount === 1 ? "was" : "were"} interrupted by a server crash and ${recoveredCount === 1 ? "has" : "have"} been automatically marked as failed.
      </div>
      <p style="font-size: 14px;"><strong>Triggered by:</strong> Automatic (server restart detection)</p>
      <p>Orphaned media files may not have been removed during the interrupted ${runWord}. Please review the run history and consider triggering a fresh cleanup to ensure storage is maintained.</p>
      ${maintenanceLinkHtml}
    </div>
  </div>`;

  const text = `LabTrax Nightly Media Cleanup — Recovery Notice\n\nWARNING: ${recoveredCount} cleanup ${runWord} ${recoveredCount === 1 ? "was" : "were"} interrupted by a server crash and ${recoveredCount === 1 ? "has" : "have"} been automatically marked as failed.\n\nTriggered by: Automatic (server restart detection)\n\nOrphaned media files may not have been removed during the interrupted ${runWord}. Please review the run history and consider triggering a fresh cleanup to ensure storage is maintained.${maintenanceLinkText}`;

  for (const email of params.adminEmails) {
    await sendMail({ to: email, subject, html, text });
  }
}

export interface InstallerPublishFailureAlertParams {
  adminEmails: string[];
  /** Workflow name (e.g. "Build Windows Installer (Test)" or "Release"). */
  workflowName?: string | null;
  /** GitHub Actions run URL — direct link to the failing run. */
  runUrl?: string | null;
  /** Numeric run ID for cross-referencing. */
  runId?: string | null;
  /** Commit SHA the run was built from. */
  commitSha?: string | null;
  /** Git ref / tag (e.g. "v1.2.3" or "refs/heads/main"). */
  ref?: string | null;
  /** Installer version that was being published (from package.json or git tag). */
  version?: string | null;
  /** Stage that failed: "upload" (multipart upload), "settings" (PUT live URL), or "unknown". */
  stage?: string | null;
  /** HTTP status code from the failing API call, if known. */
  httpStatus?: number | null;
  /** Short error message / response body excerpt. Will be truncated to ~2KB. */
  errorMessage?: string | null;
  /** ISO timestamp when the failure was reported. Defaults to now. */
  reportedAt?: string;
}

const PUBLISH_FAILURE_ERROR_MAX = 2048;

export async function sendInstallerPublishFailureAlertEmail(
  params: InstallerPublishFailureAlertParams,
): Promise<void> {
  if (params.adminEmails.length === 0) return;

  const reportedAt = params.reportedAt ?? new Date().toISOString();
  const dateStr = formatNumericDate(reportedAt);
  const versionLabel = params.version?.trim() || "unknown version";
  const workflowLabel = params.workflowName?.trim() || "GitHub Actions";
  const subject = `LabTrax desktop installer auto-publish FAILED (${versionLabel}) on ${dateStr}`;

  const stageLabel = (() => {
    switch ((params.stage || "").toLowerCase()) {
      case "upload":
        return "Uploading installer to App Storage (POST /api/admin/desktop-installer/upload)";
      case "settings":
        return "Updating live download URL (PUT /api/admin/settings/desktop-installer)";
      case "":
      case "unknown":
        return "Auto-publish step";
      default:
        return params.stage!;
    }
  })();

  const truncatedError = params.errorMessage
    ? params.errorMessage.length > PUBLISH_FAILURE_ERROR_MAX
      ? params.errorMessage.slice(0, PUBLISH_FAILURE_ERROR_MAX) + "\n…[truncated]"
      : params.errorMessage
    : "(no error message provided)";

  const rows: Array<{ label: string; value: string }> = [
    { label: "Workflow", value: workflowLabel },
    { label: "Failed stage", value: stageLabel },
    { label: "Version", value: versionLabel },
  ];
  if (params.ref) rows.push({ label: "Ref", value: params.ref });
  if (params.commitSha) rows.push({ label: "Commit", value: params.commitSha });
  if (params.runId) rows.push({ label: "Run ID", value: params.runId });
  if (typeof params.httpStatus === "number")
    rows.push({ label: "HTTP status", value: String(params.httpStatus) });
  rows.push({ label: "Reported at", value: formatNumericDateTime(reportedAt) });

  const settingsUrl = `${getAppBaseUrl()}/desktop/settings`;
  const runLinkHtml = params.runUrl
    ? `<p style="margin: 16px 0;"><a href="${escapeHtml(params.runUrl)}" style="display:inline-block;background:#4A6CF7;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">View failing GitHub Actions run</a></p>`
    : "";
  const runLinkText = params.runUrl ? `View the failing run: ${params.runUrl}\n` : "";

  const rowsHtml = rows
    .map(
      (r, i) =>
        `<tr style="background:${i % 2 === 0 ? "#f5f5f5" : "transparent"};"><td style="padding:8px 12px;font-weight:bold;">${escapeHtml(r.label)}</td><td style="padding:8px 12px;word-break:break-all;">${escapeHtml(r.value)}</td></tr>`,
    )
    .join("");

  const html = `<div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
    <div style="background:#c0392b;color:white;padding:20px;border-radius:8px 8px 0 0;">
      <h2 style="margin:0;">LabTrax</h2>
      <p style="margin:4px 0 0;opacity:0.9;">Desktop installer auto-publish failed</p>
    </div>
    <div style="padding:20px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;">
      <p>The CI step that automatically publishes the freshly-built Windows installer to the live download page failed. The live download page is still serving the previous installer until this is resolved.</p>
      ${runLinkHtml}
      <table style="border-collapse:collapse;width:100%;font-size:14px;">${rowsHtml}</table>
      <h3 style="margin-top:20px;">Error</h3>
      <pre style="background:#1e1e1e;color:#f5f5f5;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;">${escapeHtml(truncatedError)}</pre>
      <h3 style="margin-top:20px;">What to do</h3>
      <ol style="font-size:14px;line-height:1.5;">
        <li>Open the failing run above and inspect the "Publish installer to live download page" step.</li>
        <li>If it was transient (network blip, API restart), re-run the workflow.</li>
        <li>If the secret was rotated or the API URL changed, update <code>PLATFORM_ADMIN_SECRET</code> / <code>PUBLISH_API_BASE_URL</code> in GitHub Actions secrets.</li>
        <li>As a fallback, upload the installer manually from <a href="${settingsUrl}" style="color:#4A6CF7;">Settings → Desktop App</a>.</li>
      </ol>
    </div>
  </div>`;

  const rowsText = rows.map((r) => `${r.label}: ${r.value}`).join("\n");
  const text = `LabTrax desktop installer auto-publish FAILED\n\n${rowsText}\n\nError:\n${truncatedError}\n\n${runLinkText}Fallback: upload manually at ${settingsUrl}`;

  for (const email of params.adminEmails) {
    await sendMail({ to: email, subject, html, text });
  }
}

export interface BackupNotificationParams {
  adminEmails: string[];
  triggeredBy: string;
  success: true;
  result: {
    destination: string;
    fileName: string;
    size: number;
    completedAt: string;
    path?: string | null;
    /**
     * The run finished but dropped content (media it could not read, for
     * example). Reported here as partial rather than as a clean success:
     * "Backup completed successfully" over an archive missing files is how an
     * incomplete recovery point gets trusted.
     */
    partialFailure?: boolean;
    warnings?: string | null;
  };
}

export interface BackupFailureNotificationParams {
  adminEmails: string[];
  triggeredBy: string;
  success: false;
  errorMessage: string;
  destination?: string | null;
  /** ISO timestamp from the backup_runs row — used verbatim in the alert email. */
  failedAt?: string;
}

export type BackupEmailParams =
  | BackupNotificationParams
  | BackupFailureNotificationParams;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDestinationLabel(dest: string): string {
  switch (dest) {
    case "local": return "Local filesystem";
    case "network": return "Network / SFTP";
    default: return dest;
  }
}

function formatTriggeredByBackupLabel(triggeredBy: string): string {
  if (triggeredBy === "scheduler:daily") return "Daily scheduled backup";
  if (triggeredBy === "scheduler:interval") return "Recurring interval backup";
  if (triggeredBy.startsWith("admin:")) {
    const name = triggeredBy.slice("admin:".length).trim();
    return name ? `Manual (${name})` : "Manual";
  }
  return triggeredBy;
}

/**
 * What actually happened to a backup email, per recipient.
 *
 * `sendMail` reports a refused or skipped send by resolving `{ sent: false }`
 * rather than throwing — unconfigured SMTP, a rejected recipient, a reserved
 * domain. A caller that only watches for a thrown error therefore records a
 * delivery that never happened, which is precisely the silence the backup
 * alarm exists to break. Backup mail hands the outcome back instead.
 */
export interface BackupEmailDelivery {
  attempted: number;
  sent: number;
  failures: Array<{ email: string; reason: string }>;
}

async function deliverBackupMail(
  adminEmails: string[],
  message: { subject: string; html: string; text: string },
): Promise<BackupEmailDelivery> {
  const failures: Array<{ email: string; reason: string }> = [];
  let sent = 0;
  for (const email of adminEmails) {
    try {
      const result = await sendMail({ to: email, ...message });
      if (result.sent) sent += 1;
      else failures.push({ email, reason: result.reason ?? "not_sent" });
    } catch (err: unknown) {
      failures.push({ email, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { attempted: adminEmails.length, sent, failures };
}

/** One line naming why backup mail did not go out, for an alert record. */
export function describeBackupEmailFailures(delivery: BackupEmailDelivery): string {
  if (delivery.failures.length === 0) return "";
  const reasons = Array.from(new Set(delivery.failures.map((f) => f.reason)));
  return `${delivery.failures.length} of ${delivery.attempted} recipient(s) were not reached (${reasons.join("; ")})`;
}

export async function sendBackupNotificationEmail(
  params: BackupEmailParams,
): Promise<BackupEmailDelivery> {
  if (params.adminEmails.length === 0) return { attempted: 0, sent: 0, failures: [] };

  const settingsUrl = `${getAppBaseUrl()}/desktop/settings`;
  const triggeredByLabel = formatTriggeredByBackupLabel(params.triggeredBy);

  if (params.success) {
    const { result } = params;
    const partial = result.partialFailure === true;
    const dateStr = formatNumericDate(result.completedAt);
    const destLabel = formatDestinationLabel(result.destination);
    const sizeLabel = formatBytes(result.size);
    const subject = partial
      ? `LabTrax backup completed WITH WARNINGS on ${dateStr}`
      : `LabTrax backup completed successfully on ${dateStr}`;

    const rows: Array<{ label: string; value: string }> = [
      { label: "Triggered by", value: triggeredByLabel },
      { label: "Destination", value: destLabel },
      { label: "File name", value: result.fileName },
      { label: "Size", value: sizeLabel },
      { label: "Completed at", value: formatNumericDateTime(result.completedAt) },
    ];
    if (result.path) rows.push({ label: "Path", value: result.path });
    if (partial) {
      rows.push({
        label: "Warnings",
        value: partialBackupMessage(),
      });
    }

    const rowsHtml = rows
      .map(
        (r, i) =>
          `<tr style="background:${i % 2 === 0 ? "#f5f5f5" : "transparent"};"><td style="padding:8px 12px;font-weight:bold;">${escapeHtml(r.label)}</td><td style="padding:8px 12px;word-break:break-all;">${escapeHtml(r.value)}</td></tr>`,
      )
      .join("");
    const rowsText = rows.map((r) => `${r.label}: ${r.value}`).join("\n");

    const bannerColor = partial ? "#d68910" : "#27ae60";
    const bannerTint = partial ? "#fdf6e3" : "#eafaf1";
    const headline = partial
      ? "Backup completed with warnings"
      : "Backup completed successfully";
    const summary = partial
      ? `<strong>This archive is incomplete.</strong> ${escapeHtml(partialBackupMessage())}`
      : "Your LabTrax backup finished without errors.";

    const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: ${bannerColor}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.85;">${headline}</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:${bannerTint};border-left:4px solid ${bannerColor};padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        ${summary}
      </div>
      <table style="border-collapse: collapse; width: 100%; font-size: 14px;">${rowsHtml}</table>
      <p style="margin-top: 20px; font-size: 13px;">Manage your backup settings on the <a href="${settingsUrl}" style="color: #4A6CF7;">Settings page</a>.</p>
    </div>
  </div>`;

    const text = partial
      ? `LabTrax Backup Completed WITH WARNINGS\n\n${partialBackupMessage()}\n\n${rowsText}\n\nManage backup settings: ${settingsUrl}`
      : `LabTrax Backup Completed Successfully\n\n${rowsText}\n\nManage backup settings: ${settingsUrl}`;

    return deliverBackupMail(params.adminEmails, { subject, html, text });
  } else {
    const failedAt = params.failedAt ?? new Date().toISOString();
    const dateStr = formatNumericDate(failedAt);
    const destLabel = params.destination
      ? formatDestinationLabel(params.destination)
      : "unknown";
    const subject = `LabTrax backup FAILED on ${dateStr}`;
    const userMessage = backupErrorMessage(params.errorMessage);

    const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #c0392b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.85;">Backup failed</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#fdf2f2;border-left:4px solid #c0392b;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        <strong>The scheduled backup did not complete.</strong>
      </div>
      <table style="border-collapse: collapse; width: 100%; font-size: 14px; margin-bottom: 16px;">
        <tr style="background:#f5f5f5;"><td style="padding:8px 12px;font-weight:bold;">Triggered by</td><td style="padding:8px 12px;">${escapeHtml(triggeredByLabel)}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;">Destination</td><td style="padding:8px 12px;">${escapeHtml(destLabel)}</td></tr>
        <tr style="background:#f5f5f5;"><td style="padding:8px 12px;font-weight:bold;">Failed at</td><td style="padding:8px 12px;">${escapeHtml(formatNumericDateTime(failedAt))}</td></tr>
      </table>
      <p>${escapeHtml(userMessage)}</p>
      <p style="margin-top: 20px; font-size: 13px;">Review your backup configuration and failure details on the <a href="${settingsUrl}" style="color: #4A6CF7;">Settings page</a>.</p>
    </div>
  </div>`;

    const text = `LabTrax Backup FAILED\n\n${userMessage}\n\nTriggered by: ${triggeredByLabel}\nDestination: ${destLabel}\nFailed at: ${formatNumericDateTime(failedAt)}\n\nReview backup settings and failure details: ${settingsUrl}`;

    return deliverBackupMail(params.adminEmails, { subject, html, text });
  }
}

export interface BackupStaleAlertParams {
  adminEmails: string[];
  /** ISO string of the last successful backup, or null if never run. */
  lastSuccessfulAt: string | null;
  /** Number of days since the last successful backup (or Infinity if never run). */
  daysSinceBackup: number;
  /**
   * True when the configured backup destination is "local" (desktop-executed).
   * The email wording is adjusted to explain the desktop app must be open for
   * backups to run.
   */
  isLocalDestination?: boolean;
  /**
   * The effective staleness threshold (in days) that triggered this alert.
   * Used to populate the subject and body so the copy reflects the actual
   * threshold rather than a hardcoded "7 days".
   */
  thresholdDays?: number;
}

export async function sendBackupStaleAlertEmail(
  params: BackupStaleAlertParams,
): Promise<BackupEmailDelivery> {
  if (params.adminEmails.length === 0) return { attempted: 0, sent: 0, failures: [] };

  const settingsUrl = `${getAppBaseUrl()}/desktop/settings`;
  const dateStr = formatNumericDate(new Date());
  const thresholdDisplay = Math.round(params.thresholdDays ?? 7);
  const thresholdLabel = thresholdDisplay === 1 ? "1 day" : `${thresholdDisplay} days`;
  const subject = `LabTrax — No successful backup in over ${thresholdLabel} (${dateStr})`;

  const lastRunLine = params.lastSuccessfulAt
    ? `The last successful backup was on <strong>${escapeHtml(formatNumericDate(params.lastSuccessfulAt))}</strong> — <strong>${Math.floor(params.daysSinceBackup)} days ago</strong>.`
    : `<strong>No successful backup has ever been recorded</strong> for this LabTrax installation.`;
  const lastRunText = params.lastSuccessfulAt
    ? `The last successful backup was on ${formatNumericDate(params.lastSuccessfulAt)} — ${Math.floor(params.daysSinceBackup)} days ago.`
    : `No successful backup has ever been recorded for this LabTrax installation.`;

  const localNote = params.isLocalDestination
    ? `<div style="background:#fef9e7;border-left:4px solid #f39c12;padding:10px 16px;border-radius:4px;margin-bottom:12px;font-size:13px;">
        <strong>Local folder backup:</strong> Your schedule is configured to save backups to a local folder on your PC.
        These backups only run while the <strong>LabTrax Desktop app is open</strong>. If the app has been closed or the
        PC has been off, no backups will have run. Please open LabTrax Desktop to resume scheduled backups.
      </div>`
    : "";
  const localNoteText = params.isLocalDestination
    ? `Note: Your backup destination is a local folder on your PC. Local folder backups only run while the LabTrax Desktop app is open. If the app has been closed or the PC has been off, no backups will have run. Please open LabTrax Desktop to resume scheduled backups.\n\n`
    : "";

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #e67e22; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.9;">Backup overdue — action required</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#fef3e2;border-left:4px solid #e67e22;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        <strong>Warning:</strong> Your LabTrax data has not been backed up in over ${escapeHtml(thresholdLabel)}.
      </div>
      ${localNote}<p style="font-size: 14px;">${lastRunLine}</p>
      <p style="font-size: 14px;">Regular backups protect your lab data from loss. Please check your backup configuration and ensure a backup destination is configured and reachable.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${settingsUrl}" style="display: inline-block; background: #e67e22; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Review Backup Settings →</a>
      </p>
      <p style="color: #666; font-size: 13px;">This alert is sent at most once every 3 days until a successful backup runs. You can manage backup settings on the <a href="${settingsUrl}" style="color: #4A6CF7;">Settings page</a>.</p>
    </div>
  </div>`;

  const text = `LabTrax — Backup Overdue\n\nWarning: Your LabTrax data has not been backed up in over 7 days.\n\n${localNoteText}${lastRunText}\n\nPlease review your backup settings: ${settingsUrl}\n\nThis alert is sent at most once every 3 days until a successful backup runs.\n\n— The LabTrax Team`;

  return deliverBackupMail(params.adminEmails, { subject, html, text });
}

export interface DownloadInterruptionAlertParams {
  adminEmails: string[];
  retryFailCount: number;
  totalCount: number;
  windowHours: number;
  threshold: number;
  lastOccurredAt: string;
}

export async function sendDownloadInterruptionAlertEmail(
  params: DownloadInterruptionAlertParams,
): Promise<void> {
  if (params.adminEmails.length === 0) return;

  const settingsUrl = `${getAppBaseUrl()}/desktop/settings`;
  const dateStr = formatNumericDate(params.lastOccurredAt);
  const subject = `LabTrax — Download interruptions detected (${dateStr})`;
  const lastLabel = formatNumericDateTime(params.lastOccurredAt);

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #b45309; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.9;">Desktop installer download interruptions detected</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#fffbeb;border-left:4px solid #b45309;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        <strong>${escapeHtml(String(params.retryFailCount))} retry failure${params.retryFailCount !== 1 ? "s" : ""}</strong> (threshold: ${escapeHtml(String(params.threshold))}) and
        <strong>${escapeHtml(String(params.totalCount))} total interruption${params.totalCount !== 1 ? "s" : ""}</strong> in the past ${escapeHtml(String(params.windowHours))} hours.
        This may indicate App Storage instability or network issues between the server and GCS.
      </div>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <tr style="background:#f5f5f5;"><td style="padding:8px 12px;font-weight:bold;">Retry failures (24 h)</td><td style="padding:8px 12px;">${escapeHtml(String(params.retryFailCount))}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;">Total interruptions (24 h)</td><td style="padding:8px 12px;">${escapeHtml(String(params.totalCount))}</td></tr>
        <tr style="background:#f5f5f5;"><td style="padding:8px 12px;font-weight:bold;">Alert threshold</td><td style="padding:8px 12px;">${escapeHtml(String(params.threshold))} retry failures</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;">Last occurrence</td><td style="padding:8px 12px;">${escapeHtml(lastLabel)}</td></tr>
      </table>
      <p style="font-size: 13px; color: #555; margin-top: 16px;">
        A download interruption means a GCS stream dropped mid-transfer. LabTrax retried automatically — a retry failure means the second stream also failed and the client received a truncated response. Clients can resume with a Range request.
      </p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${settingsUrl}?tab=desktop" style="display: inline-block; background: #b45309; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Review in Settings →</a>
      </p>
      <p style="color: #888; font-size: 12px;">You can adjust the alert threshold with the DOWNLOAD_INTERRUPTION_ALERT_THRESHOLD environment variable (default: 3). This alert is suppressed for 1 hour after the first send at the same failure count.</p>
    </div>
  </div>`;

  const text = `LabTrax — Desktop installer download interruptions\n\n${params.retryFailCount} retry failure(s) and ${params.totalCount} total interruption(s) detected in the past ${params.windowHours} hours. Alert threshold: ${params.threshold}.\n\nLast occurrence: ${lastLabel}\n\nReview at: ${settingsUrl}?tab=desktop\n\nThis alert is suppressed for 1 hour after the first send at the same failure count.`;

  for (const email of params.adminEmails) {
    await sendMail({ to: email, subject, html, text });
  }
}

export interface InstallerReadyNotificationParams {
  notifyEmails: string[];
  version: string;
  downloadUrl: string;
}

export async function sendInstallerReadyNotificationEmail(
  params: InstallerReadyNotificationParams,
): Promise<void> {
  if (params.notifyEmails.length === 0) return;

  const downloadPageUrl = `${getAppBaseUrl()}/desktop/download`;
  const subject = `LabTrax Desktop v${params.version} is now available for download`;

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background:#4A6CF7;color:white;padding:20px;border-radius:8px 8px 0 0;">
      <h2 style="margin:0;">LabTrax</h2>
      <p style="margin:4px 0 0;opacity:0.9;">Desktop installer is ready</p>
    </div>
    <div style="padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;">
      <p style="font-size:15px;">Great news — the LabTrax Desktop installer you signed up to be notified about is now available.</p>
      <p style="font-size:14px;color:#555;"><strong>Version:</strong> ${escapeHtml(params.version)}</p>
      <p style="margin:24px 0 8px;">
        <a href="${escapeHtml(downloadPageUrl)}" style="display:inline-block;background:#4A6CF7;color:white;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px;">Download LabTrax Desktop</a>
      </p>
      <p style="font-size:13px;color:#888;margin-top:24px;">You received this email because you requested to be notified when the installer became available. You won't receive any further automated emails from this address.</p>
    </div>
  </div>`;

  const text = `LabTrax Desktop v${params.version} is now available.\n\nDownload it at: ${downloadPageUrl}\n\nYou received this because you signed up for installer availability notifications.`;

  for (const email of params.notifyEmails) {
    await sendMail({ to: email, subject, html, text });
  }
}

export interface SecurityAlertEmailParams {
  to: string;
  username: string;
  detectedAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function sendSecurityAlertEmail(
  params: SecurityAlertEmailParams,
): Promise<SendMailResult> {
  const subject =
    "Security alert: suspicious activity detected on your LabTrax account";
  const baseUrl = getAppBaseUrl();
  const passwordResetUrl = `${baseUrl}/desktop/settings/security/password`;
  const sessionsUrl = `${baseUrl}/desktop/settings/security/sessions`;

  const timestampLabel = formatNumericDateTime(params.detectedAt);

  const ipLine = params.ipAddress
    ? `<tr><td style="padding:8px 12px;font-weight:bold;">IP address</td><td style="padding:8px 12px;">${escapeHtml(params.ipAddress)}</td></tr>`
    : "";
  const uaLine = params.userAgent
    ? `<tr style="background:#f5f5f5;"><td style="padding:8px 12px;font-weight:bold;">Device/browser</td><td style="padding:8px 12px;word-break:break-all;">${escapeHtml(params.userAgent)}</td></tr>`
    : "";
  const ipText = params.ipAddress ? `IP address: ${params.ipAddress}\n` : "";
  const uaText = params.userAgent
    ? `Device/browser: ${params.userAgent}\n`
    : "";

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #c0392b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.85;">Security alert</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#fdf2f2;border-left:4px solid #c0392b;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        <strong>Suspicious sign-in activity was detected</strong> on your LabTrax account. A device was signed out as a precaution.
      </div>
      <p style="font-size:14px;">Hi <strong>${escapeHtml(params.username)}</strong>, we detected a reused sign-in token from one of your devices and signed that device out as a precaution.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin-bottom:16px;">
        <tr style="background:#f5f5f5;"><td style="padding:8px 12px;font-weight:bold;">When</td><td style="padding:8px 12px;">${escapeHtml(timestampLabel)}</td></tr>
        ${ipLine}${uaLine}
      </table>
      <p style="font-size:14px;"><strong>If this wasn't you</strong>, your account may be compromised. Take action immediately:</p>
      <ul style="font-size:14px;line-height:1.6;">
        <li><a href="${passwordResetUrl}" style="color:#c0392b;font-weight:bold;">Reset your password</a></li>
        <li><a href="${sessionsUrl}" style="color:#c0392b;">Review and revoke active sessions</a></li>
      </ul>
      <p style="font-size:13px;color:#666;">If you recognize this activity, no action is needed — the affected session has already been signed out.</p>
    </div>
  </div>`;

  const text = [
    "LabTrax — Security alert",
    "",
    `Hi ${params.username}, we detected a reused sign-in token from one of your devices and signed that device out as a precaution.`,
    "",
    `When: ${timestampLabel}`,
    ipText,
    uaText,
    "If this wasn't you, take action immediately:",
    `  - Reset your password: ${passwordResetUrl}`,
    `  - Review active sessions: ${sessionsUrl}`,
    "",
    "If you recognize this activity, no action is needed — the affected session has already been signed out.",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return sendMail({ to: params.to, subject, html, text });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface DatabaseIdentityAlertDelivery {
  /** How many admin addresses were tried. */
  attempted: number;
  /** Addresses SMTP actually accepted. */
  delivered: string[];
  /** Addresses that were skipped or refused, with the reason. */
  failures: Array<{ email: string; reason: string }>;
}

export interface DatabaseIdentityAlertEmailParams {
  adminEmails: string[];
  /** When the scheduled comparison ran (ISO). */
  checkedAt: string;
  /** The reported facts, as the identity check itself words them. */
  facts: string[];
  /** Why the comparison refused production, worst first. */
  findings: Array<{ level: "failure" | "warning"; message: string }>;
  /** Repository path holding the expected values. */
  fingerprintPath: string;
  /** The only sanctioned way to change those expected values. */
  recordCommand: string;
}

/**
 * Tell lab admins that the production database no longer matches the identity
 * fingerprint committed in the repository.
 *
 * This is not a routine ops digest: it only fires when the counts, the lab's
 * oldest case timestamp, or the production/development lineage stopped
 * agreeing with what was recorded — i.e. when production may not be the
 * lab's own database any more. The email deliberately carries the same four
 * facts the publish preflight prints, so the alert and the build log can be
 * compared line for line.
 *
 * Each admin is mailed separately and the result of every send is reported
 * back. `sendMail` resolves `{ sent: false }` for a skipped or refused
 * recipient instead of throwing, and it treats `to` as a single address — so
 * a caller that joined the recipients and ignored the result would report a
 * swapped production database as "admins alerted" while nobody received
 * anything, which is the one failure this whole path exists to prevent.
 */
export async function sendDatabaseIdentityAlertEmail(
  params: DatabaseIdentityAlertEmailParams,
): Promise<DatabaseIdentityAlertDelivery> {
  const delivery: DatabaseIdentityAlertDelivery = {
    attempted: 0,
    delivered: [],
    failures: [],
  };
  if (params.adminEmails.length === 0) return delivery;

  const checkedLabel = formatNumericDateTime(params.checkedAt);
  const subject = `LabTrax ALERT: production database no longer matches its recorded identity (${checkedLabel})`;

  const factRows = params.facts
    .map(
      (fact, index) =>
        `<tr${index % 2 === 0 ? ' style="background:#f5f5f5;"' : ""}><td style="padding:8px 12px;word-break:break-word;">${escapeHtml(fact)}</td></tr>`,
    )
    .join("");

  const findingItems = params.findings
    .map(
      (finding) =>
        `<li style="margin-bottom:6px;"><strong>${finding.level === "failure" ? "BLOCKED" : "WARNING"}</strong> — ${escapeHtml(finding.message)}</li>`,
    )
    .join("");

  const html = `<div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
    <div style="background: #c0392b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.85;">Production database identity alert</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#fdf2f2;border-left:4px solid #c0392b;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        <strong>The production database stopped matching its recorded identity.</strong>
        A scheduled read-only check compared production against the fingerprint committed in
        <code>${escapeHtml(params.fingerprintPath)}</code> on ${escapeHtml(checkedLabel)} and they no longer agree.
      </div>
      <p style="font-size:14px;margin-bottom:6px;"><strong>What the check saw in production</strong></p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin-bottom:16px;">${factRows}</table>
      <p style="font-size:14px;margin-bottom:6px;"><strong>Why this is an alert</strong></p>
      <ul style="font-size:14px;line-height:1.5;">${findingItems}</ul>
      <p style="font-size:14px;">If nothing about production was supposed to change, treat this as a possible database swap or data loss: check which database the deployment is bound to before writing anything else to it.</p>
      <p style="font-size:14px;">If the change was deliberate, re-record the fingerprint with <code>${escapeHtml(params.recordCommand)}</code> and commit the result. Nothing else — including this alert — changes the expected values.</p>
      <p style="font-size:13px;color:#666;">This check never writes to any database. It will alert again on its next run while production still does not match.</p>
    </div>
  </div>`;

  const text = [
    "LabTrax — Production database identity alert",
    "",
    `A scheduled read-only check compared production against the fingerprint committed in ${params.fingerprintPath} on ${checkedLabel}, and they no longer agree.`,
    "",
    "What the check saw in production:",
    ...params.facts.map((fact) => `  - ${fact}`),
    "",
    "Why this is an alert:",
    ...params.findings.map(
      (finding) =>
        `  - ${finding.level === "failure" ? "BLOCKED" : "WARNING"} — ${finding.message}`,
    ),
    "",
    "If nothing about production was supposed to change, treat this as a possible database swap or data loss: check which database the deployment is bound to before writing anything else to it.",
    "",
    `If the change was deliberate, re-record the fingerprint with \`${params.recordCommand}\` and commit the result. Nothing else — including this alert — changes the expected values.`,
    "",
    "This check never writes to any database. It will alert again on its next run while production still does not match.",
  ].join("\n");

  for (const email of params.adminEmails) {
    delivery.attempted += 1;
    try {
      const result = await sendMail({ to: email, subject, html, text });
      if (result.sent) {
        delivery.delivered.push(email);
      } else {
        delivery.failures.push({
          email,
          reason: result.reason ?? "not_sent",
        });
      }
    } catch (err: any) {
      delivery.failures.push({
        email,
        reason: err?.message ? String(err.message) : "send_threw",
      });
    }
  }

  return delivery;
}
