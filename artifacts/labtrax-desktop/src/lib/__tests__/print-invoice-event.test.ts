import { describe, it, expect } from "vitest";
import { eventMetaLine } from "../print";
import type { CaseEvent } from "../types";

// ---------------------------------------------------------------------------
// The printed case history (printCaseHistory) renders one "meta" line per
// event. For bulk invoice status changes the on-screen History tab shows the
// invoice number plus a previousStatus → newStatus transition; these tests pin
// that the printed meta line surfaces the same details for invoice_updated and
// invoice_voided events.
// ---------------------------------------------------------------------------

function event(
  eventType: string,
  metadataJson: Record<string, unknown>,
): CaseEvent {
  return {
    id: "evt-1",
    caseId: "case-1",
    eventType,
    metadataJson,
    occurredAt: "2026-06-30T00:00:00.000Z",
    createdAt: "2026-06-30T00:00:00.000Z",
  };
}

describe("eventMetaLine — invoice events", () => {
  it("shows invoice number and status transition for invoice_updated", () => {
    const line = eventMetaLine(
      event("invoice_updated", {
        invoiceNumber: "INV-123",
        previousStatus: "draft",
        newStatus: "open",
      }),
    );
    expect(line).toBe("Invoice INV-123 · Draft → Open");
  });

  it("shows invoice number and status transition for invoice_voided", () => {
    const line = eventMetaLine(
      event("invoice_voided", {
        invoiceNumber: "INV-456",
        previousStatus: "partially_paid",
        newStatus: "void",
      }),
    );
    expect(line).toBe("Invoice INV-456 · Partially Paid → Void");
  });

  it("omits the transition when status is unchanged", () => {
    const line = eventMetaLine(
      event("invoice_updated", {
        invoiceNumber: "INV-789",
        previousStatus: "open",
        newStatus: "open",
      }),
    );
    expect(line).toBe("Invoice INV-789");
  });

  it("shows only the invoice number when no status is present", () => {
    const line = eventMetaLine(
      event("invoice_updated", { invoiceNumber: "INV-001" }),
    );
    expect(line).toBe("Invoice INV-001");
  });

  it("shows only the transition when no invoice number is present", () => {
    const line = eventMetaLine(
      event("invoice_voided", {
        previousStatus: "open",
        newStatus: "void",
      }),
    );
    expect(line).toBe("Open → Void");
  });
});
