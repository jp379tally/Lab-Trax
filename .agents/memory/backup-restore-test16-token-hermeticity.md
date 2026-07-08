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

**Aborted-run residue variant (2026-07-08, FIXED):** tests 11/12 (fixed token
hashes, normally truncated by the restore) could ALSO 23505-collide locally if a
prior full-suite run was aborted mid-file, leaving their rows in the persistent
dev DB. As of 2026-07-08 all session inserts in the file derive token_hash from
their per-run-random rid() id, and the restore-pipeline beforeAll deletes legacy
fixed-hash rows plus expired rid()-prefixed residue, so this failure mode should
no longer occur. If a similar 23505 reappears, some NEW session insert used a
fixed token — randomize it. Note the `rel-backup-restore` workflow's `test -- --…`
arg passing runs the WHOLE api suite, not just the two files; use a direct
`npx vitest run src/routes/backup-restore.test.ts` for true isolation.

**Gate self-concurrency variant:** the validation gate runs `rel-api-tests` AND
`rel-backup-restore` in parallel — BOTH include backup-restore.test.ts, so the
file races itself on the shared dev DB. Another instance's login/refresh
rotation can land the same token under a different id between the snapshot
SELECT and the safety-net re-insert, so `restoreSnapshotNow` must skip 23505
(like it skips 23503). Also: a "vitest run <file>" from bash right after a gate
kicks off is NOT isolated — the gate's rel-* workflows may still be running for
minutes; check pgrep vitest before trusting an "isolated" result.
