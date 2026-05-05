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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
