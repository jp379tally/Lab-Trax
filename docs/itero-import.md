# iTero Lab-Review Auto-Import

LabTrax Desktop can auto-create cases from the iTero "Lab Review" queue.

1. Admin saves shared iTero credentials in Settings → iTero auto-import. Encrypted via Electron `safeStorage`, stored at `userData/itero-creds.bin`.
2. Admin picks destination Lab + Provider org and enables polling (default 5 min; range 5–240).
3. Poller (`electron/itero-poller.cjs`): hidden BrowserWindow logs into `us-labs.bff.cloud.myitero.com`, fetches Lab-Review orders, downloads each Rx, POSTs to `POST /api/cases/import-from-itero-rx`.
4. API extracts patient/doctor/restorations via OpenAI, creates an Active case, sets `needsAiReview=true` + `aiImportSource='itero'`, and records the iTero order ID in `itero_imported_orders` (unique on `lab_organization_id + itero_order_id`) for idempotency.
5. Desktop shows a Sparkles badge; case drawer shows an amber review banner. Mobile `case/[id].tsx` shows a matching banner.

Portal selectors may need tweaking per tenant — failures surface as `lastError` in the Settings panel. De-dup is server-side, so wiping the local ledger (`userData/itero-seen.json`) won't create duplicates.
