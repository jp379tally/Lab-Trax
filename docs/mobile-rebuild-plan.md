# Mobile App Rebuild: Evaluation & Migration Plan

> **Approval gate (governance rule):** No implementation phase of this rebuild
> starts until it is **explicitly approved** by the project owner. Planning,
> investigation, test/guardrail coverage, and documentation may proceed, but any
> code change that begins an implementation phase (Phases 1–5 below) requires a
> prior explicit go-ahead.

## Supporting planning artifacts

Detailed companion documents live in [`docs/mobile-rebuild/`](mobile-rebuild/):
- [Architecture diagram](mobile-rebuild/architecture-diagram.md) — current vs. target
- [Endpoint map](mobile-rebuild/endpoint-map.md) — legacy → canonical, per operation
- [Screen-by-screen migration checklist](mobile-rebuild/screen-migration-checklist.md)
- [Protected workflow test plan](mobile-rebuild/protected-workflow-test-plan.md)
- [Rollback plan](mobile-rebuild/rollback-plan.md)
- [Legacy dependency inventory](mobile-rebuild/legacy-dependency-inventory.md)

## What & Why

The current Expo mobile app has a structural dual-data-model problem that is the root
cause of all five recurring regression categories (case sync, invoice generation, photo
attachments, location updates, duplicate invoices). Patching each symptom individually
cannot fix a structural issue. This document records the evaluation, the recommendation,
and the full migration path.

---

## Option A — Keep patching the current mobile app

### Why it keeps regressing

The current mobile app maintains **two parallel case models**:

| | Legacy | Canonical |
|---|---|---|
| Table | `lab_cases` | `cases` |
| ID format | client-generated timestamp IDs | server-generated UUIDs |
| API path | `/api/legacy/cases` | `/api/cases/:id` |
| Status enum | uppercase (`INTAKE`, `QC`) | lowercase (`received`, `qc`) |
| Photo serving | synthetic IDs resolved from blob + `legacy_case_media` | `caseAttachments` rows |

Every one of the five listed regressions maps directly to this bifurcation:

- **Case sync** — `lib/case-reconciliation.ts` merges two incompatible snapshots on
  every poll; any mismatch between the two writes back bad state.
- **Invoice duplicates** — legacy cases use client-generated IDs; the server cannot
  enforce uniqueness on IDs it did not issue.
- **Photo attachments** — three separate root causes (authorization via attachment
  row, durability on ephemeral disk vs object storage, and client auth-token timing on
  the native `<Image>` component) all trace back to the legacy photo pipeline having no
  `caseAttachments` row and serving via synthetic IDs.
- **Invoice generation** — status mapping (`INTAKE` → `received`) drifts whenever the
  canonical status list changes; a new status on desktop silently breaks mobile invoice
  eligibility checks.
- **Location/station updates** — the offline queue (`lib/offline-queue.ts` in
  `AsyncStorage`) enqueues writes against whichever ID format was stored at queue time;
  after a reconciliation pass the ID can change, leaving the queued write permanently
  unresolvable.

**Verdict:** Option A is not viable long-term. Fixing the structural problem inside the
current codebase requires replacing the reconciliation layer, the offline queue, and the
legacy API routing — which is effectively a rebuild of the data layer anyway, done
inside a codebase that already carries all the legacy weight.

---

## Option B — Rebuild mobile from the stable web/desktop architecture ✅ RECOMMENDED

### Why this is the lower-regression path

The backend is already unified. Every canonical API path (`/api/cases`, `/api/invoices`,
`/api/media/upload-session`, `/api/cases/:id/attachments`) that the desktop uses is
fully available to any bearer-token client. The desktop already proved that these paths
are stable. The mobile rebuild becomes a **thin Expo shell over the same React Query
hooks** — it reuses `@workspace/api-client-react` generated hooks directly, inherits
all desktop bug fixes automatically, and eliminates every legacy shim.

### What gets reused from web/desktop

