---
name: LabTrax add-item dual price resolution
description: The case stored price and the invoice line rate for an added item are computed at two independent call sites; any pricing input must be threaded to both.
---

When an item is added to a case in the mobile app, its price is resolved
**twice, independently**:

1. The case's stored `price` is computed inside `addCaseItem` (in
   `lib/app-context.tsx`) via `resolvePriceForCase`.
2. The linked invoice line `rate`/`amount` is computed in `handleSaveItem`
   (in `app/case/[id].tsx`) via a separate `resolvePriceForCase` call.

**Why:** These two sites do not share a computation. When a new pricing input
is introduced (e.g. the custom-materials price map), threading it into only one
site makes the case price and the invoice line diverge — a custom item showed
the correct price on the invoice but fell back to the $250 default on the case.

**How to apply:** Any new pricing factor (tier overrides, custom materials,
discounts) must be passed to **both** `addCaseItem` and the `handleSaveItem`
invoice-line calculation. For not-yet-persisted values (e.g. an in-progress
custom item held in component state), pass them as an explicit override argument
to `addCaseItem` since the context state won't contain them yet.

Note also: the case price uses a bridge/pontic-aware billable count while the
invoice line historically uses raw selected-teeth count — a pre-existing
quantity-basis mismatch, separate from the pricing-input issue above.
