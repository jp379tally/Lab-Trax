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

**Intra-suite corruption (the lock can't help inside ONE vitest run):** with
maxWorkers=2, running backup-restore.test.ts inside the full api-server suite
let its pg_restore truncate tables under sibling integration files
(intermittent 500s, e.g. case-create FK failures) while sibling writes skewed
its post-restore count validation — both directions of the same corruption
class, invisible to the cross-workflow advisory lock. Fix: the two restore
files are excluded in api-server vitest.config.ts and run ONLY via the
dedicated rel-backup-restore gate using vitest.restore.config.ts (a config
`exclude` also blocks explicit CLI file args — "No test files found" — so the
gate needs its own config, not file args against the default config).

**Full-audit outcome (2026-07-08):** all other test workflows (knowledge-test,
installer-download-test, rel-scripts/desktop/mobile-tests) are hermetic — no
`@workspace/db`/`DATABASE_URL` usage — and were empirically verified passing
concurrently with an in-flight destructive restore. Do NOT wrap hermetic
suites: the wrapper needs a live DB connection just to take the lock and would
needlessly serialize the aggregate. The authoritative wrapped/safe-unwrapped
table lives in REGRESSION_GUARDRAILS.md → "DB Serialization Rule
(with-db-lock)"; update it if a suite gains real DB access.
