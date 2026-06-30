# iTero Lab-Review Auto-Import

LabTrax Desktop can auto-create cases from the iTero "Lab Review" queue.

1. Admin saves shared iTero credentials in Settings → iTero auto-import. Encrypted via Electron `safeStorage`, stored at `userData/itero-creds.bin`.
2. Admin picks destination Lab + Provider org and enables polling (default 5 min; range 5–240).
3. Poller (`electron/itero-poller.cjs`): hidden BrowserWindow logs into `us-labs.bff.cloud.myitero.com`, fetches Lab-Review orders, downloads each Rx, POSTs to `POST /api/cases/import-from-itero-rx`.
4. API extracts patient/doctor/restorations via OpenAI, creates an Active case, sets `needsAiReview=true` + `aiImportSource='itero'`, and records the iTero order ID in `itero_imported_orders` (unique on `lab_organization_id + itero_order_id`) for idempotency.
5. Desktop shows a Sparkles badge; case drawer shows an amber review banner. Mobile `case/[id].tsx` shows a matching banner.

Portal selectors may need tweaking per tenant — failures surface as `lastError` in the Settings panel. De-dup is server-side, so wiping the local ledger (`userData/itero-seen.json`) won't create duplicates.

## Duplicate-doctor auto-merge

The manual create-case flow rejects a near-duplicate doctor name with a `409 DOCTOR_CONFIRMATION_REQUIRED` so a human can confirm. Auto-import has no human typing a name at create time, so instead of rejecting, all three iTero create paths (`POST /api/cases/import-from-itero-rx`, `POST /api/cases/import-from-itero-zip`, and the desktop poller helper `processOneIteroZipFile`) **auto-merge**: when the AI-parsed doctor name is a near-duplicate (`>=` the lab's `duplicateSuggestionThreshold`, default 0.7) of an existing doctor in the **same practice**, the case adopts the existing spelling rather than silently creating a new doctor.

- Implemented via the shared helper `resolveIteroDoctorAutoMerge()`, which reuses `findSimilarDoctorsInPractice` from `doctor-similarity.ts` (same matcher/threshold as the 409 flow). It never rewrites a literal-exact name and leaves the `"Unknown Doctor"` placeholder untouched.
- The merged name is threaded into pricing resolution and the case insert. A `doctor_auto_merged_from_itero` case event records `parsedDoctorName`, `mergedToDoctorName`, and `similarity` so reviewers can see (and undo) the merge.
- Below threshold the parsed name is kept verbatim and surfaced for review via the existing medium-confidence `suggestedDoctorName` banner (threshold 0.4), unchanged.
