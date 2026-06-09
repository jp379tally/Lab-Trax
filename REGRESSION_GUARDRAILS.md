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

---

## Zero-Regression Process

Every code change that touches a protected workflow must follow this process, in order:

1. **Identify impact** — before writing any code, identify which protected workflows (sections above) are affected by the change. If in doubt, assume all are affected.
2. **Add or update tests before changing code** — if the change will alter a protected behavior, update or add the regression tests first so that the tests fail against the current code. This proves the tests actually guard the behavior.
3. **Run the full protected suite after every change** — after the code change, run the complete test suite for every affected workflow (see Test Coverage Map below). All previously-passing tests must still pass.
4. **Stop immediately on any failure** — if any protected test fails, stop. Do not merge, publish, or claim the work is done. Fix the regression first.
5. **Never claim success from unit tests alone** — if the unit tests pass but the real app workflow fails (tested manually or via integration/E2E tests), the work is not done. The standard is: the protected workflow works as the user confirmed it.

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

Run command:
```
pnpm --filter @workspace/labtrax run test -- cases.smoke case-detail.smoke
```

### Invoice

| Layer | File | What it guards |
|-------|------|----------------|
| API integration | `artifacts/api-server/src/routes/invoices.test.ts` | Create, status transitions, line items, subtotal, list scoping, auth enforcement |
| API integration | `artifacts/api-server/src/routes/cases-ai-reader.test.ts` | Auto-invoice generated on case creation (the `auto-generates an open invoice` test) |

Run command:
```
pnpm --filter @workspace/api-server run test -- --reporter=verbose invoices cases-ai-reader
```

### Mobile Case Interactions

| Layer | File | What it guards |
|-------|------|----------------|
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/cases.smoke.test.tsx` | Cases screen renders, case numbers visible |
| Mobile unit | `artifacts/labtrax/lib/__tests__/screens/case-detail.smoke.test.tsx` | Case detail renders, empty state, completed case |
| API integration | `artifacts/api-server/src/routes/cases-core.test.ts` | Case lifecycle: create, read, list, patch status, cross-lab scoping, soft-delete |
| Mobile unit | _(pending)_ | Long-press locate — covered by companion restore task |

Run command:
```
pnpm --filter @workspace/labtrax run test -- cases.smoke case-detail.smoke
pnpm --filter @workspace/api-server run test -- --reporter=verbose cases-core
```

### Run the full protected suite at once

```bash
pnpm --filter @workspace/api-server run test -- cases-ai-reader analyze-prescription invoices cases-core
pnpm --filter @workspace/labtrax run test -- cases.smoke case-detail.smoke scan.smoke
```

---

## How to Add a Protected Workflow

A workflow becomes protected when the user explicitly confirms it is working and should not regress. The lifecycle is:

1. **User confirms the workflow works** — the user tests the feature end-to-end and says it is working correctly.
2. **Document it here** — add a new `## Protected Workflow: <Name>` section to this file listing the specific sub-behaviors the user confirmed. Be concrete: describe what the user sees and does, not just what the code does.
3. **Map it in the Test Coverage Map** — add a row to the Test Coverage Map table with the layer (API integration, mobile unit, E2E), the test file, and a one-line description of what it guards. If no test yet guards the behavior, note it as `_(pending)_` and create the test before the section is considered fully protected.
4. **The workflow is now protected** — from this point forward, every code change that touches this workflow must follow the Zero-Regression Process above.

When in doubt about whether a behavior is protected, treat it as protected.
