# SDR website prescription reader — isolated implementation

Prepared on `codex/sdr-website-case-intake-2026-11-06`. This is not a production
release and does not enable WordPress delivery. No Replit Agent, database
mutation, schema push, production restart or publication was used.

## Behavior and scope

`POST /api/website-intake/analyze-prescription` calls the same accurate reader
handler as the authenticated `/analyze-prescription` and `/cases/analyze-rx`
routes. Their auth middleware, aliases, per-user limits, model chain, PDF-page
limits, cancellation and errors are retained. Added nullable extraction fields
are `doctorLicenseNumber`, `practiceEmail` and `restorationType`; missing fields
remain absent, and no signature is extracted. Compact text PDFs are sent to the
canonical bounded renderer instead of being rejected by the photo corruption
floor. The existing image-size rejection remains unchanged for photos.

The website entry is disabled unless these server variables are configured:

- `SDR_WEBSITE_READER_ENABLED=true`
- `SDR_WEBSITE_READER_TOKEN`: separate reader-only secret, at least 32 characters
- `SDR_WEBSITE_LAB_ORG_ID`: exact SDR lab ID

The WordPress relay supplies that token as `Authorization: Bearer` and the lab
as `X-SDR-Lab-Organization`. The middleware does **not** fabricate a user session
and confers no access to records, inbox files, case creation, signature or any
other API. It permits only a bounded PDF/JPEG/PNG data URL. Caller-supplied
models, prompts, account IDs and additional images are discarded or rejected.
The selected document is temporary input, not persisted media. No document
content, contact values or patient names are added to logs.

The website has an independent process-local 6/minute, 100/day burst budget.
The WordPress plugin additionally applies single-use same-origin/IP-bound
tickets, 6 sessions/15 minutes/network and an atomic persistent website-wide
100/day ceiling. A direct browser never receives the service credential.

## Impact and regression checks

Protected workflows affected: server AI prescription analysis and the shared
reader contract used by desktop/web. No mobile UI, dashboard drop zone, tooth
chart, case/invoice creation, auth/session implementation, persistent data
shape, existing files or backup behavior is changed. Backup/restore persistent
data exemption applies to this reader-only patch; ordinary full release gates
still apply before merge/publication.

Tests were added before implementation. Both compact-PDF tests failed with
HTTP 400 before the fix. Reader access checks cover disabled/missing config,
missing/wrong token, wrong lab, byte/type/size validation, no URL input,
prompt/model override stripping, isolated limits, no-cache response and the
shared accurate-reader route. Existing reader tests retain image errors,
auth, model fallback, deadline/cancellation, name order, strict nullable schema,
missing AI configuration and rate limiting.

Local tests use mocked OpenAI and a deliberately unreachable loopback database
placeholder (`127.0.0.1:1`), never lab credentials. They do not prove live OCR
accuracy. API TypeScript checking passed after building only shared declaration
references. Dependency lockfile/security policy was not changed. A pnpm install
reported an unapproved esbuild build script; no approval or policy exception was
added, and tests ran with the already installed Vitest executable.

## Remaining release gates

Do not merge/publish solely because focused tests pass. Run the required
protected-suite gates, review the exact pending Replit managed schema diff,
verify unchanged production DB identity and a recent intact off-site production
backup, and preserve existing production binding/data. No paid installer or
mobile build is authorized by this patch. Configure the reader-only credential
through a secure operator workflow; never commit or paste it into chat. Then
test a synthetic prescription from private WordPress, verify corrections and
the fresh-signature requirement, and only enable public intake after its
separate Unassigned Documents receiving/assignment workflow is verified.
