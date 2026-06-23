/**
 * Generic SMS provider module.  Currently backed by Vonage (Nexmo) — the API
 * is simple enough that switching to another provider later only requires
 * changing this file.
 *
 * Env vars:
 *   VONAGE_API_KEY      — Vonage API key
 *   VONAGE_API_SECRET   — Vonage API secret
 *   VONAGE_PHONE_NUMBER — Sender number (E.164, e.g. +15551234567)
 *
 * In dev mode (NODE_ENV=development) or when VITEST is set, the module
 * logs the message instead of dispatching it, so tests and local dev work
 * without live credentials.
 */

import type { Logger } from "pino";

const VONAGE_SEND_URL = "https://rest.nexmo.com/sms/json";

function getCredentials() {
  const key = process.env["VONAGE_API_KEY"];
  const secret = process.env["VONAGE_API_SECRET"];
  const from = process.env["VONAGE_PHONE_NUMBER"];
  return { key, secret, from };
}

export function isConfigured(): boolean {
  const { key, secret, from } = getCredentials();
  return !!(key && secret && from);
}

function isDevOrTest(): boolean {
  return (
    process.env["NODE_ENV"] === "development" || !!process.env["VITEST"]
  );
}

export interface SendSmsArgs {
  to: string;
  body: string;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

export interface SendSmsResult {
  ok: boolean;
  /** Provider message id (e.g. Vonage message-id) when successful. */
  messageId?: string;
  /** Error code from the provider when the request is rejected. */
  errorCode?: string;
  /** Human-readable error message. */
  errorMessage?: string;
  /** True when the provider is not configured (dev) — the caller may still
   *  proceed with side-effects (e.g. persisting the invite row). */
  skipped?: boolean;
}

/**
 * Send a single SMS via Vonage.  Returns a result object so callers can
 * decide whether to fail the request or just log the issue.
 */
export async function sendSms(args: SendSmsArgs): Promise<SendSmsResult> {
  const { key, secret, from } = getCredentials();

  if (!key || !secret || !from) {
    if (isDevOrTest()) {
      args.log?.info?.(
        { phone: maskPhone(args.to) },
        "SMS not configured — logging demo message (dev/test)",
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
    const resp = await globalThis.fetch(VONAGE_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        api_secret: secret,
        from,
        to: args.to,
        text: args.body,
      }),
    });

    const data = (await resp.json()) as any;
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const first = messages[0] as any;

    // Vonage returns 200 even for rejected messages; inspect the inner status.
    const status = first?.["status"] ?? "unknown";
    if (status !== "0") {
      const errorText = first?.["error-text"] ?? "Unknown SMS error";
      args.log?.warn?.(
        {
          phone: maskPhone(args.to),
          providerStatus: status,
          providerError: errorText,
        },
        "SMS provider rejected message",
      );
      return {
        ok: false,
        errorCode: String(status),
        errorMessage: errorText,
      };
    }

    return { ok: true, messageId: String(first?.["message-id"] ?? "") };
  } catch (err: any) {
    args.log?.error?.(
      { err: err?.message ?? String(err), phone: maskPhone(args.to) },
      "SMS provider request failed",
    );
    return {
      ok: false,
      errorCode: "network_error",
      errorMessage: err?.message ?? String(err),
    };
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
 * Normalise a Vonage inbound webhook payload.
 * Vonage posts x-www-form-urlencoded with keys: msisdn, to, text, messageId,
 * message-timestamp, etc.
 */
export function parseInboundSms(
  body: Record<string, unknown>,
): InboundSmsPayload | null {
  const from = String(body["msisdn"] ?? body["from"] ?? "").trim();
  const to = String(body["to"] ?? "").trim();
  const text = String(body["text"] ?? body["Body"] ?? "").trim();
  const timestamp = String(body["message-timestamp"] ?? "").trim() || undefined;
  const messageId = String(body["messageId"] ?? body["message-id"] ?? "").trim() || undefined;

  if (!from || !text) return null;
  return { from, to, text, timestamp, messageId };
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return phone.slice(0, -4).replace(/\d/g, "*") + phone.slice(-4);
}
