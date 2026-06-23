# Threat Model

## Project Overview

LabTrax is a multi-tenant dental laboratory case-tracking system with an Express 5 API (`artifacts/api-server`), PostgreSQL/Drizzle data layer (`lib/db`), and mobile client (`artifacts/labtrax`) that authenticates to the API with JWTs. The production security boundary is the API server: it stores user accounts, organization membership, financial records, invoices, uploaded case media, audit events, and integration credentials used for email, AI, and OneDrive backup flows.

Production assumptions for future scans:
- `NODE_ENV` is `production` in deployed environments.
- TLS is handled by the platform.
- Mockup/sandbox-only code is out of scope unless production reachability is demonstrated.

## Assets

- **User accounts and sessions** — usernames, emails, phone numbers, password hashes, JWT access/refresh tokens, and server-side session records. Compromise enables impersonation and persistent access.
- **Clinical and operational case data** — patient names/identifiers, doctor names, case notes, workflow state, uploaded media, and case attachments. This is the highest-sensitivity business data in the application.
- **Organization and membership state** — lab/provider organizations, invites, join requests, and role assignments. Tampering here changes tenant boundaries and authorization decisions.
- **Financial records** — invoices, statement PDFs, deposits, reconciliations, bank accounts, and transaction metadata. Exposure or modification directly affects billing integrity.
- **Application secrets and third-party credentials** — `JWT_SECRET`, SMTP credentials, OpenAI key, Vonage credentials, OneDrive connector access, and scheduled-job shared secrets.
- **Backups and exported archives** — ZIP backups and mirrored media contain broad cross-tenant datasets and must be treated as highly sensitive.

## Trust Boundaries

- **Mobile/Desktop client → API** — all client input is untrusted. Authentication, authorization, validation, and business-rule enforcement must happen server-side.
- **API → PostgreSQL** — the API has full database authority. Access-control bugs at the route layer can become full cross-tenant data exposure.
- **API → filesystem (`uploads/case-media`)** — user-controlled files cross from request handlers into persistent storage and later back out through serving/download flows.
- **API → external services** — SMTP, Vonage, OpenAI, and Microsoft Graph/OneDrive are privileged outbound integrations that can leak data or amplify abuse if invoked without adequate checks.
- **Public/unauthenticated → authenticated/org-admin/system-admin surfaces** — the codebase mixes public routes, user-authenticated routes, organization-scoped admin routes, and global maintenance endpoints. This boundary is security-critical.
- **Scheduled-job token callers → internal maintenance endpoints** — cron-style endpoints protected by shared secrets must remain isolated from normal user privileges and from public traffic.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/index.ts`, and `artifacts/api-server/src/routes/labtrax-routes.ts`.
- **Highest-risk code areas:** `src/routes/auth.ts`, `src/routes/cases.ts`, `src/routes/organizations.ts`, `src/routes/finance.ts`, `src/routes/labtrax-routes.ts`, and `src/middlewares/auth.ts` / `src/middlewares/csrf.ts`.
- **Public surfaces:** `/api/auth/register`, `/api/auth/login`, `/api/auth/refresh`, password/verification endpoints in `labtrax-routes.ts`, health checks, and `/uploads/case-media/*` static serving.
- **Authenticated surfaces:** most `/api/cases`, `/api/organizations`, `/api/finance`, `/api/invoices`, `/api/statements`, and `/api/auth/me` routes.
- **Usually dev-only / lower-priority areas:** `attached_assets/`, build output, and `.expo/`; ignore unless production reachability is shown. Desktop/mobile bundles are clients of the same API rather than separate trust anchors.

## Threat Categories

### Spoofing

The API accepts both bearer tokens and cookie-based sessions. Every protected route must validate JWTs, bind them to an active non-revoked server-side session, and avoid letting user-controlled profile or registration inputs influence effective privilege. Job-style endpoints must authenticate with dedicated secrets, not ordinary user roles.

### Tampering

Client input crosses into organization membership, finance, case workflow, attachment metadata, and maintenance settings. The server must enforce organization-scoped authorization on every write, must not trust client-supplied role fields, and must keep system-wide settings separate from tenant-scoped admins.

### Information Disclosure

The application stores sensitive case media, user contact details, financial records, and backup archives. API responses, static file serving, downloads, logs, and exported archives must be scoped to the requesting tenant and role. Uploaded case media must not become publicly retrievable merely because a filename or URL is known.

### Denial of Service

Public auth and verification endpoints can trigger expensive or abuse-prone work such as password reset email, SMS/email verification, AI processing, file upload, and archive generation. These endpoints require size limits, abuse controls, and strong authorization before invoking costly downstream work.

### Destructive Data Loss (Lab Data Protection)

Past incidents have lost customer data to hard `db.delete(...)` calls and
to filesystem cleanups that unlinked files irrecoverably. The mitigation
is enforced in two layers:

- **Soft-delete only** for protected tables: `users`, `organizations`,
  `lab_memberships`, `cases`, `case_attachments`, `invoices`,
  `bank_transactions`, `pricing_tiers`, `pricing_overrides`. All deletions
  go through `softDelete()` / `softDeleteById()` in
  `artifacts/api-server/src/lib/soft-delete.ts`, which sets
  `deleted_at` + `deleted_by_user_id` and writes an audit entry. The
  single source of truth for the list is `PROTECTED_TABLES` in that file.
- **Case-media files** are moved to `uploads/case-media/.trash/` instead
  of being unlinked, so a false-positive orphan cleanup can be reversed.
- A CI lint guard (`pnpm --filter @workspace/scripts run
  lint-protected-tables`) scans the API source tree for
  `db.delete(<protected>)` and direct `fs.unlink|rm` of case-media files
  and fails the build on a regression.

Reads on protected tables should still be filtered with `notDeleted(table)`
so soft-deleted rows do not leak back into normal API responses.

### Elevation of Privilege

This codebase has multiple privilege tiers: unauthenticated users, authenticated users, organization members, organization admins/billing users, and maintenance/system-level operators. The core guarantee is that no user can obtain broader tenant visibility or system-wide capabilities by editing profile fields, selecting privileged registration values, accepting crafted invites, or calling maintenance endpoints that only check a coarse global role flag.