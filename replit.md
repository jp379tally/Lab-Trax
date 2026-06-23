# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Regression Policy

All protected workflows are documented in [`REGRESSION_GUARDRAILS.md`](./REGRESSION_GUARDRAILS.md). Once a workflow is listed there, no code change may be merged or published unless every protected workflow still passes. See that file for the full list of protected workflows, the zero-regression process, and the test coverage map.

Start with the **Stable Beta Protected Workflows** section near the top of that file: it is the single consolidated matrix of every protected desktop, mobile, and backend workflow with its test coverage and release gate, plus the Required Pre-Release Checklist, manual smoke checklists, the backup/restore blocking gate, the manual-only build policy, and the keep-tests-permanently regression policy. Run that checklist before any release, build, publish, or TestFlight submission.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Artifacts

### LabTrax Desktop — `artifacts/labtrax-desktop`
Electron + React desktop client. Renderer runs at the custom `app://labtrax` protocol in production (cross-origin to the API). Key implications:
- CORS allowlist (`artifacts/api-server/src/lib/cors.ts`) must include `app://labtrax`.
- Authenticates with **bearer tokens** (`clientType: "desktop"`), not cookies. Tokens stored in renderer `localStorage` under `labtrax_desktop_tokens_v1`, sent as `Authorization: Bearer …`. Bearer requests are CSRF-exempt (see `middlewares/csrf.ts`).

### LabTrax (Mobile App) — `artifacts/labtrax`
Expo (React Native) dental lab case-tracking app with expo-router.
- Port: 19134 (Expo dev server)
- Auth: JWT tokens in SecureStore; biometric lock via expo-local-authentication
- Key libraries: expo-share-intent, expo-document-picker, expo-camera, expo-print, expo-media-library

### API Server — `artifacts/api-server`
Express 5 backend, all routes under `/api/*`.
- Port: 8080
- Auth: JWT (`JWT_SECRET` — **must be set in production**)
- File uploads: multer → `uploads/case-media/`, served at `/uploads/case-media`
- Key libraries: multer, archiver, openai, nodemailer, sharp, bcryptjs

### DB Schema — `lib/db`
Drizzle ORM schema for PostgreSQL. Source of truth: `lib/db/src/schema/schema.ts`.
Run `pnpm --filter @workspace/db run push` to apply schema changes.

## Key Commands

