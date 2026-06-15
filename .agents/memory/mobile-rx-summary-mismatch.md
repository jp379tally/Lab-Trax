---
name: Mobile rx-summary DetailRestoration mismatch
description: Mobile deriveRxSummary/RxSummary is incompatible with DetailRestoration from case/[id].tsx; use direct array derivation instead.
---

## Rule

When building mobile UI that shows per-restoration summary (type, material, shade) from a `DetailedCase`, do NOT call `deriveRxSummary(c.restorations)` — use direct Set-based derivation from the array instead.

```tsx
const rests = c.restorations ?? [];
const types = [...new Set(rests.map((r) => r.restorationType).filter((v): v is string => !!v))];
const materials = [...new Set(rests.map((r) => r.material).filter((v): v is string => !!v))];
const shades = [...new Set(rests.map((r) => r.shade).filter((v): v is string => !!v))];
```

**Why:**
Two incompatibilities in `artifacts/labtrax/lib/rx-summary.ts` vs `DetailRestoration` (from `app/case/[id].tsx`):

1. `RxSummary` (mobile) has only `restorativeType` and `materials` fields — no `shades` field. The desktop `PrescriptionPreview.tsx` has `shades` because the desktop's rx-summary is a different version.
2. `deriveRxSummary` expects `RestorationLike` which requires `restorationType: string` (non-nullable), but `DetailRestoration.restorationType` is `string | null | undefined` (all fields optional).

**How to apply:**
Any new mobile component that needs to display restoration summary data from `DetailedCase.restorations` should derive the values directly rather than going through `deriveRxSummary`.

If you need the full `RxSummary` shape (e.g. for a tooth chart), `caseToRxSummary` in the same lib adapts the mobile `LabCase` blob format and is the intended mobile entry point — but it works from the flat `LabCase` shape, not `DetailedCase.restorations`.
