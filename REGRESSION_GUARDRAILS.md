# Regression Guardrails

When the user confirms that a feature or workflow is working, that behavior becomes protected and must not regress. No code change — feature addition, refactor, AI Reader improvement, invoice change, sync change, or any other modification — may be merged or published unless every protected workflow listed here still passes end-to-end. Unit tests that pass while the real app workflow fails do not constitute success.

---

## Protected Workflow: AI Reader

The AI Reader is the Scan-tab flow where a lab technician photographs or attaches an Rx PDF and the app uses OpenAI to extract patient name, doctor name, case type, shade, and other fields, then pre-fills the new-case form.

Protected sub-behaviors:

- **Exact provider match auto-assign** — when the AI-extracted doctor last name exactly matches a provider on file, the form is silently pre-filled with the on-file spelling (not the raw AI string).
- **Similar provider prompt** — when the extracted name is close but not identical (edit distance ≤ 1 on the last name), the app prompts "Similar Provider Found" and shows both spellings before assigning. It must NOT silently auto-assign.
- **All extracted fields propagate** — patient name, case type, and shade all arrive on the new-case form after the AI flow completes. A break in the AI-response → setState wiring must surface as a test failure.
- **Duplicate patient warning** — when the selected patient already has an open case at the same practice, the app shows a "Possible duplicate / remake?" prompt before submission.
- **503 when AI is not configured** — `POST /api/analyze-prescription` returns `{ success: false }` with HTTP 503 when `AI_INTEGRATIONS_OPENAI_API_KEY` is absent.
- **400 for bad input** — truncated payloads return `IMAGE_TOO_SMALL`; HEIC images return an explicit HEIC error; missing image body returns 400.
- **Model chain resilience** — if the lead model fails, the endpoint falls through the chain; if every model fails, it returns 500. The current-gen model must never send `temperature` (gpt-5+ rejects it). Nullable fields must use `anyOf` in the JSON schema, not the array-union shorthand.
- **iTero import creates case with AI review flag** — `POST /api/cases/import-from-itero-rx` creates a case with `needsAiReview: true` and `aiImportSource: 'itero'` even when AI is not configured (stub path). Non-members get 403; missing `labOrganizationId` gets 400.
- **iTero dedup is idempotent** — a duplicate `iteroOrderId` for the same lab returns the existing case, not a second row.
- **AI review acknowledgement** — `PATCH /api/cases/:id/ai-review` clears `needsAiReview`; non-members get 403; already-reviewed cases are idempotent.

---

## Protected Workflow: Mobile/Web/Desktop Sync

Cases, invoices, and case events created or updated in any client (mobile, desktop, or web) must appear consistently across all clients without requiring a manual refresh that the user would not normally perform.

Protected sub-behaviors:

- **Case list reflects server state** — the mobile Cases screen renders case numbers and statuses sourced from the server-synced local state.
- **Case detail reflects server state** — the case detail screen renders the correct case header (case number, patient name), activity log entries, and invoice badge.
- **Edit saves propagate** — editing a case field (e.g. material) calls both `updateCase` and `updateInvoice` with the recomputed caseType so the invoice line item stays in sync with the case.
- **Add-item propagates to invoice** — adding an appliance item calls `addCaseItem` and `updateInvoice` with the correct line item (item name, rate, amount) derived from the practice's pricing tier.
- **AI-imported banner renders** — when `needsAiReview: true` and `aiImportSource: 'itero'` arrive from the full case hydration fetch, the amber "AI-imported — needs review" banner is visible in the case detail screen.

---

## Protected Workflow: Invoice

Invoices are created automatically when a case is created, and can be updated through status transitions and line-item edits. The financial integrity of these records must not regress.

Protected sub-behaviors:

- **Auto-invoice on case creation** — every new case triggers creation of an `open` invoice scoped to the correct `labOrganizationId` and `providerOrganizationId`, within 2 seconds of the case being created.
- **Create invoice via API** — `POST /api/invoices` returns 201 with the new draft invoice for a lab member; returns 403 for non-members; returns 400 when required fields are missing; returns 401 when unauthenticated.
- **Status transitions** — `PATCH /api/invoices/:id` with `{ status: "open" }` moves a draft to open; `{ status: "paid" }` marks it paid.
- **Line-item storage and subtotal** — patching an invoice with an `items` array stores the line items and returns the correct subtotal (`Σ quantity × unitPrice`).
- **List scoping** — `GET /api/invoices?labOrganizationId=...` returns invoices only for labs the caller is a member of; a non-member for that lab gets 200 with an empty list, never another lab's data.

---

## Protected Workflow: Mobile Case Interactions

Core case interactions on the mobile app — creating cases, viewing case details, and locating cases from the list — must remain functional.

Protected sub-behaviors:

