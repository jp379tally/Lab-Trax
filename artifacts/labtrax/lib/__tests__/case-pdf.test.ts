// Tests for `lib/case-pdf.ts` — the pure HTML builders and the thin
// expo-print / expo-sharing wrappers. We mock expo-print and expo-sharing so no
// real native I/O happens (mirrors the open-attachment.test.ts pattern).
import { describe, it, expect, beforeEach, vi } from "vitest";

const { printToFileAsync, shareAsync, isAvailableAsync } = vi.hoisted(() => ({
  printToFileAsync: vi.fn(),
  shareAsync: vi.fn(),
  isAvailableAsync: vi.fn(),
}));

vi.mock("expo-print", () => ({ printToFileAsync }));
vi.mock("expo-sharing", () => ({ shareAsync, isAvailableAsync }));

import {
  buildCaseCardHtml,
  buildInvoiceHtml,
  generatePdf,
  sharePdf,
} from "@/lib/case-pdf";

beforeEach(() => {
  vi.clearAllMocks();
  printToFileAsync.mockResolvedValue({ uri: "file:///tmp/doc.pdf", base64: "dGVzdA==" });
  isAvailableAsync.mockResolvedValue(true);
  shareAsync.mockResolvedValue(undefined);
});

describe("buildCaseCardHtml", () => {
  it("renders the case number, patient, doctor and restorations", () => {
    const html = buildCaseCardHtml({
      caseNumber: "5001",
      patientName: "Jane Doe",
      doctorName: "Dr. Smith",
      status: "in_design",
      priority: "rush",
      dueDate: "2024-01-15",
      restorations: [
        { toothNumber: "8", restorationType: "crown", material: "Zirconia", shade: "A2", quantity: 1 },
      ],
      rxNotes: "Handle with care",
      labName: "Acme Dental Lab",
    });

    expect(html).toContain("Work Order");
    expect(html).toContain("#5001");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("Dr. Smith");
    expect(html).toContain("Zirconia");
    expect(html).toContain("Acme Dental Lab");
    // titleCase of the status / priority / restoration type.
    expect(html).toContain("In Design");
    expect(html).toContain("Rush");
    expect(html).toContain("Crown");
    // Rx notes block is rendered when present.
    expect(html).toContain("Handle with care");
  });

  it("escapes HTML-significant characters in user-supplied text", () => {
    const html = buildCaseCardHtml({
      caseNumber: "1",
      patientName: "<script>alert('x')</script>",
      doctorName: "Smith & Sons",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Smith &amp; Sons");
  });

  it("shows an empty-state row when there are no restorations", () => {
    const html = buildCaseCardHtml({ caseNumber: "1", restorations: [] });
    expect(html).toContain("No restorations recorded.");
  });
});

describe("buildInvoiceHtml", () => {
  it("renders invoice metadata, line items and money totals", () => {
    const html = buildInvoiceHtml({
      invoiceNumber: "INV-2024-002",
      status: "paid",
      issuedAt: "2024-01-12T00:00:00.000Z",
      dueAt: "2024-02-11T00:00:00.000Z",
      total: 500,
      balanceDue: 0,
      items: [
        { description: "Zirconia crown", quantity: 2, unitPrice: 250, lineTotal: 500, toothNumbers: "8,9" },
      ],
      patientName: "John Roe",
      caseNumber: "5002",
      labName: "Acme Dental Lab",
    });

    expect(html).toContain("Invoice");
    expect(html).toContain("#INV-2024-002");
    expect(html).toContain("John Roe");
    expect(html).toContain("5002");
    expect(html).toContain("Zirconia crown");
    expect(html).toContain("#8,9");
    // Money is formatted as $x.xx.
    expect(html).toContain("$250.00");
    expect(html).toContain("$500.00");
    expect(html).toContain("$0.00");
    // Status badge title-cased.
    expect(html).toContain("Paid");
  });

  it("shows an empty-state row when there are no line items", () => {
    const html = buildInvoiceHtml({ invoiceNumber: "INV-1", items: [] });
    expect(html).toContain("No line items.");
  });
});

describe("generatePdf", () => {
  it("passes html through to printToFileAsync and returns the uri", async () => {
    const result = await generatePdf("<html></html>");
    expect(printToFileAsync).toHaveBeenCalledWith({ html: "<html></html>", base64: undefined });
    expect(result.uri).toBe("file:///tmp/doc.pdf");
  });

  it("requests base64 bytes when asked and returns them", async () => {
    const result = await generatePdf("<html></html>", { base64: true });
    expect(printToFileAsync).toHaveBeenCalledWith({ html: "<html></html>", base64: true });
    expect(result.base64).toBe("dGVzdA==");
  });
});

describe("sharePdf", () => {
  it("shares the uri with the pdf mime type and UTI", async () => {
    await sharePdf("file:///tmp/doc.pdf", { dialogTitle: "Invoice #1" });
    expect(shareAsync).toHaveBeenCalledTimes(1);
    const [uri, opts] = shareAsync.mock.calls[0] as [string, Record<string, unknown>];
    expect(uri).toBe("file:///tmp/doc.pdf");
    expect(opts).toMatchObject({
      mimeType: "application/pdf",
      UTI: "com.adobe.pdf",
      dialogTitle: "Invoice #1",
    });
  });

  it("throws and never shares when sharing is unavailable", async () => {
    isAvailableAsync.mockResolvedValue(false);
    await expect(sharePdf("file:///tmp/doc.pdf")).rejects.toThrow();
    expect(shareAsync).not.toHaveBeenCalled();
  });

  it("treats an isAvailableAsync error as unavailable", async () => {
    isAvailableAsync.mockRejectedValue(new Error("boom"));
    await expect(sharePdf("file:///tmp/doc.pdf")).rejects.toThrow();
    expect(shareAsync).not.toHaveBeenCalled();
  });
});
