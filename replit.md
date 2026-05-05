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

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