- **Cases screen renders** — the Cases tab renders without throwing, shows the "Cases" header, and displays case numbers from state (e.g. `#5001`, `#5002`).
- **Case detail renders** — the case detail screen renders the case header (case number, patient name) and activity log entries without throwing. An unknown case ID shows "Case not found".
- **Completed-case detail renders** — a completed case with an attached paid invoice renders without throwing.
- **Long-press locate** _(tests pending restoration)_ — long-pressing a case on the list triggers the locate/highlight workflow. This behavior is protected and must be covered by a regression test once the companion restore task is complete.
- **Case Detail Notes Rendering** — the case detail screen must render without crashing regardless of the shape of the `notes` field returned by the API. Protected sub-behaviors:
  - Case detail renders when `notes` is `undefined`.
  - Case detail renders when `notes` is `null`.
  - Case detail renders when `notes` is an array.
  - Case detail renders when `notes` is an object.
  - Non-string `notes` values must never crash the screen.
  - Notes normalization (`normalizeNotes`) must remain applied at all case-detail ingestion, render, and edit boundaries — canonical mapper, Rx Summary `.trim()` check, both notes render sites, the notes-card empty check, edit/quick-edit initializers, and the quick-edit price-comparison snapshot.

---

## Protected Workflow: E2E Browser Tests

Playwright end-to-end specs that exercise live app flows in a real browser. They complement unit and API tests but do **not** replace real-device TestFlight verification — native rendering, OS-level permissions, camera access, biometric lock, and push notifications can only be confirmed on a real device.

Protected sub-behaviors:

- **AI Reader scan flow** — the Scan tab is reachable, the upload/gallery path triggers a stubbed `POST /api/analyze-prescription`, and extracted fields (patient name, doctor name, shade) appear in the UI after analysis.
- **Mobile photo web view** — a photo attachment seeded via the API is accessible (no 401/403) from the case attachment endpoint; the desktop case page renders without crashing and no attachment URL returns a 401.
- **Long-press locate case** — long-pressing (contextmenu) a case card triggers the "Locate Case" dialog or browser alert, and accepting it opens the station-picker modal ("Select a station:").

---

## Protected Workflow: Mobile Prescription Image Cross-Platform Visibility

A prescription photo captured on mobile (AI Reader camera flow) must be visible in the web and desktop case detail for the same Case ID. The image must be stored as a server-side attachment — not a device-local URI — so that any authenticated client can view it.

Protected sub-behaviors:

- **Camera photo uploaded to server** — after case creation via the AI Reader scan flow, each photo in `casePhotos` is uploaded to `/api/media/upload` and a `case_attachments` row is created via `POST /api/cases/:caseId/attachments`.
- **Attachment linked to Case ID** — the `case_attachments` row carries `labCaseId` referencing the mobile case's `lab_cases` row; the same `caseId` the mobile app generated is used as the lookup key.
- **Web/desktop Files tab shows the image** — `GET /api/cases/:caseId/attachments` returns the uploaded image attachment (with `fileType` starting with `image/`) for the same `caseId`.
- **Auth-gated serving** — the serving route (`GET /api/cases/:caseId/attachments/:attachmentId/file`) authorizes the download via `labCaseId` membership check and returns the file bytes; it does not return 401 or 403 for a valid lab member.
- **No regression on core workflow** — the AI Reader → case creation → invoice → case sync workflow must continue to pass after any change to the photo-upload path.

---

## Protected Workflow: Mobile Case Location Cross-Platform Sync

When a lab technician locates (moves) a case to a station on the mobile app — whether by tapping a single case or using the Batch Locate barcode scanner — that location change must appear immediately on the web and desktop clients without requiring any manual refresh.

Two bugs were fixed to make this work:
1. `batchLocateCases()` only saved the new status to AsyncStorage; it never called `syncCaseToServer()`, so batch location changes were silently lost. Single-case `updateCaseStatus()` already synced correctly.
2. The `GET /api/cases` list endpoint had a local `MOBILE_TO_DESKTOP_STATUS` map that was incomplete (missing SCAN, POST_MILL, SINTERING_FURNACE, MODEL_ROOM) and mapped COMPLETE to `"delivered"` instead of `"complete"`, causing the web list view to show the wrong location even when the mobile client had correctly synced the status to the server.

Protected sub-behaviors:

- **Single locate syncs to server** — moving a case to a station from the case detail screen or from the long-press "Locate Case" menu calls `syncCaseToServer()`, which POSTs the updated `caseData` blob (including the new `status`) to `POST /api/legacy/cases`. The server stores the new status in `lab_cases.caseData`.
- **Batch locate syncs to server** — using the Batch Locate barcode scanner on the dashboard calls `batchLocateCases()`, which now calls `syncCaseToServer()` for each case in the batch, mirroring the single-case path.
- **Offline fallback** — if the sync request fails (e.g. network offline), the case ID is enqueued via `enqueueStatus()` so the location change is retried when connectivity is restored.
- **Web/desktop list shows updated location** — `GET /api/cases` bridges the `lab_cases.caseData.status` field into the desktop status format using `MOBILE_TO_DESKTOP_STATUS`. All 13 mobile statuses (INTAKE, DESIGN, SCAN, MILLING, POST_MILL, SINTERING_FURNACE, MODEL_ROOM, PORCELAIN, QC_CHECK, COMPLETE, DELIVERY, ON_HOLD, REMAKE) must map correctly; an unknown status falls back to `"received"`.
- **Web/desktop detail shows updated location** — `GET /api/cases/:id` for a mobile-created case uses `tryProjectLegacyCaseForDesktop()` to project the `lab_cases` blob into the canonical shape; the `status` field in that response must match what the list returns.
- **List and detail agree** — the location shown in `GET /api/cases` (list) must be the same as what `GET /api/cases/:id` (detail) returns for the same case. The two endpoints must use the same `MOBILE_TO_DESKTOP_STATUS` mapping.
- **No regression on existing workflows** — AI Reader, invoice, image upload, and case creation must continue to pass after any change to the locate/sync path.

