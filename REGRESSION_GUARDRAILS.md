# Regression Guardrails

When the user confirms that a feature or workflow is working, that behavior becomes protected and must not regress. No code change — feature addition, refactor, AI Reader improvement, invoice change, sync change, or any other modification — may be merged or published unless every protected workflow listed here still passes end-to-end. Unit tests that pass while the real app workflow fails do not constitute success.

---

## Retired pending Phase 2 rebuild (user-approved 2026-06-11)

The mobile app (`artifacts/labtrax`) was reset to a **read-only, desktop-derived case viewer** in Phase 1 of the approved mobile rebuild. The old local-first UI/state layer (offline queue, AsyncStorage case cache, `app-context.tsx`, drawer/messenger contexts) and every create/edit/scan/upload/messaging surface were removed. The native shell (bundle id, EAS/TestFlight config, `app.json` plugins), auth, biometric lock, and theming were kept.

The workflows below were **mobile-only** and depended on those removed features. They are **no longer protected** because the code and their guarding tests were deleted in the reset. They will be re-protected — with fresh tests — when Phase 2 rebuilds the corresponding create/edit/scan/upload features. Do **not** treat their absence as a regression.

| Retired workflow | Why retired | Guarding test (removed) |
|------------------|-------------|--------------------------|
| Mobile AI Reader / Scan tab (form prefill, exact-match provider auto-assign, similar-provider prompt, duplicate-patient warning) | Scan tab removed in Phase 1 | `lib/__tests__/screens/scan.smoke.test.tsx` |
| Mobile AI Reader Unknown-Provider creation parity | Scan/create flow removed | `lib/__tests__/screens/scan.smoke.test.tsx` |
| Mobile case create + edit propagation (new-case form, edit-save → invoice, add-item → invoice) | Viewer is read-only | edit/add-item portions of the old `case-detail` suite |
| Mobile photo/media upload + "Upload Failed" alert | Upload UI removed | `lib/__tests__/screens/case-attach-failure.smoke.test.tsx` |
| Mobile Failed-Upload Retry queue | Offline upload queue removed | `lib/__tests__/pending-uploads.test.ts` |
| Pending Upload Queue banner UI | `PendingSyncBanner` + queue removed | `lib/__tests__/screens/pending-sync-banner.smoke.test.tsx` |
| Mobile status-normalization **ingestion boundaries** (server fetch + AsyncStorage hydration through `app-context`) | `app-context`/local cache removed; viewer reads canonical `/api/cases` directly | `lib/__tests__/case-status-normalization-boundaries.test.tsx` |
| Mobile single/batch **locate** UI (station picker, barcode batch locate) | Locate UI removed | covered previously via screen smoke + E2E |
| E2E Playwright mobile specs (AI Reader scan, long-press locate) | Underlying mobile flows removed | `e2e/ai-reader-mobile-scan.spec.ts`, `e2e/long-press-locate-case.spec.ts` |

> **AI Reader is a later-phase deliverable, not Phase 2.** Phase 2 covers mobile **Case Detail desktop parity** only. The mobile AI Reader / Scan flow — and its `mapRxResponseToFormFields` form-prefill mapping — returns in a dedicated AI Reader phase *after* Phase 2, not as part of Case Detail. The orphaned end-to-end chain test that imported the deleted mobile scan lib (`ai-reader-chain.test.ts`) has been **parked** to `artifacts/api-server/test-plans/phase3-ai-reader/` — outside the vitest (`src/**/*.test.ts`) and tsc (`src`) globs, so it neither runs nor typechecks — and will be revived when AI Reader is rebuilt. Its server-side links remain protected today by `analyze-prescription.test.ts` and `cases-ai-reader.test.ts` (see the AI Reader Test Coverage Map). The AI Reader **server endpoints** stay protected for the final product; **do not** reintroduce the deleted mobile scan module just to satisfy the parked test.

