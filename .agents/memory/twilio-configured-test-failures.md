---
name: Twilio-configured workspace breaks verification DB-integration tests
description: Why account-epic-verification & signup-email-verification-backfill fail in the Replit workspace but pass in CI
---

The api-test suite shows up to 4 failures in `account-epic-verification.test.ts`
(send-phone-code expects 200, gets 500) and `signup-email-verification-backfill.test.ts`
(register/verification path) **only in the Replit workspace**, not in CI.

**Why:** these DB-integration tests assume SMS/email verification services are
*unconfigured*, so the route returns the dev demo-code path (200). The Replit
workspace has real `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER`
set and `NODE_ENV` undefined (so `isDev=false`). `send-phone-code` then makes a
real Twilio call with the test's fake number → Twilio error → 500. Same class as
the existing `test-mail-bounce-flood` and `itero-import-test-flake` quirks.

**How to apply:** when api-test fails ONLY in these two files with 500/404 on
verification/register, it is an environment quirk, not a regression. Prove it by
running with the creds unset: `env -u TWILIO_ACCOUNT_SID -u TWILIO_AUTH_TOKEN
-u TWILIO_PHONE_NUMBER NODE_ENV=development npx vitest run <file>` → passes.
Do not "fix" by changing unrelated feature code.
