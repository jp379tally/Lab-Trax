# Mobile Case Detail Functionality — Desktop Parity (Phase 2 Plan)

> **Checkpoint:** "Mobile Case Detail Desktop Parity Plan"
> **Status:** DRAFT — awaiting user approval. **No Phase 2 code will be written until this plan is approved.**
> **Supersedes:** the implicit "viewer is the final product" reading of Phase 1. Phase 1 (Build 239) is the **foundation/shell only**.

---

## 1. Goal & Guiding Principles

Translate **all desktop/web case-detail functionality** to the mobile case-detail screen, adapted for mobile UI. The mobile app must move from **read-only viewer → fully interactive case detail**, with zero workflow divergence from desktop.

Hard constraints (from the request, enforced throughout):

| # | Constraint | How it is enforced |
|---|------------|--------------------|
| 8 | **Canonical DB/API only** | Every action calls a canonical `/api/*` route. No new mobile-only tables or shadow stores. |
| 9 | **No local-only saves** | All mutations write to the server; server is the source of truth. Optimistic UI is allowed, but never a substitute for a server write. (The offline queue was already removed — see memory `mobile-shim-removal`.) |
| 10 | **No AI Reader yet** | AI intake/Reader is **out of scope**. AI-derived fields already on a case (e.g. `suggestedDoctorName`) may be shown read-only as a data source, nothing more. |
| 11 | **No mobile-only divergence** | Every mobile action maps 1:1 to a desktop-supported canonical action. If desktop cannot do it, mobile will not either. |

EAS discipline (unchanged from Phase 1): EAS builds are **manual, paid, and require explicit per-build approval**. Most verification happens in the **Expo dev client / simulator**; TestFlight builds are reserved for final on-device acceptance and are **batched per milestone** to conserve credits. EAS auto-start stays disabled.

---

## 2. Prerequisite — Close the API Contract Gap (contract-first)

Some desktop write actions hit **server routes that are not in the OpenAPI spec**, so no typed React Query hooks exist (desktop calls them via raw `apiFetch`). Per repo convention (`pnpm-workspace` skill: define contract in OpenAPI first, then generate), Phase 2 begins by adding these to `lib/api-spec/openapi.yaml` and running `pnpm --filter @workspace/api-spec run codegen`, so mobile + desktop share typed, validated contracts.

| Route (exists in `cases.ts`) | Method + Path | In OpenAPI today? | Action |
|---|---|---|---|
| Add restoration | `POST /api/cases/:id/restorations` | ❌ | Add to spec → `useAddCaseRestoration` |
| Edit restoration | `PATCH /api/cases/:id/restorations/:rid` | ❌ | Add to spec → `useUpdateCaseRestoration` |
| Delete restoration | `DELETE /api/cases/:id/restorations/:rid` | ❌ | Add to spec → `useDeleteCaseRestoration` |
| Restoration pricing | `GET /api/cases/restorations/pricing` | ❌ | Add to spec → `useCaseRestorationPricing` |
| Add note | `POST /api/cases/:id/notes` | ❌ | Add to spec → `useAddCaseNote` |
| Upload attachment | `POST /api/cases/:id/attachments` | ❌ | Add to spec → `useUploadCaseAttachment` (multipart; mobile keeps XHR `uploadCaseMedia`) |
| Delete attachment | `DELETE /api/cases/:id/attachments/:attId` | ❌ | Add to spec → `useDeleteCaseAttachment` |
| Location/station change | `POST /api/cases/:id/location-changes` | ❌ (verify) | Add to spec → `useChangeCaseLocation` |

Already typed/available (no contract work): `useGetCase`/`useCase`, `useUpdateCase`, `useCaseAttachments`, `useInvoice`/`useInvoices`, `useUpdateInvoice`, `useGenerateInvoiceForCase`, `useReceiveInvoicePayments`, `useNotifyCaseNote`, `useEmailInvoice`, `useSmsInvoice`.

**Decision needed (D1):** `expectedDeliveryDate` and `bridgeConnectors` are edited on desktop but are **not** part of canonical `UpdateCaseInput`. Either (a) add them to the spec so mobile can edit them canonically, or (b) leave them desktop-only for now. Default proposal: **(a)** add `bridgeConnectors` (needed for the interactive tooth chart) and `expectedDeliveryDate` to `UpdateCaseInput`.