**Still protected (not retired):** all server/API workflows below (AI Reader endpoints, Invoice, case lifecycle, attachment serving, location-sync server bridge, Same-Case-ID invariant), the canonical read-only mobile viewer (list + search + read-only detail), the `normalizeCaseStatus()` helper, mobile auth/hydration + reconnecting indicator, the share-intent native firewall test, the desktop Pricing workflows, and the Mobile Legacy-Path Fence.

---

## Protected Workflow: AI Reader (server + desktop)

The AI Reader uses OpenAI to extract patient name, doctor name, case type, shade, and other fields from an Rx image/PDF and pre-fills a new-case form. The **mobile Scan-tab entry point is retired** (see above); the **server endpoints and the desktop/web `DashboardDropZone` flow remain protected**.

Protected sub-behaviors:

- **503 when AI is not configured** — `POST /api/analyze-prescription` returns `{ success: false }` with HTTP 503 when `AI_INTEGRATIONS_OPENAI_API_KEY` is absent.
- **400 for bad input** — truncated payloads return `IMAGE_TOO_SMALL`; HEIC images return an explicit HEIC error; missing image body returns 400.
- **Model chain resilience** — if the lead model fails, the endpoint falls through the chain; if every model fails, it returns 500. The current-gen model must never send `temperature` (gpt-5+ rejects it). Nullable fields must use `anyOf` in the JSON schema, not the array-union shorthand.
- **iTero import creates case with AI review flag** — `POST /api/cases/import-from-itero-rx` creates a case with `needsAiReview: true` and `aiImportSource: 'itero'` even when AI is not configured (stub path). Non-members get 403; missing `labOrganizationId` gets 400.
- **iTero dedup is idempotent** — a duplicate `iteroOrderId` for the same lab returns the existing case, not a second row.
- **AI review acknowledgement** — `PATCH /api/cases/:id/ai-review` clears `needsAiReview`; non-members get 403; already-reviewed cases are idempotent.

---

## Protected Workflow: Mobile/Web/Desktop Sync

Cases and invoices created or updated in any client (mobile, desktop, or web) must appear consistently across all clients. With the mobile app now a read-only viewer, the protected mobile guarantee is that it **renders server state faithfully**; write-side propagation (edit-save, add-item) is retired pending Phase 2 (see above).

Protected sub-behaviors:

- **Case list reflects server state** — the mobile Cases screen renders case numbers, patient names, and statuses sourced from the canonical `GET /api/cases` payload.
- **Case detail reflects server state** — the mobile case detail screen renders the correct case header (case number, patient name), the read-only sections (overview, restorations, notes, files, invoice, history), and the activity log, all from the canonical `GET /api/cases/:id` payload.
- **Same Case ID invariant (server)** — a client-generated case ID is preserved unchanged from sync into `GET /api/cases`, so the same case resolves identically across clients.

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

## Protected Workflow: Mobile Case Viewer (Read-Only)

Core read-only case interactions on the mobile app — viewing the canonical case list, searching it, and opening a read-only case detail — must remain functional. (Create/edit/locate are retired pending Phase 2.)

Protected sub-behaviors:

- **Cases screen renders** — the Cases tab renders without throwing, shows the "Cases" header and case count, and displays case numbers and patient names from the canonical list (e.g. `#5001`, `#5002`).
- **In-memory search** — typing in the search box filters the list by patient name, doctor name, or case number; a non-matching query shows a no-results empty state.
- **Row navigation** — pressing a case row navigates to `/case/:id`.
- **Case detail renders (read-only)** — the case detail screen renders the case header and the section tabs (overview, restorations, notes, files, invoice, history) without throwing. An unknown case ID shows the "Unable to load this case" empty state.
- **Completed-case detail renders** — a completed case with an attached paid invoice renders without throwing, and the invoice section shows the invoice number.
- **Case Detail Notes Rendering** — the case detail screen must render without crashing regardless of the shape of the `notes` field returned by the API (undefined, null, array, or object). Non-string `notes` values must never crash the screen.

---

## Protected Workflow: Prescription / Case Media Cross-Platform Serving (server)

