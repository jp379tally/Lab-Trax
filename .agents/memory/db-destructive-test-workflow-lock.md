---
name: DB-destructive test workflows need whole-run serialization
description: Why rel-api-tests and rel-backup-restore wrap their commands in a PG advisory-lock wrapper, and the pitfalls hit getting there.
---

The backup-restore integrity suite performs a **DB-wide pg_restore**. Any test
workflow running it cannot safely overlap with ANY other DB-integration suite
— not just another copy of the same file. A file-level advisory lock inside
backup-restore.test.ts is insufficient: the restore truncates tables out from
under unrelated suites in the other workflow (spurious 500s/timeouts), and
their concurrent writes skew the restore's post-restore count validation.

**Fix:** both DB-touching release gates (`rel-api-tests`, `rel-backup-restore`)
wrap their test command in `pnpm --filter @workspace/scripts run with-db-lock
"<cmd>"` (scripts/src/run-with-db-lock.ts), which holds a PG session advisory
lock (`hashtext('labtrax-db-test-workflows')`) for the whole command. Session
scope means PG auto-releases on process death.

**Pitfalls discovered:**
- `pg_advisory_lock`'s blocking wait counts as statement execution — the
  pool's `statement_timeout=30s` kills a wait for a full suite run. Must
  `SET statement_timeout = 0` on the lock session first.
- The pool's production `connectionTimeoutMillis: 10s` fail-fast produces
  false "Connection terminated due to connection timeout" under full-aggregate
  CPU saturation (TLS handshake > 10s). Override via `DB_CONNECT_TIMEOUT_MS`
  (set to 60s in api-server vitest env, 120s in the wrapper); production keeps
  10s.
- The in-file suite lock in backup-restore.test.ts (separate key,
  'backup-restore-suite') is kept as defense for any future workflow that runs
  the file without the wrapper.

**How to apply:** any new validation workflow that runs DB-integration tests
against the shared dev DB should wrap its command with `with-db-lock`, or the
Run-button aggregate will reintroduce cross-workflow corruption.
