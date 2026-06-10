# Mobile Rebuild — Endpoint Map

> Planning artifact. Maps every legacy endpoint the current mobile app calls to its
> canonical replacement. Paths verified against `artifacts/api-server/src/routes/`.
> Documentation only.

## Legend
- **Legacy** — endpoint backed by the `lab_cases` blob table (`/api/legacy/cases`).
- **Canonical** — endpoint backed by the `cases` / `invoices` / `caseAttachments`
  tables, already used by desktop and web.
- **Hook** — the generated `@workspace/api-client-react` hook to use after rebuild.

## 1. Cases

| Operation | Legacy (current mobile) | Canonical (target) | Generated hook |
|---|---|---|---|
| List cases | `GET /api/legacy/cases` | `GET /api/cases` | `useCases` / `useGetCases` |
| Case detail | `GET /api/legacy/cases/:caseId` | `GET /api/cases/:caseId` | `useCase` / `useGetCase` |
| Create case | `POST /api/legacy/cases` (full blob PUT) | `POST /api/cases` | `useCreateCase` |
| Update case | `POST /api/legacy/cases` (re-PUT whole blob) | `PATCH /api/cases/:caseId` | `useUpdateCase` |
| Delete case | `DELETE /api/legacy/cases/:caseId` | `DELETE /api/cases/:caseId` (soft-delete) | `useDeleteCase` |
| Status / location change | `POST /api/legacy/cases` (status in blob) | `PATCH /api/cases/:caseId` (or `/:caseId/location-changes`) | `useUpdateCase` |
| Add case item | local blob + `POST /api/legacy/cases` | `PATCH /api/cases/:caseId/restorations` | `useUpdateRestorations` |
| Notes | inside case blob | `POST /api/cases/:caseId/notes` | `useAddCaseNote` |
| Barcode / QR lookup | client-side scan of blob list | `GET /api/cases/barcode/:code` / `GET /api/cases/by-number/:caseNumber` | `useCaseByBarcode` |
| Quick search | client-side filter of blob list | `GET /api/cases/quick-search` | `useQuickSearchCases` |
| Remake chain | manual fetch of `remakeOfCaseId` blob | `GET /api/cases/:caseId/remake-chain` | `useRemakeChain` |
| AI review ack | n/a (mobile banner only) | `PATCH /api/cases/:caseId/ai-review` | `useAckAiReview` |

> Exact hook names come from Orval codegen (`pnpm --filter @workspace/api-spec run
> codegen`); the implementation task should import the generated names verbatim
> rather than the illustrative names above.

## 2. Photos / attachments

| Operation | Legacy (current mobile) | Canonical (target) |
|---|---|---|
| Upload photo (small) | `POST /api/media/upload` (single-shot XHR) | `POST /api/media/upload` *(kept for small files)* |
| Upload photo (large) | single-shot XHR (drops >~20 MB at proxy) | chunked `/media/upload-session` → `PATCH` chunks → finalize |
| Link photo to case | synthetic photo ID in case blob | `POST /api/cases/:caseId/attachments` (creates `caseAttachments` row) |
| List attachments | parse blob `photos[]` | `GET /api/cases/:caseId/attachments` |
| Serve / view file | `GET /api/cases/:caseId/attachments/:attId/file` (legacy projection) | `GET /api/cases/:caseId/attachments/:attachmentId/file` (auth-gated) |
| Delete attachment | remove from blob | `DELETE /api/cases/:caseId/attachments/:attachmentId` |

**Chunked upload sequence** (from `labtrax-routes.ts`):
1. `POST /api/media/upload-session` → `{ sessionId, uploadedBytes }`
2. `PATCH /api/media/upload-session/:id` (binary chunks, `Upload-Offset` header)
3. finalize on last chunk → returns the stored file URL
4. `GET /api/media/upload-session/:id` to re-check progress / resume

## 3. Invoices

| Operation | Current mobile | Canonical (target) | Generated hook |
|---|---|---|---|
| List invoices | `GET /api/invoices?labOrganizationId=` | same | `useInvoices` |
| Invoice detail | `GET /api/invoices/:id` | same | `useInvoice` |
| Create invoice | `POST /api/invoices` | same | `useCreateInvoice` |
| Status transition | `PATCH /api/invoices/:id` `{status}` | same | `useUpdateInvoice` |
| Line-item edit | `PATCH /api/invoices/:id` `{items}` | same | `useUpdateInvoice` |

> Invoices are **already canonical today** — the mobile app uses `/api/invoices`
> directly. The rebuild mainly replaces `resilientFetch` calls with the generated
> hooks; no endpoint change. Auto-invoice on case creation continues server-side.

## 4. AI Reader

| Operation | Current mobile | Canonical (target) |
|---|---|---|
| Analyze Rx image/PDF | `POST /api/analyze-prescription` | same (unchanged) |
| Create case from AI result | `POST /api/legacy/cases` | `POST /api/cases` |
| iTero import | `POST /api/cases/import-from-itero-rx` | same (already canonical) |

> The AI extraction endpoint is unchanged. Only the **case-creation target** after
> analysis moves from legacy to canonical.

## 5. Endpoints retired from the mobile client after rebuild

These remain mounted server-side for historical `lab_cases` data but are **no longer
called** by the rebuilt mobile client:
- `GET /api/legacy/cases`
- `GET /api/legacy/cases/:caseId`
- `POST /api/legacy/cases`
- `DELETE /api/legacy/cases/:caseId`

The write guard is now implemented: `POST /api/legacy/cases` returns **410 Gone** for
the rebuilt mobile client (header `X-LabTrax-Client: mobile/2`) when it posts a
canonical UUID case id — old clients sending non-UUID legacy ids, and clients without
the header, still pass through. Covered by
`artifacts/api-server/src/routes/legacy-case-mobile-guard.test.ts`. No new
mobile-created case goes through `lab_cases`; legacy reads remain for historical data.
