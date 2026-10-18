import { describe, expect, it } from "vitest";
import { buildInvoicePdf, buildInvoicesPdf, type InvoicePdfOptions } from "../export";

function options(number: string, count = 1): InvoicePdfOptions {
  return {
    invoiceNumber: number, labName: "Lab", practiceName: "Practice", status: "issued",
    subtotal: 10 * count, total: 10 * count, generatedAt: new Date("2026-01-01"),
    items: Array.from({ length: count }, (_, i) => ({ description: `Line ${number}-${i}`, quantity: 1, unitPrice: 10, lineTotal: 10 })),
  };
}
async function pdfText(blob: Blob) {
  return Buffer.from(await blob.arrayBuffer()).toString("latin1");
}
const pages = (text: string) => text.match(/\/Type \/Page\b/g)?.length ?? 0;

describe("shared batch invoice PDF rendering", () => {
  it("adds exactly one page per short invoice, without blank separators", async () => {
    expect(pages(await pdfText(buildInvoicesPdf([options("A"), options("B")])))).toBe(2);
    expect(pages(await pdfText(buildInvoicesPdf([options("A")])))).toBe(1);
  });
  it("retains every page of a long invoice and starts the next invoice on a fresh page", async () => {
    const long = options("LONG", 90);
    const single = await pdfText(buildInvoicePdf(long).blob);
    const batch = await pdfText(buildInvoicesPdf([long, options("NEXT")]));
    expect(pages(single)).toBeGreaterThan(1);
    expect(pages(batch)).toBe(pages(single) + 1);
    expect(batch).toContain("Line LONG-89");
    expect(batch).toContain("#NEXT");
  });
  it("paginates long case and invoice notes without losing their final lines", async () => {
    const opts = { ...options("NOTES"), caseNotes: "Clinical instructions\n".repeat(150) + "LAST RX LINE", notes: "Billing notes\n".repeat(150) + "LAST BILLING LINE" };
    const pdf = await pdfText(buildInvoicesPdf([opts]));
    expect(pages(pdf)).toBeGreaterThan(4);
    expect(pdf).toContain("LAST RX LINE");
    expect(pdf).toContain("LAST BILLING LINE");
  });
  it("rejects empty jobs and bad required branding rather than printing incomplete documents", () => {
    expect(() => buildInvoicesPdf([])).toThrow("No invoices");
    expect(() => buildInvoicesPdf([{ ...options("A"), logoUrl: "data:image/png;base64,bad" }])).toThrow();
  });
});
