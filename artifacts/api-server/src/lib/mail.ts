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
  /**
   * When set, an <img> with the lab logo is shown in the email header.
   * Should be an absolute URL (e.g. https://…/api/organizations/:id/logo).
   * Only included when the lab's `welcome_emails` placement is enabled.
   */
  labLogoUrl?: string | null;
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

  const logoHtml = params.labLogoUrl
    ? `<div style="margin-bottom: 10px;"><img src="${escapeHtml(params.labLogoUrl)}" alt="Lab logo" style="max-height: 44px; max-width: 140px; object-fit: contain; display: block;" /></div>`
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
    const failedAt = params.failedAt ?? new Date().toISOString();
    const dateStr = failedAt.slice(0, 10);
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
        <tr style="background:#f5f5f5;"><td style="padding:8px 12px;font-weight:bold;">Failed at</td><td style="padding:8px 12px;">${escapeHtml(failedAt)}</td></tr>
      </table>
      <h3 style="color:#c0392b;margin-top:0;">Error</h3>
      <pre style="background:#1e1e1e;color:#f5f5f5;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(params.errorMessage)}</pre>
      <p style="margin-top: 20px; font-size: 13px;">Review your backup configuration on the <a href="${settingsUrl}" style="color: #4A6CF7;">Settings page</a>.</p>
    </div>
  </div>`;

    const text = `LabTrax Backup FAILED\n\nTriggered by: ${triggeredByLabel}\nDestination: ${destLabel}\nFailed at: ${failedAt}\n\nError:\n${params.errorMessage}\n\nReview backup settings: ${settingsUrl}`;

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

export interface OneDriveDisconnectedAlertParams {
  adminEmails: string[];
  /** Optional error message from the failed status check. */
  errorMessage?: string | null;
  /** ISO timestamp when the disconnect was detected. */
  detectedAt: string;
}

export async function sendOneDriveDisconnectedAlertEmail(
  params: OneDriveDisconnectedAlertParams,
): Promise<void> {
  if (params.adminEmails.length === 0) return;

  const settingsUrl = `${getAppBaseUrl()}/desktop/settings`;
  const dateStr = params.detectedAt.slice(0, 10);
  const subject = `LabTrax — OneDrive backup disconnected (${dateStr})`;
  const detectedAtLabel = (() => {
    const ms = new Date(params.detectedAt).getTime();
    return isNaN(ms) ? params.detectedAt : new Date(ms).toUTCString();
  })();

  const errorBlock = params.errorMessage
    ? `<h3 style="color:#c0392b;margin-top:0;">Reported error</h3>
      <pre style="background:#1e1e1e;color:#f5f5f5;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(params.errorMessage)}</pre>`
    : "";

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #c0392b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.9;">OneDrive backup disconnected — action required</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#fdf2f2;border-left:4px solid #c0392b;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        <strong>Your LabTrax OneDrive backup integration is no longer connected.</strong> Scheduled backups to OneDrive will keep failing until an admin reconnects the integration.
      </div>
      <p style="font-size: 14px;">Disconnect detected at: <strong>${escapeHtml(detectedAtLabel)}</strong></p>
      ${errorBlock}
      <p style="text-align: center; margin: 24px 0;">
        <a href="${settingsUrl}" style="display: inline-block; background: #c0392b; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Reconnect OneDrive →</a>
      </p>
      <p style="color: #666; font-size: 13px;">Open Settings → Backup and click "Reconnect" to re-authorize the OneDrive integration. You'll only receive this alert once per disconnect event — a follow-up email will confirm when OneDrive reconnects.</p>
    </div>
  </div>`;

  const text = `LabTrax — OneDrive backup disconnected\n\nYour LabTrax OneDrive backup integration is no longer connected. Scheduled backups to OneDrive will keep failing until an admin reconnects it.\n\nDisconnect detected at: ${detectedAtLabel}${params.errorMessage ? `\n\nReported error:\n${params.errorMessage}` : ""}\n\nReconnect at: ${settingsUrl}\n\nYou will only receive this alert once per disconnect event. A follow-up email will confirm when OneDrive reconnects.`;

  for (const email of params.adminEmails) {
    await sendMail({ to: email, subject, html, text });
  }
}

export interface OneDriveReconnectedAlertParams {
  adminEmails: string[];
  /** ISO timestamp when reconnection was detected. */
  reconnectedAt: string;
}

export async function sendOneDriveReconnectedAlertEmail(
  params: OneDriveReconnectedAlertParams,
): Promise<void> {
  if (params.adminEmails.length === 0) return;

  const settingsUrl = `${getAppBaseUrl()}/desktop/settings`;
  const dateStr = params.reconnectedAt.slice(0, 10);
  const subject = `LabTrax — OneDrive backup reconnected (${dateStr})`;
  const reconnectedAtLabel = (() => {
    const ms = new Date(params.reconnectedAt).getTime();
    return isNaN(ms) ? params.reconnectedAt : new Date(ms).toUTCString();
  })();

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #27ae60; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.9;">OneDrive backup reconnected</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#eafaf1;border-left:4px solid #27ae60;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        <strong>Good news:</strong> the OneDrive backup integration is connected again. Scheduled backups will resume on the next run.
      </div>
      <p style="font-size: 14px;">Reconnection confirmed at: <strong>${escapeHtml(reconnectedAtLabel)}</strong></p>
      <p style="font-size: 13px; color:#555;">Review backup status any time on the <a href="${settingsUrl}" style="color: #4A6CF7;">Settings page</a>.</p>
    </div>
  </div>`;

  const text = `LabTrax — OneDrive backup reconnected\n\nGood news: the OneDrive backup integration is connected again. Scheduled backups will resume on the next run.\n\nReconnection confirmed at: ${reconnectedAtLabel}\n\nReview backup status: ${settingsUrl}`;

  for (const email of params.adminEmails) {
    await sendMail({ to: email, subject, html, text });
  }
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
  const dateStr = params.lastOccurredAt.slice(0, 10);
  const subject = `LabTrax — Download interruptions detected (${dateStr})`;
  const lastLabel = (() => {
    const ms = new Date(params.lastOccurredAt).getTime();
    return isNaN(ms) ? params.lastOccurredAt : new Date(ms).toUTCString();
  })();

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

