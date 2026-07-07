---
name: backup-restore phase capture & full-suite case-count contention
description: Why backup-restore phase-sequence tests must read a deterministic phase history, and why case-count mismatches under the full api-server suite are environmental (CI-green), not regressions.
---

# Backup-restore phase capture must be deterministic

The restore phase-sequence tests (the "full phase sequence" / "state machine"
tests) used to observe phases by **polling** `getRestoreState().phase` between
`setImmediate` yields. A poll cannot reliably see a phase whose only `await`
resolves fast — `clearing_sessions` just runs one orphan-session `DELETE`, so
under full-suite CPU load the poll starves and the phase is skipped, producing
`expected [...] to include 'clearing_sessions'`. It passes in isolation purely
by timing luck.

**Fix / rule:** `backup.ts` records an ordered `_restoreHistory` (appended
synchronously inside `setRestorePhase`, and explicitly for the `done`/`error`
terminal states which bypass the setter). Tests read `getRestoreHistory()`
**after the restore settles** instead of polling. Any new phase-sequence
assertion must use the history, never a live poll.

**Why:** a synchronous or fast-await phase transition is invisible to a
macrotask poll; only a synchronously-appended history captures every phase.

# Full-suite case-count mismatches are environmental

Under the whole api-server suite (`maxWorkers=2`, one shared persistent dev DB),
backup-restore intermittently fails with `Case count mismatch: manifest says
N, found N-1`. pg_restore is **mocked** in these tests, so the "restore" never
changes case data — the drift is entirely from **concurrent test files** that
create/delete cases between the fixed manifest snapshot (built once in
`beforeAll`) and each test's post-restore validation. Both the manifest and
the validation count with `WHERE deleted_at IS NULL`, so a soft-deleted row is
counted identically by both and never causes the mismatch.

**How to apply:** treat full-suite backup-restore count failures as the
shared-DB contention/contamination class (same as the token-hermeticity note) —
CI uses a fresh isolated DB and is green. Prove no regression by running the
file **in isolation** (`vitest run src/routes/backup-restore.test.ts` → all
tests pass), not by chasing the concurrent-suite count. Aborted restore runs
can also leave
orphan `user_sessions` (the FK to `users` is absent and restore never drops
that table); clean those before trusting a local full-suite result.