---

## 3. Feature Matrix (overview)

| Scope item | Milestone | Canonical endpoint(s) | New hook? | Risk |
|---|---|---|---|---|
| 2. Edit overview fields | M1 | `PATCH /cases/:id` | existing | Low |
| (status/location/station actions) | M1 | `PATCH /cases/:id` (status), `POST /cases/:id/location-changes` | 1 new | Low |
| 4. Edit notes | M1 | `POST /cases/:id/notes`, `POST .../notify` | 1 new | Low |
| 3. Files/photos/PDFs/docs (view+open+upload) | M2 | `GET/POST/DELETE /cases/:id/attachments`, `.../file` | 2 new | Med (upload/proxy) |
| 1. Interactive tooth chart / restorations | M3 | `POST/PATCH/DELETE /cases/:id/restorations`, pricing | 4 new | Med-High |
| 5. Invoice interaction/editing | M4 | `GET/PATCH /invoices/:id`, generate, receive-payments | existing | Med (billing) |
| 6. Lab slip view/print | M5 | `GET /cases/:id` (client-rendered via expo-print) | none | Low-Med |
| 7. Case label print | M5 | `GET /cases/:id` (client-rendered via expo-print) | none | Low |

---

## 4. Per-Feature Plans

Each feature lists: **Desktop source → Mobile plan → Canonical API/hook → Tests → TestFlight acceptance.**

