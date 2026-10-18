import { describe, it, expect } from "vitest";
import {
  eventAuthorName,
  eventMetaLine,
  eventNoteBody,
  formatEventTitle,
} from "../print";
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

  it("labels date repairs separately with old and corrected dates", () => {
    const repair = event("invoice_dates_repaired", {
      invoiceNumber: "INV-REPAIR",
      authorName: "Olive Owner",
      previousIssuedAt: "2026-01-15T05:00:00.000Z",
      previousDueAt: "2026-02-15T05:00:00.000Z",
      correctedIssuedAt: "2026-01-15T00:00:00.000Z",
      correctedDueAt: "2026-02-15T00:00:00.000Z",
    });

    expect(formatEventTitle(repair.eventType)).toBe("Invoice Dates Repaired");
    expect(eventAuthorName(repair)).toBe("Olive Owner");
    expect(eventMetaLine(repair)).toBe(
      "Invoice INV-REPAIR · Issued: 2026-01-15T05:00:00Z (UTC) → 2026-01-15T00:00:00Z (UTC) · Due: 2026-02-15T05:00:00Z (UTC) → 2026-02-15T00:00:00Z (UTC)",
    );
  });

  it("labels cleared-payment corrections with retained audit details", () => {
    const correction = event("invoice_payments_deleted", {
      invoiceNumber: "INV-CLEAR",
      authorName: "Olive Owner",
      deletedCount: 2,
      reversedDepositCount: 1,
      previousStatus: "paid",
    });

    expect(formatEventTitle(correction.eventType)).toBe(
      "Invoice Payments Deleted",
    );
    expect(eventAuthorName(correction)).toBe("Olive Owner");
    expect(eventMetaLine(correction)).toBe(
      "Invoice INV-CLEAR · 2 cleared payments deleted · Previous status: Paid · 1 linked deposit reversed",
    );
  });

  it("labels doctor identity repairs separately with actor and both identities", () => {
    const repair = event("invoice_doctor_identity_repaired", {
      invoiceNumber: "INV-DOCTOR",
      authorName: "Olive Owner",
      previousDoctorIdentity: null,
      previousDoctorDisplayName: "Dr. Legacy",
      correctedDoctorIdentity: "doctor-profile-corrected",
      correctedDoctorDisplayName: "Dr. Corrected",
    });

    expect(formatEventTitle(repair.eventType)).toBe(
      "Invoice Doctor Identity Repaired",
    );
    expect(eventAuthorName(repair)).toBe("Olive Owner");
    expect(eventMetaLine(repair)).toBe(
      "Invoice INV-DOCTOR · Doctor: Dr. Legacy → Dr. Corrected [doctor-profile-corrected]",
    );
  });
});

describe("printCaseHistory — internal exception notes", () => {
  it("puts internal exception labels, bodies, and responsible lab members in the printed history", () => {
    const historyEvents = [
      event("internal_exception_opened_note", {
        authorName: "Olive Owner",
        noteText: "Margin requires an internal review.",
      }),
      {
        ...event("internal_exception_note_added", {
          authorName: "Tina Tech",
          noteText: "Model checked and re-articulated.",
        }),
        id: "evt-2",
      },
      {
        ...event("internal_exception_resolution_note_added", {
          authorName: "Olive Owner",
          noteText: "Margin corrected before release.",
        }),
        id: "evt-3",
      },
    ];

    expect(historyEvents.map((e) => formatEventTitle(e.eventType))).toEqual([
      "Internal Exception — Issue",
      "Internal Exception Note",
      "Internal Exception — Resolution Note",
    ]);
    expect(historyEvents.map(eventNoteBody)).toEqual([
      "Margin requires an internal review.",
      "Model checked and re-articulated.",
      "Margin corrected before release.",
    ]);
    expect(historyEvents.map(eventAuthorName)).toEqual([
      "Olive Owner",
      "Tina Tech",
      "Olive Owner",
    ]);
  });
});
