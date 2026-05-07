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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