---

## Protected Workflow: Case Status Normalization Boundaries

Case status tokens arrive in the mobile app from sources that still emit legacy uppercase and desktop-bridge tokens (e.g. `DELIVERY`, `SHIP`, `ON_HOLD`, `QC_CHECK`). Every status must be coerced to the canonical lowercase `CaseStatus` at the moment it is ingested, so the mobile domain model stays canonical end-to-end. If normalization is skipped at any ingestion boundary, status drift silently breaks downstream features — most visibly the "shipped shows as Intake" bug.

Status drift caused by a missed normalization breaks:

- **Case lists** — cases sort/group/display under the wrong status.
- **Location/station views** — the station a case is shown at no longer matches its real status.
- **Invoice eligibility** — status-gated invoice logic misfires on raw tokens.
- **Shipped/delivered tracking** — completion and delivery tracking reads the wrong state.

`normalizeCaseStatus()` / `normalizeCaseStatuses()` (in `artifacts/labtrax/lib/data.ts`) are unit-tested for their token mappings, but a correct helper is useless if a refactor stops calling it at the boundaries. These behaviors are protected:

- **Desktop/server tokens normalize on fetch** — cases pulled from `/api/legacy/cases` via `fetchCasesFromServer()` are passed through `normalizeCaseStatuses()` before reaching UI/state. Legacy uppercase and desktop-bridge tokens become canonical lowercase.
- **AsyncStorage-hydrated tokens normalize on load** — cases hydrated from the local cache (`CASES_KEY`) in `loadData()` on mount are passed through `normalizeCaseStatuses()` before reaching UI/state.
- **Normalized status reaches the screen** — the canonical status must survive `mergeServerCases()` reconciliation and the `cases` selector and appear in the `cases` value a real consumer of `useApp()` sees. A raw uppercase token (e.g. `DELIVERY`, `SHIP`) must never reach `useApp().cases` via either the server-fetch or the AsyncStorage-hydration path. This protects against a regression where normalization runs but a later merge/dedup/selector bug re-introduces a raw token.
- **No regression on the helper itself** — the `normalizeCaseStatus()` token mappings (uppercase mobile tokens, desktop-bridge tokens, whitespace trimming, unknown-value fallback to `received`) must remain correct.

## Protected Workflow: Mobile Failed-Upload Retry

Failed mobile photo uploads must retry when connection returns and eventually become visible on web/desktop.

When a chunked photo/video upload exhausts its in-session retries, the file is parked in a persistent, user-scoped retry queue (`@drivesync_pending_uploads:<userId>`) instead of being lost. A background pass re-drives each parked entry through the existing upload + attachment-create path once the app returns to the foreground (connectivity-returned proxy) or on a slow interval, so the photo eventually lands on the server and is visible on web/desktop for the same Case ID.

Protected sub-behaviors:

- **Failed upload enters retry queue** — a photo/video upload that fails after in-session retries is enqueued (`enqueuePendingUpload`) with its `caseId` + device-local `fileUri`; the toast/badge reflects the pending state.
- **Persists across app restarts** — the queue is written to AsyncStorage and reloaded on sign-in, so a parked upload survives an app restart and is retried on the next pass.
- **User-scoped** — the queue is keyed per signed-in user; a shared device / account switch never inherits or exposes another user's parked uploads.
- **Retries only failed photo uploads** — only case media (photos/videos) is queued. Case creation, invoice generation, status/location sync, and AI Reader extraction are NOT routed through this queue.
- **No duplicate attachments** — a recovered upload is removed from the queue on success, so a subsequent background pass never re-uploads it or creates a second `case_attachments` row; entries are also de-duplicated on `(caseId, fileUri)` at enqueue time.
- **Clears on success + becomes visible** — on success the device-local uri is swapped for the canonical serving URL in the case's photos/activity log, the case is re-synced, and the queue entry is cleared, so the photo is visible on web/desktop.
- **Local-only warning** — while an upload is still parked (local-only), the user sees a clear warning that the photo will upload automatically when back online.
- **No regression on existing workflows** — AI Reader → case creation → invoice → case sync and location sync must continue to pass after any change to the retry path.

---

## Protected Workflow: Pending Upload Queue UI

The user must be able to *see and manage* photos/videos still waiting to upload. This is a visibility layer over the existing Mobile Failed-Upload Retry queue (above) — it reads the queue and drives the queue's own actions; it must never reimplement or redesign the queue itself.