> **Build counter recovery:** If a GitHub Actions build exits with a push-failure warning, download the `build-counter-fallback` artifact from the run summary and follow [`docs/build-counter-recovery.md`](docs/build-counter-recovery.md).

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/api-server run test` — run API server tests

## Environment Variables

**Required in production:**
- `JWT_SECRET` — auth token signing; defaults to insecure value in dev
- `PLATFORM_ADMIN_SECRET` — must be sent as `X-Platform-Admin-Secret` to access all `/api/admin/*` endpoints; if unset, all admin endpoints return 403

**Optional — core features:**
- `EXPO_PUBLIC_DOMAIN` — set automatically from `$REPLIT_DEV_DOMAIN` in the labtrax dev script
- `AI_INTEGRATIONS_OPENAI_API_KEY` — enables AI features (Rx parsing, AI chat, smile preview)
- `LABTRAX_ENABLE_DEMO_SEEDS` — set `"true"` to seed demo users on startup
- `PLATFORM_ADMIN_PIN` — short numeric PIN alternative to `PLATFORM_ADMIN_SECRET` via `X-Platform-Admin-Pin`; requires a signed-in `role:"admin"` user (PIN alone cannot authenticate)

**SMS (Vonage):**
- `VONAGE_API_KEY` — Vonage API key for SMS
- `VONAGE_API_SECRET` — Vonage API secret for SMS
- `VONAGE_PHONE_NUMBER` — sender phone number for outbound SMS (must be registered with Vonage)

**Backup / OneDrive:**
- `ONEDRIVE_*` — OneDrive integration credentials. Settings → Backup shows status via `GET /api/admin/backup/onedrive-status` and a Reconnect button at `POST /api/admin/backup/onedrive-reconnect`.
- `BACKUP_HOUR_UTC` — UTC hour for nightly OneDrive backup (default: `7`)
- `BACKUP_HISTORY_RETENTION_DAYS` — days of `backup_runs` to keep (default: `90`; overridable per-lab)
- `BACKUP_HISTORY_MAX_ROWS` — max `backup_runs` rows (default: `500`; overridable per-lab)

**AI memory candidate cleanup:**
- `AI_MEMORY_CANDIDATE_RETENTION_DAYS` — reviewed (approved/rejected) `ai_memory_candidates` rows older than this are pruned by the nightly billing job (default: `90`). De-dup (skip re-proposing rejected keys) is preserved within this window; rejected rows only become eligible for re-proposal after they age out.
- `AI_MEMORY_CANDIDATE_MAX_PENDING_PER_LAB` — max pending candidates kept per lab; oldest pending rows beyond the cap are dropped (default: `500`).

**Cleanup:**
- `CLEANUP_HOUR_UTC` — UTC hour for nightly orphaned media cleanup (default: `8`)
- `CLEANUP_ALERT_MIN_REMOVED` — min files removed before alert email (default: `1`)
- `CLEANUP_ALERT_MIN_FREED_MB` — min MB freed before alert email (default: `0`, disabled)
- `CLEANUP_HISTORY_RETENTION_DAYS` — days of `media_cleanup_runs` to keep (default: `365`)
- `CLEANUP_HISTORY_MAX_ROWS` — max `media_cleanup_runs` rows (default: `1000`)
- `MEDIA_CLEANUP_JOB_TOKEN` / `MEDIA_CLEANUP_API_URL` — for standalone cleanup script (scheduled deployment only)

**Desktop installer (code-signing):**
- `CSC_LINK` — base64-encoded PFX certificate (OV or EV) for Windows code-signing. Encode with `base64 -w 0 certificate.pfx`. When set alongside `CSC_KEY_PASSWORD`, electron-builder signs the installer automatically, removing the SmartScreen "Windows protected your PC" warning. Absent → unsigned build (SmartScreen warning present).
- `CSC_KEY_PASSWORD` — password protecting the `CSC_LINK` PFX. Must be set together with `CSC_LINK`. Signing config (sha256, RFC 3161 via Sectigo) lives in `artifacts/labtrax-desktop/electron-builder.yml` under `signtoolOptions`.
- `CSC_EXPECTED_PUBLISHER` — optional but strongly recommended. Exact CN (Common Name) from the code-signing certificate (e.g. `"Acme Dental Software LLC"`). When set, `desktop-build-publish.sh` verifies the built EXE's signer subject contains this string after `signtool verify /pa` passes — catches wrong-cert scenarios (expired cert renewed under a new name, dev cert used in production, etc.). Absent → publisher-name check is skipped.

**Desktop installer:**
- `DESKTOP_INSTALLER_VERSION` — version string in Desktop App settings panel (default: `"1.0.0"`)
- `DESKTOP_INSTALLER_URL` — download URL (default: `/downloads/LabTrax-Setup.exe`); switch to `/downloads/LabTrax-Windows-Portable.zip` (portable ZIP fallback) or `/downloads/LabTrax.dmg` for those slots
- `INSTALLER_HEALTH_CHECK_HOUR_UTC` — UTC hour for nightly installer health check (default: `6`)
- `INSTALLER_HEALTH_BASE_URL` — base URL for the download HEAD probe (e.g. `https://your.replit.app`); if unset, reachability probe is skipped
- `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS` — App Storage config (auto-set when provisioned)
- `GITHUB_REPO_URL` — optional; shows Actions tab link in Settings → Desktop App
- `BUILD_BOT_TOKEN` — fine-grained GitHub PAT (Contents: Read & Write + bypass branch protection) used by CI to push incremented build counters to protected branches; falls back to `github.token` if unset

**Billing:**
- `SUBSCRIPTION_TRIAL_DAYS` — free trial length (default: `30`). Changed from 14 → 30 days. Existing in-flight trials keep their original end date.
- `SUBSCRIPTION_GRACE_DAYS` — grace period after trial/payment failure before locking (default: `7`)
- `STRIPE_PRICE_ID` — default Stripe price ID (fallback); run `pnpm --filter @workspace/scripts run seed-stripe-products` to create all four plans
- `STRIPE_PRICE_ID_LAB_MONTHLY` — Lab plan, monthly billing ($99/mo) — output by seed-stripe-products
- `STRIPE_PRICE_ID_LAB_ANNUAL` — Lab plan, annual billing ($990/yr) — output by seed-stripe-products
- `STRIPE_PRICE_ID_PROVIDER_MONTHLY` — Provider plan, monthly billing ($49/mo) — output by seed-stripe-products
- `STRIPE_PRICE_ID_PROVIDER_ANNUAL` — Provider plan, annual billing ($490/yr) — output by seed-stripe-products
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret (store in Stripe Replit integration connector)
- `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` / `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY` — RevenueCat public keys for IAP

## Subscription Billing

LabTrax uses a free-trial + recurring subscription model. Every new org/user gets a 14-day trial automatically on signup.

| Status | Access | Notes |
|--------|--------|-------|
| `trialing` | Full | 14-day trial starts at signup |
| `active` | Full | Paying subscriber |
| `past_due` | Full | Last payment failed; grace before locking |
| `grace` | Read-only | Trial expired without payment |
| `locked` | Locked | Grace period elapsed |
| `canceled` | Locked | Manually canceled |
| `legacy_free` | Full | Predates billing; grandfathered |

- **Desktop/web** — Stripe hosted checkout; webhooks at `POST /api/billing/webhook/stripe`
- **iOS/Android** — RevenueCat; webhooks at `POST /api/billing/webhook/revenuecat`

Key files: `lib/entitlement.ts`, `lib/billing-jobs.ts`, `lib/stripeClient.ts`, `routes/billing.ts`

Setup: connect Stripe integration → run `seed-stripe-products` → set `STRIPE_PRICE_ID` → configure webhook → set `STRIPE_WEBHOOK_SECRET`.

## Desktop Installer Download

Installers (`LabTrax-Windows-Portable.zip`, `LabTrax-Setup.exe`, `LabTrax.dmg`) are stored in App Storage and served at `GET /downloads/<filename>` (no auth). Object keys: `<PRIVATE_OBJECT_DIR>/desktop-installer/<filename>`.

To publish a new installer:
1. **Auto-release on merge (default):** `.github/workflows/auto-tag-desktop-release.yml` triggers on every push to `main`, bumps the patch in `artifacts/labtrax-desktop/package.json`, commits with `[skip ci]`, tags `vX.Y.Z`, and pushes via `BUILD_BOT_TOKEN`. The tag fires `release.yml` → builds + publishes to `/downloads/`. Skips when only non-desktop paths changed (docs, mobile, mockup, etc.) or when the commit message contains `[skip desktop-release]` / `[skip ci]`.
2. **In-app (manual):** Settings → Desktop App → "Choose installer and upload" → `POST /api/admin/desktop-installer/upload`
3. **CLI bootstrap:** `pnpm --filter @workspace/scripts run upload-desktop-installer`
4. **CI tag-push (manual override):** push a `v*` tag yourself to re-run `release.yml` for a specific commit.

The publish endpoint (`/publish`) accepts `X-Platform-Admin-Secret` without a user JWT so CI doesn't need an account. The Windows + macOS publish steps in `release.yml` now **fail loudly** (exit 1) when `PLATFORM_ADMIN_SECRET` or `PUBLISH_API_BASE_URL` is unset — auto-release on merge made silent skip a real foot-gun. A deduped alert email fires at most once per 6 h window for any publish failure or health-check failure. Full runbook: [`docs/desktop-publish-pipeline.md`](docs/desktop-publish-pipeline.md), [`artifacts/labtrax-desktop/docs/auto-update-runbook.md`](artifacts/labtrax-desktop/docs/auto-update-runbook.md).

End-users see the current installed version and a **Check for updates** button in Settings → Desktop App (admin-only). The card mirrors auto-updater state (checking / available / downloading / ready-to-install) and exposes **Restart & install** when a build is staged. IPC: `check-for-updates`, `download-update`, `get-update-state`, plus the `update-state` broadcast channel.

Auto-update channel for existing installs uses the **generic** electron-updater provider pointed at `GET /downloads/latest.yml` on the same App Storage-backed API server that serves the installer ZIPs. The feed URL is baked into `resources/app-update.yml` at build time by `scripts/desktop-build-publish.sh` (via `UPDATE_FEED_URL`). No GitHub remote or `GH_TOKEN` is required for auto-update to work.

## Cross-Lab Provider Account Numbers

Every provider user and org gets a platform-wide account number on creation: format `<seq><YY><F><L>` (e.g. `2926JW`), allocated atomically per `(year, entityType)` via `platform_account_sequences` (`SELECT … FOR UPDATE`). See `artifacts/api-server/src/lib/platform-account-number.ts`.

- **Login:** `/api/auth/login` accepts `username` or `identifier`; `identifier` matches username or `platform_account_number` (case-insensitive).
- **Cross-lab linking:** When a 2nd lab adds a doctor whose email/phone matches an existing platform doctor, an SMS invite is sent. Pairs tracked in `account_link_invites`.
- **YES-reply linking:** `POST /api/sms/sms-inbound` (form-encoded, no auth) — replying YES creates a `doctor_account_links` row.
- **Manual linking:** Mobile → Profile → "Link Labs" (`app/link-labs.tsx`) → `POST /api/account-links/manual`
- **Provider aggregation:** Cases and invoices expand `membershipOrgIds` via `getProviderOrgIdsForUserAndLinks` — doctors see a unified worklist across linked labs.
- **Backfill:** `pnpm --filter @workspace/scripts run backfill-platform-account-numbers` (safe to re-run)

## iTero Lab-Review Auto-Import

LabTrax Desktop can auto-create cases from the iTero "Lab Review" queue.

1. Admin saves shared iTero credentials in Settings → iTero auto-import. Encrypted via Electron `safeStorage`, stored at `userData/itero-creds.bin`.
2. Admin picks destination Lab + Provider org and enables polling (default 5 min; range 5–240).
3. Poller (`electron/itero-poller.cjs`): hidden BrowserWindow logs into `us-labs.bff.cloud.myitero.com`, fetches Lab-Review orders, downloads each Rx, POSTs to `POST /api/cases/import-from-itero-rx`.
4. API extracts patient/doctor/restorations via OpenAI, creates an Active case, sets `needsAiReview=true` + `aiImportSource='itero'`, and records the iTero order ID in `itero_imported_orders` (unique on `lab_organization_id + itero_order_id`) for idempotency.
5. Desktop shows a Sparkles badge; case drawer shows an amber review banner. Mobile `case/[id].tsx` shows a matching banner.

Portal selectors may need tweaking per tenant — failures surface as `lastError` in the Settings panel. De-dup is server-side, so wiping the local ledger (`userData/itero-seen.json`) won't create duplicates.

## AI Assistant (Knowledge + Memory)

Phase 1 foundation that grounds the LabTrax AI in curated knowledge plus per-lab memory. Strictly additive — no existing AI request/response contract changed.

- **Curated knowledge** — `@workspace/ai-knowledge` (`lib/ai-knowledge`) ships read-only packs (`labtrax/`, `dental/`, `hipaa/`) and a pure `selectKnowledge(query, { maxChars })` that returns the most relevant snippets within a char budget. No DB, no network.
- **Per-lab memory** — soft-deletable `ai_memory` table (`lib/db`): `(lab_organization_id, kind, key)` unique, `kind ∈ {glossary, preference, fact}`. Registered in `PROTECTED_TABLES`/`PROTECTED_DRIZZLE_EXPORTS` (soft-delete only). Adding any new protected table requires adding it to the `tables` record in every fully-mocked `@workspace/db` test (otherwise those suites throw "No <table> export").
- **CRUD API** — `/api/ai-memory`: GET (any active member) / POST, PATCH, DELETE (lab admin only; DELETE is soft-delete). Zod-validated, lab-scoped, mirrors `vocabulary.ts`. OpenAPI under tag `ai`; hooks generated into `@workspace/api-client-react`.
- **Prompt augmentation** — `lib/ai-knowledge-augment.ts` (`buildKnowledgeBlock`, `buildLabMemoryBlock`) is wired into `ai-chat.ts` and `ai-agent.ts` only, behind the existing AI-availability checks. Both helpers return `""` when nothing matches so the prompt is unchanged.
- **Desktop UI** — Settings → "AI Assistant" (admin-only) manages glossary/preference/fact entries per lab.

## Lab Data Protection

**Never hard-delete these tables** — use `softDelete()` / `softDeleteById()` from `artifacts/api-server/src/lib/soft-delete.ts`:

`users`, `organizations`, `lab_memberships`, `cases`, `case_attachments`, `invoices`, `bank_transactions`, `pricing_tiers`, `pricing_overrides`

Each carries `deleted_at` + `deleted_by_user_id` columns and an audit log entry. The authoritative list is `PROTECTED_TABLES` in `soft-delete.ts`.

**Case-media files** — move to `.trash/`, never unlink directly. The orphan-media cleanup uses `uploads/case-media/.trash/<timestamp>__<name>`.

**CI lint guard:** `pnpm --filter @workspace/scripts run lint-protected-tables` — exits non-zero on any `db.delete(<protected>)` or direct `fs.unlink/rm` of case-media in production code.

**Adding a protected table:** (1) add `deleted_at` + `deleted_by_user_id` to schema and push; (2) filter reads with `notDeleted(table)`; (3) add table + Drizzle export to `PROTECTED_TABLES` and `PROTECTED_DRIZZLE_EXPORTS` in `soft-delete.ts`.

## Installer Storage Integration Tests (opt-in)

`installer-storage-e2e.test.ts` (upload → download round-trip) and `installer-publish-e2e.test.ts` (atomic `/publish`) exercise real App Storage. Both are gated on `INSTALLER_E2E_OBJECT_DIR` + `PLATFORM_ADMIN_SECRET` — auto-skipped unless **both** are set. They never touch the production `PRIVATE_OBJECT_DIR`: when `INSTALLER_E2E_OBJECT_DIR` is set they redirect storage to a unique per-run prefix (`<INSTALLER_E2E_OBJECT_DIR>/e2e-run-<id>/…`, see `installer-e2e-target.ts`) for that fork only, so they can run anywhere (including a workspace whose `PRIVATE_OBJECT_DIR` points at the live bucket) with zero risk of overwriting the real desktop installer. The per-run prefix also means the two suites never collide, so no shared lock is needed. Point `INSTALLER_E2E_OBJECT_DIR` at a dedicated, non-production storage dir (in CI it reuses the staging bucket).

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
