---
name: post-merge scope + user_sessions FK drift
description: What scripts/post-merge.sh may do, and how the user_sessions→users cascade FK drift was resolved (orphan cleanup before push).
---

## scripts/post-merge.sh scope
Runs automatically after every task merge with stdin closed (/dev/null). It must ONLY reconcile the environment: `pnpm install --frozen-lockfile`, a one-shot orphan-session cleanup, then `pnpm --filter @workspace/db run push-force`. Fast, idempotent, non-interactive.

**Why:** A prior version also ran the full desktop Electron build+publish (`scripts/desktop-build-publish.sh`). That needs Wine (NSIS installer) and a running, reachable server (post-publish HEAD download probe) — neither exists in the merge sandbox — so it failed every merge (exit 1: "Wine is required" + HTTP 502 on the reachability check). Desktop releases are handled by GitHub Actions (auto-tag-desktop-release.yml → release.yml), never by post-merge.

**How to apply:** Never put builds / publishes / reachability checks in post-merge. Only env reconciliation (deps, the orphan cleanup, migrations, codegen if needed).

## user_sessions → users FK drift — RESOLVED (apply the cascade FK, clean orphans first)
Schema declares `user_sessions.user_id` → `users.id` (onDelete cascade), but the live DB historically had NO such FK. Every `drizzle-kit push` tried to CREATE it and failed (Postgres 23503) because of orphaned `user_sessions` rows whose user_id has no `users` row. drizzle logged the error to stderr **but the push process exited 0**, so the FK never applied and the same error recurred on every merge — masking what a real failure would look like.

**Root cause of the orphans (not what it looked like):** the orphan user_ids carry synthetic test prefixes (`uadmin_`, `uout_`, `viewer_`, `escaluser_`, `celadmin_`, `pu_`, `invitee_`, raw UUIDs, etc.) produced by api-server test `rid()` helpers run against this DB. They are NOT live platform-admin sessions. Platform-admin auth uses an `X-Platform-Admin-Secret` header / PIN — it does NOT create `user_sessions` rows at all. Orphans accumulate precisely BECAUSE the cascade FK was missing: when a hard-deleted user disappears (tests, legacy), its sessions are left behind. The earlier worry that "adding the FK could reject valid platform-admin session inserts at runtime" was based on a wrong assumption — every real session insert (login/register/refresh in `routes/auth.ts`) uses `user.id` from an existing `users` row.

**Resolution (chosen option a):** delete orphans, then let push apply the declared cascade FK.
- `scripts/post-merge.sh` runs `DELETE FROM user_sessions s WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id)` (via psql, guarded on DATABASE_URL, non-fatal) BEFORE `push-force`. Deleting an orphan is always safe — a session whose user does not exist can never authenticate.
- With orphans gone, `push-force` applies `user_sessions_user_id_users_id_fk` (FK ... ON DELETE CASCADE). Verified: post-merge now exits 0 with "Changes applied" and no 23503; re-running is a clean no-op.
- The cascade FK now auto-deletes sessions when a user is deleted, so orphans can't re-accumulate. It is also what `lib/backup.ts` expects (it drops the FK before pg_restore and re-adds it after).

**Verification:** full api-server suite ran 960 passed / 1 failed; the only failure was `vocabulary.test.ts` "default material list" (`E.max` naming — unrelated, pre-existing, see material-naming-rules.md). All auth / auth-session / restore-session / backup-restore suites passed → no auth regression. Tests already create a real `users` row before inserting sessions, so the FK does not break them.

**How to apply:** The FK is now expected to exist in every environment after post-merge. If a future `push` ever logs 23503 on `user_sessions_user_id_users_id_fk` again, it means orphans were re-created (e.g. a new hard-delete path bypassing cascade) — investigate that path; the cleanup + cascade FK should normally keep it clean.
