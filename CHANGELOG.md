# Changelog

## AI Reader Baseline (protected)

> **Instruction:** If a regression appears, revert only the new-feature change
> that caused it — do **not** revert this baseline section. The tests here are
> the canary; the canary must stay lit.

### What was stabilised

The AI Reader flow converts a prescription photograph into a pre-filled dental
case form across three surfaces:

| Surface | Entry point |
|---------|------------|
| Mobile (Expo) | `app/(tabs)/scan.tsx` — Scan tab |
| Desktop / web | `artifacts/labtrax-desktop/src/components/DashboardDropZone.tsx` |
| Server | `artifacts/api-server/src/routes/labtrax-routes.ts` — `POST /api/analyze-prescription` |

### Files now covered by the test suite

#### New tests added by this baseline

| Test file | What it guards |
|-----------|----------------|
| `artifacts/labtrax/lib/scan-helpers.test.ts` | `shouldAutoAnalyze`, `decideManualEntry`, `resolveCloseAction`, `pickRawCaptureUri` — all pure scan-tab gate functions |
| `artifacts/labtrax/lib/scan/rx-to-form.ts` | *New pure extraction* — `mapRxResponseToFormFields` — maps an `analyzeRx` API response to form state without React side effects |
| `artifacts/labtrax/lib/scan/rx-to-form.test.ts` | Full field-mapping contract: nullable fields → `""`, `isRush` toggle, `toothIndices` parsing, `dueDate` normalisation, `caseType` map, `patientName` fallback to `patientInitials`, `aiFilledFields` tracking |
| `artifacts/labtrax-desktop/src/components/__tests__/DashboardDropZone.analyze.test.tsx` | JPEG → `imageBase64` POST; PDF → conversion path; successful response → `rxConfirm` state; 503 → error message; 500 → generic error |
| `e2e/ai-reader-mobile-scan.spec.ts` | Mobile gallery upload → AI stub → case form pre-fill (Playwright) |
| `e2e/mobile-photo-web-view.spec.ts` | API-seeded photo attachment → desktop page → no 401 (Playwright) |

#### Pre-existing tests that were already protecting the server endpoint

| Test file | What it guards |
|-----------|----------------|
| `artifacts/api-server/src/routes/analyze-prescription.test.ts` | 400 on missing image; 400 on truncated payload; 400 on HEIC; happy-path field extraction; model-chain fallback; 500 when all models fail |
| `artifacts/api-server/src/routes/cases-ai-reader.test.ts` | 503 "AI not configured" branch |
| `artifacts/labtrax/lib/scan/ai-doctor-assignment.test.ts` | `decideAiDoctorAssignment` — exact / similar / new outcomes; `nextCaseNumber`; `buildPatientInitials`; `buildToothDiagram`; `mergeDuplicateMatches` |
| `artifacts/labtrax/lib/scan/duplicate-merge.test.ts` | `mergeDuplicateMatches`; `localCaseToHit`; `defaultSelectedDuplicateId` |
| `artifacts/labtrax/lib/scan/provider-match.test.ts` | `normalizeProviderName`; `pickProviderMatch` (exact/similar/none); `scoreProviderMatch` |
| `artifacts/labtrax/lib/scan/page-edits.test.ts` | `makePageEdit`; `rotateBy90`; `reorderArray`; `pageNeedsBake`; `clampNormalizedPoint`; `colorMatrixForFilter` |

### Invariants that must not break

1. **`shouldAutoAnalyze`** returns `true` only when `cancelled === false && alreadyFired === false`. It fires at most once per review-phase entry.
2. **`decideManualEntry`** fires manual entry exactly once per nonce; resets to camera when not on the form phase; noops when already on the form.
3. **`resolveCloseAction`** — review phase always discards; camera phase uses `router.back` if possible, else replaces to `/(tabs)`.
4. **`pickRawCaptureUri`** — prefers camera URI, falls back to web canvas, then image picker; returns `ok: false` when all absent.
5. **`mapRxResponseToFormFields`** — null/missing fields produce `""` (not `"null"`, not `undefined`); `isRush` is always boolean; `toothIndices` is parsed to a sorted `selectedTeeth` array of valid integers 1–32; `dueDate` in `MM/DD/YYYY` is normalised to `YYYY-MM-DD`; `caseType` is mapped via `AI_CASE_TYPE_MAP`; `patientName` falls back to `patientInitials`.
6. **DashboardDropZone** — JPEG drops send `imageBase64` (not raw bytes) to `/api/analyze-prescription`; PDF drops go through the PDF-to-image conversion; a `success:false` API response never shows the `rxConfirm` panel.
7. **Server endpoint** — `POST /api/analyze-prescription` validates image presence and minimum size; the model-chain falls through legacy models to a current-gen model; returns 503 when `AI_INTEGRATIONS_OPENAI_API_KEY` is absent.

### Source change

`artifacts/labtrax/app/(tabs)/scan.tsx` — added import for `mapRxResponseToFormFields` from the new `@/lib/scan/rx-to-form` module. The inline AI-response→form mapping now delegates to that pure function so the mapping logic has a single testable home.
