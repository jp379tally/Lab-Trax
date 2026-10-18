import nodemailer, { type Transporter } from "nodemailer";

export interface MailerConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * Normalize SMTP settings read from the environment.
 *
 * - Host, username, and from-address: trim surrounding whitespace only —
 *   internal whitespace could be meaningful (e.g. a display-name from), and
 *   stripping it would silently change the value.
 * - Password: strip ALL whitespace. Google displays app passwords in groups
 *   ("xxxx xxxx xxxx xxxx") and users routinely paste them verbatim; the
 *   spaces are never part of the credential, so a space-containing password
 *   is always a paste artifact that would otherwise fail auth (535).
 */
export function normalizeSmtpValue(value: string): string {
  return value.trim();
}

export function normalizeSmtpPassword(pass: string): string {
  return pass.replace(/\s+/g, "");
}

export function getMailerConfig(): MailerConfig | null {
  const host = normalizeSmtpValue(process.env.SMTP_HOST || "");
  const user = normalizeSmtpValue(process.env.SMTP_USER || "");
  const pass = normalizeSmtpPassword(process.env.SMTP_PASS || "");
  if (!host || !user || !pass) return null;
  const portStr = (process.env.SMTP_PORT || "587").trim();
  const port = parseInt(portStr, 10) || 587;
  return {
    host,
    port,
    secure: portStr === "465",
    user,
    pass,
    from: normalizeSmtpValue(process.env.SMTP_FROM || "") || user,
  };
}

export function createTransport(cfg: MailerConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
}
