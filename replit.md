# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

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

### LabTrax (Mobile App) — `artifacts/labtrax`
Dental laboratory case-tracking app. Expo (React Native) with expo-router.
- Port: 19134 (Expo dev server)
- Frontend-only; communicates with the API server via `EXPO_PUBLIC_DOMAIN`
- Auth: JWT tokens stored in SecureStore; biometric lock via expo-local-authentication
- Key libraries: expo-share-intent, expo-document-picker, expo-camera, expo-print

### API Server — `artifacts/api-server`
Express 5 backend serving all LabTrax routes under `/api/*`.
- Port: 8080
- Auth: JWT (`JWT_SECRET` env var — **must be set in production**)
- File uploads: multer → stored in `uploads/case-media/`, served at `/uploads/case-media`
- Key libraries: multer, archiver, openai (AI integrations), nodemailer, sharp, bcryptjs

### DB Schema — `lib/db`
Drizzle ORM schema for PostgreSQL. Source of truth: `lib/db/src/schema/schema.ts`.
Run `pnpm --filter @workspace/db run push` to apply schema changes.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/api-server run test` — run API server unit/integration tests (range parser, installer download)

### Installer storage integration test (opt-in)

`installer-storage-e2e.test.ts` exercises the full upload → download round-trip against **real App Storage**. It is automatically skipped unless both of these env vars are present:

- `PRIVATE_OBJECT_DIR` — App Storage bucket directory (auto-set when Object Storage is provisioned)
- `PLATFORM_ADMIN_SECRET` — admin secret passed via `X-Platform-Admin-Secret` header

**Warning:** running this test writes a small dummy `.exe` object to the live `desktop-installer/` prefix in App Storage, overwriting the `LabTrax-Setup.exe` slot. Run it against a dedicated test bucket, not a production-backed one.

## Environment Variables

- `JWT_SECRET` — required in production; defaults to an insecure value in dev
- `EXPO_PUBLIC_DOMAIN` — set in the labtrax dev script automatically from `$REPLIT_DEV_DOMAIN`
- `AI_INTEGRATIONS_OPENAI_API_KEY` — optional; enables AI features (tooth chart detection, etc.)
- `LABTRAX_ENABLE_DEMO_SEEDS` — set to `"true"` to seed demo users on startup
- `ONEDRIVE_*` — optional OneDrive backup integration credentials
- `CLEANUP_HOUR_UTC` — UTC hour (0–23) for the nightly orphaned media cleanup (default: `8`)
- `CLEANUP_ALERT_MIN_REMOVED` — minimum files-removed count before a cleanup alert email is sent (default: `1`); raise to reduce noise in active labs
- `CLEANUP_ALERT_MIN_FREED_MB` — minimum megabytes freed before a cleanup alert email is sent (default: `0`, disabled); works alongside `CLEANUP_ALERT_MIN_REMOVED` — either threshold can trigger the alert
- `CLEANUP_HISTORY_RETENTION_DAYS` — how many days of `media_cleanup_runs` history to keep (default: `365`); rows older than this are deleted after each run
- `CLEANUP_HISTORY_MAX_ROWS` — maximum number of `media_cleanup_runs` rows to retain (default: `1000`); oldest rows are removed first; works alongside `CLEANUP_HISTORY_RETENTION_DAYS` — whichever removes more rows wins
- `BACKUP_HOUR_UTC` — UTC hour (0–23) for the nightly OneDrive backup (default: `7`)
- `MEDIA_CLEANUP_JOB_TOKEN` — shared secret for the standalone cleanup script (scheduled deployment path only)
- `MEDIA_CLEANUP_API_URL` — base API URL for the standalone cleanup script (e.g. `https://your.replit.app/api`; scheduled deployment path only)
- `DESKTOP_INSTALLER_VERSION` — version string shown in the Desktop App settings panel (default: `"1.0.0"`)
- `DESKTOP_INSTALLER_URL` — direct download URL for the desktop installer (default: `/downloads/LabTrax-Windows-Portable.zip`); the default path is served by the API from App Storage (see "Desktop installer download" below). Override to a GitHub Release asset URL if you'd rather host the file on GitHub. Switching to `/downloads/LabTrax-Setup.exe` or `/downloads/LabTrax.dmg` selects the Windows EXE or macOS DMG slot from App Storage.
- `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS` — App Storage configuration (auto-set when Object Storage is provisioned). The API server reads/writes the desktop installer zip in App Storage via these.
- `GITHUB_REPO_URL` — optional; GitHub repository URL (e.g. `https://github.com/your-org/your-repo`); when set, the Settings → Desktop App panel shows a direct link to the repo's Actions tab so admins can trigger installer builds in one click
- `PLATFORM_ADMIN_SECRET` — **required in production**; a strong secret string that must be sent as `X-Platform-Admin-Secret` header to access all `/api/admin/*` platform-wide endpoints (backup, cleanup, system settings). If unset, all admin endpoints return 403.