| Desktop asset | Mobile reuse |
|---|---|
| `@workspace/api-client-react` generated React Query hooks | Direct import — same hooks, same API paths |
| `apiFetch` Bearer token + 401 refresh pattern | Port to mobile (already works with SecureStore) |
| Chunked resumable upload pipeline (`/media/upload-session`) | Replace XHR upload; fixes >20 MB proxy drops |
| `AuthedMedia` blob-URL pattern | Port to RN using `expo-file-system` fetch + `Image` `source={{uri}}` |
| `InvoiceEditor` data model and line-item logic | Reuse via shared API hooks |
| Case status enum (canonical lowercase) | Single source of truth; no mapping layer |
| Attachment row-based photo authorization | Fixes photo blank/401 regressions permanently |

### What gets retired from mobile

| Current mobile code | Reason for retirement |
|---|---|
| `lib/case-reconciliation.ts` | No longer needed; single case table |
| `lib/offline-queue.ts` | Replaced by React Query optimistic updates |
| `lib/data.ts` — `isCanonicalCaseId` routing | No legacy IDs on rebuilt app |
| All `/api/legacy/cases` API calls | Legacy endpoint deprecated for new mobile |
| `lab_cases` table reads/writes from mobile | Desktop never touches it; retire from mobile too |
| Uppercase status enum and mapping | Canonical statuses used directly |
| Legacy photo serving via synthetic IDs | `caseAttachments`-row-based serving only |
| `AppContext` local cases state reconciliation | React Query server state is the only cache |

### Mobile-native features to preserve (ported, not removed)

1. **Camera prescription capture + AI Reader** — `scan.tsx` OCR → AI → case creation.
   Wire directly to `/api/cases` (canonical create) and `/api/cases/analyze-rx` (or
   equivalent). No legacy path needed.
2. **QR / barcode case lookup** — thin search UI over `/api/cases?search=`. No
   mobile-specific endpoint needed.
3. **expo-share-intent** — file receipt from system share sheet; forward directly to
   `/api/media/upload-session` (same chunked pipeline as desktop). Plugin block stays
   in `app.json`.
4. **Biometric lock + idle auto-logout** — keep PanResponder idle timer and
   `expo-local-authentication`; these are purely UI-layer and have no data model
   dependency.
5. **Deep links + QR case jump** — `labtrax://cases/:id` scheme stays; resolves to
   canonical UUID only.

---

## Migration Plan (in order)

### Phase 0 — Freeze and audit (pre-code)
1. **Freeze new mobile development** on the current codebase. No new features or
   patches touch mobile until the migration plan is accepted.
2. **Audit `lab_cases` table usage** — identify all API routes that still write to
   `lab_cases`. Document which are exclusively legacy-mobile paths vs. shared.
3. **Identify all tasks in the queue that touch mobile** — cancel or redirect any
   in-flight proposed tasks that would add new mobile-only logic.

### Phase 1 — Shared auth and API client layer
4. **Port `apiFetch` to mobile** — a mobile-compatible `apiFetch` that reads/writes JWT
   from `SecureStore`, sends `Authorization: Bearer`, handles 401 → refresh. Replaces
   `resilientFetch`. Share as a thin wrapper in a new `lib/api-client-core` package or
   inline in the app.
5. **Wire `@workspace/api-client-react` hooks into the rebuilt mobile app** — configure
   `QueryClientProvider` with the same 30 s `staleTime` as desktop. Generated hooks
   (`useCases`, `useInvoices`, etc.) are the only data-fetch layer.

### Phase 2 — Core case and invoice screens (canonical only)
6. **Cases list and detail** — rewrite using `useCases` / `useCase` hooks. Case IDs
   are server UUIDs only. No reconciliation layer.
7. **Invoice list and detail** — rewrite using `useInvoices` / `useInvoice` hooks.
   Same line-item model as desktop.
8. **Attachment/photo display** — `expo-file-system` fetch with Bearer header → save to
   cache dir → `Image source={{uri: cachedPath}}`. No synthetic IDs.

