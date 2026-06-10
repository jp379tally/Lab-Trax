---
name: LabTrax Lists page live-vs-dead duplicate
description: Which file backs the desktop "Lists" page (and its Billable Items / vendors form), and which lookalike is dead code.
---

# LabTrax desktop "Lists" page — edit the right file

The desktop **sidebar "Lists"** entry routes to `/lists` → `lists.tsx`
(`artifacts/labtrax-desktop/src/pages/lists.tsx`). This is the LIVE page with
the Vendors / Employees / Billable Items / Categories tabs and the vendor
("New Item") drawer.

`artifacts/labtrax-desktop/src/pages/finance/payees.tsx` is a LEGACY duplicate
at route `/finance/payees` with **no sidebar nav** — effectively dead. It looks
almost identical, so it is an easy wrong-file trap.

**Why:** A change to the Billable Items form once landed in `payees.tsx` and
had zero user-visible effect because that route is unreachable from the UI.

**How to apply:** Any desktop change to Lists / vendors / employees / billable
items goes in `lists.tsx`. Treat `finance/payees.tsx` as dead unless you first
confirm a live route reaches it.

## Data-model note (vendors / billable items)
`vendors` rows carry `vendorType` of `vendor | employee | item`. Billable items
are `vendorType === "item"`. The vendors table is NOT in `PROTECTED_TABLES`, and
the only FKs pointing at it (`bankTransactions.vendorId`,
`recurringTransactions.vendorId`) use `ON DELETE SET NULL`. Invoices/cases
reference items by **name string**, not FK — so removing an item is referentially
safe. Prefer recoverable removal via `deletedAt` (GET `/vendors` filters
`deletedAt IS NULL`) over a hard `db.delete`.
