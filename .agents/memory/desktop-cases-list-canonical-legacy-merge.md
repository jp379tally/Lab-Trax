---
name: Desktop /cases list merges canonical + legacy rows
description: Why bulk case operations must resolve ids from BOTH the canonical cases table and the legacy lab_cases table.
---

The desktop case list (`GET /cases`) merges canonical `cases` rows with legacy
mobile `lab_cases` rows into one selectable list. Legacy ids are NOT present in
the canonical `cases` table.

**Rule:** Any bulk endpoint that resolves the lab org / existence from a single
selected id against the canonical `cases` table only will 404 the entire batch
for a lab whose cases were all created in the mobile app (legacy-only). Resolve
matches from BOTH tables via `inArray(...)` across the full id set, 404 only if
neither matches, derive the lab org from whichever matched, and enforce the
single-lab tenant boundary across both result sets.

**Why:** Real incident — desktop "Delete N cases?" returned 404 "No matching
cases found." and deleted nothing for a mobile-only lab, because bulk-delete
resolved everything from `uniqueCaseIds[0]` against canonical `cases`.

**How to apply:** `/cases/bulk-delete` is fixed (queries both tables; legacy
soft-delete mirrors `DELETE /legacy/cases/:caseId` via
`db.update(labCases).set({deletedAt, deletedBy})`). The sibling endpoints
`/cases/bulk-reassign` and `/cases/bulk-status` STILL carry the same
`uniqueCaseIds[0]`/canonical-only flaw and will 404 when the first selected id
is legacy — fix them the same way when next touched. Note legacy reassign/status
have no canonical column equivalents, so those need a semantic decision, not just
a resolution fix.
