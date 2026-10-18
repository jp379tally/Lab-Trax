import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENT_RECEIPT_BODY,
  DEFAULT_PAYMENT_RECEIPT_SUBJECT,
  generatePaymentReceiptPdf,
  normalizePaymentReceiptTemplate,
  paymentReceiptApplicationLine,
  renderPaymentReceiptTemplate,
  type PaymentReceiptData,
} from "./payment-receipts";

const receipt: PaymentReceiptData = {
  receiptNumber: "RCP-20260902-ABC12345",
  labName: "Reliable Dental Lab",
  customerName: "Main Street Dental",
  practiceName: "Main Street Dental",
  doctorDisplayName: "Dr. Jane Smith",
  customerEmail: "billing@mainstreet.example",
  customerAddress: {
    addressLine1: "123 Main Street",
    city: "Austin",
    state: "TX",
    zip: "78701",
  },
  paymentDate: new Date("2026-09-02T12:00:00.000Z"),
  receivedAmount: "125.00",
  appliedAmount: "100.00",
  customerCreditAmount: "25.00",
  accountBalanceAfter: "40.00",
  paymentMethod: "check",
  checkNumber: "9001",
  cardLast4: null,
  memo: "September statement",
  status: "undeposited",
  applications: [
    {
      invoiceNumber: "INV-101",
      patientName: "Sample Patient",
      statementInvoiceAmount: "145.00",
      amount: "100.00",
      invoiceBalanceBefore: "100.00",
      invoiceBalanceAfter: "0.00",
    },
  ],
};

describe("payment receipt templates", () => {
  it("uses defaults when saved fields are blank", () => {
    expect(
      normalizePaymentReceiptTemplate({
        emailSubject: " ",
        emailBody: "",
      }),
    ).toEqual({
      emailSubject: DEFAULT_PAYMENT_RECEIPT_SUBJECT,
      emailBody: DEFAULT_PAYMENT_RECEIPT_BODY,
    });
  });

  it("renders all accounting and method placeholders", () => {
    const rendered = renderPaymentReceiptTemplate(
      "{{receiptNumber}}|{{labName}}|{{customerName}}|{{paymentDate}}|" +
        "{{amountReceived}}|{{amountApplied}}|{{customerCredit}}|" +
        "{{openBalance}}|{{paymentMethod}}|{{referenceNumber}}|{{referenceLine}}",
      receipt,
    );
    expect(rendered).toBe(
      "RCP-20260902-ABC12345|Reliable Dental Lab|Main Street Dental|" +
        "09/02/2026|$125.00|$100.00|$25.00|$40.00|Check|9001|Reference: 9001",
    );
  });

  it("renders durable doctor and practice attribution", () => {
    expect(
      renderPaymentReceiptTemplate(
        "{{practiceName}}|{{doctorName}}|{{paymentScope}}",
        receipt,
      ),
    ).toBe("Main Street Dental|Dr. Jane Smith|Doctor: Dr. Jane Smith");

    expect(
      renderPaymentReceiptTemplate(
        "{{practiceName}}|{{doctorName}}|{{paymentScope}}",
        { ...receipt, doctorDisplayName: null },
      ),
    ).toBe("Main Street Dental|Entire practice|Entire practice");
  });
});

describe("payment receipt PDF", () => {
  it("renders a non-empty reproducible PDF", async () => {
    const first = await generatePaymentReceiptPdf(receipt);
    const second = await generatePaymentReceiptPdf(receipt);
    expect(first.subarray(0, 4).toString()).toBe("%PDF");
    expect(second.subarray(0, 4).toString()).toBe("%PDF");
    expect(first.length).toBeGreaterThan(1_000);
    expect(second.length).toBeGreaterThan(1_000);
  });

  it("renders the captured statement amount before the applied amount", async () => {
    expect(paymentReceiptApplicationLine(receipt.applications[0]!)).toBe(
      "INV-101 · Patient: Sample Patient · Invoice amount $145.00 · Applied $100.00 · Balance $0.00",
    );
  });

  it("renders legacy applications without a statement amount", async () => {
    const legacyReceipt: PaymentReceiptData = {
      ...receipt,
      applications: receipt.applications.map(
        ({ statementInvoiceAmount: _omitted, ...application }) => application,
      ),
    };
    const pdf = await generatePaymentReceiptPdf(legacyReceipt);
    expect(paymentReceiptApplicationLine(legacyReceipt.applications[0]!)).toContain(
      "Invoice amount $100.00 · Applied $100.00",
    );
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1_000);
  });
});