### Feature 1 — Interactive tooth chart / restoration details *(M3)*
- **Desktop source:** `artifacts/labtrax-desktop/src/components/ToothChart.tsx`, `ToothActionDialog.tsx`, and the `CaseDrawer` restorations tab in `src/pages/cases.tsx`. Tap a tooth → Add Crown / Add Pontic / Mark Missing; add/edit/delete restoration line items (tooth #, type, material, shade, qty, unit price); toggle bridge connectors between teeth.
- **Mobile plan:** Promote the existing `ReadOnlyToothChart` to an `InteractiveToothChart` (tap tooth → bottom-sheet action menu). Add a restoration add/edit form (mobile inputs + pickers) and swipe/long-press to delete. Bridge connectors via tap-between-teeth (depends on D1 adding `bridgeConnectors`). Optimistic update, then refetch `useCase`.
- **Canonical API/hook:** `useAddCaseRestoration` (`POST /cases/:id/restorations`), `useUpdateCaseRestoration` (`PATCH …/:rid`), `useDeleteCaseRestoration` (`DELETE …/:rid`), `useCaseRestorationPricing` (`GET /cases/restorations/pricing`); bridge connectors via `useUpdateCase`. *(All new in §2.)*
- **Tests:** server route tests for restoration CRUD (verify/extend in `cases.test.ts`); mobile component test for tooth-selection state + action routing; hook-wiring test mirroring the vi.mock pattern in `lib/__tests__`.
- **TestFlight acceptance:** Add a crown to tooth #14, edit its material, delete it; reopen case → state persisted; open same case on desktop → identical chart + line items.

### Feature 2 — Edit overview fields *(M1)*
- **Desktop source:** `CaseDrawer` `startEdit`/`Field` in `src/pages/cases.tsx` (patient first/last, doctor with datalist, due date, priority).
- **Mobile plan:** Overview tab gains an Edit toggle → inline form (text inputs, doctor suggestions from existing data, date picker, priority segmented control). Save → `useUpdateCase`; cancel discards. No staged/local persistence.
- **Canonical API/hook:** `useUpdateCase` → `PATCH /cases/:id`. Editable fields = canonical `UpdateCaseInput`: `patientFirstName`, `patientLastName`, `doctorName`, `dueDate`, `priority` (and `expectedDeliveryDate` only if D1(a)).
- **Tests:** mutation hook test; form validation (required name, valid date); hydration test extension.
- **TestFlight acceptance:** Edit patient name + due date + priority → save → reload → persisted; desktop reflects the change.

### Feature 3 — View/open files, photos, PDFs, documents *(M2)*
- **Desktop source:** `src/components/AuthedMedia.tsx` (`AuthedImage`/`AuthedVideo`), lightbox, PDFs in new tab; `DesktopFileDropZone` upload.
- **Mobile plan:** Files tab already renders an image grid + lightbox (`AuthedImage`). Add: open PDFs/docs (download via `authedMediaFetch` → `expo-sharing`/system viewer), video playback (`expo-av`), and **upload** via `expo-camera` + `expo-document-picker` → existing XHR `uploadCaseMedia` → attach. Respect the Replit proxy upload limit (chunked `/media/upload-session` for >~20 MB — see memory `replit-proxy-upload-limit`); every persisted file must be backed by a `caseAttachments` row (memory `case-media-attachment-row`). All media fetches route through `authedMediaFetch` with the same-origin guard (memory `authed-media-cache-origin`).
- **Canonical API/hook:** list `useCaseAttachments` (`GET /cases/:id/attachments`); serve `GET /cases/:id/attachments/:attId/file`; upload `useUploadCaseAttachment` (`POST …/attachments`, new); delete `useDeleteCaseAttachment` (`DELETE …/:attId`, new, soft-delete).
- **Tests:** same-origin media-auth test; XHR upload happy-path + attachment-row creation; delete soft-delete assertion.
- **TestFlight acceptance:** Open a PDF and a video; upload one photo from camera and one document from picker → both appear in the grid, persist on reload, and are visible on desktop.

### Feature 4 — Edit notes *(M1)*
- **Desktop source:** notes composer with visibility (Internal Lab Only vs Shared) + per-note notify (email/SMS) in `CaseDrawer`.
- **Mobile plan:** Notes tab gains a composer with a visibility toggle; list shows author/date/visibility (already rendered). Optional "Notify provider" on shared notes.
- **Canonical API/hook:** `useAddCaseNote` (`POST /cases/:id/notes`, new), `useNotifyCaseNote` (`POST …/notes/:noteId/notify`, existing).
- **Tests:** add-note mutation (default visibility), list refresh after add, notify gated to shared notes.
- **TestFlight acceptance:** Add an internal and a shared note → persist + appear on desktop; optional notify dispatches.

### Feature 5 — Invoice interaction / editing *(M4)*
- **Desktop source:** `InvoiceEditor` in `src/pages/invoices.tsx` — generate from restorations, edit line items (desc/qty/price/tax/discount), receive payments.
- **Mobile plan:** Invoice tab: if none, "Generate invoice"; if present, view line items + edit (mobile line-item editor) and save; receive payment (scope-gated). Invoice PDF for view/email/SMS is client-rendered (see Feature 6 approach) → `pdfBase64`.
- **Canonical API/hook:** `useInvoice`/`useGetInvoice` (`GET /invoices/:id`), `useGenerateInvoiceForCase` (`POST /invoices/cases/:id/generate-invoice`), `useUpdateInvoice` (`PATCH /invoices/:id`), `useReceiveInvoicePayments`, `useEmailInvoice`/`useSmsInvoice`. Org-scoped; payment/edit gated to `BILLING_ROLES` server-side.
- **Tests:** invoice update hook + line-item totals; role-gating (non-billing user blocked); generate-from-case path.
- **TestFlight acceptance:** Generate an invoice from a case, edit a line-item price, save → persists + desktop matches; (if in D2 scope) receive a payment updates balance.
- **Decision needed (D2):** Invoice scope for Phase 2 — full parity (edit line items **+ receive payments + email/SMS**) or **view + line-item edit only** (defer payments)? Default proposal: **view + line-item edit + generate**, defer receive-payments/email to a later pass to keep billing risk contained.

### Feature 6 — Lab slip view / edit / print *(M5)*
- **Desktop source:** **client-side** print — `src/lib/print.ts` (`printCaseOverview`) + `src/styles/print.css`, rendered via hidden iframe + `window.print()`. **There is no server lab-slip PDF endpoint.**
- **Mobile plan:** Build an HTML lab-slip template mirroring the desktop layout, populated from canonical case data, then `expo-print` → AirPrint (`printAsync`) and `printToFileAsync` → share/save (`expo-sharing`/`expo-media-library`). "Edit" means the slip reflects the **edited canonical case** (overview + restorations from Features 1–2); it is not a separately editable document — this preserves "no divergence."
- **Canonical API/hook:** `useCase` (`GET /cases/:id`). No new endpoint.
- **Tests:** template renders from a case fixture (HTML snapshot); print invoked with expected content; missing-field fallbacks.
- **TestFlight acceptance:** Open lab slip → AirPrint to a printer and/or save PDF; content matches the case and the desktop slip.

### Feature 7 — Case label print *(M5)*
- **Desktop source:** client-side label print (`print.ts`/`print.css`).
- **Mobile plan:** HTML label template (label-size: case #, patient, doctor, due date, barcode if present) → `expo-print`.
- **Canonical API/hook:** `useCase` (`GET /cases/:id`). No new endpoint.
- **Tests:** label template render incl. case number + patient; barcode presence when available.
- **TestFlight acceptance:** Preview/print label; case number + patient correct and scannable.

### Items 8–11 — Cross-cutting guarantees
Enforced by construction (see §1 table): canonical-only endpoints, no local-only persistence, no AI Reader (AI fields read-only only), and strict 1:1 mapping to desktop-supported actions.

---

## 5. Milestones, Sequencing & TestFlight Batching

Dependencies are explicit; within a milestone, work is parallelizable.

| Milestone | Contents | Depends on | TestFlight build |
|---|---|---|---|
| **M0 — Contract + editing foundation** | §2 OpenAPI additions + codegen; shared mobile form/mutation/bottom-sheet primitives; theming via `useTheme` | — | none (dev only) |
| **M1 — Overview + status/location + notes** | Features 2, 4, status/location actions | M0 | Build N (e.g. 240) |
| **M2 — Files/media** | Feature 3 (view/open + upload/delete) | M0 | Build N+1 |
| **M3 — Tooth chart / restorations** | Feature 1 | M0 (+D1) | Build N+2 |
| **M4 — Invoice** | Feature 5 | M0 (+D2) | Build N+3 |
| **M5 — Lab slip + label print** | Features 6, 7 | M1, M3 (so printed data reflects edits) | Build N+4 |

Each TestFlight build is **explicitly approved before it runs**, auto-bumps the build number, and is preceded by full dev-client verification. Builds can be combined (e.g. M1+M2 in one build) if you want fewer paid builds — your call per milestone.

---

## 6. Testing Strategy & Regression Guardrails

- **Contract:** `pnpm --filter @workspace/api-spec run codegen` then `pnpm run typecheck` after every §2 addition.
- **Server:** extend `artifacts/api-server/src/routes/cases.test.ts` / `invoices` tests for any route whose contract or behavior we touch (org-scoping, soft-delete, billing-role gating).
- **Mobile:** unit/hook tests in `artifacts/labtrax/lib/__tests__` (mirror the existing `vi.mock('@workspace/api-client-react')` pattern; remember mock completeness — memory `vitest-mock-completeness-flake`); component tests for interactive chart + forms.
- **Regression policy:** all protected workflows in `REGRESSION_GUARDRAILS.md` (`api-server-tests`, `labtrax` tests, `regression-tests`) must stay green before any merge/build. Each milestone ends with a green regression run + an architect review.
- **Manual/dev:** Expo dev client on simulator + a physical device before each TestFlight build; TestFlight acceptance checklist (per feature above) on-device after each build.

---

## 7. Risks & Open Decisions (need your input)

- **D1 — Tooth chart fields:** add `bridgeConnectors` (required for interactive chart) and `expectedDeliveryDate` to canonical `UpdateCaseInput`? *(Default: yes.)*
- **D2 — Invoice scope:** full parity incl. receive-payments + email/SMS, or view + line-item edit + generate first, deferring payments? *(Default: defer payments.)*
- **D3 — Build batching:** one TestFlight build per milestone (5 builds) or combine milestones to spend fewer credits? *(Default: per milestone, you approve each.)*
- **Media upload risk:** large STL/3D files vs the ~20 MB proxy limit — chunked upload path must be used (already understood from Phase 0/1 memory).
- **Mobile-only sensitive-key residual** (`@drivesync_*` AsyncStorage fallback) is tracked as a **separate** follow-up, **not** part of Phase 2.

---

## 8. Explicitly Out of Scope for Phase 2

- AI Reader / AI case intake (deferred to a later phase).
- New case creation on mobile (Phase 2 is **case detail**, not intake).
- Any mobile-only feature with no desktop equivalent.
- Offline/local-only persistence of any kind.

---

## 9. What Happens Next

**Awaiting approval.** On approval (and answers to D1–D3), implementation starts at **M0 (contract + foundation)** — no EAS build — followed by milestone-by-milestone delivery, each gated on your explicit TestFlight build approval. **No Phase 2 code will be written until you approve.**
