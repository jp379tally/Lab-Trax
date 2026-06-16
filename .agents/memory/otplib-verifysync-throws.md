---
name: otplib verifySync throws on non-6-digit tokens
description: 2FA challenge 500 when a backup code (or any malformed code) hits otplib verifySync directly; wrap it.
---

otplib's `verifySync({ token, secret })` **throws** (`TokenLengthError`, etc.)
when `token` is not a well-formed 6-digit TOTP — it does not return
`{ valid: false }`. User-supplied codes routinely are not 6 digits: a LabTrax
2FA backup code is 10 hex chars, and clients can send arbitrary input.

**Symptom:** `POST /api/auth/2fa/challenge` with a valid backup code returned
500 (`TokenLengthError`) instead of falling through to the backup-code branch —
backup-code login was completely broken, and any wrong/malformed code 500'd
instead of returning a clean 422.

**Fix / convention:** never call `verifySync` directly on user input. Route all
TOTP checks in `artifacts/api-server/src/routes/two-factor.ts` through the
`isValidTotp(token, secret)` wrapper (try/catch → returns false on throw). All
four call sites (setup-confirm, regenerate, disable-verify, challenge) use it.

**Why it stayed hidden:** the happy-path TOTP tests always send a valid 6-digit
token, so the throw never fired until a backup-code integration test exercised
the challenge with a 10-char code.
