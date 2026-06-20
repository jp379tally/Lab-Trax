#!/bin/bash
set -euo pipefail

# Post-merge reconciliation.
#
# Runs automatically after a task is merged to bring the workspace into a
# runnable state. Keep this FAST, idempotent, and NON-INTERACTIVE — stdin is
# closed (/dev/null), so any command that prompts will get EOF and fail.
#
# NOTE: Desktop installer builds/publishes are intentionally NOT performed here.
# That pipeline needs Wine (for the NSIS installer) and a running, reachable
# server (for the post-publish download check), neither of which exists in the
# merge sandbox. Desktop releases are handled by GitHub Actions
# (auto-tag-desktop-release.yml -> release.yml). Doing it here only produced a
# guaranteed failure (Wine missing + HTTP 502 on the reachability probe).

# 1. Install dependencies for every workspace package, exactly per the lockfile.
pnpm install --frozen-lockfile

# 1.5. Remove orphaned user_sessions rows (sessions whose user no longer exists)
# BEFORE applying the schema. The schema declares a cascade FK
# user_sessions.user_id -> users.id that the live DB historically lacked, so
# every `drizzle-kit push` tried to CREATE that FK and failed (Postgres 23503)
# on leftover rows whose user_id has no `users` row — the recurring
# "user_sessions_user_id_users_id_fk" noise. drizzle logs that error to stderr
# but still exits 0, so the FK never applied and the error recurred on every
# merge, masking what a real failure would look like.
#
# Orphans only arise from HARD-deleted users (test runs against this DB, or
# legacy data). Soft-deleted users keep their row (see Lab Data Protection), so
# their sessions are never orphaned. Deleting an orphan is always safe: a
# session whose user does not exist can never authenticate. Once the cascade FK
# is applied below it auto-deletes sessions when a user is deleted, preventing
# this from ever recurring. Idempotent: a no-op once the table is clean.
#
# Guarded so it never aborts the merge: skipped if DATABASE_URL is unset, and a
# brand-new DB without the table yet falls through to push-force creating it.
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "DELETE FROM user_sessions s WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id);" \
    || echo "post-merge: orphan user_sessions cleanup skipped (psql unavailable or table not created yet)"
else
  echo "post-merge: DATABASE_URL unset — skipping orphan user_sessions cleanup"
fi

# 2. Apply any Drizzle schema changes brought in by the merge (non-interactive).
# With orphans cleared, the declared user_sessions.user_id -> users.id cascade
# FK now applies cleanly.
pnpm --filter @workspace/db run push-force
