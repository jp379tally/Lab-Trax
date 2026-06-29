/**
 * Generic SMS provider module.  Backed by Twilio -- the API is wrapped in a
 * thin local interface so switching to another provider later only requires
 * changing this file.
 *
 * Env vars:
 *   TWILIO_ACCOUNT_SID   -- Twilio Account SID
 *   TWILIO_AUTH_TOKEN    -- Twilio Auth Token
 *   TWILIO_PHONE_NUMBER  -- Sender phone number in E.164 (e.g. +15551234567)
 *
 * In dev mode (NODE_ENV=development) or when VITEST is set, the module
 * logs the message instead of dispatching, so tests and local dev work
 * without live credentials.
 */

import type { Logger } from "pino";
import twilio from "twilio";

function getCredentials() {
  const accountSid = process.env["TWILIO_ACCOUNT_SID"];
  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  const from = process.env["TWILIO_PHONE_NUMBER"];
  return { accountSid, authToken, from };
}

export function isConfigured(): boolean {
  const { accountSid, authToken, from } = getCredentials();
  return !!(accountSid && authToken && from);
}

export function isDevOrTest(): boolean {
  return (
    process.env["NODE_ENV"] === "development" ||
    process.env["NODE_ENV"] === "test" ||
    (!!process.env["VITEST"] && !process.env["NODE_ENV"])
  );
}

export interface SendSmsArgs {
  to: string;
  body: string;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

export interface SendSmsResult {
  ok: boolean;
  /** Provider message id when successful. */
  messageId?: string;
  /** Error code from the provider when the request is rejected. */
  errorCode?: string;
  /** Human-readable error message. */
  errorMessage?: string;
  /** True when the provider is not configured (dev) -- the caller may still
   *  proceed with side-effects (e.g. persisting the invite row). */
  skipped?: boolean;
}

/**
 * Send a single SMS via Twilio.  Returns a result object so callers can
 * decide whether to fail the request or just log the issue.
 */
export async function sendSms(args: SendSmsArgs): Promise<SendSmsResult> {
  const { accountSid, authToken, from } = getCredentials();

  if (!accountSid || !authToken || !from) {
    if (isDevOrTest()) {
      args.log?.info?.(
        { phone: maskPhone(args.to) },
        "SMS not configured -- logging demo message (dev/test)",
      );
      return { ok: true, skipped: true };
    }
    return {
      ok: false,
      errorCode: "not_configured",
      errorMessage: "SMS provider is not configured on this server.",
    };
  }

  try {
    const client = twilio(accountSid, authToken);
    const message = await client.messages.create({
      from,
      to: args.to,
      body: args.body,
    });

    return { ok: true, messageId: message.sid };
  } catch (err: any) {
    const errorCode = String(err.code ?? err.status ?? "unknown");
    const errorMessage = err.message ?? String(err);
    args.log?.warn?.(
      { phone: maskPhone(args.to), providerErrorCode: errorCode, providerError: errorMessage },
      "SMS provider rejected message",
    );
    return { ok: false, errorCode, errorMessage };
  }
}

/**
 * Convenience wrapper for verification codes that just sends a body string.
 * Throws on failure (for routes that want to propagate the error).
 */
export async function sendVerificationSms(
  to: string,
  body: string,
): Promise<void> {
  const result = await sendSms({ to, body });
  if (!result.ok && !result.skipped) {
    throw new Error(result.errorMessage || "SMS delivery failed.");
  }
}

// ---------------------------------------------------------------------------
// Inbound webhook helpers
// ---------------------------------------------------------------------------

export interface InboundSmsPayload {
  from: string;
  to: string;
  text: string;
  timestamp?: string;
  messageId?: string;
}

/**
 * Normalise an inbound SMS webhook payload (Twilio format by default).
 * Twilio posts x-www-form-urlencoded with keys: From, To, Body, MessageSid,
 * etc.  This also accepts Vonage keys for backward compatibility during
 * transition: msisdn, text, message-timestamp, message-id.
 */
export function parseInboundSms(
  body: Record<string, unknown>,
): InboundSmsPayload | null {
  const from = String(body["From"] ?? body["msisdn"] ?? body["from"] ?? "").trim();
  const to = String(body["To"] ?? body["to"] ?? "").trim();
  const text = String(body["Body"] ?? body["text"] ?? "").trim();
  const timestamp = String(body["DateSent"] ?? body["message-timestamp"] ?? "").trim() || undefined;
  const messageId = String(body["MessageSid"] ?? body["messageId"] ?? body["message-id"] ?? "").trim() || undefined;

  if (!from || !text) return null;
  return { from, to, text, timestamp, messageId };
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return phone.slice(0, -4).replace(/\d/g, "*") + phone.slice(-4);
}
