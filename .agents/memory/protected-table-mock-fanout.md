---
name: Protected-table addition breaks mocked db tests
description: Adding a table to soft-delete PROTECTED_DRIZZLE_EXPORTS makes every fully-mocked @workspace/db test throw unless the table is added to its mock.
---

Adding a new protected table to `PROTECTED_DRIZZLE_EXPORTS` in
`artifacts/api-server/src/lib/soft-delete.ts` means `soft-delete.ts` now imports
that Drizzle export at module load. Any test that does `vi.mock("@workspace/db", ...)`
with a hand-listed set of exports (a `tables` record mirroring the protected
tables) will throw `[vitest] No "<table>" export is defined on the "@workspace/db"
mock` the moment it transitively imports soft-delete (via routes / lab-creation / etc.).

**Why:** these mocks enumerate exports explicitly instead of spreading
`vi.importActual`, so a brand-new export is missing until added by hand.

**How to apply:** after adding a protected table, grep api-server tests for the
existing protected markers (e.g. `vendorTypes`, `pricingOverrides`) and add the new
table to each `tables` record in the same format that file uses
(`{ __table: "x" }`, a shared `T`, or `{}` — match the file). Env-gated suites
(installer-publish-e2e, installer-storage-e2e) won't fail locally when skipped but
will in a release run with the env set, so fix them too.
