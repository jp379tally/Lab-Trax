# Mobile Rebuild — Legacy Dependency Inventory

> Planning artifact. A grounded inventory of every dependency on the four legacy
> pillars — `/api/legacy/cases`, the `lab_cases` table, `case-reconciliation`, and
> `offline-queue` — across the codebase. Generated from `rg` over the current tree.
> Documentation only — nothing is removed by this file.

## Summary table

| Pillar | Mobile call sites | Server-side defs | Retire from mobile? | Keep server-side? |
|---|---|---|---|---|
| `/api/legacy/cases` | `app-context.tsx`, `case/[id].tsx` (+ tests, comments) | `labtrax-routes.ts` (4 routes) | Yes (Phase 2–4) | Yes — read-only for historical data |
| `lab_cases` table | via legacy endpoints only | schema + 9 route/lib files (+ tests) | Yes (stop writing) | Yes — historical archive |
| `case-reconciliation` | `app-context.tsx` | n/a (client-only) | Yes — delete (Phase 4) | n/a |
| `offline-queue` | `app-context.tsx`, `query-client.ts`, `PendingSyncBanner.tsx` | n/a (client-only) | Yes — delete (Phase 4) | n/a |

## 1. `/api/legacy/cases` — call sites

### Mobile production code (must migrate)
- `lib/app-context.tsx`
  - L408 — comment: visibility derived from `lab_memberships`
  - L513 — `POST /api/legacy/cases` (create/update whole-blob sync)
  - L530 — `DELETE /api/legacy/cases/:caseId`
  - L550 — `GET /api/legacy/cases` (list)
  - L1961 — `GET /api/legacy/cases` (probe)
- `app/case/[id].tsx`
  - L539 — `GET /api/legacy/cases/:id` (detail)
  - L558 — `GET /api/legacy/cases/:id` (detail)
  - L607 — comment: remake-chain reads `remakeOfCaseId` blob `activityLog`
  - L676 — `GET /api/legacy/cases/:remakeOfCaseId` (remake source)
- `app/(tabs)/scan.tsx`
  - L3059 — comment: AI-built payload persisted via `POST /api/legacy/cases`

### Mobile tests (update alongside migration)
- `vitest.setup.ts` L94 — legacy detail override helper
- `lib/__tests__/offline-queue-integration.test.tsx` L40, L237, L429, L510, L525 —
  legacy status-sync POST assertions
- `lib/__tests__/screens/case-detail.smoke.test.tsx` L114, L117 — stubs legacy detail
- `lib/case-reconciliation.ts` L6 — comment referencing `GET /api/legacy/cases`

### Server-side route definitions (KEEP for historical data)
`artifacts/api-server/src/routes/labtrax-routes.ts`:
- L1382 — `POST /legacy/cases`
- L1804 — `GET /legacy/cases`
- L2436 — `GET /legacy/cases/:caseId`
- L2774 — `DELETE /legacy/cases/:caseId`

> Cutover (Phase 4) may add a flag-gated 410 guard on the write routes for the rebuilt
> client. Out of scope here.

## 2. `lab_cases` table — references

> The rebuilt mobile client stops **writing** `lab_cases`. The table and its
> server-side readers stay so historical mobile-created cases still render on
> desktop/web. The implementation tasks must not delete any of these without an
> explicit data-archival decision.

### Schema
- `lib/db/src/schema/schema.ts` — `lab_cases` table definition (source of truth)

### Server production code (reads/projections — KEEP)
- `artifacts/api-server/src/routes/labtrax-routes.ts` — legacy routes + projection
- `artifacts/api-server/src/routes/cases.ts` — `tryProjectLegacyCaseForDesktop`,
  `MOBILE_TO_DESKTOP_STATUS` bridge in `GET /api/cases`
- `artifacts/api-server/src/routes/invoices.ts`
- `artifacts/api-server/src/routes/organizations.ts`
- `artifacts/api-server/src/routes/doctors.ts`
- `artifacts/api-server/src/lib/case-media.ts`
- `artifacts/api-server/src/lib/backup.ts`
- `artifacts/api-server/src/storage.ts`
- `artifacts/api-server/src/index.ts`

### Server tests referencing `lab_cases` (update only if behavior changes)
- `routes/legacy-attachments.test.ts`, `routes/legacy-case-history-merge.test.ts`,
  `routes/legacy-case-media-serving.test.ts`, `routes/cases-location-sync.test.ts`,
  `routes/cases-attachments.test.ts`, `routes/cases-mobile-photo-attachment.test.ts`,
  `routes/cases-prescription-photo.test.ts`, `routes/cases-invoice-creation.test.ts`,
  `routes/cases-similarity.test.ts`, `routes/mobile-sync-invoice.test.ts`,
  `admin-subscriptions.test.ts`, `installer-storage-e2e.test.ts`,
  `installer-publish-e2e.test.ts`

## 3. `case-reconciliation` — references (DELETE from mobile, Phase 4)
- `lib/case-reconciliation.ts` — the `reconcileCases()` implementation
- `lib/app-context.tsx`
  - L64 — `import { reconcileCases } from "./case-reconciliation"`
  - L1800, L1805 — used in the server-fetch merge
  - L2089 — comment: "the server fetch's reconcileCases handles everything else"
- `lib/__tests__/case-reconciliation.test.ts` — full unit suite (delete with the file)

**Replacement:** React Query server-state cache. No two-snapshot merge needed once
there is a single `cases` table.

## 4. `offline-queue` — references (DELETE from mobile, Phase 4)
- `lib/offline-queue.ts` — the queue implementation
- `lib/app-context.tsx` — `enqueueStatus()` / drain on reconnect
- `lib/query-client.ts` — queue integration in the fetch wrapper
- `components/PendingSyncBanner.tsx` — pending-sync UI
- `lib/__tests__/offline-queue.test.ts` — unit suite
- `lib/__tests__/offline-queue-integration.test.tsx` — integration suite

**Replacement:** React Query optimistic updates + mutation retry. The
`PendingSyncBanner` can be removed or repurposed to reflect React Query mutation state.

## 5. `lib/data.ts` legacy routing (part of the dual model)
- L4, L18 — uppercase status enum entries (`INTAKE`, …)
- L251 — `isCanonicalCaseId(id)` — branches writes between legacy and canonical
- L261 — `isCanonicalCase(c)` wrapper
- L361+ — mock/demo data using uppercase `station: "INTAKE"` (test fixtures)

**Action:** remove `isCanonicalCaseId` and the uppercase enum once all screens are on
canonical hooks. Demo fixtures move to canonical lowercase statuses.

## 6. Retirement order (cross-reference to follow-up tasks)
| Pillar | Stops being called in | Deleted in |
|---|---|---|
| `/api/legacy/cases` (mobile) | #1401 (cases/detail), #1402 (scan) | client calls gone after #1403 |
| `case-reconciliation` | #1401 (AppContext stripped) | #1403 (file delete) |
| `offline-queue` | #1402 (uploads → chunked) | #1403 (file delete) |
| `isCanonicalCaseId` / uppercase enum | #1401 | #1403 |
| `lab_cases` writes (mobile) | #1401–#1402 | **never deleted** — read-only archive |

## Verification commands (to re-run this inventory)
```bash
rg -n "api/legacy/cases" artifacts/labtrax
rg -n "case-reconciliation|reconcileCases" artifacts/labtrax
rg -ln "offline-queue" artifacts/labtrax
rg -ln "lab_cases|labCases" artifacts/api-server/src lib/db/src
rg -n "isCanonicalCaseId|INTAKE" artifacts/labtrax/lib/data.ts
```
