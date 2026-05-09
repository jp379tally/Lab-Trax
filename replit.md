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
- `DESKTOP_INSTALLER_URL` — direct download URL for the Windows installer (default: `/downloads/LabTrax-Windows-Portable.zip`); the default path is served by the API from App Storage (see "Desktop installer download" below). Override to a GitHub Release asset URL if you'd rather host the zip on GitHub.
- `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS` — App Storage configuration (auto-set when Object Storage is provisioned). The API server reads/writes the desktop installer zip in App Storage via these.
- `GITHUB_REPO_URL` — optional; GitHub repository URL (e.g. `https://github.com/your-org/your-repo`); when set, the Settings → Desktop App panel shows a direct link to the repo's Actions tab so admins can trigger installer builds in one click
- `PLATFORM_ADMIN_SECRET` — **required in production**; a strong secret string that must be sent as `X-Platform-Admin-Secret` header to access all `/api/admin/*` platform-wide endpoints (backup, cleanup, system settings). If unset, all admin endpoints return 403.

## Desktop installer download

The Windows portable zip (`LabTrax-Windows-Portable.zip`) is stored in App Storage so it survives deploys, and the API serves it publicly at `GET /downloads/LabTrax-Windows-Portable.zip` (no auth required — same URL as before). Object key: `<PRIVATE_OBJECT_DIR>/desktop-installer/LabTrax-Windows-Portable.zip`.

After running a fresh electron build, refresh the hosted zip in one of two ways:

1. **In-app (preferred):** Settings → Desktop App → "Choose ZIP and upload". Hits `POST /api/admin/desktop-installer/upload` (admin-only, 300 MB max, zip-only).
2. **CLI fallback / first-time bootstrap:** `pnpm --filter @workspace/scripts run upload-desktop-installer` — uploads `artifacts/labtrax-desktop/electron-dist/LabTrax-Windows-Portable.zip` to App Storage. Pass a custom path as the first arg if needed.

The Settings → Desktop App panel shows the current installer's size and uploaded-at timestamp so admins can verify freshness. If no zip has been uploaded yet, `/downloads/LabTrax-Windows-Portable.zip` returns a 404 JSON body explaining that an admin must upload one.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