Case media stored as a server-side attachment must be retrievable by any authenticated client for the same Case ID, scoped to lab membership. (The mobile **camera-upload UI** is retired pending Phase 2; the **server attachment + serving behavior** remains protected.)

Protected sub-behaviors:

- **Attachment linked to Case ID** — a `case_attachments` row carries `labCaseId` referencing the case row; the same `caseId` is used as the lookup key.
- **Web/desktop/mobile Files tab shows the image** — `GET /api/cases/:caseId/attachments` returns the image attachment (with `fileType` starting with `image/`) for the same `caseId`.
- **Auth-gated serving** — the serving route (`GET /api/cases/:caseId/attachments/:attachmentId/file`) authorizes the download via `labCaseId` membership check and returns the file bytes; it does not return 401 or 403 for a valid lab member, and must not become publicly retrievable by guessing a filename.

---

## Protected Workflow: Case Location Cross-Platform Sync (server bridge)

The canonical `/api/cases` endpoints must present a consistent, correct location/status for a case across all clients. (The mobile **locate UI** — single and batch barcode — is retired pending Phase 2; the **server status bridge** that the read-only viewer depends on remains protected.)

Protected sub-behaviors:

- **List bridges legacy statuses correctly** — `GET /api/cases` bridges the `lab_cases.caseData.status` field into the desktop status format using `MOBILE_TO_DESKTOP_STATUS`. All 13 mobile statuses (INTAKE, DESIGN, SCAN, MILLING, POST_MILL, SINTERING_FURNACE, MODEL_ROOM, PORCELAIN, QC_CHECK, COMPLETE, DELIVERY, ON_HOLD, REMAKE) must map correctly; an unknown status falls back to `"received"`. `COMPLETE` maps to `"complete"`, not `"delivered"`.
- **Detail bridge agrees with list** — `GET /api/cases/:id` for a mobile-created case uses `tryProjectLegacyCaseForDesktop()` to project the `lab_cases` blob into the canonical shape; the `status` field in that response must match what the list returns for the same case.
- **Auth guard** — both endpoints require an authenticated lab member and never leak another lab's cases.

---

## Protected Workflow: Case Status Normalization Helper

Case status tokens still arrive from sources that emit legacy uppercase and desktop-bridge tokens (e.g. `DELIVERY`, `SHIP`, `ON_HOLD`, `QC_CHECK`). The canonical normalization **helper** must remain correct so any consumer that needs to coerce a token gets canonical lowercase. (The mobile **ingestion-boundary** integration — normalizing inside the old `app-context` fetch/hydration paths — is retired with `app-context`; see the retired section.)

Protected sub-behaviors:

- **Helper token mappings are correct** — `normalizeCaseStatus()` / `normalizeCaseStatuses()` (in `artifacts/labtrax/lib/data.ts`) map canonical identity, legacy uppercase mobile tokens, desktop-bridge tokens, whitespace trimming, and unknown-value fallback to `received`.

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

Before publishing a release, the applicable gates must pass:

| Gate | Command | Notes |
|------|---------|-------|
| Mobile unit tests | `pnpm --filter @workspace/labtrax run test` | All mobile unit / smoke tests green (read-only viewer scope) |
| API integration tests | `pnpm --filter @workspace/api-server run test` | All server-side integration tests green |
| Legacy-path fence | `pnpm --filter @workspace/scripts run lint-mobile-legacy-paths && pnpm --filter @workspace/scripts run test` | No new legacy paths; lint unit tests pass |
| Real-device TestFlight | Manual | See below — no automated test replaces this |

> **E2E browser specs:** the Playwright mobile specs (`ai-reader-mobile-scan`, `long-press-locate-case`) are **retired pending Phase 2** because the underlying mobile flows were removed in the Phase 1 reset. Re-add an E2E gate when Phase 2 restores scan/create/locate.

**Real-device TestFlight verification (Phase 1 read-only viewer):**

Install the TestFlight build on a physical iOS device and manually walk this flow end-to-end:

