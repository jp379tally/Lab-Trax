---
name: Test suite real-mail bounce flood
description: Why test runs can send real email to @test.local fixtures and flood the owner inbox with bounces, and the guard that prevents it.
---

# Test suite sent real verification email -> 400+ NDR bounce flood

Symptom: owner inbox flooded overnight with hundreds of non-delivery
bounce-backs (e.g. "LabTrax - Email Verification Code" to
`ipcap_N_<hash>@test.local`, "domain couldn't be found").

**Root cause:** transactional-mail endpoints called
`nodemailer.createTransport(...).sendMail(...)` **inline** in route handlers,
bypassing the centralized `lib/mail.ts` `sendMail()`. SMTP_* is configured
in this workspace, so verification tests that POST fixture
`@test.local` addresses (e.g. the ipcap loop in
`account-epic-verification.test.ts`) sent REAL email that bounced to
`SMTP_FROM`. The `api-server-tests` / `regression-tests` workflows
**auto-restart overnight on every merge/install**, multiplying it into 400+.

**Rule:** all transactional mail MUST go through the central
`lib/mail.ts` `sendMail()`. Never call `nodemailer.createTransport` inline
in a route. `sendMail()` now has two pre-SMTP guards:
1. early no-send return when `process.env.VITEST` is set (vitest sets it
   during runs) — the test runner must never dispatch real mail.
2. `isReservedEmailDomain()` — RFC 2606/6761/6762 reserved TLDs
   (`.local`/`.test`/`.example`/`.invalid`/`.localhost`) + example.com/net/org,
   returning `{sent:false, reason:"reserved_domain"}` before the DNS MX/A check.

**Why VITEST + reserved-domain (not NODE_ENV):** `NODE_ENV` is unset in the
bare shell; vitest sets it during a run but relying on it is fragile. `VITEST`
is deterministic in the test runner, and the reserved-domain guard is a
defense-in-depth catch for any fixture address even outside vitest.

**Caller contract:** endpoints that previously 500'd on send failure should
treat intentional skips (`disabled_in_test`, `reserved_domain`, undeliverable)
as success (200) and only 500 on a genuine delivery failure — otherwise the
guard turns into a test failure.

**Still un-centralized (mocked in tests, not the flood source, but a future
risk):** `routes/invoices.ts` and `lib/statements.ts` build transports
directly. Their tests mock the mailer/`sendStatementEmail`, so they don't
send real mail today, but new tests/fixtures could. Migrating them to
`sendMail()` (needs attachments/replyTo support) or adding a lint guard that
bans route-level `createTransport` would close the gap.
