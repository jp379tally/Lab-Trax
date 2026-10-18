// Tests for `lib/printCaseHistory.ts` — the pure `buildCaseHistoryHtml`
// builder behind the mobile "Print case history" export. The on-screen History
// tab renders invoice lifecycle events (invoice_updated / invoice_voided), and
// this guards that the separate printed/exported document does too, so a bulk
// invoice status change is never silently dropped from a shared/printed record.
import { describe, it, expect } from "vitest";

import { buildCaseHistoryHtml, type PrintableEvent } from "@/lib/printCaseHistory";
import { caseWithInvoiceEventHistory } from "./screens/__fixtures__/cases";

describe("buildCaseHistoryHtml — invoice lifecycle events", () => {
  it("renders invoice number and previousStatus → newStatus for invoice events", async () => {
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

  it("renders internal exception issue, follow-up, and resolution notes with their authors", async () => {
    const events: PrintableEvent[] = [
      {
        id: "exception-issue",
        eventType: "internal_exception_opened_note",
        occurredAt: "2026-03-01T10:00:00Z",
        metadataJson: {
          authorName: "Olive Owner",
          noteText: "Margin requires an internal review.",
        },
      },
      {
        id: "exception-follow-up",
        eventType: "internal_exception_note_added",
        occurredAt: "2026-03-02T10:00:00Z",
        metadataJson: {
          authorName: "Tina Tech",
          noteText: "Model checked and re-articulated.",
        },
      },
      {
        id: "exception-resolution",
        eventType: "internal_exception_resolution_note_added",
        occurredAt: "2026-03-03T10:00:00Z",
        metadataJson: {
          authorName: "Olive Owner",
          noteText: "Margin corrected before release.",
        },
      },
    ];

    const html = buildCaseHistoryHtml(caseWithInvoiceEventHistory, events);

    expect(html).toContain("Internal Exception — Issue");
    expect(html).toContain("Internal Exception Note");
    expect(html).toContain("Internal Exception — Resolution Note");
    expect(html).toContain("Margin requires an internal review.");
    expect(html).toContain("Model checked and re-articulated.");
    expect(html).toContain("Margin corrected before release.");
    expect(html).toContain("Olive Owner");
    expect(html).toContain("Tina Tech");
  });

  it("renders invoice date repairs separately with actor and old and corrected dates", async () => {
    const html = buildCaseHistoryHtml(caseWithInvoiceEventHistory, [
      {
        id: "date-repair",
        eventType: "invoice_dates_repaired",
        occurredAt: "2026-09-16T14:30:00.000Z",
        metadataJson: {
          invoiceNumber: "INV-REPAIR",
          authorName: "Olive Owner",
          previousIssuedAt: "2026-01-15T05:00:00.000Z",
          previousDueAt: "2026-02-15T05:00:00.000Z",
          correctedIssuedAt: "2026-01-15T00:00:00.000Z",
          correctedDueAt: "2026-02-15T00:00:00.000Z",
        },
      },
    ]);

    expect(html).toContain("Invoice Dates Repaired");
    expect(html).toContain("INV-REPAIR");
    expect(html).toContain("Olive Owner");
    expect(html).toContain(
      "Issued: 2026-01-15T05:00:00Z (UTC) → 2026-01-15T00:00:00Z (UTC)",
    );
    expect(html).toContain(
      "Due: 2026-02-15T05:00:00Z (UTC) → 2026-02-15T00:00:00Z (UTC)",
    );
    expect(html).not.toContain("Invoice Updated");
  });

  it("renders cleared-payment corrections separately with actor and retained audit details", () => {
    const html = buildCaseHistoryHtml(caseWithInvoiceEventHistory, [
      {
        id: "payment-correction",
        eventType: "invoice_payments_deleted",
        occurredAt: "2026-09-17T15:45:00.000Z",
        metadataJson: {
          invoiceNumber: "INV-CLEAR",
          authorName: "Olive Owner",
          deletedCount: 2,
          reversedDepositCount: 1,
          previousStatus: "paid",
        },
      },
    ]);

    expect(html).toContain("Invoice Payments Deleted");
    expect(html).toContain("INV-CLEAR");
    expect(html).toContain("Olive Owner");
    expect(html).toContain("2 cleared payments deleted");
    expect(html).toContain("Previous status: Paid");
    expect(html).toContain("1 linked deposit reversed");
    expect(html).not.toContain("Invoice Updated");
    expect(html).not.toContain("Invoice Dates Repaired");
  });

  it("renders doctor identity repairs separately with actor and both identities", () => {
    const html = buildCaseHistoryHtml(caseWithInvoiceEventHistory, [
      {
        id: "doctor-repair",
        eventType: "invoice_doctor_identity_repaired",
        occurredAt: "2026-09-17T15:45:00.000Z",
        metadataJson: {
          invoiceNumber: "INV-DOCTOR",
          authorName: "Olive Owner",
          previousDoctorIdentity: null,
          previousDoctorDisplayName: "Dr. Legacy",
          correctedDoctorIdentity: "doctor-profile-corrected",
          correctedDoctorDisplayName: "Dr. Corrected",
        },
      },
    ]);

    expect(html).toContain("Invoice Doctor Identity Repaired");
    expect(html).toContain("INV-DOCTOR");
    expect(html).toContain("Olive Owner");
    expect(html).toContain(
      "Doctor: Dr. Legacy → Dr. Corrected [doctor-profile-corrected]",
    );
    expect(html).not.toContain("Invoice Updated");
    expect(html).not.toContain("Invoice Dates Repaired");
  });
});
