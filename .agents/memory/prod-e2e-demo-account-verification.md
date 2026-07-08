---
name: Prod end-to-end verification via seeded demo account
description: How to verify prod API features (e.g. Maynard AI) end-to-end without polluting the prod DB, and where the desktop auto-update feed really lives.
---

# Prod end-to-end verification via seeded demo account

**Rule:** to prove a prod feature truly works (not just "route returns 401 so it's deployed"),
log in to prod with a seeded demo user (see `DEMO_SEED_USERS` in
`artifacts/api-server/src/routes/labtrax-routes.ts`; they exist on prod) with
`clientType:"desktop"` for bearer tokens, then curl the real endpoint. curl consumes SSE
fine, so `/api/ai-agent/stream` can be verified end-to-end: 200 + `data: {"token":…}` events
+ `{"done":true}`. Never register a throwaway user on prod for this.

**Why:** the users table is protected/soft-delete-only; test registrations pollute prod
forever. Demo accounts already exist and are read-safe for AI-chat probes.

**Also learned:**
- Legacy non-stream `POST /api/ai-agent` still lives alongside `/ai-agent/stream`, so
  pre-2026-06-22 desktop builds keep a working Maynard — a stale desktop install does NOT
  reproduce "Maynard down".
- The desktop auto-update feed is at `/downloads/latest.yml` (NOT `/api/downloads/latest.yml`
  as the release-runbook curl example says — that 404s). Its `version:` + `releaseDate` +
  sha512 identify exactly which build installed apps are on; compare sha/size against the
  installer slot from `GET /api/desktop-installer` (auth required).
- Delete any file holding prod tokens (e.g. /tmp/login.json) when done.