`PendingSyncBanner` (mounted once at the authed root, `app/_layout.tsx`) reads `pendingSyncCount` / `stuckSyncItems` from app-context and drives the queue's `retrySync` / `discardSync`.

Protected sub-behaviors:

- **Badge/banner appears while uploads are pending** — when `pendingSyncCount > 0` the user sees a persistent banner stating attachments are still uploading and are not yet visible on web/desktop.
- **Hidden when the queue is empty** — when `pendingSyncCount` is 0 the banner (and its management sheet) render nothing.
- **Tap reveals the stuck items** — tapping the banner opens a sheet listing each entry from `stuckSyncItems`.
- **Per-item Retry now → `retrySync`** — each item exposes a "Retry now" action that calls `retrySync(item.id)` (kicks an immediate queue pass).
- **Per-item Discard → `discardSync`** — each item exposes a "Discard" action that calls `discardSync(item.id)` (drops the entry).
- **Indicator clears when the queue drains** — once everything uploads (`pendingSyncCount` returns to 0) the banner disappears on its own.
- **No queue redesign** — the banner must not change the retry/resume/persistence logic, case sync, AI Reader, case creation, invoice generation, or location sync.

---

## Protected Workflow: Pricing Tier Decimal Consistency

All price values displayed in the Pricing Tier editor — including the per-item `PriceField` inputs, the "Bulk edit prices" collapsible, and the save-confirmation dialog — must render with exactly two decimal places. This ensures that a price entered as `119` is always shown and committed as `119.00`, never `119` or `119.0`.

Protected sub-behaviors:

- **All pricing displays must render with two decimal places** — any price value surfaced to the user (in a field, in a preview row, or in a confirmation diff) must always carry exactly two decimal places. A raw integer like `119` must display as `119.00`; `99.5` must display as `99.50`.
- **Bulk percent preview shows two decimals** — after entering a percent adjustment and clicking Apply in the "Bulk edit prices" panel, each changed item shows a before→after row where both values carry exactly two decimal places.
- **Bulk paste preview shows two decimals** — after pasting `key = price` lines and clicking "Apply pasted prices", each accepted item shows a before→after row with two-decimal formatting.
- **Calculations are not altered by formatting** — the numeric result forwarded to `onApply` (and ultimately stored in the form) is the same `.toFixed(2)` value produced before the preview feature was added. The preview is display-only.
- **Preview hidden on error** — no before/after rows appear when the operation produces a validation error (missing percent, zero percent, no priced items, unparseable paste).
- **Preview cleared on panel collapse** — collapsing the "Bulk edit prices" panel clears any stale preview rows.

---

## Protected Workflow: Pricing Editor Two Decimal Display Protected

Every price input in the Pricing page (`PriceField` used by TierEditor and OverrideEditor, plus the "New unit price" field in BilledEditor) must display exactly two decimal places at all times when the field is not actively being edited. This is purely visual — stored values and calculations are unchanged.

Protected sub-behaviors:

- **`PriceField` shows two decimals when unfocused** — integer `119` renders as `119.00`; single-decimal `99.5` renders as `99.50`; already-formatted `119.00` stays `119.00`; blank stays blank.
- **`PriceField` shows the raw value while focused** — no mid-type reformatting disrupts the user while they type.
- **`PriceField` formats on blur** — when the field loses focus, `formatPriceTwoDecimals` is applied and `onChange` is called with the formatted result.
- **`PriceField` formats on Enter** — pressing Enter triggers the same formatting as blur.
- **`PriceField` is `type="text"` with `inputMode="decimal"`** — no browser number-spinners; native mobile decimal keyboards are hinted via `inputMode`.
- **BilledEditor "New unit price" input has the same two-decimal display guard** — the restoration bulk-pricing panel uses the identical focus/blur pattern.
- **Stored values are not altered** — bulk math, invoice math, and tier resolution are unaffected by display formatting.

---

## Zero-Regression Process

Every code change that touches a protected workflow must follow this process, in order:

1. **Identify impact** — before writing any code, identify which protected workflows (sections above) are affected by the change. If in doubt, assume all are affected.
2. **Add or update tests before changing code** — if the change will alter a protected behavior, update or add the regression tests first so that the tests fail against the current code. This proves the tests actually guard the behavior.
3. **Run the full protected suite after every change** — after the code change, run the complete test suite for every affected workflow (see Test Coverage Map below). All previously-passing tests must still pass.
4. **Stop immediately on any failure** — if any protected test fails, stop. Do not merge, publish, or claim the work is done. Fix the regression first.
5. **Never claim success from unit tests alone** — if the unit tests pass but the real app workflow fails (tested manually or via integration/E2E tests), the work is not done. The standard is: the protected workflow works as the user confirmed it.

### Pre-publish checklist

Before publishing a release, **all four gates** must pass:

| Gate | Command | Notes |
|------|---------|-------|
| Mobile unit tests | `pnpm --filter @workspace/labtrax run test` | All mobile unit / smoke tests green |
| API integration tests | `pnpm --filter @workspace/api-server run test` | All server-side integration tests green |
| Legacy-path fence | `pnpm --filter @workspace/scripts run lint-mobile-legacy-paths && pnpm --filter @workspace/scripts run test` | No new legacy paths; lint unit tests pass |
| E2E browser tests | `pnpm test:e2e` | All Playwright specs pass against the running stack |
| Real-device TestFlight | Manual | See below — no automated test replaces this |

