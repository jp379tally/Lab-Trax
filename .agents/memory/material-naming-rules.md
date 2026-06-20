---
name: Material naming rules (zirconia / Emax→Lithium Disilicate / PFM)
description: How the AI Rx reader canonicalizes materials and why the Emax vocab rename does NOT touch the internal price key.
---

# Material naming canonicalization

`normalizeMaterialName()` in `artifacts/api-server/src/lib/material-mapping.ts`
is the single source of truth for collapsing material synonyms to a canonical
name. It must run on `extracted.material` in **every** AI Rx ingest path before
storage and before price resolution: iTero single-file import, iTero ZIP batch
import, the shared iTero helper, AND the manual/camera `analyze-prescription`
return in `labtrax-routes.ts` (normalize `cleanedData.material`).

Rules: zirconia synonyms (zirc/zr/brux/bruxz/bruxzir/bzr/pfz) → "Zirconia";
emax/e.max/e max/lithium disilicate/lithium silicate → "Lithium Disilicate";
pfm/porcelain fused to metal → "PFM". Lithium is checked FIRST so its multi-word
phrases aren't shadowed; short abbreviations match on word boundaries.

## Why the vocab rename keeps the internal price key

The user-facing material vocabulary entry is **"Lithium Disilicate (Emax)"**
(server `vocabulary.ts` VOCAB_DEFAULTS + every client material picker), but the
internal pricing key stays **`emax_crown`** and the tier-editor label stays
**"E.max Crown"**.

**Why:** renaming the price key would orphan every existing lab's tiers and
overrides that reference `emax_crown`, silently breaking price resolution. The
canonical material name "Lithium Disilicate" still maps to `emax_crown` via
`materialToPriceKey`, so display changes without touching pricing.

**How to apply:** when adding/renaming a material, change ONLY the user-facing
vocab strings; never rename a DEFAULT_TIER_ITEMS key. There is a round-trip test
asserting "Lithium Disilicate (Emax)" → `emax_crown` in material-mapping.test.ts.

## PFM alloy reminder

PFM cases show a dismissible amber "PFM detected — don't forget to charge for
alloy" reminder on desktop (`cases.tsx` lab-slip tab, localStorage) and mobile
(`case/[id].tsx` OverviewSection, AsyncStorage). Two dismissals: per-case (id
list) and permanent ("don't show again" flag). It is a prompt only — no alloy
line item is auto-added. Keys: `labtrax_pfm_alloy_reminder_dontshow_v1` and
`labtrax_pfm_alloy_reminder_dismissed_cases_v1` on both platforms.
