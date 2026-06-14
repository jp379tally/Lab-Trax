---
name: LabTrax desktop finance-table cell dropdowns
description: Why dropdowns inside the invoice/finance line-item tables must use a portal, and how billable-item creation refreshes everywhere
---

# Finance-table cell dropdowns must be portal + fixed-positioned

The invoice "Line items" table (and similar finance tables) in
`artifacts/labtrax-desktop/src/pages/invoices.tsx` wraps rows in an
`overflow-x-auto` (and often `overflow-y-auto`) container. An in-flow
`position:absolute` dropdown rendered inside a table cell gets **clipped**
by that wrapper.

**Rule:** any autocomplete/combobox/dropdown that lives inside one of these
table cells must render via `createPortal(..., document.body)` with
`position:fixed`, computing its coordinates from the trigger's
`getBoundingClientRect()` and re-measuring on `scroll` (capture) + `resize`.
The established components doing this are `VendorCombobox.tsx` and
`ItemCombobox.tsx` — copy that pattern, don't hand-roll an absolute dropdown.

**Why:** a naive absolute dropdown looks fine in isolation but is silently
clipped/scrolled-away once it's in the real overflow-scrolled table.

# Creating a "billable item" and refreshing both surfaces

A billable item in LabTrax is a `vendors` row with `vendorType:"item"`
(see `labtrax-lists-page-duplicate.md` for the data model). To create one
from anywhere on the client: `POST /api/finance/vendors`
`{ organizationId, name, vendorType:"item", unitPrice }` (duplicate name →
409). To make the new item show up immediately in BOTH the invoice editor's
item picker and the Lists → Billable Items page, invalidate the query
**prefix** `["finance","vendors",orgId]` — it prefix-matches both the
editor's `[...,"items"]` key and the Lists page's `[...,"all"]` key.
