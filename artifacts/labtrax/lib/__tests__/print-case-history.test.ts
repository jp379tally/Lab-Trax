// Tests for `lib/printCaseHistory.ts` — the pure `buildCaseHistoryHtml`
// builder behind the mobile "Print case history" export. The on-screen History
// tab renders invoice lifecycle events (invoice_updated / invoice_voided), and
// this guards that the separate printed/exported document does too, so a bulk
// invoice status change is never silently dropped from a shared/printed record.
import { describe, it, expect } from "vitest";

import { buildCaseHistoryHtml, type PrintableEvent } from "@/lib/printCaseHistory";
import { caseWithInvoiceEventHistory } from "./screens/__fixtures__/cases";

describe("buildCaseHistoryHtml — invoice lifecycle events", () => {
  it("renders invoice number and previousStatus → newStatus for invoice events", () => {
    const html = buildCaseHistoryHtml(
      caseWithInvoiceEventHistory,
      caseWithInvoiceEventHistory.events as PrintableEvent[],
    );

    // Event type labels are title-cased.
    expect(html).toContain("Invoice Updated");
    expect(html).toContain("Invoice Voided");

    // The affected invoice number is surfaced so the printed record shows
    // WHICH invoice changed.
    expect(html).toContain("INV-9001");
    expect(html).toContain("INV-9002");

    // The previousStatus → newStatus transition is rendered, title-cased.
    expect(html).toContain("Draft → Open");
    expect(html).toContain("Open → Void");
  });
});
