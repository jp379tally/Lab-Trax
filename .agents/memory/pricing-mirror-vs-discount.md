---
name: Pricing mirror-vs-discount rule
description: When a per-doctor exact override price equals the practice default tier price, a configured discount wins over it.
---

# Legacy "mirror" exact prices yield to a discount

Per-doctor pricing overrides store exact dollar prices in `pricesJson`. Historically the
resolver gave an exact $ price strict priority, which blocked percentage discounts even when
the exact price was just a redundant copy of the practice default (connection) tier price.

**Rule:** an exact override price is treated as a non-blocking "mirror" — and the configured
discount wins — only when ALL hold: there is a discount configured for that key, there is a
practice default tier price for that key, and the exact value equals it (within half a cent via
`pricesEqual`). A genuinely custom exact price (different from the default tier) still wins, and
a key with NO practice default tier price keeps its exact override (safe fallback).

**Why:** older overrides duplicated tier prices into exact fields, so percentage discounts never
applied. Stripping the data outright is risky; the resolver heuristic restores intended discount
behaviour without touching stored prices.

**How to apply:** this rule must be applied in lockstep in THREE places or they diverge —
`resolveServerPriceWithSource` (single-item, used by case-create/invoices),
`resolveAllPricesForContext` (full catalog / `GET /api/pricing/resolve-items`), and the desktop
live display in `artifacts/labtrax-desktop/src/pages/practices.tsx` (`DoctorPricingRow`
effective price). The comparison base is the connection/practice default tier resolved by tier
name. Do not change the discount formula or tier resolution order.
