# Mobile Rebuild — Protected Workflow Test Plan

> Planning artifact. Defines how each protected workflow in
> [`REGRESSION_GUARDRAILS.md`](../../REGRESSION_GUARDRAILS.md) is verified to still
> pass after the mobile rebuild. The rebuild must follow the Zero-Regression Process:
> tests updated before code, full protected suite green before any merge/publish.
> Documentation only.

## Ground rule
The rebuild changes the mobile **client's** data path, but every protected behavior is
defined at the **API + cross-client** level. The rebuild must keep all seven protected
workflows green. Where a protected sub-behavior is currently expressed in terms of the
legacy path (e.g. "POSTs to `/api/legacy/cases`"), the test plan notes the canonical
equivalent the rebuilt client must satisfy instead — **without weakening the assertion**.

## 1. AI Reader
**Guarded by:** `analyze-prescription.test.ts`, `cases-ai-reader.test.ts`,
`scan.smoke.test.tsx`.

| Sub-behavior | Rebuild impact | Verification |
|---|---|---|
| Exact provider auto-assign | none (client UI logic) | `scan.smoke` must still pass after `scan.tsx` rewrite |
| Similar-provider prompt (edit dist ≤1) | none | `scan.smoke` |
| All extracted fields propagate | AI→setState wiring rebuilt | `scan.smoke` — assert patient/type/shade reach the new-case form |
| Duplicate-patient warning | none | `scan.smoke` |
| 503 when AI unconfigured | none (server) | `analyze-prescription.test.ts` |
| iTero import creates case w/ review flag | case-create now canonical | `cases-ai-reader.test.ts` (already canonical) |
| AI review acknowledgement | none | `cases-ai-reader.test.ts` |

**New coverage required:** a smoke test asserting the AI flow creates the case via
`POST /api/cases` (canonical) and the new-case form is pre-filled — replacing any test
that asserted the legacy create path.

## 2. Mobile/Web/Desktop Sync
**Guarded by:** `cases.smoke.test.tsx`, `case-detail.smoke.test.tsx`,
`mobile-sync-invoice.test.ts`.

| Sub-behavior | Rebuild impact | Verification |
|---|---|---|
| Case list reflects server state | list now from `useCases` | `cases.smoke` rewritten against React Query cache |
| Case detail reflects server state | detail from `useCase` | `case-detail.smoke` |
| Edit saves propagate to invoice | `updateCase` + `updateInvoice` → hooks | `case-detail.smoke` — assert both mutations fire |
| Add-item propagates to invoice | hook-based | `case-detail.smoke` |
| AI-imported banner renders | banner reads canonical `needsAiReview` | `case-detail.smoke` |

**Note on `mobile-sync-invoice.test.ts`:** this currently asserts the *client-generated
ID is preserved unchanged* through legacy sync. After cutover the rebuilt client uses
server UUIDs, so this invariant **changes meaning**. The implementation task must
update this test to assert canonical-ID round-trip consistency — and must NOT delete
the cross-client sync assertion. Flagged as the single highest-risk test rewrite.

## 3. Invoice
**Guarded by:** `invoices.test.ts`, `cases-ai-reader.test.ts`,
`cases-invoice-creation.test.ts`.

All three are **server-side** and already canonical. The rebuild should not change
them. Re-run unchanged:
- Auto-invoice on case creation (within 2 s, correct org IDs).
- Create / status transition / line-item subtotal / list scoping / auth.

**New coverage required:** mobile integration test that creating a case via the rebuilt
client surfaces the auto-created invoice through `useInvoices`.

## 4. Mobile Case Interactions
**Guarded by:** `cases.smoke.test.tsx`, `case-detail.smoke.test.tsx`,
`cases-core.test.ts`.