**Real-device TestFlight verification (required before every production release):**

Install the TestFlight build on a physical iOS device and manually walk the following flow end-to-end:

1. **AI Reader → case creation** — photograph or attach an Rx; confirm AI extracts patient name, doctor name, and shade; confirm the new-case form is pre-filled correctly.
2. **Case sync** — create the case on mobile and verify it appears immediately in the desktop/web client without a manual refresh.
3. **Invoice** — open the auto-created invoice from the new case; add a line item; confirm the subtotal is correct; mark it paid.

This flow exercises native camera permissions, OS-level secure storage, biometric lock, and the full JWT refresh cycle — none of which can be replicated in a browser-based E2E test.

---

## Test Coverage Map

Each protected workflow is guarded by the following test files. Run them to verify the workflow has not regressed.

### AI Reader

| Layer | File | What it guards |
|-------|------|----------------|
| API integration | `artifacts/api-server/src/routes/analyze-prescription.test.ts` | Full endpoint behavior: bad input, model chain, name-order fix, schema correctness, 503 on missing key |
| API integration | `artifacts/api-server/src/routes/cases-ai-reader.test.ts` | Case creation auth, iTero import (stub path), dedup idempotency, AI review acknowledgement, auto-invoice |
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/scan.smoke.test.tsx` | Exact-match auto-assign, similar-provider prompt, duplicate-patient warning, AI-flow field propagation |

Run command:
```
pnpm --filter @workspace/api-server run test -- --reporter=verbose cases-ai-reader analyze-prescription
pnpm --filter @workspace/labtrax run test -- scan.smoke
```

### Mobile/Web/Desktop Sync

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/cases.smoke.test.tsx` | Cases list renders with server-synced state |
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/case-detail.smoke.test.tsx` | Case detail renders; edit-save propagation to invoice; add-item propagation; AI-imported banner |
| API integration | `artifacts/api-server/src/routes/mobile-sync-invoice.test.ts` | Same Case ID invariant (test h): client-generated ID preserved unchanged from mobile sync into GET /api/cases |

Run command:
```
pnpm --filter @workspace/labtrax run test -- cases.smoke case-detail.smoke
pnpm --filter @workspace/api-server run test -- --reporter=verbose mobile-sync-invoice
```

### Invoice

| Layer | File | What it guards |
|-------|------|----------------|
| API integration | `artifacts/api-server/src/routes/invoices.test.ts` | Create, status transitions, line items, subtotal, list scoping, auth enforcement |
| API integration | `artifacts/api-server/src/routes/cases-ai-reader.test.ts` | Auto-invoice generated on case creation (the `auto-generates an open invoice` test) |
| API integration | `artifacts/api-server/src/routes/cases-invoice-creation.test.ts` | Case creation → invoice caseId linkage; correct org IDs; invoice starts as "open" |

Run command:
```
pnpm --filter @workspace/api-server run test -- --reporter=verbose invoices cases-ai-reader cases-invoice-creation
```

### Mobile Case Interactions

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/cases.smoke.test.tsx` | Cases screen renders, case numbers visible, long-press locate alert + modal |
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/case-detail.smoke.test.tsx` | Case detail renders, empty state, completed case; non-string `notes` (undefined/null/array/object) never crashes the screen |
| API integration | `artifacts/api-server/src/routes/cases-core.test.ts` | Case lifecycle: create, read, list, patch status, cross-lab scoping, soft-delete |

Run command:
```
pnpm --filter @workspace/labtrax run test -- cases.smoke case-detail.smoke
pnpm --filter @workspace/api-server run test -- --reporter=verbose cases-core
```

### Mobile Prescription Image Cross-Platform Visibility

| Layer | File | What it guards |
|-------|------|----------------|
| API integration | `artifacts/api-server/src/routes/cases-attachments.test.ts` | Legacy mobile case photo upload creates attachment row with `labCaseId`; attachment surfaces via `GET /api/cases/:caseId/attachments` |
| API integration (E2E chain) | `artifacts/api-server/src/routes/cases-prescription-photo.test.ts` | Full chain: case creation → photo upload → DB integrity (labCaseId, fileType) → list endpoint (web/desktop Files tab) → file-serving auth (not 401/403) → invoice generation |
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/case-attach-failure.smoke.test.tsx` | The user-facing "Upload Failed" alert fires when `uploadAttachment` gets `{ ok: false }` across **all three** attach sources (Browse Files, Camera, Photo Library) and stays silent on success — so a failed photo upload can never silently vanish |

Run command:
```
pnpm --filter @workspace/api-server run test -- --reporter=verbose cases-attachments cases-prescription-photo
pnpm --filter @workspace/labtrax run test -- case-attach-failure.smoke
```

### Mobile Case Location Cross-Platform Sync

