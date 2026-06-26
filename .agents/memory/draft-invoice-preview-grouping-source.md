---
name: Draft-invoice preview grouping vs the case invoice path
description: Which code path actually produces a case's invoice lines, and why the preview only matches after restorations/connectors sync.
---

Two different code paths produce a case's invoice lines, and they DO NOT agree:

- **POST /cases auto-invoice** builds lines with an **inline, ungrouped** loop
  (one `invoiceLineItems` row per restoration, descriptions via
  `buildLineItemDescription`). It does NOT collapse pontic bridge spans, does
  NOT group same-material restorations, and `createCaseSchema` does NOT even
  accept `bridgeConnectors`, so bridges can't collapse at create time.
- **`syncInvoiceFromRestorations`** (`lib/invoice-sync.ts`) builds lines with
  `buildBridgeAwareLineItems` (shared `lib/invoice-line-grouping.ts`) —
  collapsing bridges and grouping same-material lines. It runs on restoration
  add/delete/price-edit and on the case PATCH route when `bridgeConnectors`
  changes (which also reprices pontics via `_repricePonticsInSpans`).
- **POST /invoices/preview-draft** mirrors the GROUPED path
  (`buildBridgeAwareLineItems`), accepting `bridgeConnectors` inline.

**Consequence (verified empirically):** preview line items match the invoice
ONLY after the case has gone through `syncInvoiceFromRestorations` (e.g. drawing
bridge connectors or editing a restoration). The grand total matches immediately
(grouping doesn't change the sum), but the per-line descriptions/totals differ
between the fresh POST /cases invoice (ungrouped) and the preview (grouped).

**How to apply:** any code/test that must match the preview must compare against
the grouped invoice (post-sync), not the fresh POST /cases invoice. When mirroring
the draft invoice, reuse the shared helpers in `lib/invoice-line-grouping.ts`
(`buildBridgeAwareLineItems`, `buildGroupedSyncItems`); resolve prices with the
same `resolveAllPricesForContext` + `resolveServerPriceWithSource` fallback. Do
not reimplement grouping; do not copy the inline ungrouped POST /cases builder.
The regression test `cases-invoice-preview-match.test.ts` pins preview == grouped
invoice (it PATCHes connectors to force the sync path before comparing).