| Sub-behavior | Rebuild impact | Verification |
|---|---|---|
| Cases screen renders w/ case numbers | rebuilt on hooks | `cases.smoke` |
| Case detail renders / "Case not found" | rebuilt on hooks | `case-detail.smoke` |
| Completed-case detail renders | rebuilt | `case-detail.smoke` |
| Long-press locate | now `PATCH /api/cases/:id` | restore + update `cases.smoke` locate test |
| Case lifecycle / soft-delete / scoping | server (canonical) | `cases-core.test.ts` unchanged |

## 5. E2E Browser Tests
**Guarded by:** `e2e/ai-reader-mobile-scan.spec.ts`,
`e2e/mobile-photo-web-view.spec.ts`, `e2e/long-press-locate-case.spec.ts`.

Run `pnpm test:e2e` against the rebuilt Expo web build. The photo-web-view spec is the
key cross-client guard: a mobile-uploaded photo must be viewable on desktop with no
401/403. After the rebuild this exercises the `caseAttachments` path end-to-end.

## 6. Mobile Prescription Image Cross-Platform Visibility
**Guarded by:** `cases-attachments.test.ts`, `cases-prescription-photo.test.ts`.

| Sub-behavior | Rebuild impact | Verification |
|---|---|---|
| Camera photo uploaded to server | upload now chunked → `caseAttachments` | `cases-prescription-photo.test.ts` |
| Attachment linked to Case ID | now canonical `caseId` (not `labCaseId`) | **update test** to assert canonical FK |
| Web/desktop Files tab shows image | `GET /api/cases/:id/attachments` | unchanged |
| Auth-gated serving (no 401/403) | unchanged | `cases-prescription-photo.test.ts` |
| No regression on core workflow | full chain | re-run full suite |

**Highest-value rebuild win:** the three photo-blank root causes (attachment-row auth,
durability, client image-auth timing) all collapse once photos always have a
`caseAttachments` row and are fetched via the desktop `AuthedMedia` cached-URI pattern.

## 7. Mobile Case Location Cross-Platform Sync
**Guarded by:** `cases-location-sync.test.ts`.

This test is written entirely around the legacy path (`POST /api/legacy/cases`,
`MOBILE_TO_DESKTOP_STATUS`, `tryProjectLegacyCaseForDesktop`). After the rebuild the
client moves to `PATCH /api/cases/:id`. The implementation task must:
- Keep the existing test green for **historical** `lab_cases` data (legacy projection
  stays for archived cases).
- **Add** a parallel test asserting canonical location change (`PATCH /api/cases/:id`)
  is reflected in `GET /api/cases` list and `GET /api/cases/:id` detail, and that
  list + detail agree.
- Single locate and batch locate must both sync (the batch-locate silent-loss bug must
  not reappear in the rebuilt batch path).

## Pre-publish gates (all four required before any release)
| Gate | Command |
|---|---|
| Mobile unit | `pnpm --filter @workspace/labtrax run test` |
| API integration | `pnpm --filter @workspace/api-server run test` |
| E2E browser | `pnpm test:e2e` |
| Real-device TestFlight | Manual: AI Reader → case create → sync → invoice |

## Full protected suite (single run)
```bash
pnpm --filter @workspace/api-server run test -- cases-ai-reader analyze-prescription \
  invoices cases-core cases-invoice-creation mobile-sync-invoice cases-attachments \
  cases-prescription-photo cases-location-sync
pnpm --filter @workspace/labtrax run test -- cases.smoke case-detail.smoke scan.smoke
pnpm test:e2e
```

## Test-rewrite risk register (for the coding phases)
1. `mobile-sync-invoice.test.ts` — ID-preservation invariant changes meaning.
2. `cases-location-sync.test.ts` — entirely legacy-path; needs canonical parallel.
3. `cases-prescription-photo.test.ts` / `cases-attachments.test.ts` — `labCaseId` →
   canonical `caseId` FK.
These three must be updated **before** the corresponding code change (Zero-Regression
Process step 2), and must not lose any cross-client assertion.
