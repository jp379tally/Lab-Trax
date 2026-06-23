---
name: Practices tier dropdown cache-key collision
description: Two sections sharing a React Query key but caching different shapes silently empties a dropdown
---

On the desktop Practices page, the pricing-tier dropdowns were empty even though
the API returned tiers. Root cause: ConnectionTierSection and
PracticeDoctorsSection both keyed their `/pricing/tiers` query on the same lab id
but cached **different response shapes** (one a `Record<labId, tiers[]>` map, the
other `{labOrganizationId, keys, tiers}`). For a single-connection practice the
keys were identical, so React Query deduped them — whichever fetched first won
and the other section read the wrong shape, resolving to `[]` with no error to
catch.

**Why:** React Query dedupes purely on the serialized query key. Two callers
that share a key MUST agree on the cached value's shape.

**How to apply:** When two components fetch the same endpoint but transform the
response differently, give them distinct, namespaced query keys (e.g.
`["practice-default-tier","tiers-by-lab", ids]` vs
`["practice-doctors","tiers", labId]`). Don't `.catch(() => null)`-swallow
per-item fetch errors — capture them per id and surface to the user, and add a
zero-result empty-state hint so "no data" is visibly distinct from "broken".

**Regression test:** `practices-tier-dropdown.test.tsx` now mounts BOTH
ConnectionTierSection + PracticeDoctorsSection under ONE shared QueryClient
(render them as siblings of a single `render()` call — `makeAuthWrapper` closes
over one client) and asserts tiers populate both dropdowns. This catches a
re-collision directly, which single-section tests cannot. Scope assertions with
`within(getByTestId(...))` since both sections render identical option/error
text.