1. **Login** — log in on a fresh install; the Cases list loads from the server.
2. **Search** — search by patient, doctor, or case number; the list filters correctly.
3. **Open a case (read-only)** — open a case and confirm the header and read-only sections (overview, restorations, notes, files, invoice, history) render correctly and match desktop/web for the same case.
4. **Biometric lock** — the lock screen appears after inactivity; Face ID / Touch ID unlocks without re-login.
5. **Share intent** — sharing a PDF into LabTrax from the Files app is still routed by the share-intent plugin (native firewall).

> The full **create case → scan → upload → invoice** real-device flow returns to this checklist when Phase 2 rebuilds those features.

This flow exercises native secure storage, biometric lock, the JWT refresh cycle, and the share-sheet plugin — none of which can be replicated in a browser-based E2E test.

---

## Test Coverage Map

Each protected workflow is guarded by the following test files. Run them to verify the workflow has not regressed.

### AI Reader (server + desktop)

| Layer | File | What it guards |
|-------|------|----------------|
| API integration | `artifacts/api-server/src/routes/analyze-prescription.test.ts` | Full endpoint behavior: bad input, model chain, name-order fix, schema correctness, 503 on missing key |
| API integration | `artifacts/api-server/src/routes/cases-ai-reader.test.ts` | Case creation auth, iTero import (stub path), dedup idempotency, AI review acknowledgement, auto-invoice |

Run command:
```
pnpm --filter @workspace/api-server run test -- --reporter=verbose cases-ai-reader analyze-prescription
```

### Mobile/Web/Desktop Sync

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/cases.smoke.test.tsx` | Cases list renders patient names + case numbers from canonical server state |
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/case-detail.smoke.test.tsx` | Read-only case detail renders from canonical server state |
| API integration | `artifacts/api-server/src/routes/mobile-sync-invoice.test.ts` | Same Case ID invariant: client-generated ID preserved unchanged into GET /api/cases |

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

### Mobile Case Viewer (Read-Only)

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/cases.smoke.test.tsx` | Cases list renders + case count; in-memory search by patient/doctor/caseNumber; no-results state; row → `/case/:id` navigation |
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/case-detail.smoke.test.tsx` | Read-only detail renders all sections; unknown id → "Unable to load this case"; completed case + invoice; non-string `notes` never crashes |
| API integration | `artifacts/api-server/src/routes/cases-core.test.ts` | Case lifecycle: create, read, list, patch status, cross-lab scoping, soft-delete |

Run command:
```
pnpm --filter @workspace/labtrax run test -- cases.smoke case-detail.smoke
pnpm --filter @workspace/api-server run test -- --reporter=verbose cases-core
```

### Prescription / Case Media Cross-Platform Serving (server)

| Layer | File | What it guards |
|-------|------|----------------|
| API integration | `artifacts/api-server/src/routes/cases-attachments.test.ts` | Legacy mobile case photo upload creates attachment row with `labCaseId`; attachment surfaces via `GET /api/cases/:caseId/attachments` |
| API integration (E2E chain) | `artifacts/api-server/src/routes/cases-prescription-photo.test.ts` | Full chain: case creation → photo upload → DB integrity (labCaseId, fileType) → list endpoint (Files tab) → file-serving auth (not 401/403) → invoice generation |

Run command:
```
pnpm --filter @workspace/api-server run test -- --reporter=verbose cases-attachments cases-prescription-photo
```

### Case Location Cross-Platform Sync (server bridge)

| Layer | File | What it guards |
|-------|------|----------------|
| API integration | `artifacts/api-server/src/routes/cases-location-sync.test.ts` | POST syncs status to lab_cases; GET /api/cases list maps all 13 mobile statuses correctly; batch case bridge; GET /api/cases/:id detail bridge; list+detail agree on COMPLETE→"complete"; auth guard |

Run command:
```
pnpm --filter @workspace/api-server run test -- --reporter=verbose cases-location-sync
```

