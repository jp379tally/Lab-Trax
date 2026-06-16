---
name: iTero import restoration creation gaps
description: Four recurring bugs that cause Lab Slip fields (tooth #, shade, restorative type) to appear empty after iTero auto-import.
---

## The four gaps — fix all three paths (processOneIteroRxPdf, import-from-itero-rx ZIP, ZIP-batch helper)

**1. extracted.teeth empty but restorations array populated**  
AI sometimes puts tooth numbers only in `extracted.restorations[].teeth` (especially Crown & Bridge).
Top-level `extracted.teeth` stays null → `teethList = []` → no restoration rows created.  
**Fix:** after building `teethList` from `extracted.teeth`, fall back to aggregating from `extracted.restorations[].teeth`, expanding bridge ranges ("8-10" → 8,9,10).

**2. normalizedCaseType null gates all restoration creation**  
Condition `if (teethList.length > 0 && normalizedCaseType)` — when AI returns `caseType: null`, `normalizedCaseType` is null even if teeth/material/shade were extracted, so nothing is saved.  
**Fix:** fall back `normalizedCaseType` to `"Other"` when caseType is absent but any clinical data (teeth/material/shade) exists.

**3. No stub restoration when teeth unknown but type/material/shade present**  
General Rx-analysis path has a fallback that creates a single toothNumber="" restoration. iTero paths didn't. Without it, RESTORATIVE TYPE, MATERIAL, and SHADE are all blank on Lab Slip.  
**Fix:** add `else if (normalizedCaseType || extracted.material || extracted.shade)` block creating a stub restoration (matches general path).

**4. shade not written to the case row**  
`cases` table has a `shade TEXT` column. All three iTero insert statements omitted it.  
**Fix:** add `shade: normalizeIteroShade(extracted.shade)` to each iTero case `.insert().values()` call.

**Why:** TOOTH # and SHADE on the Lab Slip come from `deriveRxSummary(data?.restorations)` — if no restoration rows exist, both show "—". The `?? "Other"` for RESTORATIVE TYPE is a UI fallback that looks like "extracted" but means nothing was stored.
