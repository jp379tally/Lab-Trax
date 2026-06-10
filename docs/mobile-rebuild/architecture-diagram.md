# Mobile Rebuild — Architecture Diagram

> Planning artifact for the LabTrax mobile rebuild on the canonical API (Option B).
> Documentation only — no code changes implied by this file.

## 1. Current architecture (the problem)

The current mobile app runs a **dual data model**. Mobile cases live in their own
`lab_cases` table behind `/api/legacy/cases`, while desktop/web use the canonical
`cases` table behind `/api/cases`. A reconciliation + offline-queue layer tries to
keep the two worlds in sync, and that layer is the structural source of the five
recurring regression categories.

```
                         ┌──────────────────────────────────────────────┐
                         │              API SERVER (Express 5)            │
                         │                                                │
   ┌────────────┐        │   /api/legacy/cases  ─────►  lab_cases table   │
   │   MOBILE    │───────►│     (blob: caseData JSON, client timestamp IDs,│
   │  (Expo RN)  │        │      uppercase status enum, synthetic photos)  │
   │             │        │            │                                   │
   │ resilientFetch        │            │  tryProjectLegacyCaseForDesktop() │
   │ AppContext  │        │            ▼  MOBILE_TO_DESKTOP_STATUS map     │
   │ reconcileCases◄──────┐│   /api/cases  ──────────►  cases table         │
   │ offline-queue│       ││     (server UUIDs, lowercase status,           │
   └────────────┘        ││      caseAttachments rows)                     │
                         ││            ▲                                   │
   ┌────────────┐        ││            │                                   │
   │  DESKTOP    │───────►─┘            │                                   │
   │  (Electron) │        │   /api/invoices, /api/media/upload-session ─────┘
   │   apiFetch  │        │                                                │
   └────────────┘        └──────────────────────────────────────────────┘
   ┌────────────┐                              │
   │    WEB      │──────────────────────────────┘
   └────────────┘
```

### Why this design regresses
- **Two ID namespaces** — mobile generates client timestamp IDs; canonical uses
  server UUIDs. `isCanonicalCaseId()` in `lib/data.ts` branches every write between
  the two endpoints.
- **Two status enums** — mobile uppercase (`INTAKE`, `QC_CHECK`, `COMPLETE`) vs.
  canonical lowercase, bridged by `MOBILE_TO_DESKTOP_STATUS`. A new status added on
  desktop silently breaks mobile.
- **Two photo pipelines** — legacy synthetic photo IDs resolved from the blob +
  `legacy_case_media` ledger, vs. canonical `caseAttachments` rows.
- **A reconciliation layer** — `reconcileCases()` merges two snapshots on every
  poll; mismatches write back bad state.
- **An offline queue** — `offline-queue.ts` enqueues writes keyed by whichever ID
  format was current at enqueue time; a reconciliation pass can invalidate the key.

## 2. Target architecture (Option B)

The rebuilt mobile app becomes a **thin Expo shell over the same canonical API and
the same generated React Query hooks the desktop already uses**. No legacy table,
no reconciliation, no offline queue, one ID namespace, one status enum.

```
   ┌──────────────────────────────┐
   │        MOBILE (Expo RN)       │
   │                              │
   │  Screens (expo-router)        │
   │      │                        │
   │      ▼                        │
   │  @workspace/api-client-react  │   ← SAME generated hooks as desktop
   │  (useCases, useCase,          │
   │   useInvoices, useInvoice…)   │
   │      │                        │
   │      ▼                        │
   │  React Query (QueryClient)    │   ← single server-state cache
   │      │                        │
   │      ▼                        │
   │  apiFetch (Bearer + 401       │   ← ported from desktop src/lib/api.ts
   │   refresh, SecureStore tokens)│
   └──────┬───────────────────────┘
          │  Authorization: Bearer <jwt>
          ▼
   ┌──────────────────────────────────────────────┐
   │              API SERVER (Express 5)            │
   │                                                │
   │   /api/cases               ─►  cases table     │
   │   /api/invoices            ─►  invoices table  │
   │   /api/cases/:id/attachments ─► caseAttachments│
   │   /api/media/upload-session  ─► chunked upload  │
   │   /api/analyze-prescription  ─► AI Reader       │
   └──────────────────────────────────────────────┘
          ▲                         ▲
          │                         │
   ┌────────────┐            ┌────────────┐
   │  DESKTOP    │            │    WEB      │
   │ (Electron)  │            │             │
   └────────────┘            └────────────┘

   lab_cases table ──► READ-ONLY historical archive (not written by rebuilt mobile)
```

### Key properties of the target
- **One data path** — mobile, desktop, and web all read/write the canonical `cases`
  and `invoices` tables through the same hooks. No bridge maps.
- **One ID namespace** — server UUIDs everywhere. `isCanonicalCaseId()` is deleted.
- **One status enum** — canonical lowercase. `MOBILE_TO_DESKTOP_STATUS` is no longer
  exercised by the rebuilt client (kept only for historical `lab_cases` projection).
- **One photo pipeline** — `caseAttachments` rows, auth-gated serving, displayed via
  `expo-file-system` fetch + cached URI (the desktop `AuthedMedia` pattern).
- **No reconciliation / no offline queue** — React Query owns server state; optimistic
  updates + mutation retry replace the bespoke queue.

## 3. Component ownership matrix

| Concern | Current mobile | Target mobile | Source of truth |
|---|---|---|---|
| Data fetching | `resilientFetch` + `AppContext` | `@workspace/api-client-react` hooks | Generated from OpenAPI |
| Server-state cache | `AppContext` local state + reconcile | React Query `QueryClient` | React Query |
| Auth/token | `auth-context` + `resilientFetch` | ported `apiFetch` (Bearer + refresh) | `labtrax-desktop/src/lib/api.ts` |
| Case storage | `lab_cases` via `/api/legacy/cases` | `cases` via `/api/cases` | canonical `cases` table |
| Status model | uppercase enum in `lib/data.ts` | canonical lowercase | `lib/db` schema |
| Photos | synthetic IDs + `legacy_case_media` | `caseAttachments` rows | canonical attachments |
| Uploads | single-shot XHR | chunked `/media/upload-session` | desktop upload pipeline |
| Offline writes | `offline-queue.ts` | React Query mutation retry | React Query |

## 4. Coexistence during migration

The rebuild does **not** delete `lab_cases` or the legacy endpoints. During and after
migration:
- `lab_cases` remains readable so historical mobile-created cases still display on
  desktop/web (`tryProjectLegacyCaseForDesktop()` stays).
- The legacy `/api/legacy/cases` routes remain mounted, but writes are now guarded:
  the rebuilt client sends `X-LabTrax-Client: mobile/2` and `POST /api/legacy/cases`
  returns 410 Gone for it on canonical UUID ids. Legacy paths stay available for old
  clients and historical reads; no new mobile-created case goes through `lab_cases`.
  Covered by `artifacts/api-server/src/routes/legacy-case-mobile-guard.test.ts`.
- The current mobile workflow keeps running unchanged throughout this planning phase.
