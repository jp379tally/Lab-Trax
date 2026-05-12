/**
 * Twilio SMS helpers for the cross-lab account-link flow (Task #320).
 *
 * Two responsibilities:
 *  1. Normalise phone numbers to E.164 so doctor matching and inbound-SMS
 *     lookup agree on a single canonical form.
 *  2. Send the "your doctor record exists at <new lab>" SMS via the same
 *     Twilio credentials used by the existing verification flow.
 */
import type { Logger } from "pino";

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
  messageSid?: string;
  errorCode?: string;
  errorMessage?: string;
  /** True when Twilio is not configured (dev) — the caller should still
   *  insert the invite row and surface the prompt in-app. */
  skipped?: boolean;
}

/**
 * Send the cross-lab link-invite SMS via Twilio. Reuses the same env vars as
 * the existing verification flow so no new secrets are required.
 *
 * The SMS deliberately tells the doctor what to do (reply YES to link) and
 * mentions the new lab + the freshly-issued platform account number so they
 * have a paper trail even if they don't reply.
 */
export async function sendLinkInviteSms(
  args: SendLinkInviteSmsArgs
): Promise<SendLinkInviteSmsResult> {
  const sid = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  const from = process.env["TWILIO_PHONE_NUMBER"];
  if (!sid || !token || !from) {
    args.log?.warn?.(
      { phone: maskPhone(args.toPhoneE164) },
      "Twilio not configured — skipping link-invite SMS"
    );
    return { ok: false, skipped: true };
  }
  const body =
    `LabTrax: ${args.newLabName} just added you as a doctor ` +
    `(account ${args.newAccountNumber}). ` +
    `Reply YES to link this number to your existing LabTrax account.`;
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const params = new URLSearchParams();
    params.append("To", args.toPhoneE164);
    params.append("From", from);
    params.append("Body", body);
    const resp = await globalThis.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const data = (await resp.json()) as any;
    if (data?.error_code || data?.code) {
      args.log?.warn?.(
        {
          phone: maskPhone(args.toPhoneE164),
          twilioCode: data.error_code ?? data.code,
          twilioMessage: data.message,
        },
        "Twilio rejected link-invite SMS"
      );
      return {
        ok: false,
        errorCode: String(data.error_code ?? data.code ?? "unknown"),
        errorMessage: String(data.message ?? "Twilio error"),
      };
    }
    return { ok: true, messageSid: String(data.sid ?? "") };
  } catch (err: any) {
    args.log?.error?.(
      { err: err?.message ?? String(err), phone: maskPhone(args.toPhoneE164) },
      "Twilio request failed for link-invite SMS"
    );
    return {
      ok: false,
      errorCode: "network_error",
      errorMessage: err?.message ?? String(err),
    };
  }
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return phone.slice(0, -4).replace(/\d/g, "*") + phone.slice(-4);
}