## Desktop installer download

The desktop installers (Windows portable zip `LabTrax-Windows-Portable.zip`, Windows one-click `LabTrax-Setup.exe`, and macOS `LabTrax.dmg`) are stored in App Storage so they survive deploys, and the API serves them publicly at `GET /downloads/<filename>` (no auth required — same URLs as before). Object keys: `<PRIVATE_OBJECT_DIR>/desktop-installer/<filename>`.

After running a fresh electron build, refresh the hosted installer in one of two ways:

1. **In-app (preferred):** Settings → Desktop App → "Choose installer and upload". Hits `POST /api/admin/desktop-installer/upload` (admin-only, 300 MB max, accepts `.zip`, `.exe`, or `.dmg`).
2. **CLI fallback / first-time bootstrap:** `pnpm --filter @workspace/scripts run upload-desktop-installer` — uploads `artifacts/labtrax-desktop/electron-dist/LabTrax-Windows-Portable.zip` to App Storage. Pass a custom path as the first arg if needed.
3. **CI auto-publish (preferred for tagged releases):** the GitHub Actions Windows build jobs (`.github/workflows/build-windows.yml`, `.github/workflows/release.yml`) include a "Publish installer to live download page" step that POSTs the freshly built `LabTrax-Setup.exe` to `/api/admin/desktop-installer/upload` and PUTs the matching URL/version to `/api/admin/settings/desktop-installer`. The macOS build job in `.github/workflows/release.yml` mirrors this with a "Publish DMG to live download page" step that uploads the freshly built DMG (preferring a universal build if present, then x64 — which runs natively on Intel and via Rosetta 2 on Apple Silicon — then arm64 as a last-resort fallback) and points the live download URL at `/downloads/LabTrax.dmg`. The steps are gated by two GitHub Actions secrets — `PLATFORM_ADMIN_SECRET` (must equal the API server's env var of the same name) and `PUBLISH_API_BASE_URL` (e.g. `https://your.replit.app`). If either secret is unset, the step logs a notice and exits 0, so it's safe to disable. The two endpoints accept the `X-Platform-Admin-Secret` header alone (no JWT required) so CI doesn't need a user account.

The Settings → Desktop App panel shows the current installer's size and uploaded-at timestamp so admins can verify freshness. If no zip has been uploaded yet, `/downloads/LabTrax-Windows-Portable.zip` returns a 404 JSON body explaining that an admin must upload one.

## iTero Lab-Review auto-import

LabTrax Desktop (Electron) can auto-create cases from the iTero "Lab Review"
queue using a single shared lab iTero account.

**Flow:**
1. Admin opens Settings → "iTero auto-import" in the desktop app and saves the
   shared iTero username + password. Credentials are encrypted via Electron
   `safeStorage` (OS keychain) and stored at `userData/itero-creds.bin`.
2. Admin picks the destination Lab + default Provider organization and turns
   on auto-poll (default: every 5 min, minimum 5, maximum 240).
3. The poller (`artifacts/labtrax-desktop/electron/itero-poller.cjs`) runs in
   the Electron main process: a hidden `BrowserWindow` with the
   `persist:itero` partition logs into `us-labs.bff.cloud.myitero.com`,
   fetches the Lab-Review order list, downloads each Rx PDF/image, and
   POSTs it to LabTrax at `POST /api/cases/import-from-itero-rx` (multipart:
   `file` (the Rx PDF/image), `iteroOrderId`, `labOrganizationId`,
   `providerOrganizationId`, `source=itero`). The renderer's session cookies are reused via
   `net.fetch({ useSessionCookies: true })` so the import call carries the
   admin's existing LabTrax auth.
4. The API uses OpenAI (`AI_INTEGRATIONS_OPENAI_API_KEY`) to extract patient,
   doctor, restorations, and notes from the Rx, creates an Active case with
   the Rx attached, sets `cases.needsAiReview=true` and `aiImportSource='itero'`,
   and records the iTero order id in `itero_imported_orders` (uniqueIndex
   on `lab_organization_id + itero_order_id`) so re-polls are idempotent.
5. Desktop case list shows a Sparkles badge next to the case number; the case
   drawer shows an amber "AI-imported — needs review" banner with a "Mark as
   reviewed" button that calls `PATCH /api/cases/:id/ai-review`. Mobile
   `app/case/[id].tsx` shows a matching banner when those fields are present.

**iTero portal selectors are tenant-specific.** The login form selectors and
list/Rx-download endpoints in `itero-poller.cjs` are written defensively
against common patterns but may need tweaking once an admin can DevTools the
real portal — failures surface as `lastError` in the Settings panel rather
than crashing the app. The three URL candidates probed for the order list
(`/api/orders`, `/api/lab/orders`, `/api/cases` with `?status=labReview`) and
the login `<input>` selectors are the place to adjust.

**De-dup is enforced server-side**, not just locally — even if the local
`userData/itero-seen.json` ledger is wiped, the unique index on
`itero_imported_orders` prevents duplicate cases.

## Lab data protection (regression watch list)

Customer lab data has been lost in the past to overly-eager `db.delete(...)`
calls and to filesystem cleanups. To stop those regressions from coming back:

**Protected tables — soft-delete only.** Direct `db.delete(<table>)` against
any table in this list is forbidden. Use `softDelete()` / `softDeleteById()`
from `artifacts/api-server/src/lib/soft-delete.ts`.

  - `users`
  - `organizations`
  - `lab_memberships` (organizationMemberships)
  - `cases`
  - `case_attachments`
  - `invoices`
  - `bank_transactions`
  - `pricing_tiers`
  - `pricing_overrides`

Each of these tables carries `deleted_at` + `deleted_by_user_id` columns
and a soft-delete audit log entry (`<entity>_soft_deleted`). The single
source of truth for the protected list is `PROTECTED_TABLES` in
`artifacts/api-server/src/lib/soft-delete.ts`.

**Case-media files — trash, don't unlink.** The orphan-media cleanup
moves files to `uploads/case-media/.trash/<timestamp>__<name>` instead of
unlinking, so a false-positive cleanup can be reversed.

**CI guard.** Run `pnpm --filter @workspace/scripts run lint-protected-tables`
to scan the API tree for `db.delete(<protected>)` and direct
`fs.unlink|rm` of case-media. Add this to your CI pipeline; it exits
non-zero on any violation.

**Adding a new protected table** requires three steps:
  1. Add `deleted_at` + `deleted_by_user_id` columns in
     `lib/db/src/schema/schema.ts` (and re-push the schema).
  2. Filter reads with `notDeleted(table)` from `lib/soft-delete.ts`.
  3. Add the table + its Drizzle export name to `PROTECTED_TABLES` and
     `PROTECTED_DRIZZLE_EXPORTS` in `lib/soft-delete.ts` so the lint
     guard picks it up.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
