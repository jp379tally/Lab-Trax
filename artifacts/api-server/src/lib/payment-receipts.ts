import PDFDocument from "pdfkit";
import { formatNumericDate } from "./date-format";

export const DEFAULT_PAYMENT_RECEIPT_SUBJECT =
  "Payment receipt from {{labName}} — {{receiptNumber}}";
export const DEFAULT_PAYMENT_RECEIPT_BODY = [
  "Hello {{customerName}},",
  "",
  "Thank you for your payment to {{labName}}.",
  "Practice: {{practiceName}}",
  "Doctor: {{doctorName}}",
  "Receipt: {{receiptNumber}}",
  "Payment date: {{paymentDate}}",
  "Amount received: {{amountReceived}}",
  "Amount applied: {{amountApplied}}",
  "Account credit: {{customerCredit}}",
  "Remaining account balance: {{openBalance}}",
  "Payment method: {{paymentMethod}}",
  "{{referenceLine}}",
  "",
  "Thank you,",
  "{{labName}}",
].join("\n");

export const PAYMENT_RECEIPT_PLACEHOLDERS = [
  "receiptNumber",
  "labName",
  "practiceName",
  "doctorName",
  "paymentScope",
  "customerName",
  "paymentDate",
  "amountReceived",
  "amountApplied",
  "customerCredit",
  "openBalance",
  "paymentMethod",
  "referenceNumber",
  "referenceLine",
] as const;

export type PaymentReceiptTemplate = {
  emailSubject: string | null;
  emailBody: string | null;
};

export type PaymentReceiptApplication = {
  invoiceNumber: string;
  patientName: string | null;
  statementInvoiceAmount?: string | null;
  amount: string;
  invoiceBalanceBefore: string;
  invoiceBalanceAfter: string;
};

export type PaymentReceiptData = {
  receiptNumber: string;
  labName: string;
  /** Immutable practice/customer name captured when the payment session was created. */
  practiceName: string;
  /** Immutable doctor scope captured when the payment session was created. */
  doctorDisplayName: string | null;
  customerName: string;
  customerEmail: string | null;
  customerAddress: Record<string, unknown> | null;
  paymentDate: Date;
  receivedAmount: string;
  appliedAmount: string;
  customerCreditAmount: string;
  accountBalanceAfter: string;
  paymentMethod: string;
  checkNumber: string | null;
  cardLast4: string | null;
  memo: string | null;
  status: string;
  applications: PaymentReceiptApplication[];
};

export function defaultPaymentReceiptTemplate(): {
  emailSubject: string;
  emailBody: string;
} {
  return {
    emailSubject: DEFAULT_PAYMENT_RECEIPT_SUBJECT,
    emailBody: DEFAULT_PAYMENT_RECEIPT_BODY,
  };
}

export function normalizePaymentReceiptTemplate(
  value: unknown,
): { emailSubject: string; emailBody: string } {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    emailSubject:
      typeof source.emailSubject === "string" && source.emailSubject.trim()
        ? source.emailSubject.trim()
        : DEFAULT_PAYMENT_RECEIPT_SUBJECT,
    emailBody:
      typeof source.emailBody === "string" && source.emailBody.trim()
        ? source.emailBody
        : DEFAULT_PAYMENT_RECEIPT_BODY,
  };
}

export function renderPaymentReceiptTemplate(
  template: string,
  data: PaymentReceiptData,
): string {
  const referenceNumber = data.checkNumber ?? data.cardLast4 ?? "";
  const referenceLine = referenceNumber
    ? `Reference: ${referenceNumber}`
    : "";
  const values: Record<string, string> = {
    receiptNumber: data.receiptNumber,
    labName: data.labName,
    practiceName: data.practiceName,
    doctorName: data.doctorDisplayName || "Entire practice",
    paymentScope: data.doctorDisplayName
      ? `Doctor: ${data.doctorDisplayName}`
      : "Entire practice",
    customerName: data.customerName || "Customer",
    paymentDate: formatNumericDate(data.paymentDate),
    amountReceived: formatMoney(data.receivedAmount),
    amountApplied: formatMoney(data.appliedAmount),
    customerCredit: formatMoney(data.customerCreditAmount),
    openBalance: formatMoney(data.accountBalanceAfter),
    paymentMethod: paymentMethodLabel(data.paymentMethod),
    referenceNumber,
    referenceLine,
  };
  return template.replace(
    /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g,
    (_match, name: string) => values[name] ?? "",
  );
}

