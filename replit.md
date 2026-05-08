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
- `DESKTOP_INSTALLER_URL` — direct download URL for the Windows installer (default: `/downloads/LabTrax-Windows-Portable.zip`); set to a GitHub Release asset URL in production
- `PLATFORM_ADMIN_SECRET` — **required in production**; a strong secret string that must be sent as `X-Platform-Admin-Secret` header to access all `/api/admin/*` platform-wide endpoints (backup, cleanup, system settings). If unset, all admin endpoints return 403.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
