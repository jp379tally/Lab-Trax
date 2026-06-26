---
name: backup-restore test16 token hermeticity
description: Why a fixed token_hash in the backup-restore "abort-before-truncate" test leaks across local runs.
---

# backup-restore test 16 must use a per-run-random token_hash

In `backup-restore.test.ts`, the test asserting that an incompatible schema
version throws **before** any `user_sessions` row is touched is special: by
design the restore aborts *before* the `TRUNCATE user_sessions` step, so unlike
the other session tests its inserted row is **never cleared**.

**Rule:** any session row that intentionally survives the restore must derive its
`token_hash` from a per-run-random value (e.g. the already-random `rid()` id),
never a fixed literal.

**Why:** `user_sessions` has a unique index `user_sessions_token_hash_unique`. A
fixed `token_hash` collides on the *second* local run against a persistent dev DB
(error 23505). CI passes because its DB is fresh each run, so this surfaces only
locally and looks like a flaky regression when it is really a hermeticity bug.

**How to apply:** when a test deliberately skips the user_sessions truncate path,
randomize its token; the other session tests can stay deterministic because the
restore truncates their rows.