function formatMoney(value: string | number): string {
  return `$${Number(value || 0).toFixed(2)}`;
}

function paymentMethodLabel(value: string): string {
  return (
    {
      ach: "ACH",
      card: "Card",
      cash: "Cash",
      check: "Check",
      other: "Other",
    }[value] ?? value
  );
}

export function paymentReceiptApplicationLine(
  application: PaymentReceiptApplication,
): string {
  const patient = application.patientName
    ? ` · Patient: ${application.patientName}`
    : "";
  return `${application.invoiceNumber}${patient} · Invoice amount ${formatMoney(application.statementInvoiceAmount ?? application.invoiceBalanceBefore)} · Applied ${formatMoney(application.amount)} · Balance ${formatMoney(application.invoiceBalanceAfter)}`;
}

function pdfText(doc: PDFKit.PDFDocument, text: string, options?: PDFKit.Mixins.TextOptions) {
  doc.text(text, options);
}

export async function generatePaymentReceiptPdf(
  data: PaymentReceiptData,
  logoBuffer?: Buffer | null,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (logoBuffer) {
      try {
        doc.image(logoBuffer, { fit: [150, 60] });
        doc.moveDown(0.75);
      } catch {
        // A stale or unsupported stored logo must not prevent a receipt.
      }
    }

    doc.fontSize(20).font("Helvetica-Bold");
    pdfText(doc, "Payment Receipt");
    doc.fontSize(10).font("Helvetica");
    pdfText(doc, data.labName);
    pdfText(doc, `Practice: ${data.practiceName}`);
    pdfText(
      doc,
      `Doctor: ${data.doctorDisplayName || "Entire practice"}`,
    );
    if (data.customerName) pdfText(doc, `Customer: ${data.customerName}`);
    if (data.customerEmail) pdfText(doc, `Email: ${data.customerEmail}`);
    const address = data.customerAddress;
    if (address) {
      const addressLine = [
        address.addressLine1,
        address.addressLine2,
        [address.city, address.state, address.zip].filter(Boolean).join(", "),
      ]
        .filter((part) => typeof part === "string" && part)
        .join(" · ");
      if (addressLine) pdfText(doc, addressLine);
    }

    doc.moveDown();
    doc.font("Helvetica-Bold");
    pdfText(doc, `Receipt number: ${data.receiptNumber}`);
    pdfText(doc, `Payment date: ${formatNumericDate(data.paymentDate)}`);
    pdfText(doc, `Payment method: ${paymentMethodLabel(data.paymentMethod)}`);
    if (data.checkNumber) pdfText(doc, `Check number: ${data.checkNumber}`);
    if (data.cardLast4) pdfText(doc, `Card ending: ${data.cardLast4}`);
    if (data.memo) pdfText(doc, `Memo: ${data.memo}`);

    doc.moveDown();
    doc.font("Helvetica-Bold");
    pdfText(doc, "Invoice applications");
    doc.font("Helvetica");
    if (data.applications.length === 0) {
      pdfText(doc, "No invoice applications — the full payment is account credit.");
    } else {
      for (const application of data.applications) {
        pdfText(doc, paymentReceiptApplicationLine(application));
      }
    }

    doc.moveDown();
    doc.font("Helvetica-Bold");
    pdfText(doc, `Amount received: ${formatMoney(data.receivedAmount)}`);
    pdfText(doc, `Amount applied: ${formatMoney(data.appliedAmount)}`);
    pdfText(
      doc,
      `Account credit: ${formatMoney(data.customerCreditAmount)}`,
    );
    pdfText(
      doc,
      `Remaining account balance: ${formatMoney(data.accountBalanceAfter)}`,
    );
    doc.font("Helvetica");
    pdfText(doc, `Status: ${data.status}`);
    doc.end();
  });
}