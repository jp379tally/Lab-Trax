# Mobile Rebuild — Screen-by-Screen Migration Checklist

> Planning artifact. One row per screen in `artifacts/labtrax/app/`. Tracks what each
> screen uses today and what it migrates to. `resilientFetch` counts are from the
> current codebase (call sites per file). Documentation only — nothing is migrated by
> this file.

## How to read this
- **Legacy data** = touches `/api/legacy/cases`, `lab_cases`, `reconcileCases`, the
  uppercase status enum, or `offline-queue`.
- **Action** = the migration move for the rebuild implementation tasks.
- Each checkbox is left **unchecked** — this is the tracking sheet for the coding
  phases (#1401–#1403), not a record of completed work.

## Tab screens (`app/(tabs)/`)

| Screen | resilientFetch sites | Legacy data? | Migration action |
|---|---|---|---|
| `index.tsx` (dashboard) | — | Yes (batch locate → legacy sync) | [ ] Rebuild dashboard tiles on `useCases`; move batch-locate to `PATCH /api/cases/:id` |
| `cases.tsx` | 1 | Yes (list from AppContext blob) | [ ] Replace with `useCases`; remove AppContext list dependency; server UUID keys |
| `scan.tsx` (AI Reader) | 7 | Yes (case create → `/api/legacy/cases`) | [ ] Keep `POST /api/analyze-prescription`; switch case-create to `POST /api/cases` |
| `messages.tsx` | — | No | [ ] Confirm messenger uses canonical endpoints; swap to hooks where available |
| `notifications.tsx` | — | No | [ ] Port to hook-based fetch; no data-model change |
| `profile.tsx` | 2 | No | [ ] Swap `resilientFetch` → `apiFetch`/hooks; `organization.type` (not `userType`) |

## Case + invoice screens

| Screen | resilientFetch sites | Legacy data? | Migration action |
|---|---|---|---|
| `case/[id].tsx` | 20 | Yes (detail + remake from `/api/legacy/cases/:id`) | [ ] Rebuild on `useCase`; remake via `/api/cases/:id/remake-chain`; photos via `caseAttachments` |
| `invoice/[id].tsx` | 3 | No (already canonical) | [ ] Swap to `useInvoice`/`useUpdateInvoice`; preserve line-item logic |
| `invoices.tsx` | 2 | No (already canonical) | [ ] Swap to `useInvoices` |

## Finance screens

| Screen | resilientFetch sites | Legacy data? | Migration action |
|---|---|---|---|
| `bank-register.tsx` | 9 | No | [ ] Port to hooks; no case-model change (Phase 4 parity) |
| `receive-payments.tsx` | 5 | No | [ ] Port to hooks; preserve deposit logic |
| `reports.tsx` | 7 | No | [ ] Port to hooks; reports already canonical |
| `statements.tsx` | 10 | No | [ ] Port to hooks; statement PDF/email unchanged |
| `pricing.tsx` | 6 | No | [ ] Port to hooks; pricing-tier model unchanged |
| `payees.tsx` | — | No | [ ] Port to hooks |
| `customers.tsx` | — | No | [ ] Port to hooks |

## Communication + misc screens

| Screen | resilientFetch sites | Legacy data? | Migration action |
|---|---|---|---|
| `chat.tsx` | 6 | No | [ ] Port to hooks (AI chat unchanged) |
| `messenger/[id].tsx` | — | No | [ ] Port to hooks; messenger-context already canonical |
| `chart-history.tsx` | — | Possibly (case history) | [ ] Verify source; move to `/api/cases/:id` history |
| `lists.tsx` | 11 | No | [ ] Port to hooks |
| `link-labs.tsx` | — | No | [ ] No change (uses `/api/account-links/manual`) |
| `smile-preview.tsx` | 2 | No | [ ] Port to hooks (AI feature unchanged) |
| `download.tsx` | — | No | [ ] No change |
| `settings.tsx` | 23 | No | [ ] Port to hooks/apiFetch; largest single migration surface |
| `subscription.tsx` | 5 | No | [ ] Port to hooks; billing unchanged |
| `two-factor.tsx` | — | No | [ ] Port to apiFetch |
| `privacy-policy.tsx` / `terms-of-service.tsx` | — | No | [ ] Static; no change |
| `_layout.tsx` / `(tabs)/_layout.tsx` | 2 | No | [ ] Wire `QueryClientProvider`; keep biometric lock + idle timer |
| `+native-intent.tsx` | — | Yes (deep-link → case ID) | [ ] Resolve `labtrax://cases/:id` to canonical UUID only |
| `+not-found.tsx` | — | No | [ ] No change |

## Shared lib / components to rework

| File | Role today | Migration action |
|---|---|---|
| `lib/app-context.tsx` (34 sites) | Local case state + reconcile + legacy fetch | [ ] Strip case state + `reconcileCases`; keep only auth/session glue |
| `lib/case-reconciliation.ts` | Two-snapshot merge | [ ] Delete (Phase 4) |
| `lib/offline-queue.ts` | AsyncStorage write queue | [ ] Delete; React Query mutation retry |
| `lib/data.ts` | `isCanonicalCaseId`, uppercase enum, mock data | [ ] Remove `isCanonicalCaseId` + uppercase enum; canonical statuses only |
| `lib/query-client.ts` (8 sites) | `resilientFetch` + upload | [ ] Replace with `apiFetch` + chunked upload helper |
| `components/PendingSyncBanner.tsx` | Offline-queue UI | [ ] Remove or repurpose for React Query mutation state |
| `components/LabFileDropZone.tsx` (7 sites) | File upload | [ ] Route through chunked `/media/upload-session` |
| `lib/auth-context.tsx` (11 sites) | Token/session | [ ] Keep; back with ported `apiFetch` refresh |

## Migration order (maps to follow-up tasks)
- **#1401 (Phases 1–2)**: `_layout`, `cases`, `case/[id]`, `invoices`, `invoice/[id]`,
  `app-context`, `query-client`, `data.ts`.
- **#1402 (Phase 3)**: `scan`, `+native-intent`, `LabFileDropZone`, upload pipeline.
- **#1403 (Phases 4–5)**: finance + comms screens, delete `case-reconciliation`,
  `offline-queue`, `PendingSyncBanner`; validation.
