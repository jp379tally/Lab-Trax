---
name: Orphan media cleanup must fail-closed
description: cleanupOrphanedCaseMedia must skip deletion entirely if any reference scan throws — never trash on an incomplete reference set.
---

# Orphan media cleanup must fail-closed

`cleanupOrphanedCaseMedia` builds a `referenced` set from three scans
(`case_attachments`, `legacy_case_media` ledger, live `lab_cases.caseData`
blob), then trashes any on-disk file not in that set. If ANY of those scans
throws, the set is incomplete and trashing becomes false-positive deletion of
in-use media.

**Rule:** if any reference scan fails, set a `referenceScanFailed` flag, push an
error entry, and `return` the report BEFORE the trash phase. Never delete on a
partial reference set.

**Why:** the old catch blocks logged a warning and *continued* (fail-open),
which trashed a file protected by BOTH a ledger row and a live case blob. This
aligns with the Lab Data Protection threat model: never destroy on incomplete
information. Files go to `.trash` (recoverable), but the correct behaviour is to
not trash in the first place.

**How it surfaced:** flaky failure of
`legacy-case-media-serving.test.ts → "orphan cleanup never trashes a
ledger-bound legacy file"` only in `regression-tests`, never in isolation.

**How to apply / testing trap:** the `api-server-tests` and `regression-tests`
workflows BOTH run the full api-server vitest suite and share the same Postgres
DB + `uploads/case-media/` dir. When they run concurrently, DB pool pressure
makes reference scans throw — exactly the fail-open path. Any test asserting
real filesystem state of `uploads/case-media` is inherently cross-suite racy;
prefer asserting the report shape (`removedCount === 0`, error recorded) with a
`db.select` spy that throws, and avoid filesystem assertions.