| Layer | File | What it guards |
|-------|------|----------------|
| API integration | `artifacts/api-server/src/routes/cases-location-sync.test.ts` | POST syncs status to lab_cases; GET /api/cases list maps all 13 mobile statuses correctly; batch locate (two cases); GET /api/cases/:id detail bridge; list+detail agree on COMPLETE→"complete"; auth guard |

Run command:
```
pnpm --filter @workspace/api-server run test -- --reporter=verbose cases-location-sync
```

### Case Status Normalization Boundaries

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/normalize-case-status.test.ts` | `normalizeCaseStatus()` / `normalizeCaseStatuses()` token mappings: canonical identity, legacy uppercase + desktop-bridge tokens, whitespace trimming, unknown-value fallback to `received` |
| Mobile unit | `artifacts/labtrax/lib/__tests__/case-status-normalization-boundaries.test.tsx` | Both real ingestion boundaries call `normalizeCaseStatuses()`: server fetch (`/api/legacy/cases` → `fetchCasesFromServer()`) and AsyncStorage hydration (`CASES_KEY` → `loadData()`). Plus end-to-end: a legacy token (`DELIVERY`/`SHIP`) ingested via either path surfaces as canonical lowercase (`shipped`) in `useApp().cases`, proving the normalized status survives merge/dedup and the `cases` selector |

Run command:
```
pnpm --filter @workspace/labtrax run test -- normalize-case-status case-status-normalization-boundaries
```

### Mobile Failed-Upload Retry

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/pending-uploads.test.ts` | Failed upload enters retry queue; retry resumes after app restart (persist + reload); successful retry removes item; duplicate retries do not re-upload / create duplicate attachments; queue scoped per user; vanished local file dropped |

Run command:
```
pnpm --filter @workspace/labtrax run test -- pending-uploads
```

### Pending Upload Queue UI

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/pending-sync-banner.smoke.test.tsx` | Badge appears when `pendingSyncCount > 0`; hidden when empty; tapping shows stuck items; "Retry now" calls `retrySync(id)`; "Discard" calls `discardSync(id)`; banner clears after the queue drains |

Run command:
```
pnpm --filter @workspace/labtrax run test -- pending-sync-banner
```

### E2E Browser Tests

| Layer | File | What it guards |
|-------|------|----------------|
| E2E (Playwright) | `e2e/ai-reader-mobile-scan.spec.ts` | Scan tab reachable; upload path calls `/api/analyze-prescription`; AI-extracted fields appear in UI |
| E2E (Playwright) | `e2e/mobile-photo-web-view.spec.ts` | Case attachment endpoint returns non-401/403; desktop case page renders; no attachment URL returns 401 |
| E2E (Playwright) | `e2e/long-press-locate-case.spec.ts` | Long-press (contextmenu) on a case card opens "Locate Case" dialog; accepting it opens the station-picker modal |

Run command:
```
pnpm test:e2e
```

Set `PLAYWRIGHT_BASE_URL` to the target deployment URL when running against staging or production (defaults to `http://localhost:80`).

> **Note:** E2E specs run against the Expo web build in a browser. They do **not** cover native rendering, OS permissions, camera, biometric lock, or push notifications — those require real-device TestFlight verification (see Pre-publish checklist above).

### Mobile Auth Hydration Guard

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/auth-hydration.test.ts` | Singleton hydration promise deduplication; `waitForHydration` queuing; `ensureHydrated` one-shot refresh; `getIsHydrated` flag accuracy |

Run command:
```
pnpm --filter @workspace/labtrax run test -- auth-hydration
```

### Mobile Rebuild Phase 1 — Auth Foundation

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile smoke | `artifacts/labtrax/app/__tests__/auth-hydration.smoke.ts` | Phase 1 acceptance criteria end-to-end: SecureStore hydration → protected request; `x-labtrax-client: mobile/2` on protected requests, refresh calls, and retried requests; mid-session 401 → transparent refresh + retry; in-memory token updated after refresh; second request uses rotated token |
| Mobile unit | `artifacts/labtrax/lib/__tests__/auth-hydration.test.ts` | `X-LabTrax-Client: mobile/2` header present on every API request; `Authorization: Bearer <token>` header present when token is available; mid-session 401 triggers transparent refresh + retry using new token; retry also carries `mobile/2` header; no retry when refresh token is absent (401 surface); in-memory token updated to refreshed value after mid-session refresh |

Run command:
```
pnpm --filter @workspace/labtrax run test -- auth-hydration
```

### Mobile Reconnecting Indicator

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/reconnecting-indicator.test.ts` | Listener fires `true` on refresh start and `false` on end (success and failure); listener fires exactly once for concurrent callers (deduplication); no listener call for requests that don't need a refresh; `createReconnectingTracker` suppresses indicator for fast refreshes (< 400ms); indicator appears after 400ms delay for slow refreshes; indicator clears immediately after success or failure; pending timer cancelled when refresh completes before threshold; `resilientFetch` hydration unaffected when listener is registered |

Run command:
```
pnpm --filter @workspace/labtrax run test -- reconnecting-indicator
```

### Pricing Tier Decimal Consistency

