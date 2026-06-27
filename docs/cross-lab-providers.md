# Cross-Lab Provider Account Numbers

Every provider user and org gets a platform-wide account number on creation: format `<seq><YY><F><L>` (e.g. `2926JW`), allocated atomically per `(year, entityType)` via `platform_account_sequences` (`SELECT … FOR UPDATE`). See `artifacts/api-server/src/lib/platform-account-number.ts`.

- **Login:** `/api/auth/login` accepts `username` or `identifier`; `identifier` matches username or `platform_account_number` (case-insensitive).
- **Cross-lab linking:** When a 2nd lab adds a doctor whose email/phone matches an existing platform doctor, an SMS invite is sent. Pairs tracked in `account_link_invites`.
- **YES-reply linking:** `POST /api/sms/sms-inbound` (form-encoded, no auth) — replying YES creates a `doctor_account_links` row.
- **Manual linking:** Mobile → Profile → "Link Labs" (`app/link-labs.tsx`) → `POST /api/account-links/manual`
- **Provider aggregation:** Cases and invoices expand `membershipOrgIds` via `getProviderOrgIdsForUserAndLinks` — doctors see a unified worklist across linked labs.
- **Backfill:** `pnpm --filter @workspace/scripts run backfill-platform-account-numbers` (safe to re-run)
