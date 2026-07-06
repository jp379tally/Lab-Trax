---
name: Legacy mobile invoices in bulk invoice routes
description: Why bulk invoice mutations silently no-op on mobile:<id> invoices and how to fix them
---

Legacy mobile-origin invoices surface in the desktop invoice list with a
synthetic id `mobile:<localInvoiceId>` synthesized from a `lab_cases.case_data`
JSON blob that carries an `invoiceId`. They have NO row in the relational
`invoices` table.

**Rule:** any bulk invoice mutation route (delete, and by extension reset/void)
that only queries the `invoices` table will silently resolve `mobile:` ids to
zero rows → `deletedCount: 0` ("No invoices were deleted"). Split `mobile:` ids
out, resolve + authorize them separately, and apply the change by editing the
blob — not the invoices table.

**Delete = strip the blob's invoiceId**, do NOT create-then-soft-delete a
canonical invoice. The list only suppresses a legacy invoice when a LIVE
canonical exists, so a soft-deleted canonical would let the legacy one resurface.
Set `invoiceId:null` + record `deletedInvoiceId`/`invoiceDeletedAt`/
`invoiceDeletedByUserId`; keep the `lab_cases` row (don't soft-delete the case).

**Authorization:** the legacy resolver scopes reads to the caller's own orgs
(active memberships + provider-org expansion, mirroring GET /api/invoices).
An out-of-scope legacy case is therefore invisible → fails closed as
deletedCount 0 (not 403, unlike the real-invoice path which looks up by id
globally then 403s). This is safe and avoids an expensive global JSON scan.

**Why:** bulk is the ONLY invoice delete path (no single `DELETE /:id`).
Reference implementation: `resolveLegacyMobileInvoiceTargets` + the split in
`DELETE /bulk`, `artifacts/api-server/src/routes/invoices.ts`.
