/**
 * SMS helpers for the cross-lab account-link flow.
 *
 * Two responsibilities:
 *  1. Normalise phone numbers to E.164 so doctor matching and inbound-SMS
 *     lookup agree on a single canonical form.
 *  2. Send the "your doctor record exists at <new lab>" SMS via the generic
 *     sendSms helper in sms.ts.
 */
import type { Logger } from "pino";
import { sendSms } from "./sms.js";

const DEFAULT_COUNTRY_CODE = "1"; // US/CA — most LabTrax customers today.

/**
 * Strip non-digit characters and normalise to E.164. Returns null when the
 * input is unusable (no digits, or fewer than 7).
 */
export function normalizePhoneE164(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  // Already E.164.
  if (/^\+\d{7,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length < 7) return null;
  if (digits.length === 10) return `+${DEFAULT_COUNTRY_CODE}${digits}`;
  if (digits.length === 11 && digits.startsWith(DEFAULT_COUNTRY_CODE)) {
    return `+${digits}`;
  }
  return `+${digits}`;
}

/**
 * Lowercase + trim an email for case-insensitive matching.
 */
export function normalizeEmail(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;
  const t = String(raw).trim().toLowerCase();
  return t || null;
}

export interface SendLinkInviteSmsArgs {
  toPhoneE164: string;
  newLabName: string;
  newAccountNumber: string;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

export interface SendLinkInviteSmsResult {
  ok: boolean;
  /** Provider message id when successful. */
  messageId?: string;
  /** Error code from the provider when the request is rejected. */
  errorCode?: string;
  /** Human-readable error message. */
  errorMessage?: string;
  /** True when the provider is not configured (dev) — the caller should still
   *  insert the invite row and surface the prompt in-app. */
  skipped?: boolean;
}

/**
 * Send the cross-lab link-invite SMS via the generic provider.
 *
 * The SMS deliberately tells the doctor what to do (reply YES to link) and
 * mentions the new lab + the freshly-issued platform account number so they
 * have a paper trail even if they don't reply.
 */
export async function sendLinkInviteSms(
  args: SendLinkInviteSmsArgs
): Promise<SendLinkInviteSmsResult> {
  const body =
    `LabTrax: ${args.newLabName} just added you as a doctor ` +
    `(account ${args.newAccountNumber}). ` +
    `Reply YES to link this number to your existing LabTrax account.`;
  const result = await sendSms({
    to: args.toPhoneE164,
    body,
    log: args.log,
  });
  return {
    ok: result.ok,
    messageId: result.messageId,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    skipped: result.skipped,
  };
}

