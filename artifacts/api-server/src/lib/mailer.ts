import nodemailer, { type Transporter } from "nodemailer";

export interface MailerConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export function getMailerConfig(): MailerConfig | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const portStr = process.env.SMTP_PORT || "587";
  const port = parseInt(portStr, 10) || 587;
  return {
    host,
    port,
    secure: portStr === "465",
    user,
    pass,
    from: process.env.SMTP_FROM || user,
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
