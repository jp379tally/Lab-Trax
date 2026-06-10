# Mobile Rebuild — Rollback Plan

> Planning artifact. Defines how to safely back out of the mobile rebuild at each
> phase if a regression or production incident occurs. The rebuild is designed to be
> **reversible at every stage** because it does not destroy legacy data. Documentation
> only.

## Core safety property
The rebuild is **additive on the server side**. The legacy `lab_cases` table and the
`/api/legacy/cases` routes are never deleted during the rebuild — they become a
read-only historical archive. This means a rollback is always a **client revert**, not
a data restore. No customer data is at risk of loss from a rollback.

## Rollback triggers
Roll back if any of these occur after a rebuild phase ships:
- A protected workflow test (see test plan) fails in CI or on device.
- A production incident in any of the five regression categories (case sync, invoice
  generation, photo attachments, location updates, duplicate invoices).
- Cross-client divergence: a case/invoice/photo created on the rebuilt mobile client
  does not appear correctly on desktop/web.
- Auth/token failures (Bearer refresh loop, blank media after token expiry).

## Phase-by-phase rollback

### Phase 1 — Shared auth + API client layer
- **Change:** adds ported `apiFetch` + `QueryClientProvider`; no screen behavior change
  yet.
- **Rollback:** revert the layer commit. `resilientFetch` and `AppContext` remain
  intact and untouched, so the app returns to current behavior immediately.
- **Risk:** low — additive infrastructure.

### Phase 2 — Core case/invoice screens on canonical hooks
- **Change:** `cases.tsx`, `case/[id].tsx`, `invoices`, `invoice/[id]` read/write
  canonical endpoints.
- **Rollback:** revert the screen commits to the legacy `AppContext`/`resilientFetch`
  versions. Because `lab_cases` was still being written in parallel? **No** — once
  Phase 2 ships, new cases go to the canonical `cases` table. See "Data-direction
  rollback" below.
- **Risk:** medium — this is the first phase that changes where new data is written.

### Phase 3 — Camera/QR/uploads
- **Change:** `scan.tsx` creates cases via `POST /api/cases`; uploads go chunked.
- **Rollback:** revert `scan.tsx` and the upload helper. Canonical attachments already
  created remain valid and viewable on desktop.
- **Risk:** medium — verify chunked upload before removing the single-shot path.

### Phase 4 — Remove legacy shims + cutover guard
- **Change:** deletes `case-reconciliation.ts`, `offline-queue.ts`; optionally guards
  legacy write endpoints (410 Gone).
- **Rollback:** this is the **least reversible** phase. Do not ship the legacy-endpoint
  410 guard until Phases 1–3 are proven in production for a defined soak period.
  Deleting the shim files is reversible via git revert, but the 410 guard affects any
  un-migrated client still in the wild (e.g. an old TestFlight build).
- **Mitigation:** gate the 410 guard behind a server flag (env var) so it can be
  toggled off instantly without a redeploy of the client.
- **Risk:** high — treat as a separate, carefully-staged change.

### Phase 5 — Validation
- No production code change; pure verification. Nothing to roll back.

## Data-direction rollback (the important case)
After Phase 2, new cases are written to the canonical `cases` table. If you roll the
**client** back to the legacy version after that point:
- Cases created during the canonical window live in `cases`, not `lab_cases`.
- The legacy client reads `lab_cases` via `/api/legacy/cases` and will **not** see
  those canonical-only cases.

**Mitigation options (decide before Phase 2 ships):**
1. **Forward-only with soak** (recommended): keep each phase in production for a soak
   period with the full protected suite green before proceeding. Roll back only within
   the soak window, before significant canonical-only data accumulates.
2. **Dual-write bridge** (heavier): during Phase 2, have the canonical create path also
   mirror into `lab_cases` so a legacy-client rollback still sees new cases. This adds
   complexity and partially recreates the dual-model problem, so use only if a long
   coexistence window is required.

The recommended path is **forward-only with soak**, because the whole point of the
rebuild is to eliminate the dual model — a long-lived dual-write bridge undermines that.

## Client-distribution rollback (mobile specifics)
Mobile is not a simple web redeploy:
- **Expo OTA / EAS Update:** if the rebuild ships via an OTA update channel, roll back
  by publishing the previous update to the same channel — fast, no store review.
- **Native binary (TestFlight / store build):** a rebuild that changes native config
  requires a new binary. Rollback = re-promote the last-known-good build in TestFlight
  / store, which is slower. Prefer shipping rebuild phases as OTA-compatible where
  possible so rollback stays fast.
- Keep the current production build tagged as last-known-good before each phase.

## Server-side rollback levers (no client change needed)
- **Legacy-endpoint 410 guard** behind an env flag → toggle off to instantly re-admit
  legacy writes.
- `lab_cases` and `tryProjectLegacyCaseForDesktop()` stay in place → historical cases
  always render regardless of client version.

## Rollback decision checklist
1. Identify which phase introduced the regression.
2. If Phase 1 or 3 → straight git revert of that phase's commits.
3. If Phase 2 → revert client; assess canonical-only data accumulated during the
   window; if significant, prefer fix-forward over revert.
4. If Phase 4 (410 guard) → toggle the server env flag off first (instant), then
   decide on code revert.
5. Re-run the full protected suite after any rollback to confirm the legacy path is
   green again.
6. Record the incident and the regression category to feed the fix-forward plan.
