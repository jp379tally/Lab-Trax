import type { Transporter } from "nodemailer";
import { logger } from "./logger";
import {
  createTransport,
  getMailerConfig,
  type MailerConfig,
} from "./mailer";

let cachedTransport: { key: string; transporter: Transporter } | null = null;

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
}

export interface SendMailResult {
  sent: boolean;
  reason?: string;
}

export async function sendMail(opts: SendMailOptions): Promise<SendMailResult> {
  const cfg = getMailerConfig();
  if (!cfg) {
    logger.warn(
      { to: opts.to, subject: opts.subject },
      "[mail] SMTP not configured; skipping send"
    );
    return { sent: false, reason: "smtp_not_configured" };
  }
  try {
    const transporter = getTransporter(cfg);
    await transporter.sendMail({
      from: cfg.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
    return { sent: true };
  } catch (err: any) {
    logger.error(
      { err: err?.message || String(err), to: opts.to, subject: opts.subject },
      "[mail] failed to send"
    );
    return { sent: false, reason: err?.message || "send_failed" };
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

export interface InviteEmailParams {
  to: string;
  organizationName: string;
  roleToAssign: string;
  token: string;
  inviterName?: string | null;
  expiresAt?: Date | null;
}

export async function sendInviteEmail(
  params: InviteEmailParams
): Promise<SendMailResult> {
  const roleLabel = formatRoleLabel(params.roleToAssign);
  const acceptUrl = `${getAppBaseUrl()}/desktop/?invite=${encodeURIComponent(
    params.token
  )}`;
  const expires = params.expiresAt ? params.expiresAt.toUTCString() : null;
  const inviter = params.inviterName?.trim();

  const greetingHtml = inviter
    ? `${escapeHtml(inviter)} has invited you to join`
    : `You have been invited to join`;
  const greetingText = inviter
    ? `${inviter} has invited you to join`
    : `You have been invited to join`;

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
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

  const dateStr = report.ranAt.slice(0, 10);
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
      <p style="color: #555; font-size: 13px;">Run at: ${escapeHtml(report.ranAt)}</p>
      ${fatalBannerHtml}${fatalTriggeredByHtml}${statsHtml}${errorRowsHtml}${maintenanceLinkHtml}
    </div>
  </div>`;

  const text = `LabTrax Nightly Media Cleanup Report\nRun at: ${report.ranAt}\n\n${fatalBannerText}${fatalTriggeredByText}${statsText}${errorRowsText}${maintenanceLinkText}`;

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
  const dateStr = new Date().toISOString().slice(0, 10);
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
  const dateStr = reportedAt.slice(0, 10);
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
  rows.push({ label: "Reported at", value: reportedAt });

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
  };
}

export interface BackupFailureNotificationParams {
  adminEmails: string[];
  triggeredBy: string;
  success: false;
  errorMessage: string;
  destination?: string | null;
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
    case "onedrive": return "OneDrive";
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

export async function sendBackupNotificationEmail(
  params: BackupEmailParams,
): Promise<void> {
  if (params.adminEmails.length === 0) return;

  const settingsUrl = `${getAppBaseUrl()}/desktop/settings`;
  const triggeredByLabel = formatTriggeredByBackupLabel(params.triggeredBy);

  if (params.success) {
    const { result } = params;
    const dateStr = result.completedAt.slice(0, 10);
    const destLabel = formatDestinationLabel(result.destination);
    const sizeLabel = formatBytes(result.size);
    const subject = `LabTrax backup completed successfully on ${dateStr}`;

    const rows: Array<{ label: string; value: string }> = [
      { label: "Triggered by", value: triggeredByLabel },
      { label: "Destination", value: destLabel },
      { label: "File name", value: result.fileName },
      { label: "Size", value: sizeLabel },
      { label: "Completed at", value: result.completedAt },
    ];
    if (result.path) rows.push({ label: "Path", value: result.path });

    const rowsHtml = rows
      .map(
        (r, i) =>
          `<tr style="background:${i % 2 === 0 ? "#f5f5f5" : "transparent"};"><td style="padding:8px 12px;font-weight:bold;">${escapeHtml(r.label)}</td><td style="padding:8px 12px;word-break:break-all;">${escapeHtml(r.value)}</td></tr>`,
      )
      .join("");
    const rowsText = rows.map((r) => `${r.label}: ${r.value}`).join("\n");

    const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #27ae60; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.85;">Backup completed successfully</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#eafaf1;border-left:4px solid #27ae60;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        Your LabTrax backup finished without errors.
      </div>
      <table style="border-collapse: collapse; width: 100%; font-size: 14px;">${rowsHtml}</table>
      <p style="margin-top: 20px; font-size: 13px;">Manage your backup settings on the <a href="${settingsUrl}" style="color: #4A6CF7;">Settings page</a>.</p>
    </div>
  </div>`;

    const text = `LabTrax Backup Completed Successfully\n\n${rowsText}\n\nManage backup settings: ${settingsUrl}`;

    for (const email of params.adminEmails) {
      await sendMail({ to: email, subject, html, text });
    }
  } else {
    const dateStr = new Date().toISOString().slice(0, 10);
    const destLabel = params.destination
      ? formatDestinationLabel(params.destination)
      : "unknown";
    const subject = `LabTrax backup FAILED on ${dateStr}`;

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
        <tr style="background:#f5f5f5;"><td style="padding:8px 12px;font-weight:bold;">Failed at</td><td style="padding:8px 12px;">${escapeHtml(new Date().toISOString())}</td></tr>
      </table>
      <h3 style="color:#c0392b;margin-top:0;">Error</h3>
      <pre style="background:#1e1e1e;color:#f5f5f5;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(params.errorMessage)}</pre>
      <p style="margin-top: 20px; font-size: 13px;">Review your backup configuration on the <a href="${settingsUrl}" style="color: #4A6CF7;">Settings page</a>.</p>
    </div>
  </div>`;

    const text = `LabTrax Backup FAILED\n\nTriggered by: ${triggeredByLabel}\nDestination: ${destLabel}\nFailed at: ${new Date().toISOString()}\n\nError:\n${params.errorMessage}\n\nReview backup settings: ${settingsUrl}`;

    for (const email of params.adminEmails) {
      await sendMail({ to: email, subject, html, text });
    }
  }
}

export interface BackupStaleAlertParams {
  adminEmails: string[];
  /** ISO string of the last successful backup, or null if never run. */
  lastSuccessfulAt: string | null;
  /** Number of days since the last successful backup (or Infinity if never run). */
  daysSinceBackup: number;
}

export async function sendBackupStaleAlertEmail(
  params: BackupStaleAlertParams,
): Promise<void> {
  if (params.adminEmails.length === 0) return;

  const settingsUrl = `${getAppBaseUrl()}/desktop/settings`;
  const dateStr = new Date().toISOString().slice(0, 10);
  const subject = `LabTrax — No successful backup in over 7 days (${dateStr})`;

  const lastRunLine = params.lastSuccessfulAt
    ? `The last successful backup was on <strong>${escapeHtml(params.lastSuccessfulAt.slice(0, 10))}</strong> — <strong>${Math.floor(params.daysSinceBackup)} days ago</strong>.`
    : `<strong>No successful backup has ever been recorded</strong> for this LabTrax installation.`;
  const lastRunText = params.lastSuccessfulAt
    ? `The last successful backup was on ${params.lastSuccessfulAt.slice(0, 10)} — ${Math.floor(params.daysSinceBackup)} days ago.`
    : `No successful backup has ever been recorded for this LabTrax installation.`;

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #e67e22; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.9;">Backup overdue — action required</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#fef3e2;border-left:4px solid #e67e22;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        <strong>Warning:</strong> Your LabTrax data has not been backed up in over 7 days.
      </div>
      <p style="font-size: 14px;">${lastRunLine}</p>
      <p style="font-size: 14px;">Regular backups protect your lab data from loss. Please check your backup configuration and ensure a backup destination is configured and reachable.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${settingsUrl}" style="display: inline-block; background: #e67e22; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Review Backup Settings →</a>
      </p>
      <p style="color: #666; font-size: 13px;">This alert is sent at most once every 3 days until a successful backup runs. You can manage backup settings on the <a href="${settingsUrl}" style="color: #4A6CF7;">Settings page</a>.</p>
    </div>
  </div>`;

  const text = `LabTrax — Backup Overdue\n\nWarning: Your LabTrax data has not been backed up in over 7 days.\n\n${lastRunText}\n\nPlease review your backup settings: ${settingsUrl}\n\nThis alert is sent at most once every 3 days until a successful backup runs.\n\n— The LabTrax Team`;

  for (const email of params.adminEmails) {
    await sendMail({ to: email, subject, html, text });
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