| Layer | File | What it guards |
|-------|------|----------------|
| Desktop unit | `artifacts/labtrax-desktop/src/pages/__tests__/bulk-price-tools.test.tsx` | Bulk percent preview shows two-decimal before/after rows; bulk paste preview shows two-decimal rows; whole-number inputs padded to `.00`; `onApply` receives numerically unchanged `.toFixed(2)` values; no preview on error; preview clears on panel collapse |
| Desktop unit | `artifacts/labtrax-desktop/src/lib/__tests__/pricing-keys.test.ts` | `formatPriceTwoDecimals` pads integers, single-cent values, passes through valid two-decimal inputs, returns empty for blank, leaves non-numeric unchanged; `applyPct` logic produces `.toFixed(2)` strings in `next` and preview rows; `applyPaste` logic produces `.toFixed(2)` strings in `next` and preview rows |

Run command:
```
pnpm --filter @workspace/labtrax-desktop exec vitest run src/pages/__tests__/bulk-price-tools.test.tsx src/lib/__tests__/pricing-keys.test.ts
```

### Pricing Editor Two Decimal Display Protected

| Layer | File | What it guards |
|-------|------|----------------|
| Desktop unit | `artifacts/labtrax-desktop/src/pages/__tests__/pricing-fields.test.tsx` | `PriceField` unfocused shows two decimals for integers and single-decimal values; focused shows raw value; blur fires `onChange` with formatted value; Enter fires `onChange` with formatted value; no mid-type reformatting; renders as `type="text"` with `inputMode="decimal"` |

Run command:
```
pnpm --filter @workspace/labtrax-desktop exec vitest run src/pages/__tests__/pricing-fields.test.tsx src/pages/__tests__/bulk-price-tools.test.tsx src/lib/__tests__/pricing-keys.test.ts
```

### Run the full protected suite at once

```bash
pnpm --filter @workspace/api-server run test -- cases-ai-reader analyze-prescription invoices cases-core cases-invoice-creation mobile-sync-invoice cases-attachments cases-prescription-photo cases-location-sync cases-canonical-mobile
pnpm --filter @workspace/labtrax run test -- cases.smoke case-detail.smoke scan.smoke normalize-case-status case-status-normalization-boundaries auth-hydration reconnecting-indicator pending-uploads pending-sync-banner
pnpm --filter @workspace/scripts run lint-mobile-legacy-paths
pnpm --filter @workspace/scripts run test
pnpm test:e2e
```

---

## Protected Workflow: Mobile Rebuild Phase 1 — Auth Foundation Stable

The canonical mobile rebuild depends on JWT bearer auth being fully stable before any screen-level rebuilds begin. These behaviors must remain correct end-to-end through any future change to the auth layer, token store, or networking stack.

Protected sub-behaviors:

- **SecureStore hydration on app start** — `loadTokens()` reads `@labtrax_tokens` from `SecureStore` on first call and populates `_accessToken` / `_refreshToken` in memory. `getIsHydrated()` returns `true` only after the read completes. Concurrent callers at startup all await the same singleton promise (one SecureStore read, not N).
- **`X-LabTrax-Client: mobile/2` on every request** — `injectAuthHeaders` unconditionally adds the `x-labtrax-client: mobile/2` header on the native (non-web) path. No API request may leave the device without this identifier, including retried requests after a 401.
- **`Authorization: Bearer <token>` when token is available** — `injectAuthHeaders` attaches `Authorization: Bearer <accessToken>` when `_accessToken` is non-null. A request issued after a successful hydration must carry this header.
- **Mid-session 401 → transparent refresh → retry** — when a protected request returns 401 and `_refreshToken` is available, `resilientFetch` calls `refreshAccessToken()`, updates the in-memory token, and retries the original request with the new token. The caller receives the successful response transparently. The in-memory `_accessToken` is updated to the refreshed value.
- **Retry carries `mobile/2` header** — the retried request (after a mid-session 401 + refresh) must also carry `x-labtrax-client: mobile/2`.
- **No retry when refresh token is absent** — if `_refreshToken` is falsy, `resilientFetch` does not attempt a refresh; the 401 response is returned as-is.
- **Startup refresh when access token is missing** — if `loadTokens()` finds no access token but a refresh token is present, `ensureHydrated()` proactively calls `refreshAccessToken()` so the first protected request goes out with a valid bearer token rather than failing immediately.

---

## Protected Workflow: Mobile Legacy-Path Fence

The mobile app must not introduce new direct calls to the legacy case endpoints
(`/api/legacy/cases`, `lab_cases` table references, `pendingSyncCount`,
`stuckSyncItems`, `unionActivityLog`) outside the grandfathered files that
pre-date the canonical rebuild. This is enforced by a compile-time lint script
that fails the build if any violation is found.

Protected sub-behaviors:

- **Fence blocks `/api/legacy/cases`** — any non-comment, non-allowed-line
  reference to `/api/legacy/cases` in `artifacts/labtrax/app/`,
  `artifacts/labtrax/lib/`, `artifacts/labtrax/components/`, or
  `artifacts/labtrax/hooks/` causes `lint-mobile-legacy-paths` to exit 1.
