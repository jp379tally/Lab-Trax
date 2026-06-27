# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

LabTrax is a multi-tenant dental laboratory case-tracking system: an Express 5 API (`artifacts/api-server`), an Electron + React desktop client (`artifacts/labtrax-desktop`), and an Expo (React Native) mobile app (`artifacts/labtrax`), all backed by PostgreSQL + Drizzle (`lib/db`).

## User Preferences

- **Paid/publishing builds stay script-only — never Replit workflows.** EAS iOS Build + Submit and Desktop Build + Publish must be run manually from Shell (`bash scripts/eas-ios-build.sh`, `bash scripts/desktop-build-publish.sh`), never registered as Replit workflows. The reason: the workflow tooling auto-attaches any new workflow to the `Project` run aggregate (the Run button), which would fire these paid/publishing builds accidentally. Only reconsider if Replit adds a way to exclude a workflow from the `Project` aggregate; even then they must remain manual-only and off the Run button.

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

Full reference (SMS, backup/OneDrive, cleanup, AI-memory cleanup, desktop installer, billing, GitHub backup): [`docs/environment-variables.md`](docs/environment-variables.md).

**Required in production:**
- `JWT_SECRET` — auth token signing; defaults to insecure value in dev
- `PLATFORM_ADMIN_SECRET` — must be sent as `X-Platform-Admin-Secret` to access all `/api/admin/*` endpoints; if unset, all admin endpoints return 403

**Optional — core features:**
- `EXPO_PUBLIC_DOMAIN` — set automatically from `$REPLIT_DEV_DOMAIN` in the labtrax dev script
- `AI_INTEGRATIONS_OPENAI_API_KEY` — enables AI features (Rx parsing, AI chat, smile preview)
- `LABTRAX_ENABLE_DEMO_SEEDS` — set `"true"` to seed demo users on startup
- `PLATFORM_ADMIN_PIN` — short numeric PIN alternative to `PLATFORM_ADMIN_SECRET` via `X-Platform-Admin-Pin`; requires a signed-in `role:"admin"` user (PIN alone cannot authenticate)

## Lab Data Protection

**Never hard-delete these tables** — use `softDelete()` / `softDeleteById()` from `artifacts/api-server/src/lib/soft-delete.ts`:

`users`, `organizations`, `lab_memberships`, `cases`, `case_attachments`, `invoices`, `bank_transactions`, `pricing_tiers`, `pricing_overrides`

Each carries `deleted_at` + `deleted_by_user_id` columns and an audit log entry. The authoritative list is `PROTECTED_TABLES` in `soft-delete.ts`.

**Case-media files** — move to `.trash/`, never unlink directly. The orphan-media cleanup uses `uploads/case-media/.trash/<timestamp>__<name>`.

**CI lint guard:** `pnpm --filter @workspace/scripts run lint-protected-tables` — exits non-zero on any `db.delete(<protected>)` or direct `fs.unlink/rm` of case-media in production code.

**Adding a protected table:** (1) add `deleted_at` + `deleted_by_user_id` to schema and push; (2) filter reads with `notDeleted(table)`; (3) add table + Drizzle export to `PROTECTED_TABLES` and `PROTECTED_DRIZZLE_EXPORTS` in `soft-delete.ts`.

## Detailed Guides

Deep reference for individual subsystems lives under `docs/`:

- **Environment variables (full)** — [`docs/environment-variables.md`](docs/environment-variables.md)
- **GitHub backup (auto-mirror)** — [`docs/github-backup.md`](docs/github-backup.md)
- **Subscription billing** — [`docs/subscription-billing.md`](docs/subscription-billing.md)
- **Desktop installer download** — [`docs/desktop-installer.md`](docs/desktop-installer.md); publish pipeline runbook [`docs/desktop-publish-pipeline.md`](docs/desktop-publish-pipeline.md); auto-update runbook [`artifacts/labtrax-desktop/docs/auto-update-runbook.md`](artifacts/labtrax-desktop/docs/auto-update-runbook.md)
- **Build counter recovery** — [`docs/build-counter-recovery.md`](docs/build-counter-recovery.md)
- **Cross-lab provider account numbers** — [`docs/cross-lab-providers.md`](docs/cross-lab-providers.md)
- **iTero lab-review auto-import** — [`docs/itero-import.md`](docs/itero-import.md)
- **AI assistant (knowledge + memory)** — [`docs/ai-assistant.md`](docs/ai-assistant.md)
- **Installer storage integration tests (opt-in)** — [`docs/installer-storage-tests.md`](docs/installer-storage-tests.md)

Security-relevant architecture and threat categories: [`threat_model.md`](./threat_model.md).

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
