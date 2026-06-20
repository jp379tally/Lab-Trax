---
name: post-merge scope + user_sessions FK drift
description: What scripts/post-merge.sh may do, and why the user_sessions→users FK is absent from the DB and must not be force-applied.
---

## scripts/post-merge.sh scope
Runs automatically after every task merge with stdin closed (/dev/null). It must ONLY reconcile the environment: `pnpm install --frozen-lockfile` + `pnpm --filter @workspace/db run push-force`. Fast, idempotent, non-interactive.

**Why:** A prior version also ran the full desktop Electron build+publish (`scripts/desktop-build-publish.sh`). That needs Wine (NSIS installer) and a running, reachable server (post-publish HEAD download probe) — neither exists in the merge sandbox — so it failed every merge (exit 1: "Wine is required" + HTTP 502 on the reachability check). Desktop releases are handled by GitHub Actions (auto-tag-desktop-release.yml → release.yml), never by post-merge.

**How to apply:** Never put builds / publishes / reachability checks in post-merge. Only env reconciliation (deps, migrations, codegen if needed).

## user_sessions → users FK is absent from the DB
Schema defines `user_sessions.user_id` → `users.id` (onDelete cascade), but the live DB has NO such FK (only the PK and the token_hash unique index). Every `drizzle-kit push` tries to CREATE it and fails because of orphaned `user_sessions` rows whose user_id (e.g. `uadmin_…` platform-admin ids) is not present in `users`. drizzle logs the Postgres 23503 FK-violation to stderr **but the push process exits 0** — so push "succeeds", the FK never applies, and the same error recurs on every push.

**Why not just delete the orphans and apply the FK:** the orphans look like platform-admin (`uadmin_`) sessions whose user_id has no `users` row. Adding the cascade FK could start rejecting those session inserts at runtime → auth regression. Treat it as a separate, deliberate investigation, not a drive-by fix.

**How to apply:** Don't be alarmed by the recurring `user_sessions_user_id_users_id_fk` (code 23503) error in push / post-merge logs — it is non-fatal (exit 0). Do NOT force-apply the FK without first confirming platform-admin session creation won't break.
