# Regression Guardrails

When the user confirms that a feature or workflow is working, that behavior becomes protected and must not regress. No code change — feature addition, refactor, AI Reader improvement, invoice change, sync change, or any other modification — may be merged or published unless every protected workflow listed here still passes end-to-end. Unit tests that pass while the real app workflow fails do not constitute success.

---

## Mobile Beta Protected Workflows

The mobile app (`artifacts/labtrax`) reached beta quality after Task #1493 (Mobile UI and Workflow Parity With Desktop). The 18 workflows below are confirmed working in TestFlight and are **permanently protected**. No future change — feature addition, UI refactor, API change, pricing change, invoice change, media change, or cleanup — may be merged or built if it breaks any of these workflows.

### The 22 Protected Workflows

Workflows 1–18 were confirmed in TestFlight after Task #1493 (Mobile UI Parity). Workflows 19–21 were added in Task #1503 (AI Reader Intake). Workflow 22 was added for bulk locate. **All 22 must pass before any build is approved.**

| # | Workflow | Automated Gate | Real-Device Required |
|---|----------|---------------|---------------------|
| 1 | **Login / logout** | `auth-hydration.test.ts`, `auth-hydration.smoke.ts` | **Yes** — biometric lock, session restore after force-quit |
| 2 | **Cases list loads from canonical database** | `cases.smoke.test.tsx`, `cases-canonical-mobile.test.ts` | **Yes** — server data round-trip |
| 3 | **Search / look up cases** | `cases.smoke.test.tsx` | Yes |
| 4 | **Open case detail** | `case-detail.smoke.test.tsx` | Yes |
| 5 | **Overview displays correctly** | `case-detail.smoke.test.tsx` | Yes |
| 6 | **Case history displays correctly** | `case-detail.smoke.test.tsx` | **Yes** — attachment thumbnails and previews in history events |
| 7 | **Invoice displays correctly** | `invoice-editor.smoke.test.tsx`, `invoices.test.ts` | **Yes** — editor loads, save round-trips without data loss |
| 8 | **Files / photos / documents open correctly** | `open-attachment.test.ts`, `pdf-viewer.smoke.test.tsx` | **Yes** — media viewing, auth-token timing on device |
| 9 | **Tooth chart displays with corrected layout** | _(pending automated test — see note)_ | **Yes** — native SVG rendering |
| 10 | **Locate Case uses desktop-matching stations** | `terminology-parity.test.ts`, `case-detail.smoke.test.tsx` | **Yes** — station labels match desktop, PATCH round-trip |
| 11 | **Mobile changes sync to desktop/web** | `cases-canonical-mobile.test.ts`, `mobile-sync-invoice.test.ts` | **Yes** — verify on desktop after mobile action |
| 12 | **Desktop/web changes sync back to mobile** | `cases.smoke.test.tsx`, `case-detail.smoke.test.tsx` | **Yes** — verify on mobile after desktop edit |
| 13 | **Lab slip / overview print output** | `case-pdf.test.ts` _(HTML structure only)_ | **Yes** — native iOS print sheet |
| 14 | **Case label print output** | `case-pdf.test.ts` _(HTML structure only)_ | **Yes** — native iOS print sheet |
| 15 | **No `/api/legacy/cases` in mobile source** | `lint-mobile-legacy-paths` (exits 1 on any violation) | No |
| 16 | **No local-only mobile saves** | `lint-mobile-legacy-paths`, `cases-canonical-mobile.test.ts` | No |
| 17 | **No duplicate invoices** | `mobile-sync-invoice.test.ts` | **Yes** — verify no ghost invoice on both clients |
| 18 | **No blank / unauthorized media regressions** | `authed-media-cache.test.ts`, `cases-prescription-photo.test.ts` | **Yes** — media must load on device without blanks |
| 19 | **AI Reader camera capture → review → AI extraction** | `ai-reader.smoke.test.ts` (store + helpers) | **Yes** — camera permission, live capture, base64 round-trip |
| 20 | **AI Reader provider resolution + duplicate detection + case creation** | `ai-reader.smoke.test.ts` (name/date helpers, codegen guard) | **Yes** — doctor search, practice alias, similarity modal, case PATCH |
| 21 | **AI Reader barcode assign + label print** | `ai-reader.smoke.test.ts` | **Yes** — CameraView barcode scan, manual entry, `expo-print` share sheet |
| 22 | **Mobile bulk locate — multi-select + bulk PATCH** | `cases.smoke.test.tsx` (multi-select suite, 6 tests) | **Yes** — long-press activates mode, tapping selects/deselects, Locate opens sheet, PATCH all selected, history events, selection clears on success |