### Case Status Normalization Helper

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/normalize-case-status.test.ts` | `normalizeCaseStatus()` / `normalizeCaseStatuses()` token mappings: canonical identity, legacy uppercase + desktop-bridge tokens, whitespace trimming, unknown-value fallback to `received` |

Run command:
```
pnpm --filter @workspace/labtrax run test -- normalize-case-status
```

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

### Share-Intent Native Firewall

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/share-intent-config.test.ts` | The `expo-share-intent` plugin block stays present in `app.json` so LabTrax remains in the iOS/Android share sheet (native-only; can't be browser-tested) |

Run command:
```
pnpm --filter @workspace/labtrax run test -- share-intent-config
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
pnpm --filter @workspace/labtrax run test -- cases.smoke case-detail.smoke normalize-case-status auth-hydration reconnecting-indicator share-intent-config
pnpm --filter @workspace/scripts run lint-mobile-legacy-paths
pnpm --filter @workspace/scripts run test
```

---

## Protected Workflow: Mobile Rebuild Phase 1 — Auth Foundation Stable

The canonical mobile rebuild depends on JWT bearer auth being fully stable. These behaviors must remain correct end-to-end through any future change to the auth layer, token store, or networking stack.

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
`stuckSyncItems`, `unionActivityLog`). This is enforced by a compile-time lint
script that fails the build if any violation is found. After the Phase 1 reset,
the previously-grandfathered files (`lib/app-context.tsx`,
`components/PendingSyncBanner.tsx`) were **deleted**, so there are now **zero**
file-level or per-line exemptions in the mobile codebase.

Protected sub-behaviors:

- **Fence blocks `/api/legacy/cases`** — any non-comment, non-allowed-line
  reference to `/api/legacy/cases` in `artifacts/labtrax/app/`,
  `artifacts/labtrax/lib/`, `artifacts/labtrax/components/`, or
  `artifacts/labtrax/hooks/` causes `lint-mobile-legacy-paths` to exit 1.
- **Fence blocks `lab_cases`** — direct table-name references are forbidden
  in new mobile code; data access goes through `/api/cases`.
- **Fence blocks legacy sync fields** — `pendingSyncCount` and `stuckSyncItems`
  must not be imported or referenced in mobile code.
- **Fence blocks `unionActivityLog`** — the legacy server-side union helper
  must not be called from mobile code paths.
- **Per-line escape hatch exists but is unused** — a single line that must be
  individually exempted may end with `// legacy-fence:allow` with a justifying
  comment. There are currently **zero** active per-line exemptions.
- **File-level escape hatch exists but is unused** — `// legacy-mobile-fence:disable-file`
  as the first non-blank line exempts a whole file. There are currently **zero**
  exempt files (the former grandfathered files were deleted in the Phase 1 reset).
- **Fence passes clean today** — running `pnpm --filter @workspace/scripts
  run lint-mobile-legacy-paths` exits 0 with no violations.
- **Build-output folders are excluded by design** — `walkTs` skips `build`,
  `dist`, and `server_dist`. These hold compiled bundles, not source; they are
  gitignored (`artifacts/labtrax/.gitignore`) and must never be the canonical
  build in source control.

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

## TestFlight Smoke Test Checklist (Mobile — Phase 1 read-only viewer)

When submitting a build for TestFlight acceptance after a mobile change, the
following real-device smoke tests must pass before the build is approved. These
supplement the automated regression suite; they cannot be replaced by unit tests.
The create/scan/upload rows return when Phase 2 rebuilds those features.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Log in on a fresh install | Auth succeeds; Cases list loads from the server |
| 2 | Search the case list | Filtering by patient / doctor / case number works |
| 3 | Open a case | Read-only sections (overview, restorations, notes, files, invoice, history) render and match web/desktop for the same case |
| 4 | Lock screen via biometric | Lock screen appears after inactivity; Face ID / Touch ID unlocks without re-login |
| 5 | Share a PDF into LabTrax from Files app | Share intent received (native plugin firewall) |
| 6 | Force-quit and reopen the app | Session is restored; no login required |

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
