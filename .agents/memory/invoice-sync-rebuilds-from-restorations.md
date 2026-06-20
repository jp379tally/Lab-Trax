---
name: Invoice sync rebuilds line items from restorations
description: Why auto-added case charges (alloy surcharge, etc.) must be case_restorations rows, not manual invoice lines.
---

`syncInvoiceFromRestorations` (api-server `lib/invoice-sync.ts`) DELETES and
rebuilds the entire set of case invoice line items from the case's
`case_restorations` rows on every restoration change.

**Rule:** Any charge that must persist on a case's invoice has to be modeled
as a `case_restorations` row, never inserted directly as a manual invoice
line — a manual line gets wiped on the next restoration edit / re-sync.

**Why:** The alloy surcharge feature (one-click "add alloy charge" on PFM
cases) initially looked like it could be a manual invoice line, but it would
vanish the moment any other restoration changed. Modeling it as a restoration
row (restorationType "Alloy", toothNumber "N/A", priceKey "alloy") makes it
survive and lets it price through the normal override→tier→default cascade.

**How to apply:** When adding any new auto/derived case charge, insert a
`case_restorations` row + a `case_events` "restoration_added" event, then call
`syncInvoiceFromRestorations`. Give the restoration its own price key in
`material-mapping.ts` (`DEFAULT_TIER_ITEMS` + `materialToPriceKey`) so it auto-
surfaces a row in the tier and override editors and resolves a price.
`buildBasicDescription` special-cases tooth-less charges (renders plain label
instead of "X - Tooth N/A").