> **Tooth chart (workflow #9):** An automated structural test will be added when the arch-layout implementation is finalized. Until then this workflow is covered exclusively by the TestFlight checklist below.

> **"Real-device required" means automated tests are not sufficient.** Camera, attachment/media viewing, printing, biometric/session behavior, barcode and AI Reader flows all require TestFlight validation on a physical iOS device regardless of unit-test status.

> **AI Reader TestFlight checklist (workflows 19–21):**
> 1. Tap "Scan Rx" on Dashboard → camera opens.
> 2. Capture 1–2 pages → thumbnails appear in tray → tap Next.
> 3. Review screen shows thumbnails; "Extract with AI" calls `/api/analyze-prescription`.
> 4. Extracted screen pre-fills patient, doctor, due date, teeth, material, shade.
> 5. Low-confidence banner appears when confidence < 60%.
> 6. Doctor search dropdown resolves a provider org; green checkmark appears.
> 7. Duplicate detection modal opens for same patient; "Create as new" and "Mark as remake" both work.
> 8. Tap "Create Case" → spinner → case appears in Cases list → Rx PDF is attached in history.
> 9. Barcode screen opens → scan a real pan barcode → "Barcode assigned!" sheet appears.
> 10. "Print label" opens iOS print sheet with patient/case/doctor/shade/material.
> 11. "Skip" on barcode screen → navigates directly to case detail.
> 12. Entire flow does not degrade any of workflows 1–18 above.

### AI Reader TestFlight Build Gate Status (workflows 19–21)

**All automated pre-build gates pass as of 2026-06-12.** A TestFlight build must be cut and the 12-step device checklist above must be walked before workflows 19–21 are promoted to fully confirmed.

**Code fixes applied before gate:**
- `expo-sensors` package was missing from the installed node_modules even though it was listed in `package.json`; installed via `pnpm --filter @workspace/labtrax add expo-sensors`.
- Imported `AccelerometerMeasurement` type from `expo-sensors` in `app/ai-reader/capture.tsx` so the Accelerometer listener callback is fully typed (eliminates `TS7031` implicit-any errors that blocked `pnpm run typecheck`).

**Automated gate results (2026-06-12):**
| Gate | Result |
|------|--------|
| Mobile tests (`pnpm --filter @workspace/labtrax run test`) | ✅ 150/150 passed |
| API tests (`pnpm --filter @workspace/api-server run test`) | ✅ 541 passed, 6 skipped |
| Legacy-path fence | ✅ Zero violations |
| Scripts tests | ✅ 18/18 passed |
| Typecheck (`pnpm run typecheck`) | ✅ Zero errors |

**Device-specific concerns to verify on TestFlight:**
- **Camera permissions** — `capture.tsx` shows a "Grant access" prompt on first open; verify iOS permission dialog fires before the viewfinder mounts.
- **Barcode scan loop** — `barcode.tsx` guards via `scanned` state flag and sets `onBarcodeScanned={assigning ? undefined : handler}`; verify a single scan fires exactly once even if the scanner sees multiple frames.
- **expo-print sheet** — `Print.printAsync({ html })` calls the native iOS print dialog; verify the sheet appears and the label content (patient, case number, doctor, shade, material) renders correctly.

**To trigger the TestFlight build (once all device checks pass):**
```bash
touch .local/.eas-build-approved
# Then restart the "EAS iOS Build + Submit" workflow
```

### Rules: Before Any New Feature

1. **Identify which of the 21 workflows the feature could affect** before writing any code.
2. **Run the full protected suite after every change** (see command block in Test Coverage Map below).
3. **If any protected workflow fails, stop.** Do not merge, publish, or continue until the regression is fixed.
4. **Add regression tests when a new workflow is confirmed working** in TestFlight — map it here.

### EAS / TestFlight Build Rules

**Builds are manual-only and require explicit approval.** The `EAS iOS Build + Submit` workflow auto-restarts after every Replit merge and package install. A one-shot sentinel file gates the build so those auto-restarts exit cleanly without consuming a credit.

To approve and trigger a build:

```bash
# Step 1: All automated gates must pass (see Pre-Build Checklist below)
# Step 2: All TestFlight checklist rows must pass (see below)
# Step 3: Drop the one-shot approval token
touch .local/.eas-build-approved
# Step 4: Restart the "EAS iOS Build + Submit" workflow in the Replit workflow pane
```

The token is consumed at the start of each build — one token, one build. A workflow restart without a token prints "EAS build requires manual approval" and exits without building or consuming a credit.

### Pre-Build Checklist (Mobile Beta — Phase 2)

Every gate below must pass before dropping the approval token and starting an EAS build:

| Gate | Command | Notes |
|------|---------|-------|
| Mobile tests | `pnpm --filter @workspace/labtrax run test` | All mobile unit + smoke tests green |
| API tests | `pnpm --filter @workspace/api-server run test` | All API integration tests green |
| Legacy-path fence | `pnpm --filter @workspace/scripts run lint-mobile-legacy-paths` | Zero violations |
| Scripts tests | `pnpm --filter @workspace/scripts run test` | Fence unit tests pass |
| Typecheck | `pnpm run typecheck` | Zero TypeScript errors |
| Real-device check | Manual — walk the TestFlight checklist below | All rows pass |
| EAS approval token | `touch .local/.eas-build-approved` | Drop **after** all above pass |

### TestFlight Smoke Test Checklist (Mobile Beta — Phase 2)

Install the build on a physical iOS device. **All rows must pass before the build is promoted to testers.** If any row fails, the build is rejected and the regression is fixed before new feature work continues.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Log in on a fresh install | Auth succeeds; Cases list loads from the server |
| 2 | Log out and log back in | Session re-established; Cases list reloads; no data loss |
| 3 | Search by patient name | List filters correctly; non-matching query shows empty state |
| 4 | Search by doctor name | List filters correctly |
| 5 | Search by case number | List filters correctly |
| 6 | Open a case — Overview tab | Patient, doctor, status, due date, and restorations match desktop for the same case |
| 7 | History tab — text events | Events render with correct labels (e.g. "Location Changed", not "Status Changed") |
| 8 | History tab — tap an image attachment | Image opens in the full-screen lightbox; no blank / 401 |
| 9 | History tab — tap a PDF attachment | PDF opens in the in-app viewer |
| 10 | Files tab — tap a photo | Photo opens in the lightbox; no blank / unauthorized-media regression |
| 11 | Files tab — tap a PDF or document | File opens in the in-app PDF viewer or OS viewer |
| 12 | Tooth chart | Chart renders with the corrected arch layout; no blank or inverted layout |
| 13 | Locate Case — tap a station | Status is updated; mobile and desktop both show the same new station |
| 14 | Desktop update → mobile | Update a case on desktop; mobile reflects the new state within one pull-to-refresh |
| 15 | Mobile locate → desktop | Use Locate Case on mobile; desktop/web shows the updated station |
| 16 | Invoice tab — open editor | Fields (number, status, teeth, shade, line items) load; sub-items show "edit on desktop" note |
| 17 | Invoice tab — edit and save | Change persists; no duplicate invoice; desktop shows the same invoice |
| 18 | Print lab slip (via share / print button) | iOS print sheet appears; content includes case number, patient, restorations, lab name |
| 19 | Print case label | iOS print sheet appears; label content renders correctly |
| 20 | Lock screen (leave app idle) | Lock screen appears after inactivity; Face ID / Touch ID unlocks without re-login |
| 21 | Force-quit and reopen | Session restores; no login required; previously viewed media loads without blanks |

**Zero-regression rule:** If any row above fails in a new build, the build is **rejected** from TestFlight promotion and a regression issue is filed against the offending change before any new feature work continues.

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

> **Phase 2 update (Task #1493, 2026-06-12):** Several workflows were **restored** and are now re-protected under the Mobile Beta Protected Workflows section above. Restored: (1) single-station Locate Case picker; (2) interactive history attachments (image lightbox + PDF viewer in history events); (3) full-screen invoice editor for existing invoices; (4) file/attachment preview — photos, PDFs, and documents; (5) print output — lab slip and case label. Still retired from the table above: AI Reader Scan tab, mobile case creation from scratch, batch barcode locate, photo upload queue, and offline sync banner.

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
- **iTero Rx PDF mirrored to object storage** — every successful `import-from-itero-rx` call must fire `writeCaseMediaToObjectStorage` for the uploaded Rx PDF so the file survives server restarts and re-deployments. The ZIP import paths had this mirror; the single-file poller route was missing it (filed as a 404 regression on TestFlight). Guarded by `cases-ai-reader.test.ts` — "mirrors Rx PDF to object storage after successful import".
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

# Account Epic Protected Workflows (Platform Parity)

These ten workflows protect the cross-platform account, authentication, and tenancy surfaces shared by web, desktop, and mobile clients (Account Epic Phases 1–6). Desktop/web is the source of truth; mobile must not diverge. All gates are **API integration** or **contract** tests on `@workspace/api-server`, since the server is the single enforcement point for every client.

## Protected Workflow: User Signup & Username Rules

Registration is the entry point for every tenant. The rules below must hold identically regardless of which client submits the request.

Protected sub-behaviors:

- **Valid registration succeeds** — a well-formed payload returns 200 with an access token and a user record.
- **Username constraints enforced** — 3–12 characters, allowed character set only, case-insensitive uniqueness (duplicate → 409).
- **Duplicate email rejected** — a second registration with an existing email returns 409.
- **Lab-org registration requires lab fields** — registering while creating a lab org without the required lab fields returns 400 `LAB_FIELDS_REQUIRED`.
- **No email enumeration on forgot-password** — `forgot-password` returns 200 even for an unknown email.

---

## Protected Workflow: Login & Session Issuance

Login must issue properly-scoped sessions and accept the documented identifiers.

Protected sub-behaviors:

- **Valid credentials issue access + refresh tokens** (200); wrong password and unknown username both return 401.
- **`identifier` accepts username, email, or platform account number** (case-insensitive) and authenticates.
- **Refresh rotates tokens** — a valid refresh token returns a new access token; the old refresh token is rejected after rotation; an invalid refresh token returns 401.
- **Logout revokes the server-side session** — a subsequent refresh with the revoked session returns 401.

---

## Protected Workflow: Two-Factor Authentication (TOTP + Backup Codes)

The 2FA challenge is a high-risk auth surface shared by all clients. A wrong or malformed code must never crash the server, and backup codes must be single-use.

Protected sub-behaviors:

- **Setup/confirm lifecycle** — `/2fa/setup` requires auth and returns a TOTP secret; `/2fa/confirm` rejects a wrong code (422) and enables 2FA on a valid TOTP; `/2fa/status` reflects the enabled state.
- **Login gates on 2FA** — when 2FA is enabled, login returns `requiresTwoFactor` + a `pendingToken` and issues **no** session.
- **Challenge correctness** — an invalid `pendingToken` returns 401; a wrong code returns 422; a valid TOTP issues bearer tokens.
- **Backup codes are single-use** — a challenge with a valid backup code succeeds once; a 10-character backup code (or any non-6-digit input) must **not** throw `TokenLengthError` / 500 — it falls through to the backup-code branch or returns a clean 422 (`isValidTotp` wrapper in `two-factor.ts`).
- **Trusted "remember this device"** — a challenge with `trustDevice:true` issues a `deviceTrustToken`; a later login presenting that token skips the 2FA challenge and issues a full session immediately. A **missing**, **forged**, or **expired** device-trust token must still force the challenge (`requiresTwoFactor` + `pendingToken`, no tokens leaked). This is a 2FA-bypass surface, so the negative paths are as load-bearing as the positive one.
- **Disable** — `DELETE /2fa` on a valid TOTP disables 2FA and login no longer challenges.
- **Disable forgets trusted devices** — disabling 2FA (`DELETE /2fa`) must purge **all** of the user's `trusted_devices` rows. A device-trust token issued before the disable cannot survive a disable/re-enable cycle: after re-enabling 2FA, presenting that stale token still forces the challenge (`requiresTwoFactor` + `pendingToken`, no tokens leaked). This is a security-critical cleanup — a stale trust token must never become a permanent 2FA bypass.

---

## Protected Workflow: Email & Phone Verification Codes

Verification gates PHI access and stamps the verified-at columns relied on across clients.

Protected sub-behaviors:

- **Send endpoints validate a target** — `/send-email-code` and `/send-phone-code` return 400 without a target, 200 with one.
- **Verify is single-use and channel-correct** — `/verify-email-code` and `/verify-phone-code` reject a wrong code (`verified: false`), accept the correct code once (`verified: true`), and a consumed code cannot be replayed.
- **Verification stamps state + audit** — a successful email/phone verification sets `users.emailVerifiedAt` / `users.phoneVerifiedAt` and writes an `email_verified` / `phone_verified` audit entry.
- **Send endpoints are abuse-throttled** — `/send-email-code` and `/send-phone-code` enforce a resend cooldown plus per-identifier and per-IP rolling limits (`createSendCodeThrottle` in `lib/rate-limit.ts`). A throttled request returns **429** *before* the handler runs, so no email/SMS is dispatched and no `verification_codes` row is written. This protects the threat-model denial-of-service / cost-abuse surface (an attacker hammering the endpoints to run up email/SMS bills or spam a victim). Guarded by the throttle cases in `account-epic-verification.test.ts`.

---

## Protected Workflow: Cross-Lab Platform Account Numbers

Every provider/org gets a platform-wide canonical account number, and unverified canonical accounts are gated from PHI.

Protected sub-behaviors:

- **Canonical number allocation** — a lab user is assigned a canonical account number with the phone segment; a provider is assigned a `P`-type number (no phone segment when absent).
- **Unverified-PHI gate** — a canonical but unverified account is blocked from a PHI route (403) and allowed only after verification.
- **Legacy grandfathering** — a user with a non-canonical (legacy) account number bypasses the verification gate.

---

## Protected Workflow: Lab (Organization) Creation

Lab creation establishes the tenant boundary; only lab accounts may create labs, and the creator becomes the owner.

Protected sub-behaviors:

- **Creation succeeds and is owned** — a lab account creates a lab (201) and becomes an **active owner**; an `organization_created` audit entry is recorded and `licenseNumber` persists.
- **Unauthenticated creation rejected** (401).
- **Required fields enforced** — missing lab fields → 400 `LAB_FIELDS_REQUIRED`.
- **Duplicate lab name rejected** (case-insensitive) → 409 `LAB_NAME_TAKEN`.
- **Provider accounts cannot create labs** → 403 `LAB_USER_REQUIRED`.
- **Org type preserved** — a provider org type is reflected verbatim in the response.

---

## Protected Workflow: Organization Invitations

Invitations cross the tenant boundary and must be scoped, single-purpose, and reversible by the right parties.

Protected sub-behaviors:

- **Create / list / cancel** — `POST /:id/invites` creates a pending invite; the list endpoint shows it; cancel marks it revoked.
- **Accept creates membership** — `POST /invites/:token/accept` creates a membership for the email-matched user.
- **Decline** — the invitee can decline a pending invite.

---

## Protected Workflow: Role Assignment & Privilege Bounds

Role changes are an elevation-of-privilege surface; only admins may change roles, and the role enum bounds what can be assigned.

Protected sub-behaviors:

- **Admin can change a member's role** via `PATCH /memberships/:id`.
- **Non-admin (user role) cannot change any role** → 403.
- **Membership removal is admin-gated** — an admin can remove another member; a non-admin cannot (403).
- **Role assignment is bounded by the role enum** — out-of-enum roles are rejected at the contract layer (see API contract workflow).

---

## Protected Workflow: Provider Portal Signup & Case Isolation

The provider portal is a cross-tenant read surface; providers must see only their own assigned cases, with no IDOR escape.

Protected sub-behaviors:

- **Provider signup** issues a `P-` account number and a provider org.
- **Per-provider isolation** — each provider sees only their own assigned cases; a lab user gets an empty provider list; unauthenticated `GET /api/cases/provider` → 401; bare `/api/cases` excludes other providers' cases.
- **No IDOR via `?organizationId`** — a provider cannot read another provider org or the lab org by id; they can read only their own org and their own case detail; reading another provider's case detail is denied.

---

## Protected Workflow: Account-Epic API Contract (Zod Schemas)

The shared Zod schemas are the wire contract every client codegens against; drift here silently breaks parity. The schemas must accept valid payloads and reject invalid ones for registration, login, refresh, current-user/session responses, verification, organization/membership, and audit-log shapes.

Protected sub-behaviors:

- **Auth contract** — minimal and full (org-creating) registration accepted; missing password and invalid `userType` rejected; login by username/identifier accepted; empty refresh body allowed (cookie clients); current-user and session-list responses parse.
- **Verification contract** — email/phone verify require their target + code; a verification result parses.
- **Organization & membership contract** — create-org requires type + name and rejects an invalid type; invitations require email + `roleToAssign` and reject out-of-enum roles; partial membership updates accepted, out-of-enum membership role rejected.
- **Audit-log contract** — `organizationId` query accepted and limit bounded; audit-log list response parses.

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
| Mobile unit tests | `pnpm --filter @workspace/labtrax run test` | All mobile unit + smoke tests green (full Phase 2 beta scope) |
| API integration tests | `pnpm --filter @workspace/api-server run test` | All server-side integration tests green |
| Legacy-path fence | `pnpm --filter @workspace/scripts run lint-mobile-legacy-paths && pnpm --filter @workspace/scripts run test` | No new legacy paths; lint unit tests pass |
| Real-device TestFlight | Manual | See Mobile Beta checklist above — no automated test replaces this |

> **E2E browser specs:** the Playwright mobile specs (`ai-reader-mobile-scan`, `long-press-locate-case`) are **retired pending Phase 2** because the underlying mobile flows were removed in the Phase 1 reset. Re-add an E2E gate when Phase 2 restores scan/create/locate.

**Real-device TestFlight verification:** See the **TestFlight Smoke Test Checklist (Mobile Beta — Phase 2)** in the Mobile Beta Protected Workflows section above. That 21-row checklist supersedes the Phase 1 (6-row) checklist. All 21 rows must pass before any build is promoted to testers.

---

## Test Coverage Map

Each protected workflow is guarded by the following test files. Run them to verify the workflow has not regressed.

### AI Reader (server + desktop)

| Layer | File | What it guards |
|-------|------|----------------|
| API integration | `artifacts/api-server/src/routes/analyze-prescription.test.ts` | Full endpoint behavior: bad input, model chain, name-order fix, schema correctness, 503 on missing key |
| API integration | `artifacts/api-server/src/routes/cases-ai-reader.test.ts` | Case creation auth, iTero import (stub path), dedup idempotency, AI review acknowledgement, auto-invoice |
| API integration | `artifacts/api-server/src/routes/cases-ai-intake-carry-through.test.ts` | DashboardDropZone intake regression: shade + rxNotes + stub restoration (toothNumber:"") survive POST→GET with no SQL INSERT mismatch; casePanBarcode null when absent; bridgeConnectors/deliveryDateProposalDate/deliveryDateProposalNote absent without error; exactly one auto-invoice; restorations exposed for mobile Lab Slip |

Run command:
```
pnpm --filter @workspace/api-server run test -- --reporter=verbose cases-ai-reader analyze-prescription cases-ai-intake-carry-through
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
| Mobile unit | `artifacts/labtrax/lib/__tests__/reconnecting-indicator.test.ts` | Reconnecting banner appears when the API is unreachable; disappears when API recovers |

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

### Phase 2 Mobile Beta — New Test Files

The following test files were added in Task #1493 (Phase 2). They guard the 18 Mobile Beta Protected Workflows.

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/terminology-parity.test.ts` | Mobile `STATUS_OPTIONS` (Locate Case stations) equals desktop `STATUS_FILTERS`; "status_changed" history event renders as "Location Changed" on both clients |
| Mobile unit | `artifacts/labtrax/lib/__tests__/role-parity.test.ts` | Mobile `EDIT_ROLES` equals desktop `BILLING_ROLES` — the edit-access gate for Lists, Reports, and other admin surfaces |
| Mobile unit | `artifacts/labtrax/lib/__tests__/open-attachment.test.ts` | `openAttachment` dispatches images to the lightbox and PDFs to the in-app viewer; `downloadAttachmentToLocalFile` caches with correct extension; non-sharing-capable devices fall back gracefully |
| Mobile unit | `artifacts/labtrax/lib/__tests__/case-pdf.test.ts` | `buildCaseCardHtml` renders case number, patient, doctor, restorations, priority, and Rx notes with correct HTML escaping; `buildInvoiceHtml` renders invoice fields; `generatePdf` calls `printToFileAsync`; `sharePdf` shares the output file |
| Mobile unit | `artifacts/labtrax/lib/__tests__/authed-media-cache.test.ts` | Auth-gated media cache downloads with Bearer token; skips Bearer for external URLs; serves from cache on hit; refreshes on 401; same-origin guard prevents JWT leakage |
| Mobile smoke | `artifacts/labtrax/lib/__tests__/screens/pdf-viewer.smoke.test.tsx` | PDF viewer screen renders the in-app WebView for a PDF attachment URL; shows a loading state; does not crash on an invalid URI |
| Mobile smoke | `artifacts/labtrax/lib/__tests__/screens/invoice-editor.smoke.test.tsx` | Invoice editor renders without throwing; prefills invoiceNumber/status/teeth/shade from the invoice; PATCH payload round-trips `displayMetadata` + `subItems` verbatim (no silent data loss); status-only edit works; line-item add/edit/delete wired to PATCH |
| Mobile smoke | `artifacts/labtrax/lib/__tests__/screens/case-detail.smoke.test.tsx` (Phase 2 additions) | Locate Case via `useUpdateCase` canonical PATCH; history image thumbnail opens lightbox; history PDF opens in-app viewer; history legacy `imageUri` is preferred over canonical `/file` route; Files tab image/PDF/document tappable; delete attachment with confirmation; invoice PDF share |
| API integration | `artifacts/api-server/src/routes/cases-canonical-mobile.test.ts` | Canonical UUID round-trip end-to-end; invoice not duplicated on re-sync; status PATCH visible in GET; event history available; cross-client list/detail identity |

Run command (Phase 2 tests only):
```bash
pnpm --filter @workspace/labtrax run test -- invoice-editor.smoke terminology-parity role-parity open-attachment case-pdf pdf-viewer.smoke authed-media-cache
pnpm --filter @workspace/api-server run test -- --reporter=verbose cases-canonical-mobile
```

### Account Epic — Platform Parity (server)

These ten workflows are guarded entirely by `@workspace/api-server` integration and contract tests, since the API server is the single enforcement point for every client.

| Layer | File | What it guards |
|-------|------|----------------|
| API integration | `artifacts/api-server/src/routes/auth.test.ts` | **Signup & Username Rules** + **Login & Session Issuance** — valid/duplicate registration, `LAB_FIELDS_REQUIRED`, no forgot-password enumeration; login by username/email/account-number identifier, wrong-password 401, refresh rotation + old-token rejection, logout session revocation |
| API integration | `artifacts/api-server/src/routes/two-factor.test.ts` | **Two-Factor Authentication** — setup/confirm/status lifecycle, login `requiresTwoFactor` + `pendingToken` (no session), challenge 401/422/200 paths, valid-TOTP bearer issuance, single-use backup code (no `TokenLengthError`/500 on a 10-char code), trusted "remember this device" (valid token skips challenge; missing/forged/expired token still forces it), disable |
| API integration | `artifacts/api-server/src/routes/account-epic-verification.test.ts` | **Email & Phone Verification Codes** — send-code target validation (400/200), verify wrong/correct/replayed code, single-use consumption, `emailVerifiedAt`/`phoneVerifiedAt` stamps + `email_verified`/`phone_verified` audit |
| API integration | `artifacts/api-server/src/routes/account-epic-phase2.test.ts` | **Cross-Lab Platform Account Numbers** — canonical number allocation (lab with phone segment, provider `P`-type), unverified-PHI 403 then allow-after-verify, legacy account-number grandfathering; also reinforces username rules |
| API integration | `artifacts/api-server/src/routes/organizations.test.ts` | **Lab Creation** + **Organization Invitations** + **Role Assignment & Privilege Bounds** — owner-on-create + `organization_created` audit + `licenseNumber` persist, `LAB_FIELDS_REQUIRED`/`LAB_NAME_TAKEN`/`LAB_USER_REQUIRED`, invite create/list/cancel/accept/decline, admin role PATCH, non-admin 403, admin-gated membership removal |
| API integration | `artifacts/api-server/src/routes/cases-provider-portal.test.ts` | **Provider Portal Signup & Case Isolation** — `P-` provider signup + org, per-provider case isolation, empty provider list for lab users, 401 unauthenticated, no IDOR via `?organizationId`, denied cross-provider case detail |
| Contract (Zod) | `artifacts/api-server/src/routes/account-epic-contract.test.ts` | **Account-Epic API Contract** — auth/verification/organization/membership/audit-log Zod schemas accept valid payloads and reject invalid `userType`/org type/role-enum/missing-field shapes the clients codegen against |

Run command (Account Epic parity tests only):
```bash
pnpm --filter @workspace/api-server run test -- auth two-factor account-epic-verification account-epic-phase2 organizations cases-provider-portal account-epic-contract
```

### Run the full protected suite at once

```bash
pnpm --filter @workspace/api-server run test -- cases-ai-reader analyze-prescription invoices cases-core cases-invoice-creation mobile-sync-invoice cases-attachments cases-prescription-photo cases-location-sync cases-canonical-mobile
pnpm --filter @workspace/labtrax run test -- cases.smoke case-detail.smoke normalize-case-status auth-hydration reconnecting-indicator share-intent-config invoice-editor.smoke terminology-parity role-parity open-attachment case-pdf pdf-viewer.smoke authed-media-cache
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

> **Superseded.** This Phase 1 checklist (6 rows) has been replaced by the **TestFlight Smoke Test Checklist (Mobile Beta — Phase 2)** in the Mobile Beta Protected Workflows section above. The Phase 2 checklist covers all 18 protected workflows across 21 test rows. Use the Phase 2 checklist for all builds going forward. This section is kept for historical reference only.

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

---

## Protected Workflow: Desktop Notification → Case Navigation

Clicking **View** on a notification that carries a `caseId` (iTero import notifications and `alert`-type notifications) must always open the correct case drawer in the Cases page, regardless of whether the user is already on `/cases` or navigating from another page.

Protected sub-behaviors:

- **Initial deep-link on mount** — when CasesPage mounts with `?caseId=<id>` in the URL (e.g. navigating from a notification "View" click on a different page), the case drawer opens for the identified case within the same render cycle after data loads.
- **Same-page URL change re-opens drawer** — when the user is already on `/cases` and clicks "View" on a second notification (or any action that changes only the query string via `setLocation("/cases?caseId=X")`), the drawer opens for the new case without requiring a page remount. This was the primary regression: the old `[data, isLoading]` dependency array did not re-fire when only the search string changed.
- **Second notification replaces first** — clicking "View" on a different case while a drawer is already open replaces it with the newly linked case (no stale-ref lock-out).
- **Correct destination from `getNotificationDestination`** — `case_imported_from_itero` notifications and `alert` notifications with a `caseId` in `dataJson` both route to `/cases?caseId=<encodeURIComponent(id)>`. Notification types without a `caseId` (security alerts, etc.) are not affected.

Root causes fixed:

1. `deepLinkOpenedRef` was a one-shot boolean (`useRef(false)` set to `true` on first use) — replaced with `lastProcessedCaseIdRef` that tracks the last *processed* caseId, so a new caseId always triggers the drawer but the same caseId does not re-open.
2. The `useEffect` depended on `[data, isLoading]` — the search string (`useSearch()`) was added to the dependency array so the effect re-fires on any URL query change even when the component stays mounted.

Automated gate: `pnpm --filter @workspace/labtrax-desktop run test` — file `src/__tests__/notification-case-navigation.test.tsx`

| Test layer | Coverage |
|-----------|---------|
| Static — `src/__tests__/notification-case-navigation.test.tsx` | Asserts `useSearch` is imported, `search` is in the effect deps, the one-shot boolean guard is gone, `lastProcessedCaseIdRef` is used |
| Runtime — `src/__tests__/notification-case-navigation.test.tsx` | `getNotificationDestination` maps all notification types correctly; CasesPage calls `apiFetch('/cases/abc')` on initial mount with `?caseId=abc` and after same-page URL navigation to `?caseId=abc` |

---

## Desktop / Web Parity Rule

**The LabTrax Desktop Electron app and the LabTrax web client share the same React source tree** (`artifacts/labtrax-desktop/src/`). Every feature added to the web is automatically present in the desktop renderer — **no per-feature duplication is needed or permitted**.

The single maintenance obligation is **rebuilding and republishing the desktop installer** after every code merge that changes the shared source, so the installed Electron app picks up the same code that web users already see.

### How publishing works (Replit environment)

The GitHub Actions auto-tag pipeline (`auto-tag-desktop-release.yml` + `release.yml`) requires a `BUILD_BOT_TOKEN` and a GitHub remote — **neither exists in this Replit environment**. The Replit-native mechanism is:

1. **Automatic (post-merge):** `scripts/post-merge.sh` detects whether the latest commit changed any file under `artifacts/labtrax-desktop/`, `lib/`, or `artifacts/api-server/src/`. If yes, it calls `scripts/desktop-build-publish.sh` automatically. The post-merge timeout is set to 600 s to accommodate the ~3–5 min Electron build.

2. **Manual (on-demand):** From the Replit workflow pane, restart **"Desktop Build + Publish"** at any time to force a full rebuild + upload without waiting for a merge.

3. **CLI:** `bash scripts/desktop-build-publish.sh` from the repo root.

All three paths produce `LabTrax-Windows-Portable.zip` in `artifacts/labtrax-desktop/electron-dist/`, upload it to App Storage, and update `system_settings.desktop_installer_version` so the Settings → Desktop App panel shows the correct version.

### To skip a rebuild on a specific merge

Include `[skip desktop-release]` or `[skip ci]` in the merge commit subject. `post-merge.sh` checks for these strings and skips the build step.

### Desktop installer version

The installer version is read from `artifacts/labtrax-desktop/package.json` at build time and stored in `system_settings.desktop_installer_version` after each publish. The API exposes it at `GET /api/desktop-installer` (no auth). The `DESKTOP_INSTALLER_VERSION` env var is a fallback for environments where no publish has run yet.

### Guardrail

After any merge that touches `artifacts/labtrax-desktop/**`, `lib/**`, or `artifacts/api-server/src/**`, confirm that `GET /downloads/LabTrax-Windows-Portable.zip` returns an updated binary (check the `Last-Modified` or `ETag` header) and that `GET /api/desktop-installer` returns the new version string before closing the task.

---

## Protected Workflow: Desktop Signed Build Verification

**No desktop release workflow may merge if signing verification is failing.**

`scripts/verify-signing.sh` is called by `scripts/desktop-build-publish.sh` after every successful Electron build and before any artifact upload or `latest.yml` generation. It verifies that both `win-unpacked/LabTrax.exe` and the installer package (when it is a PE file) carry a valid, trusted Authenticode signature with the expected publisher identity.

### What this protects

- **A build signed with the wrong certificate must fail.** Signature validity, certificate chain trust, and publisher CN are all verified — not just the presence of a signature block.
- **An expired or revoked certificate must fail the build.** The certificate validity period is checked; an unsigned or wrongly-signed installer must never reach the auto-update feed.
- **Both artifacts must pass.** `LabTrax.exe` (the main executable) and `LabTrax-Setup.exe` (the NSIS installer, when produced) are both verified. A situation where the EXE is signed but the distributed installer is not is caught and failed.
- **latest.yml and the upload are blocked if verification fails.** `desktop-build-publish.sh` calls `verify-signing.sh` before generating the auto-update manifest or uploading any file; a non-zero exit from `verify-signing.sh` stops the script via `set -euo pipefail`.

### Protected sub-behaviors

| Scenario | Required outcome |
|----------|-----------------|
| `CSC_LINK` absent | Verification step skipped; log shows "Signing disabled; verification skipped." Upload proceeds (unsigned path) |
| `CSC_LINK` set, `CSC_KEY_PASSWORD` absent | **Exit 1** — misconfiguration; build aborted before upload |
| `CSC_LINK` set, signature valid, publisher matches `CSC_EXPECTED_PUBLISHER` | Verification passes; upload proceeds |
| `CSC_LINK` set, signature invalid or missing | **Exit 1** — upload blocked; `latest.yml` not generated |
| `CSC_LINK` set, certificate expired or revoked | **Exit 1** — upload blocked; `latest.yml` not generated |
| `CSC_LINK` set, publisher CN does not contain `CSC_EXPECTED_PUBLISHER` | **Exit 1** — wrong certificate; upload blocked |
| `CSC_LINK` set, no verification tool available | **Exit 1** — cannot verify; upload blocked |
| Installer is a ZIP (portable path) | Only `LabTrax.exe` verified; ZIP is not Authenticode-signable; note logged |

### CI output (logged for every verification run)

For each verified file, `verify-signing.sh` logs:
- **Certificate subject** — full Subject line from the signing certificate
- **Publisher name** — CN extracted from the Subject
- **Timestamp authority** — TSA subject from the countersignature
- **Signature status** — "VALID (Authenticode chain trusted)" or "FAILED"

### Automated gate

```
bash scripts/test-signing-verification.sh
```

The test suite injects a configurable mock `osslsigncode` via `PATH` and asserts all five required scenarios plus two bonus cases (installer verification, ZIP skip). Runs on Linux / Replit without certificates.

**Protected workflow name (Replit):** "Desktop Signed Build Verification"

**Command:** `bash scripts/test-signing-verification.sh`

All 9+ assertions must pass before any desktop release is approved.

### Test cases that must pass

| # | Scenario | Expected result |
|---|----------|----------------|
| 1 | `CSC_LINK` absent | Exit 0; log contains "Signing disabled; verification skipped." |
| 2 | Valid certificate, publisher matches | Exit 0; verification passes; publisher check passes |
| 3 | Invalid certificate (tool reports failure) | Exit 1; publish aborted |
| 4 | Corrupted certificate payload | Exit 1; publish aborted |
| 5 | Publisher mismatch (`CSC_EXPECTED_PUBLISHER` set, CN differs) | Exit 1; mismatch logged |

### Files

| File | Role |
|------|------|
| `scripts/verify-signing.sh` | Standalone verifier — verifies EXE and (optionally) installer; rich CI output |
| `scripts/test-signing-verification.sh` | Automated test suite — 5 required scenarios + bonus cases via mocked tool |
| `scripts/desktop-build-publish.sh` | Calls `verify-signing.sh`; gates upload and `latest.yml` on its exit code |

---

## Backup Restore Integrity

**Status:** Protected since the addition of clearing_sessions, pre-restore snapshot, schema version gate, and post-restore validation.

**Why:** Before this protection was added, a restore would leave all user sessions from the backup in `user_sessions`, causing unique-constraint conflicts on the next login and silently locking users out of the restored instance. An incompatible-schema backup could also corrupt the live database before failing. These bugs are non-obvious regression candidates because the rest of the restore pipeline appears to succeed.

**Test command:**
```
pnpm --filter @workspace/api-server run test -- --reporter=verbose src/routes/backup-restore.test.ts
```
Requires `DATABASE_URL` to be set. All 20 tests must pass.

### Protected behaviors

| # | Behavior | Test |
|---|----------|------|
| 1 | Backup manifest includes `userCount` | test 1 |
| 2 | Backup manifest includes `caseCount` | test 2 |
| 3 | Backup manifest includes `orgCount` | test 3 |
| 4 | Backup manifest includes `invoiceCount` | test 4 |
| 5 | Backup manifest includes `tableCount > 10` | test 5 |
| 6 | Backup manifest includes `schemaVersion = BACKUP_SCHEMA_VERSION` | test 6 |
| 7 | Manifest `caseCount` matches live DB non-deleted count | test 7 |
| 8 | `executeRestore` ends with `phase = done` on success | test 8 |
| 9 | `user_sessions` is empty immediately after restore | test 9 |
| 10 | Login succeeds post-restore without stale session conflict | test 10 |
| 11 | Back-to-back session inserts succeed post-restore | test 11 |
| 12 | `TRUNCATE TABLE user_sessions` is issued during the `clearing_sessions` step | test 12 |
| 13 | Post-restore validation SQL queries are issued before `done` | test 13 |
| 14 | Full phase sequence includes `restoring_db`, `clearing_sessions`, `restoring_media`, `done` | test 14 |
| 15 | `pg_restore` failure sets `phase = error`; pre-restore snapshot still exists | test 15 |
| 16 | Schema version mismatch throws `"schema version"` error before any DB row is touched | test 16 |
| 17 | Pre-restore safety snapshot is written to `uploads/.restore-snapshots/pre-restore-<ts>.pgdump` | test 17 |
| 18 | `runPostRestoreValidation` returns `valid = true` on clean data | test 18 |
| 19 | `runPostRestoreValidation` returns `valid = false` when orphaned `lab_membership` rows exist | test 19 |
| 20 | Phase ordering: `clearing_sessions` follows `restoring_db` and precedes `restoring_media` | test 20 |

### Files

| File | Role |
|------|------|
| `artifacts/api-server/src/lib/backup.ts` | Core backup/restore implementation — `executeRestore`, `runPostRestoreValidation`, `BACKUP_SCHEMA_VERSION`, `buildManifestCounts`, `buildBackupZipBuffer` |
| `artifacts/api-server/src/routes/backup-restore.test.ts` | 20-test suite covering all protected behaviors |
| `artifacts/labtrax-desktop/src/pages/settings.tsx` | Desktop UI — `RestorePhase` type, step labels, warning banner, success message |

---

## Desktop Installer Availability

The Settings → Desktop App panel displays `installerStatus` for each installer slot. When the status is `"missing"` the download link returns 404 for users; when it is `"ok"` the download is live. This guardrail ensures the publish pipeline cannot silently succeed while leaving the download unavailable.

### Protected Behaviors

| # | Behavior | Automated Gate |
|---|----------|---------------|
| 1 | `GET /admin/settings/desktop-installer` returns `installerStatus: "missing"` when no installer object exists in App Storage for the active download-URL kind | `installer-settings-status.test.ts` |
| 2 | `GET /admin/settings/desktop-installer` returns `installerStatus: "ok"` after a successful upload populates the active slot | `installer-settings-status.test.ts` |
| 3 | `GET /admin/settings/desktop-installer` returns 403 without the `X-Platform-Admin-Secret` header | `installer-settings-status.test.ts` |
| 4 | `desktop-build-publish.sh` exits non-zero if `HEAD /downloads/<installer>` does not return HTTP 200 after upload | Post-upload verification block in `scripts/desktop-build-publish.sh` (sets `VERIFY_BASE_URL` from `PUBLISH_API_BASE_URL` or `REPLIT_DEV_DOMAIN`) |
| 5 | `POST /admin/desktop-installer/publish` atomically writes App Storage object + `system_settings` rows + changelog in one call | `installer-publish-e2e.test.ts` (gated on `INSTALLER_E2E_OBJECT_DIR` + `PLATFORM_ADMIN_SECRET`) |

### Root cause / failure mode reference

The `"missing"` status occurs when any of these conditions hold at deploy time:
- `PRIVATE_OBJECT_DIR` or `DEFAULT_OBJECT_STORAGE_BUCKET_ID` is unset — uploads go nowhere
- `desktop-build-publish.sh` uploads to App Storage but the settings DB row (`system_settings.desktop_installer_url`) is never written (requires `PLATFORM_ADMIN_SECRET` or `DATABASE_URL` to be set)
- `release.yml` CI publish step silently skips (missing `PLATFORM_ADMIN_SECRET` or `PUBLISH_API_BASE_URL`)

### Files

| File | Role |
|------|------|
| `artifacts/api-server/src/installer-settings-status.test.ts` | 3-test suite: missing/ok/403 behaviors for `installerStatus` |
| `artifacts/api-server/src/installer-publish-e2e.test.ts` | Atomic publish end-to-end (gated on real App Storage env vars) |
| `artifacts/api-server/src/lib/desktop-installer-storage.ts` | `getDesktopInstallerMetadata` — returns null when slot is absent |
| `artifacts/api-server/src/routes/labtrax-routes.ts` | Settings endpoint: `installerStatus` computation at `GET /admin/settings/desktop-installer` |
| `scripts/desktop-build-publish.sh` | Publish pipeline: post-upload HEAD verification exits 1 on 404 |

---

## Lab Slip Optional Invoice Fields

Invoice fields are opt-in elements in the Advanced Print Layout editor. They must not break the existing lab slip print flow when absent and must render live invoice data when present.

### Protected Behaviors

| # | Behavior | Notes |
|---|----------|-------|
| 1 | **Invoice Fields section visible in Advanced Print Layout editor** | Left rail shows Invoice Fields section with 6 scalar fields + line-items table; all are opt-in (not pre-placed by default) |
| 2 | **Adding a scalar field places it on the canvas** | Admin clicks "+ Invoice Number" → element appears on canvas at a sensible position |
| 3 | **Adding Invoice Line Items places a table block** | Table block appears; column-toggle panel in Selected Properties controls which columns render |
| 4 | **Print preview fetches invoice for cases that have one** | CasePreviewPicker fetches `/invoices?caseId=…&limit=1` when the draft has invoice elements |
| 5 | **Graceful no-invoice case** | Scalar fields render "No invoice"; line-items table renders "No invoice linked to this case." when no invoice exists |
| 6 | **Existing lab slips without invoice elements are unaffected** | `ensureBuiltinElements` treats invoice elements as opt-in extras; zero invoice elements = no change to existing behavior |
| 7 | **`printCaseCardAdvanced` accepts `invoice` in extras** | Pass `invoiceDetailQuery.data ?? caseInvoice` from the cases page drawer |

### Files

| File | Role |
|------|------|
| `artifacts/labtrax-desktop/src/lib/case-print-template.ts` | Type definitions: `INVOICE_SCALAR_KINDS`, `INVOICE_LINE_ITEM_COLUMNS`, `INVOICE_ELEMENT_KINDS`, factory functions |
| `artifacts/api-server/src/lib/case-print-template.ts` | Server-side schema: `elementSchema` includes `showColumns`; `INVOICE_ELEMENT_KINDS` exported |
| `artifacts/labtrax-desktop/src/lib/print.ts` | Print rendering: `resolveInvoiceScalarValue`, `renderInvoiceLineItemsElement`, CSS for invoice table |
| `artifacts/labtrax-desktop/src/components/CasePrintLayoutEditor.tsx` | Editor UI: Invoice Fields left-rail section, column-toggle panel, invoice fetch in preview picker |
| `artifacts/labtrax-desktop/src/pages/cases.tsx` | Passes `invoice` to `printCaseCardAdvanced` from the case drawer |
