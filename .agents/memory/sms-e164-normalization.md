---
name: SMS send must normalize to E.164
description: Every sendSms() call must pass an E.164 phone; Vonage silently drops non-E.164 numbers while returning HTTP 200.
---

## Rule
Always call `normalizePhoneE164(phone)` and validate it is non-null before passing to `sendSms({ to: ... })`.

## Why
Vonage's REST API returns HTTP 200 with `status: "0"` (success) even for phone numbers that are not in E.164 format (e.g. a bare 10-digit `"NXXNXXXXXX"` instead of `"+1NXXNXXXXXX"`). The message is silently dropped — no delivery, no error. The caller's `result.ok` check passes, the modal says "code was sent", and no SMS arrives.

The delete-cases OTP flow was the one path in the codebase that skipped normalization. All other SMS paths (phone verification, invoices, statements, account-link-sms) call `normalizePhoneE164` first.

## How to apply
- Before any `sendSms({ to, body })` call: `const e164 = normalizePhoneE164(raw); if (!e164) throw/return error;`
- Use `normalizePhoneE164` from `lib/account-link-sms.ts` — handles `(NXX) NXX-XXXX`, `NNNNNNNNNN`, `+1NNNNNNNNNN`, already-E.164 strings.
- `normalizePhoneTarget` (from `lib/verification.ts`) produces a 10-digit key for OTP lookup — it is **not** suitable for the `to:` field of an SMS send.
- If normalization returns null, return a clear 400 with a user-visible message rather than letting Vonage silently discard the message.
