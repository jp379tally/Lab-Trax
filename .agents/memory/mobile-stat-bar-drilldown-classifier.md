---
name: Mobile stat-bar drill-down classifier
description: Why the mobile Stats "tap a bar" feature classifies cases locally instead of reusing the server, and the pitfalls to know.
---

Tapping a mobile Stats bar navigates to the Cases list pre-filtered to a
category and/or a created-date window (param-seeded via router params, then
consumed with router.setParams).

**Decision:** the category classification used by the Cases list is a
self-contained mobile mirror (`artifacts/labtrax/lib/case-category.ts`), NOT a
shared lib.
**Why:** the server's `material-mapping.ts` is too entangled (internal price
keys, many synonyms) to lift into a shared package cleanly; and the mobile list
only has comma-joined `restorationTypes`/`restorationMaterials` strings, not the
per-restoration rows the server classifies, so an exact match is impossible
anyway. The mirror approximates server priority (implants > zirconia >
crown_bridge > removable > other; blank -> uncategorized).
**How to apply:** if server category rules or material synonyms change, update
the mobile mirror in lockstep or the list shown behind a tapped bar drifts from
the bar's count.

**Gotchas:**
- The generated Stats category item exposes `category` (a `StatsCaseCategory`),
  NOT `key` — using `.key` fails typecheck.
- Revenue bar drill-down uses `bucketWindow()` to map the server's UTC-midnight
  `periodStart` back to a local day/week/month/year window; time-zone edges are
  the risk area.