### Phase 3 — Mobile-native feature ports
9. **Camera Rx capture + AI Reader** — port `scan.tsx` to call canonical case-create
   endpoint post-AI analysis.
10. **QR / barcode lookup** — thin search screen over `/api/cases?search=`.
11. **Resumable upload for photos** — replace XHR upload with chunked
    `/media/upload-session` calls. Fixes >20 MB proxy drops and the expo/fetch
    FormData limitation.
12. **expo-share-intent** — forward received files to `/media/upload-session`.

### Phase 4 — Feature parity and cleanup
13. **Finance screens** — bank register, receive-payments, reports. Port using the same
    canonical hooks.
14. **Messaging** — messenger screens; already use canonical endpoints.
15. **Remove all legacy shims** — delete `lib/case-reconciliation.ts`,
    `lib/offline-queue.ts`, legacy routing in `lib/data.ts`, and all `/api/legacy/cases`
    calls from the mobile codebase.
16. **Deprecate `lab_cases` mobile writes** — API server: guard the legacy write
    endpoints to return 410 Gone for the rebuilt mobile client, preserving read
    access for historical data display only. The concrete contract (implemented and
    covered by `artifacts/api-server/src/routes/legacy-case-mobile-guard.test.ts`):
    - The rebuilt mobile client **must** send the header `X-LabTrax-Client: mobile/2`
      on every request.
    - `POST /api/legacy/cases` **returns 410 Gone** for the rebuilt mobile client
      (guard fires when the `X-LabTrax-Client` header starts with `mobile/` and the
      posted case `id` is a canonical UUID — the routing-bug case the rebuilt client
      could hit). Non-UUID (legacy, client-generated) ids still pass through so old
      clients keep working.
    - **Legacy mobile paths remain available** only for old clients (no/non-matching
      `X-LabTrax-Client` header) and for read-only display of historical `lab_cases`
      data.
    - **No new mobile-created case ever goes through `lab_cases`** — the rebuilt
      client creates/updates cases exclusively via the canonical `cases` table and
      `/api/cases` endpoints.

### Phase 5 — Validation
17. **Regression test pass** — run the existing API server test suite; add mobile
    integration tests against the canonical endpoints for cases, invoices, and media.
18. **Smoke test on device** — camera capture, photo attach, invoice generation, case
    status update — all verified against the canonical API only.

---

## Done looks like
- The mobile app creates, reads, and updates cases exclusively via the canonical
  `cases` table and `/api/cases` endpoints.
- Invoices are generated and displayed using the same hooks and data model as desktop.
- Photos are stored as `caseAttachments` rows and served via the same auth-gated
  URL scheme as desktop. No synthetic IDs.
- Camera Rx capture, QR case lookup, and expo-share-intent all work against the
  canonical API.
- `lib/case-reconciliation.ts`, `lib/offline-queue.ts`, and all legacy routing are
  deleted.
- The five regression categories (case sync, invoice generation, photo attachments,
  location updates, duplicate invoices) have no structural cause to recur.

## Out of scope
- Changes to the `lab_cases` schema or historical data (read-only; not migrated or
  deleted).
- Desktop or API server changes beyond adding any missing canonical API capabilities
  the rebuilt mobile app needs.
- iOS/Android App Store submission (separate task after rebuild validates).

## Key files
- `artifacts/labtrax/app/(tabs)/cases.tsx`
- `artifacts/labtrax/app/case/[id].tsx`
- `artifacts/labtrax/lib/case-reconciliation.ts`
- `artifacts/labtrax/lib/offline-queue.ts`
- `artifacts/labtrax/lib/data.ts`
- `artifacts/labtrax/app/(tabs)/scan.tsx`
- `artifacts/labtrax/lib/query-client.ts`
- `artifacts/labtrax-desktop/src/lib/api.ts`
- `artifacts/labtrax-desktop/src/components/AuthedMedia.tsx`
- `lib/db/src/schema/schema.ts`
- `artifacts/api-server/src/routes/cases.ts`
- `artifacts/api-server/src/routes/finance.ts`