- **Fence blocks `lab_cases`** — direct table-name references are forbidden
  in new mobile code; data access goes through `/api/cases`.
- **Fence blocks legacy sync fields** — `pendingSyncCount` and `stuckSyncItems`
  must not be imported or referenced outside their grandfathered files.
- **Fence blocks `unionActivityLog`** — the legacy server-side union helper
  must not be called from new mobile code paths.
- **Grandfathered files exempt via file-level marker** —
  `artifacts/labtrax/lib/app-context.tsx` and
  `artifacts/labtrax/components/PendingSyncBanner.tsx` carry a
  `// legacy-mobile-fence:disable-file` marker and are entirely exempt.
- **Per-line escape hatch** — any single line that must be individually
  exempted may end with `// legacy-fence:allow` with a comment explaining
  why it cannot be migrated now. There are currently **zero** active
  per-line exemptions in the mobile codebase.
- **Fence passes clean today** — running `pnpm --filter @workspace/scripts
  run lint-mobile-legacy-paths` exits 0 with no violations.
- **Build-output folders are excluded by design** — `walkTs` skips `build`,
  `dist`, and `server_dist`. These hold compiled bundles, not source; the fence
  guards source so any reintroduced legacy path is caught where the bundle is
  produced. A *committed* bundle could hide stale legacy code from the scan, so
  these folders are gitignored (`artifacts/labtrax/.gitignore`) and must never
  be the canonical build in source control. The previously-committed
  `artifacts/labtrax/server_dist/index.js` (a stale Express bundle that still
  referenced `/api/legacy/cases` and `lab_cases`) has been removed — it was not
  a production artifact (production serving is `build` → `static-build/` +
  `serve` → `server/serve.js`) and is now gitignored.

| Layer | File | What it guards |
|-------|------|----------------|
| Lint script | `scripts/src/lint-mobile-legacy-paths.ts` | Exits non-zero if any new mobile code references `/api/legacy/cases`, `lab_cases`, `pendingSyncCount`, `stuckSyncItems`, or `unionActivityLog` |
| Script unit | `scripts/src/__tests__/lint-mobile-legacy-paths.test.ts` | Each forbidden pattern triggers a violation; `// legacy-fence:allow` and `legacy-mobile-fence:disable-file` suppress correctly; clean code passes; line numbers are accurate |
| API integration | `artifacts/api-server/src/routes/cases-canonical-mobile.test.ts` | Canonical case UUID round-trip, invoice not duplicated, status PATCH visible in GET, event history available, cross-client list/detail identity |

Run command:
```bash
pnpm --filter @workspace/scripts run lint-mobile-legacy-paths
pnpm --filter @workspace/scripts run test
pnpm --filter @workspace/api-server run test -- cases-canonical-mobile
```

---

## TestFlight Smoke Test Checklist (Mobile Rebuild — Phase 0+)

When submitting a build for TestFlight acceptance after any mobile change, the
following real-device smoke tests must pass before the build is approved. These
supplement the automated regression suite; they cannot be replaced by unit tests.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Log in on a fresh install | Auth succeeds; home screen loads with case list |
| 2 | Create a new case via the + button | Case appears immediately in the list; case UUID visible in case detail header |
| 3 | Open the same case on web or desktop | Identical case UUID, case number, and patient name visible |
| 4 | Open the Invoices tab | Invoice for the new case shown exactly once; no duplicates |
| 5 | Change case status (e.g. Received → In Design) | Status change visible immediately on mobile and on web/desktop without manual refresh |
| 6 | Open Scan tab, photograph an Rx | AI extracts patient/doctor/case type; tapping Create opens pre-filled new-case form |
| 7 | Upload a photo on the case detail screen | Photo appears on the web/desktop case detail without re-upload; no spinner stuck state |
| 8 | Lock screen via biometric | Lock screen appears after inactivity; Face ID / Touch ID unlocks without re-login |
| 9 | Share a PDF into LabTrax from Files app | Share intent received; PDF attached to a new or existing case |
| 10 | Force-quit and reopen the app | Session is restored; no login required; pending upload queue (if non-empty) auto-retries |

**Zero-regression rule:** If any row above breaks in a new build, the build is
rejected from TestFlight promotion and a regression issue is filed against the
offending change before any new feature work continues.

---

## How to Add a Protected Workflow

A workflow becomes protected when the user explicitly confirms it is working and should not regress. The lifecycle is:

1. **User confirms the workflow works** — the user tests the feature end-to-end and says it is working correctly.
2. **Document it here** — add a new `## Protected Workflow: <Name>` section to this file listing the specific sub-behaviors the user confirmed. Be concrete: describe what the user sees and does, not just what the code does.
3. **Map it in the Test Coverage Map** — add a row to the Test Coverage Map table with the layer (API integration, mobile unit, E2E), the test file, and a one-line description of what it guards. If no test yet guards the behavior, note it as `_(pending)_` and create the test before the section is considered fully protected.
4. **The workflow is now protected** — from this point forward, every code change that touches this workflow must follow the Zero-Regression Process above.

When in doubt about whether a behavior is protected, treat it as protected.