export interface TwoFactorEnabledEmailParams {
  to: string;
  username: string;
  ipAddress?: string | null;
  timestamp: string;
}

export async function sendTwoFactorEnabledEmail(
  params: TwoFactorEnabledEmailParams,
): Promise<SendMailResult> {
  const subject = "Two-factor authentication enabled on your LabTrax account";
  const timestampLabel = (() => {
    const ms = new Date(params.timestamp).getTime();
    return isNaN(ms) ? params.timestamp : new Date(ms).toUTCString();
  })();

  const ipLine = params.ipAddress
    ? `<tr><td style="padding:8px 12px;font-weight:bold;">IP address</td><td style="padding:8px 12px;">${escapeHtml(params.ipAddress)}</td></tr>`
    : "";
  const ipText = params.ipAddress ? `IP address: ${params.ipAddress}\n` : "";

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #27ae60; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.85;">Security alert</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#eafaf1;border-left:4px solid #27ae60;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        <strong>Two-factor authentication (2FA) has been enabled</strong> on your LabTrax account.
      </div>
      <p style="font-size:14px;">Hi <strong>${escapeHtml(params.username)}</strong>, this is a confirmation that 2FA was successfully set up for your account.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin-bottom:16px;">
        <tr style="background:#f5f5f5;"><td style="padding:8px 12px;font-weight:bold;">When</td><td style="padding:8px 12px;">${escapeHtml(timestampLabel)}</td></tr>
        ${ipLine}
      </table>
      <p style="font-size:14px;">Your account is now more secure. Keep your backup codes in a safe place — they can be used to sign in if you lose access to your authenticator app.</p>
      <p style="color:#c0392b;font-size:13px;"><strong>Didn't do this?</strong> Your account may be compromised. Change your password immediately and contact support.</p>
    </div>
  </div>`;

  const text = `LabTrax — Two-factor authentication enabled\n\nHi ${params.username}, 2FA has been enabled on your LabTrax account.\n\nWhen: ${timestampLabel}\n${ipText}\nKeep your backup codes in a safe place.\n\nDidn't do this? Change your password immediately and contact support.`;

  return sendMail({ to: params.to, subject, html, text });
}

export interface TwoFactorDisabledEmailParams {
  to: string;
  username: string;
  ipAddress?: string | null;
  timestamp: string;
}

