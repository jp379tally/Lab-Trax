---
name: Case-delete invoice freeze
description: Deleting a case must keep its invoice (frozen + zero balance), never delete it — on every delete path.
---

# Case deletion must FREEZE invoices, not delete them

When a case is deleted, every invoice linked to it must be **kept** (the row
stays, `deletedAt` null) but **frozen**: `frozen=true`, `balanceDue="0.00"`,
plus `caseDeletedAt/By/Note` metadata and a per-invoice audit entry. The
original `total` is preserved for the historical record. Restoring the case
(`POST /cases/:caseId/restore`) reverses it (clears `frozen`/`caseDeletedAt`).

**Why:** invoices are financial records the user never wants to lose. A real
bug: the single-case `DELETE /cases/:caseId` path froze invoices correctly, but
the **bulk-delete** path (`POST /cases/bulk-delete`) only soft-deleted the cases
and left their invoices with live balances. Deleting "all cases" goes through
bulk-delete, so the user saw open balances on invoices whose cases were gone.

**How to apply:**
- Both delete paths now share `freezeInvoicesForDeletedCases(...)` in
  `cases.ts`. Any NEW path that deletes/archives cases must call it too — do not
  re-implement the freeze inline (that's how the two drifted).
- The freeze must be **tenant-scoped**: filter on `invoices.labOrganizationId`
  (there is no composite FK tying an invoice's lab to its case's lab), and
  **idempotent**: skip rows already `frozen` so you don't double-zero or emit
  duplicate audit logs.
- Legacy `lab_cases` never carry invoices (`invoices.caseId` is canonical-only),
  so only pass canonical case ids.
- Invoices are a PROTECTED table — the FK `invoices.caseId → cases.id` is
  `onDelete: "set null"` but never fires, because cases are only ever
  soft-deleted (the FK row persists, so `caseId` stays intact).
