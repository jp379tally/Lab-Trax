---
name: Barcode uniqueness is a hard per-lab unique index
description: Why case_pan_barcode uniqueness is DB-enforced and the admin force-duplicate override was removed
---

# Barcode uniqueness: hard partial unique index

Barcode uniqueness for cases is enforced by a partial unique index
`cases_barcode_unique_per_lab` on `(lab_organization_id, case_pan_barcode)`.
Its predicate MUST stay in lockstep with the `checkBarcodeUniqueness`
pre-check in `artifacts/api-server/src/routes/cases.ts`:
`deleted_at IS NULL AND case_pan_barcode IS NOT NULL AND status <> 'complete'`.

**Why the `status <> 'complete'` clause:** the product intentionally lets a
new active case reuse a barcode once the prior case is `complete` (the
barcode is "released"). Two tests in `cases-search.test.ts` assert this. A
naive index without that clause regresses completed-case reuse.

**Why the admin force-duplicate override was removed:** there used to be an
`allowDuplicateBarcode=true` flag (admin-only) that skipped the pre-check and
let two active cases share a barcode. A hard unique index is physically
incompatible with that — you cannot both enforce uniqueness in the DB and
allow intentional duplicates. Product decision: enforce strict uniqueness,
drop the override (schema fields, handler branches, mobile "Assign anyway"
button, and the test now asserts 409).

**How to apply:** the pre-check is only a friendly fast-path that names the
conflicting case. The DB index is the real guard that closes the TOCTOU race
between the pre-check SELECT and the INSERT/UPDATE. Both POST (insert tx) and
PATCH (update) catch PG 23505 on this constraint via `rethrowBarcodeConflict`
and return the same 409. Any new write path that sets `case_pan_barcode` must
do the same, and the index must be pushed to production (drizzle push is
dev-only).

**Drizzle error wrapping (critical):** Drizzle's node-postgres adapter wraps
the pg `DatabaseError` in a `DrizzleQueryError` — the `code` and `constraint`
fields are on `err.cause`, NOT on `err` directly. `rethrowBarcodeConflict`
already handles both shapes (top-level and `.cause`). Any other place that
inspects raw pg error fields (code, constraint, detail) must do the same or it
will silently fail to catch the error and return 500 instead of the intended
4xx. Unit tests must cover both the direct-pg and drizzle-wrapped shapes.