export async function sendTwoFactorDisabledEmail(
  params: TwoFactorDisabledEmailParams,
): Promise<SendMailResult> {
  const subject = "Two-factor authentication disabled on your LabTrax account";
  const timestampLabel = (() => {
    const ms = new Date(params.timestamp).getTime();
    return isNaN(ms) ? params.timestamp : new Date(ms).toUTCString();
  })();

  const ipLine = params.ipAddress
    ? `<tr><td style="padding:8px 12px;font-weight:bold;">IP address</td><td style="padding:8px 12px;">${escapeHtml(params.ipAddress)}</td></tr>`
    : "";
  const ipText = params.ipAddress ? `IP address: ${params.ipAddress}\n` : "";

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #c0392b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.85;">Security alert</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#fdf2f2;border-left:4px solid #c0392b;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        <strong>Two-factor authentication (2FA) has been disabled</strong> on your LabTrax account.
      </div>
      <p style="font-size:14px;">Hi <strong>${escapeHtml(params.username)}</strong>, this is a notification that 2FA was removed from your account.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin-bottom:16px;">
        <tr style="background:#f5f5f5;"><td style="padding:8px 12px;font-weight:bold;">When</td><td style="padding:8px 12px;">${escapeHtml(timestampLabel)}</td></tr>
        ${ipLine}
      </table>
      <p style="font-size:14px;">Your account is now protected only by your password. You can re-enable 2FA at any time from your account security settings.</p>
      <p style="color:#c0392b;font-size:13px;"><strong>Didn't do this?</strong> Your account may be compromised. Change your password immediately and contact support.</p>
    </div>
  </div>`;

  const text = `LabTrax — Two-factor authentication disabled\n\nHi ${params.username}, 2FA has been disabled on your LabTrax account.\n\nWhen: ${timestampLabel}\n${ipText}\nYour account is now protected only by your password. You can re-enable 2FA from your account security settings.\n\nDidn't do this? Change your password immediately and contact support.`;

  return sendMail({ to: params.to, subject, html, text });
}

export interface TwoFactorBackupCodeUsedEmailParams {
  to: string;
  username: string;
  remainingCount: number;
  ipAddress?: string | null;
  timestamp: string;
}

export async function sendTwoFactorBackupCodeUsedEmail(
  params: TwoFactorBackupCodeUsedEmailParams,
): Promise<SendMailResult> {
  const subject = "A backup code was used to sign in to your LabTrax account";
  const timestampLabel = (() => {
    const ms = new Date(params.timestamp).getTime();
    return isNaN(ms) ? params.timestamp : new Date(ms).toUTCString();
  })();

  const ipLine = params.ipAddress
    ? `<tr><td style="padding:8px 12px;font-weight:bold;">IP address</td><td style="padding:8px 12px;">${escapeHtml(params.ipAddress)}</td></tr>`
    : "";
  const ipText = params.ipAddress ? `IP address: ${params.ipAddress}\n` : "";

  const lowWarningHtml =
    params.remainingCount <= 2
      ? `<div style="background:#fef3e2;border-left:4px solid #e67e22;padding:12px 16px;border-radius:4px;margin-top:16px;"><strong>Warning:</strong> You only have <strong>${params.remainingCount}</strong> backup code${params.remainingCount === 1 ? "" : "s"} remaining. Consider re-generating your backup codes from your account security settings.</div>`
      : "";
  const lowWarningText =
    params.remainingCount <= 2
      ? `\nWARNING: Only ${params.remainingCount} backup code${params.remainingCount === 1 ? "" : "s"} remaining. Re-generate your backup codes from your account security settings.\n`
      : "";

  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #e67e22; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0;">LabTrax</h2>
      <p style="margin: 4px 0 0; opacity: 0.85;">Security alert</p>
    </div>
    <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
      <div style="background:#fef3e2;border-left:4px solid #e67e22;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
        A <strong>backup code</strong> was used to sign in to your LabTrax account.
      </div>
      <p style="font-size:14px;">Hi <strong>${escapeHtml(params.username)}</strong>, a one-time backup code was consumed during sign-in.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin-bottom:16px;">
        <tr style="background:#f5f5f5;"><td style="padding:8px 12px;font-weight:bold;">When</td><td style="padding:8px 12px;">${escapeHtml(timestampLabel)}</td></tr>
        ${ipLine}
        <tr style="background:#f5f5f5;"><td style="padding:8px 12px;font-weight:bold;">Backup codes remaining</td><td style="padding:8px 12px;">${params.remainingCount}</td></tr>
      </table>
      <p style="font-size:14px;">Each backup code can only be used once. Once all backup codes are exhausted, you will not be able to use this recovery method.</p>
      ${lowWarningHtml}
      <p style="color:#c0392b;font-size:13px;margin-top:16px;"><strong>Didn't do this?</strong> Change your password immediately and contact support — someone may have access to your backup codes.</p>
    </div>
  </div>`;

  const text = `LabTrax — Backup sign-in code used\n\nHi ${params.username}, a backup code was used to sign in to your LabTrax account.\n\nWhen: ${timestampLabel}\n${ipText}Backup codes remaining: ${params.remainingCount}\n${lowWarningText}\nEach backup code can only be used once.\n\nDidn't do this? Change your password immediately and contact support.`;

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
