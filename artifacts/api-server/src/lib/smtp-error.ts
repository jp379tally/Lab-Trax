/**
 * Classifies a caught nodemailer/SMTP error into a stable category plus a
 * safe, user-facing message. The classifier deliberately extracts ONLY the
 * numeric provider response code, the nodemailer error `code`, and a derived
 * category — it never echoes the raw provider message, which can contain the
 * SMTP username, password, tokens, or other sensitive payload fragments.
 */

export type SmtpErrorCategory = "auth" | "connection" | "recipient" | "unknown";

export interface ClassifiedSmtpError {
  /** Stable category used for both logging and message selection. */
  category: SmtpErrorCategory;
  /** Safe, user-facing message. Never contains provider-echoed text. */
  message: string;
  /** Numeric SMTP response code (e.g. 535, 550) if the provider gave one. */
  responseCode: number | null;
  /** Nodemailer error code (e.g. EAUTH, ECONNECTION) if present. */
  code: string | null;
}

const MESSAGES: Record<SmtpErrorCategory, string> = {
  auth: "Email provider rejected the login. Check the SMTP username/password (or app password).",
  connection:
    "Could not connect to the email server. Check the SMTP host, port, and TLS setting.",
  recipient: "The email server rejected the recipient address.",
  unknown: "Failed to send the email. Check your SMTP settings and try again.",
};

export function classifySmtpError(err: unknown): ClassifiedSmtpError {
  const e = err as
    | { code?: unknown; command?: unknown; responseCode?: unknown }
    | null
    | undefined;

  const code = typeof e?.code === "string" ? e.code : null;
  const command = typeof e?.command === "string" ? e.command : null;
  const responseCode =
    typeof e?.responseCode === "number" && Number.isFinite(e.responseCode)
      ? e.responseCode
      : null;

  // Authentication failures. Check first — these use 5xx response codes that
  // would otherwise be swallowed by the generic recipient branch below.
  if (
    code === "EAUTH" ||
    responseCode === 535 ||
    responseCode === 534 ||
    responseCode === 538 ||
    responseCode === 530
  ) {
    return { category: "auth", message: MESSAGES.auth, responseCode, code };
  }

  // Connection / TLS failures.
  if (
    code === "ECONNECTION" ||
    code === "ESOCKET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "EDNS" ||
    code === "CONN" ||
    command === "CONN"
  ) {
    return {
      category: "connection",
      message: MESSAGES.connection,
      responseCode,
      code,
    };
  }

  // Recipient rejected — nodemailer's EENVELOPE, or any other 5xx SMTP reply.
  if (
    code === "EENVELOPE" ||
    (responseCode !== null && responseCode >= 500 && responseCode < 600)
  ) {
    return {
      category: "recipient",
      message: MESSAGES.recipient,
      responseCode,
      code,
    };
  }

  return { category: "unknown", message: MESSAGES.unknown, responseCode, code };
}
