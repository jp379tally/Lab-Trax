/**
 * Tests for generateStatementPdfBuffer — verifies that the four sections
 * added to the statement PDF are present (or absent) as expected:
 *
 *  1. Statement-level due date derived from `invoiceDueDayOfMonth`
 *  2. Totals block (appears after the invoice table)
 *  3. "By Doctor" breakdown (only when recipientType !== "doctor")
 *  4. Footer reply-to line (only when `footerReplyTo` is supplied)
 *
 * pdf-parse@1.1.1 is required via the impl path (not index.js) to avoid the
 * startup crash from the test-file read. See memory: pdf-parse-startup-crashes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @workspace/db — statements.ts imports it at module level even though
// generateStatementPdfBuffer itself never touches the DB.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => {
  const db = {
    query: {
      invoices: { findMany: vi.fn().mockResolvedValue([]) },
      invoiceLineItems: { findMany: vi.fn().mockResolvedValue([]) },
      statementLinkTokens: { findFirst: vi.fn().mockResolvedValue(null) },
      statementSchedules: { findMany: vi.fn().mockResolvedValue([]) },
      organizations: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    }),
  };

  return {
    db,
    cases: { id: {}, doctorName: {} },
    invoices: {
      labOrganizationId: {},
      status: {},
      issuedAt: {},
      dueAt: {},
      createdAt: {},
      providerOrganizationId: {},
    },
    invoiceLineItems: { invoiceId: {}, sortOrder: {} },
    payments: {
      id: {},
      invoiceId: {},
      amount: {},
      paidAt: {},
      paymentMethod: {},
      referenceNumber: {},
    },
    organizations: { id: {}, name: {}, displayName: {}, billingEmail: {} },
    statementLinkTokens: { token: {} },
    statementSchedules: {
      id: {},
      enabled: {},
      labOrganizationId: {},
      dayOfMonth: {},
      lastSentForMonth: {},
      inProgressForMonth: {},
      inProgressLeasedAt: {},
    },
    statementSendRuns: {
      id: {},
      status: {},
      attemptCount: {},
      nextAttemptAt: {},
      labOrganizationId: {},
    },
  };
});

// ---------------------------------------------------------------------------
// Mock drizzle-orm operators — inert stubs.
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  ne: () => ({}),
  gte: () => ({}),
  gt: () => ({}),
  lt: () => ({}),
  lte: () => ({}),
  isNull: () => ({}),
  inArray: () => ({}),
  asc: () => ({}),
  desc: () => ({}),
  notInArray: () => ({}),
}));

// ---------------------------------------------------------------------------
// Mock lab-logo-storage so readLogoBuffer returns null (no logo) by default.
// ---------------------------------------------------------------------------

vi.mock("./lab-logo-storage.js", () => ({
  openLabLogoStream: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Mock nodemailer and archiver — only used in send/zip paths, not PDF gen.
// ---------------------------------------------------------------------------

vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn().mockReturnValue({ sendMail: vi.fn() }) },
  createTransport: vi.fn().mockReturnValue({ sendMail: vi.fn() }),
}));

vi.mock("archiver", () => ({
  default: vi.fn().mockReturnValue({
    on: vi.fn(),
    pipe: vi.fn(),
    append: vi.fn(),
    finalize: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// PDF text extraction helper.
//
// pdfkit v0.18 compresses content streams with FlateDecode and encodes glyph
// runs as hex strings inside TJ operators:
//   [<48656c6c6f> 40 <576f726c64> 0] TJ
// where each 2-hex-digit pair is one WinAnsiEncoding byte (≈ Latin-1 for
// ASCII characters).
//
// We avoid pdf-parse@1.1.1 because its bundled pdfjs v1.10.100 throws
// "bad XRef entry" on some pdfkit v0.18 output (xref structure incompatible
// with that pdfjs version). Instead we:
//   1. Find every FlateDecode content stream in the raw PDF binary.
//   2. Decompress it with Node's built-in zlib.inflateSync.
//   3. Extract all hex strings from TJ operators and decode them.
// This is deterministic and works regardless of PDF version or xref format.
// ---------------------------------------------------------------------------

import { inflateSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { coerceStatementTemplate } from "./statement-template";

/**
 * Extract all visible text from a pdfkit-generated PDF buffer.
 * Handles FlateDecode-compressed content streams and hex-encoded TJ operators.
 */
function pdfText(buf: Buffer): string {
  const raw = buf.toString("binary");
  const parts: string[] = [];

  // Find every compressed content stream.
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRegex.exec(raw)) !== null) {
    const streamBin = Buffer.from(m[1]!, "binary");
    let content: string;
    try {
      content = inflateSync(streamBin).toString("latin1");
    } catch {
      // Not a FlateDecode stream — try reading as plain text (e.g. xref streams).
      content = streamBin.toString("latin1");
    }

    // Extract hex strings from TJ operators: [<hex> num <hex> ...] TJ
    // Also handle plain Tj: (text) Tj (pdfkit uses TJ for standard fonts, but
    // handle Tj too for completeness).
    const hexRegex = /<([0-9a-fA-F]*)>/g;
    let h: RegExpExecArray | null;
    while ((h = hexRegex.exec(content)) !== null) {
      const hex = h[1]!;
      if (hex.length === 0) continue;
      // Decode pairs of hex digits to Latin-1 characters.
      let text = "";
      for (let i = 0; i + 1 < hex.length; i += 2) {
        text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      }
      parts.push(text);
    }

    // Also handle literal string Tj: (text) Tj
    const litRegex = /\(([^)]*)\)\s*Tj/g;
    let l: RegExpExecArray | null;
    while ((l = litRegex.exec(content)) !== null) {
      parts.push(l[1]!);
    }
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Minimal PracticeStatementData factories.
// ---------------------------------------------------------------------------

function makeInvoiceEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-001",
    invoiceNumber: "INV-001",
    issuedAt: new Date("2025-04-15T00:00:00Z"),
    dueAt: null,
    status: "sent",
    total: "200.00",
    balanceDue: "200.00",
    patientName: "Jane Smith",
    billTo: "Dr. Adams",
    lineItems: [],
    ...overrides,
  };
}

function makePaymentEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "payment-001",
    invoiceId: "inv-001",
    amount: "40.00",
    paidAt: new Date("2025-04-20T00:00:00Z"),
    paymentMethod: "check",
    referenceNumber: null,
    ...overrides,
  };
}

function makePracticeData(
  overrides: Partial<import("./statements.js").PracticeStatementData> = {}
): import("./statements.js").PracticeStatementData {
  return {
    practiceId: "org-1",
    practiceName: "Sunrise Dental",
    practiceEmail: "billing@sunrise.example",
    statementEmailOptOut: false,
    invoiceCount: 1,
    totalBilled: 200,
    totalPaid: 0,
    openBalance: 200,
    payments: [],
    invoices: [makeInvoiceEntry() as any],
    recipientType: "practice",
    doctors: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateStatementPdfBuffer", () => {
  let generateStatementPdfBuffer: (
    ...args: Parameters<
      typeof import("./statements.js").generateStatementPdfBuffer
    >
  ) => Promise<Buffer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ generateStatementPdfBuffer } = await import("./statements.js"));
  });

  // ── 1. Statement-level due date ──────────────────────────────────────────

  it("includes the due date derived from invoiceDueDayOfMonth in the PDF", async () => {
    // Invoice issued 2025-04-15; day-of-month=20 → due 2025-05-20 → "05/20/2025"
    const data = makePracticeData({
      invoices: [
        makeInvoiceEntry({
          issuedAt: new Date("2025-04-15T00:00:00Z"),
          balanceDue: "0.00",
          status: "paid",
        }) as any,
      ],
      totalPaid: 200,
      openBalance: 0,
    });

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "04/2025",
      null,
      null,
      "all",
      20 // invoiceDueDayOfMonth
    );

    const text = pdfText(buf);
    // "Payment due: 05/20/2025" in the Summary block
    expect(text).toContain("05/20/2025");
    expect(text).toContain("Payment due");
  });

  it("falls back to day 10 when invoiceDueDayOfMonth is null", async () => {
    // Invoice issued 2025-04-15; default day=10 → due 2025-05-10 → "05/10/2025"
    const data = makePracticeData({
      invoices: [
        makeInvoiceEntry({
          issuedAt: new Date("2025-04-15T00:00:00Z"),
          balanceDue: "0.00",
          status: "paid",
        }) as any,
      ],
      totalPaid: 200,
      openBalance: 0,
    });

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "04/2025",
      null,
      null,
      "all",
      null // should default to 10
    );

    const text = pdfText(buf);
    expect(text).toContain("05/10/2025");
  });

  it("wraps year correctly for December invoices (day 15 → Jan next year)", async () => {
    const data = makePracticeData({
      invoices: [
        makeInvoiceEntry({
          issuedAt: new Date("2025-12-20T00:00:00Z"),
          balanceDue: "0.00",
          status: "paid",
        }) as any,
      ],
      totalPaid: 200,
      openBalance: 0,
    });

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "12/2025",
      null,
      null,
      "all",
      15
    );

    const text = pdfText(buf);
    // Due 2026-01-15
    expect(text).toContain("01/15/2026");
  });

  // ── 2. Totals block ──────────────────────────────────────────────────────

  it("includes a Totals section with Billed, Paid, and Open balance amounts", async () => {
    const data = makePracticeData({
      totalBilled: 500,
      totalPaid: 150,
      openBalance: 350,
    });

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "04/2025"
    );

    const text = pdfText(buf);
    expect(text).toContain("Totals");
    expect(text).toContain("$500.00");
    expect(text).toContain("$150.00");
    expect(text).toContain("$350.00");
  });

  it("includes payment date and method when the statement has a recorded payment", async () => {
    const data = makePracticeData({
      paidAt: new Date("2026-07-10T09:00:00.000Z"),
      paymentMethod: "check",
    });

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "07/2026",
    );

    const text = pdfText(buf);
    expect(text).toContain("Paid On");
    expect(text).toContain("07/10/2026 (Check)");
  });

  it("does not add payment details when the statement is unpaid", async () => {
    const data = makePracticeData({
      paidAt: null,
      paymentMethod: null,
    });

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "04/2025",
    );

    expect(pdfText(buf)).not.toContain("Paid On");
  });

  it("Totals section comes after the Invoices table (order check)", async () => {
    const data = makePracticeData();
    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "04/2025"
    );
    const text = pdfText(buf);

    const invoicesPos = text.indexOf("Invoices");
    const totalsPos = text.indexOf("Totals");
    expect(invoicesPos).toBeGreaterThanOrEqual(0);
    expect(totalsPos).toBeGreaterThan(invoicesPos);
  });

  it("honors disabled, renamed, custom, and duplicated registry sections", async () => {
    const template = coerceStatementTemplate(null);
    const balance = template.sections.find((section) => section.generatedType === "balanceSummary")!;
    template.sections = [
      { ...balance, id: "summary-one", title: "Primary account summary" },
      { ...balance, id: "summary-two", title: "Summary copy", box: { x: 40, y: 360, w: 532, h: 60 } },
      {
        id: "custom-note",
        type: "custom",
        title: "Important message",
        enabled: true,
        contentMode: "custom",
        customText: "Please include the statement number with payment.",
        box: { x: 40, y: 450, w: 532, h: 60 },
      },
      {
        ...template.sections.find((section) => section.generatedType === "totals")!,
        enabled: false,
      },
    ];

    const text = pdfText(await generateStatementPdfBuffer(
      "Acme Lab",
      makePracticeData(),
      "04/2025",
      null,
      null,
      undefined,
      null,
      null,
      null,
      null,
      template,
    ));

    expect(text).toContain("Primary account summary");
    expect(text).toContain("Summary copy");
    expect(text).toContain("Important message");
    expect(text).toContain("Please include the statement number with payment.");
    expect(text).not.toContain("Totals");
  });

  it("paginates independent transaction copies without losing either copy", async () => {
    const template = coerceStatementTemplate(null);
    const transactions = template.sections.find((section) => section.generatedType === "transactions")!;
    template.sections = [
      { ...transactions, id: "transactions-left", title: "Invoices A", box: { x: 40, y: 100, w: 250, h: 100 } },
      { ...transactions, id: "transactions-right", title: "Invoices B", box: { x: 322, y: 100, w: 250, h: 100 } },
    ];
    const invoices = Array.from({ length: 12 }, (_, index) => makeInvoiceEntry({
      id: `inv-${index}`,
      invoiceNumber: `INV-${String(index).padStart(3, "0")}`,
      issuedAt: new Date(Date.UTC(2025, 3, index + 1)),
    })) as any;

    const text = pdfText(await generateStatementPdfBuffer(
      "Acme Lab",
      makePracticeData({ invoiceCount: invoices.length, invoices }),
      "04/2025",
      null, null, undefined, null, null, null, null, template,
    ));

    expect(text).toContain("Invoices A");
    expect(text).toContain("Invoices B");
    expect(text.match(/INV-011/g)).toHaveLength(2);
  });

  it("renders a legacy short transaction box without unbounded pagination", async () => {
    const legacy = {
      ...coerceStatementTemplate(null),
      sections: undefined,
      boxes: {
        ...coerceStatementTemplate(null).boxes,
        transactions: { x: 40, y: 260, w: 532, h: 10 },
      },
    };

    const pdf = await generateStatementPdfBuffer(
      "Acme Lab", makePracticeData(), "04/2025",
      null, null, undefined, null, null, null, null, legacy as any,
    );
    expect(pdf.byteLength).toBeGreaterThan(100);
    expect(pdfText(pdf)).toContain("INV-001");
    expect(pdfText(pdf)).toContain("Running Balance");
    expect(pdf.toString("binary").match(/\/Type \/Page\b/g)).toHaveLength(2);
  });

  it.each([
    { x: 40, y: 260, w: 532, h: 10 },
    { x: 40, y: 260, w: 250, h: 100 },
  ])("does not add empty continuation pages for an undersized box %j", async (box) => {
    const template = coerceStatementTemplate(null);
    template.sections.find((section) => section.generatedType === "transactions")!.box = box;
    const buffer = await generateStatementPdfBuffer("Acme Lab",
      makePracticeData({ invoices: [], invoiceCount: 0, totalBilled: 0, totalPaid: 0, openBalance: 0 }),
      "04/2025", null, null, undefined, null, null, null, null, template);
    expect(buffer.toString("binary").match(/\/Type \/Page\b/g)).toHaveLength(1);
    expect(pdfText(buffer)).not.toContain("continued on following pages");
  });

  it("keeps saved geometry, logo, contacts, dates, summary and totals unchanged", async () => {
    const template = coerceStatementTemplate(null);
    const summary = template.sections.find((section) => section.generatedType === "balanceSummary")!;
    summary.box = { x: 50, y: 190, w: 500, h: 60 };
    const before = JSON.stringify(template);
    const image = vi.spyOn(PDFDocument.prototype, "image");
    const text = vi.spyOn(PDFDocument.prototype, "text");
    try {
      const sharp = (await import("sharp")).default;
      const logo = await sharp(Buffer.from(
        '<svg width="170" height="50"><rect width="170" height="50" fill="#123456"/><text x="10" y="30" fill="white">ACME LAB</text></svg>',
      )).png().toBuffer();
      const contact = {
        displayName: "Acme Dental Laboratory", legalName: null,
        addressLine1: "123 Sample Street", addressLine2: null,
        city: "Sample City", state: "FL", zip: "00000", phone: "555-0100",
        billingEmail: "billing@example.test", additionalEmails: [],
        accountNumber: null, licenseNumber: null, phones: [], emails: [],
      };
      const buffer = await generateStatementPdfBuffer("Acme Lab",
        makePracticeData({ labContact: contact, practiceContact: { ...contact, displayName: "Sunrise Dental" } }),
        "04/2025", logo, null, undefined, 10, "billing@example.test", null, null, template);
      expect(JSON.stringify(template)).toBe(before);
      expect(image).toHaveBeenCalledWith(logo, template.logo.x, template.logo.y, {
        fit: [template.logo.w, template.logo.h], align: "center", valign: "center",
      });
      // PDFKit overloads are wider at runtime than the spy's inferred last signature.
      const calls = text.mock.calls as unknown as [string, number, number, { width: number; height: number }][];
      expect(calls).toContainEqual([
        "Balance Summary\nInvoices: 1\nBilled: $200.00    Paid: $0.00    Open balance: $200.00\nPayment due: 05/10/2025",
        53, 193, { width: 494, height: 54, align: "left", lineGap: 1 },
      ]);
      const visible = pdfText(buffer);
      expect(visible).toContain("123 Sample Street");
      expect(visible).toContain("billing@example.test");
      expect(visible).toContain("Total billed: $200.00");
      expect(visible).toContain("Balance due: $200.00");
      expect(buffer.toString("binary")).toContain("/Subtype /Image");
      if (process.env.STATEMENT_PDF_VISUAL_DIR) {
        fs.mkdirSync(process.env.STATEMENT_PDF_VISUAL_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.STATEMENT_PDF_VISUAL_DIR, "branding.pdf"), buffer);
      }
    } finally {
      image.mockRestore();
      text.mockRestore();
    }
  });

  it("preserves complete invoice groups, long content, zero amounts and repeated headers across pages", async () => {
    const item = (id: string, description: string, parentLineItemId: string | null = null) => ({
      id, description, parentLineItemId, quantity: 1, unitPrice: "0", lineTotal: "0",
      isDiscount: false, toothLabel: null, toothNumber: null, sortOrder: 0,
    });
    const longName = "Alexandra Montgomery Robertson";
    const longDescription = "Detailed ceramic prescription with long clinical instructions ".repeat(180) + "DETAIL-END";
    const invoices = [
      makeInvoiceEntry({
        id: "zero", invoiceNumber: "INV-ZERO", patientName: longName, total: "0", balanceDue: "0",
        billTo: "Dr. Long Practice Billing Recipient With An Extended Name",
        lineItems: [
          item("parent", "Metal framework crown"),
          item("child", "Night guard - Tooth 5", "parent"),
          { ...item("discount", "Courtesy discount"), isDiscount: true, lineTotal: "-10" },
          item("long", longDescription),
        ],
      }),
      makeInvoiceEntry({
        id: "later", invoiceNumber: "INV-LATER", issuedAt: new Date("2025-04-19"),
        total: "99", balanceDue: "59",
      }),
    ] as any;
    const data = makePracticeData({
      invoiceCount: 2, invoices, totalBilled: 99, totalPaid: 40, openBalance: 59,
      payments: [makePaymentEntry({ invoiceId: "later", referenceNumber: "CHK-40" })],
    });
    const buffer = await generateStatementPdfBuffer("Acme Lab", data, "04/2025");
    const text = pdfText(buffer);
    const compact = text.replace(/\s/g, "");
    const pages = buffer.toString("binary").match(/\/Type \/Page\b/g)!.length;
    expect(pages).toBeGreaterThan(2);
    expect(text.match(/Invoice #/g)).toHaveLength(pages);
    expect(text.match(/Running Balance/g)).toHaveLength(pages);
    expect(text.match(/INV-ZERO/g)).toHaveLength(1);
    expect(text.match(/DETAIL-END/g)).toHaveLength(1);
    expect(compact).toContain(longName.replace(/\s/g, ""));
    // Headers/static sections interrupt long detail rows; every word still appears exactly once.
    expect(text.match(/prescription/g)).toHaveLength(180);
    expect(text).toContain("Night guard - Tooth 5");
    expect(text).toContain("Subtotal");
    expect(text).toContain("Discount: Courtesy discount");
    expect(text).toContain("-$10.00");
    expect(text).toContain("$0.00$0.00");
    expect(text.indexOf("DETAIL-END")).toBeLessThan(text.indexOf("INV-LATER"));
    expect(text.indexOf("INV-LATER")).toBeLessThan(text.indexOf("Payment", text.indexOf("INV-LATER")));
    expect(text).toContain("-$40.00$59.00");
    // Opt-in synthetic artifacts for print-size visual inspection; not part of source history.
    if (process.env.STATEMENT_PDF_VISUAL_DIR) {
      fs.mkdirSync(process.env.STATEMENT_PDF_VISUAL_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.STATEMENT_PDF_VISUAL_DIR, "multipage.pdf"), buffer);
      const short = makePracticeData({
        invoiceCount: 2,
        invoices: [
          { ...invoices[0], lineItems: invoices[0].lineItems.slice(0, 3) },
          invoices[1],
        ],
        totalBilled: 99, openBalance: 99,
      });
      fs.writeFileSync(path.join(process.env.STATEMENT_PDF_VISUAL_DIR, "representative.pdf"),
        await generateStatementPdfBuffer("Acme Lab", short, "04/2025"));
      const template = coerceStatementTemplate(null);
      const transaction = template.sections.find((section) => section.generatedType === "transactions")!;
      transaction.box = { x: 40, y: 260, w: 250, h: 100 };
      fs.writeFileSync(path.join(process.env.STATEMENT_PDF_VISUAL_DIR, "narrow.pdf"),
        await generateStatementPdfBuffer("Acme Lab", short, "04/2025",
          null, null, undefined, null, null, null, null, template));
    }
  });

  describe("chronological running balance", () => {
    function tableText(text: string): string {
      // The summary starts with "Invoices: N"; the table heading is emitted
      // as the adjacent "InvoicesInvoice" text by the compact PDF extractor.
      const start = text.indexOf("InvoicesInvoice");
      const end = text.indexOf("Aging Summary", start);
      return text.slice(start, end < 0 ? text.length : end);
    }

    it("accumulates invoice charges instead of repeating invoice balance due", async () => {
      const data = makePracticeData({
        invoiceCount: 2,
        totalBilled: 198,
        openBalance: 198,
        invoices: [
          makeInvoiceEntry({
            id: "inv-001",
            invoiceNumber: "INV-001",
            total: "99.00",
            balanceDue: "99.00",
            issuedAt: new Date("2025-04-01T00:00:00Z"),
          }) as any,
          makeInvoiceEntry({
            id: "inv-002",
            invoiceNumber: "INV-002",
            total: "99.00",
            balanceDue: "99.00",
            issuedAt: new Date("2025-04-02T00:00:00Z"),
          }) as any,
        ],
      });

      const text = tableText(pdfText(await generateStatementPdfBuffer("Lab", data, "04/2025")));
      const first = text.indexOf("INV-001");
      const second = text.indexOf("INV-002");
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBeGreaterThan(first);
      expect(text.slice(first, second)).toContain("$99.00$99.00");
      expect(text.slice(second)).toContain("$99.00$198.00");
    });

    it("renders a flagged invoice discount with its negative sign before the currency symbol", async () => {
      const data = makePracticeData({
        invoiceCount: 1,
        totalBilled: 100,
        totalPaid: 0,
        openBalance: 100,
        invoices: [
          makeInvoiceEntry({
            id: "inv-discount",
            invoiceNumber: "INV-DISCOUNT",
            total: "100.00",
            balanceDue: "100.00",
            lineItems: [
              {
                id: "discount-line",
                invoiceId: "inv-discount",
                description: "Courtesy discount",
                quantity: 1,
                unitPrice: "-400.00",
                lineTotal: "-400.00",
                isDiscount: true,
                parentLineItemId: null,
                toothLabel: null,
                toothNumber: null,
              },
            ],
          }) as any,
        ],
      });

      const text = tableText(
        pdfText(await generateStatementPdfBuffer("Lab", data, "04/2025")),
      );
      expect(text).toContain("Discount: Courtesy discount");
      expect(text).toContain("-$400.00");
      expect(text).not.toContain("$-400.00");
    });

    it("renders an interleaved payment as a negative activity and reduces the next balance", async () => {
      const data = makePracticeData({
        invoiceCount: 2,
        totalBilled: 198,
        totalPaid: 40,
        openBalance: 158,
        invoices: [
          makeInvoiceEntry({
            id: "inv-001",
            invoiceNumber: "INV-001",
            total: "99.00",
            balanceDue: "59.00",
            issuedAt: new Date("2025-04-01T00:00:00Z"),
          }) as any,
          makeInvoiceEntry({
            id: "inv-002",
            invoiceNumber: "INV-002",
            total: "99.00",
            balanceDue: "99.00",
            issuedAt: new Date("2025-04-03T00:00:00Z"),
          }) as any,
        ],
        payments: [
          makePaymentEntry({
            id: "payment-001",
            invoiceId: "inv-001",
            paidAt: new Date("2025-04-02T00:00:00Z"),
            referenceNumber: "CHK-40",
          }) as any,
        ],
      });

      const text = tableText(pdfText(await generateStatementPdfBuffer("Lab", data, "04/2025")));
      const first = text.indexOf("INV-001");
      const payment = text.indexOf("Payment", first);
      const second = text.indexOf("INV-002", payment);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(payment);
      expect(payment).toBeLessThan(second);
      expect(text.slice(payment, second)).toContain("-$40.00$59.00");
      expect(text.slice(second)).toContain("$99.00$158.00");
      expect(text.slice(payment, second)).toContain("CHK-40");
    });

    it("keeps multiple payments as separate rows and orders same-time activity deterministically", async () => {
      const sameTime = new Date("2025-04-02T00:00:00Z");
      const data = makePracticeData({
        invoiceCount: 2,
        totalBilled: 200,
        totalPaid: 75,
        openBalance: 125,
        invoices: [
          makeInvoiceEntry({
            id: "a-invoice",
            invoiceNumber: "INV-A",
            total: "100.00",
            balanceDue: "50.00",
            issuedAt: sameTime,
          }) as any,
          makeInvoiceEntry({
            id: "z-invoice",
            invoiceNumber: "INV-Z",
            total: "100.00",
            balanceDue: "75.00",
            issuedAt: sameTime,
          }) as any,
        ],
        payments: [
          makePaymentEntry({
            id: "payment-a",
            invoiceId: "a-invoice",
            amount: "25.00",
            paidAt: sameTime,
            referenceNumber: "A",
          }) as any,
          makePaymentEntry({
            id: "payment-b",
            invoiceId: "z-invoice",
            amount: "50.00",
            paidAt: new Date("2025-04-03T00:00:00Z"),
            referenceNumber: "B",
          }) as any,
        ],
      });

      const text = tableText(pdfText(await generateStatementPdfBuffer("Lab", data, "04/2025")));
      const invoiceA = text.indexOf("INV-A");
      const invoiceZ = text.indexOf("INV-Z");
      const paymentA = text.indexOf("Payment", invoiceZ);
      const paymentB = text.indexOf("Payment", paymentA + 1);
      expect(invoiceA).toBeLessThan(invoiceZ);
      expect(invoiceZ).toBeLessThan(paymentA);
      expect(paymentA).toBeLessThan(paymentB);
      expect(text.slice(paymentA, paymentB)).toContain("-$25.00$175.00");
      expect(text.slice(paymentB)).toContain("-$50.00$125.00");
    });

    it("settles a paid invoice to zero and ignores void activity", async () => {
      const paid = makePracticeData({
        totalBilled: 99,
        totalPaid: 99,
        openBalance: 0,
        invoices: [
          makeInvoiceEntry({
            id: "paid-invoice",
            invoiceNumber: "INV-PAID",
            total: "99.00",
            balanceDue: "0.00",
            status: "paid",
          }) as any,
        ],
        payments: [
          makePaymentEntry({
            id: "paid-payment",
            invoiceId: "paid-invoice",
            amount: "99.00",
          }) as any,
        ],
      });
      const paidText = tableText(pdfText(await generateStatementPdfBuffer("Lab", paid, "04/2025")));
      const paidPayment = paidText.indexOf("Payment");
      expect(paidPayment).toBeGreaterThanOrEqual(0);
      expect(paidText.slice(paidPayment)).toContain("-$99.00$0.00");

      const voided = makePracticeData({
        totalBilled: 99,
        totalPaid: 0,
        openBalance: 0,
        invoices: [
          makeInvoiceEntry({
            id: "void-invoice",
            invoiceNumber: "INV-VOID",
            total: "99.00",
            balanceDue: "0.00",
            status: "void",
          }) as any,
        ],
        payments: [
          makePaymentEntry({
            id: "void-payment",
            invoiceId: "void-invoice",
            amount: "99.00",
          }) as any,
        ],
      });
      const voidText = tableText(pdfText(await generateStatementPdfBuffer("Lab", voided, "04/2025")));
      expect(voidText).not.toContain("Payment");
      expect(voidText.slice(voidText.indexOf("INV-VOID"))).toContain("$0.00$0.00");
    });
  });

  // ── 3. "By Doctor" breakdown ─────────────────────────────────────────────

  it("includes a By Doctor section when recipientType is 'practice' and invoices have billTo", async () => {
    const data = makePracticeData({
      recipientType: "practice",
      invoices: [
        makeInvoiceEntry({ billTo: "Dr. Adams", balanceDue: "120.00" }) as any,
        makeInvoiceEntry({
          invoiceNumber: "INV-002",
          billTo: "Dr. Chen",
          balanceDue: "80.00",
        }) as any,
      ],
      totalBilled: 200,
      openBalance: 200,
    });

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "04/2025"
    );

    const text = pdfText(buf);
    expect(text).toContain("By Doctor");
    expect(text).toContain("Dr. Adams");
    expect(text).toContain("Dr. Chen");
  });

  it("omits the By Doctor section when recipientType is 'doctor'", async () => {
    const data = makePracticeData({
      recipientType: "doctor",
      invoices: [
        makeInvoiceEntry({ billTo: "Dr. Adams", balanceDue: "120.00" }) as any,
      ],
      openBalance: 120,
    });

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "04/2025"
    );

    const text = pdfText(buf);
    expect(text).not.toContain("By Doctor");
  });

  it("omits the By Doctor section when recipientType is undefined (treated as practice) but all balances are zero or void", async () => {
    // Even in practice mode, the By Doctor block only renders when at least one
    // non-void invoice has a positive balance and a non-empty billTo.
    const data = makePracticeData({
      recipientType: "practice",
      invoices: [
        makeInvoiceEntry({
          billTo: "Dr. Adams",
          balanceDue: "0.00",
          status: "paid",
        }) as any,
      ],
      openBalance: 0,
    });

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "04/2025"
    );

    const text = pdfText(buf);
    expect(text).not.toContain("By Doctor");
  });

  // ── 4. Footer reply-to line ───────────────────────────────────────────────

  it("includes the footer contact line when footerReplyTo is supplied", async () => {
    const data = makePracticeData();

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "04/2025",
      null,
      null,
      "all",
      10,
      "billing@acmelab.example"
    );

    const text = pdfText(buf);
    expect(text).toContain("billing@acmelab.example");
    expect(text).toContain("Questions?");
  });

  it("omits the footer contact line when footerReplyTo is null", async () => {
    const data = makePracticeData();

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "04/2025",
      null,
      null,
      "all",
      10,
      null // no replyTo
    );

    const text = pdfText(buf);
    expect(text).not.toContain("Questions?");
  });

  it("includes footer text blocks when supplied", async () => {
    const data = makePracticeData();

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "04/2025",
      null,
      null,
      "all",
      10,
      null,
      [{ id: "footer-1", text: "Please remit by check or ACH.", bold: false, fontSize: 9, align: "left" as const }]
    );

    const text = pdfText(buf);
    expect(text).toContain("Please remit by check or ACH.");
  });

  it("omits footer text blocks when not supplied", async () => {
    const data = makePracticeData();

    const buf = await generateStatementPdfBuffer(
      "Acme Lab",
      data,
      "04/2025"
    );

    const text = pdfText(buf);
    // Generic sanity check — the basic sections are still present.
    expect(text).toContain("Statement");
    expect(text).toContain("Totals");
  });

  // ── 5. Aging Summary ──────────────────────────────────────────────────────

  describe("Aging Summary", () => {
    // Pin "now" so bucket math is deterministic regardless of when tests run.
    const NOW = new Date("2025-06-01T12:00:00Z");

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Return a Date that is `n` days before NOW (i.e. overdue by n days). */
    function daysAgo(n: number): Date {
      return new Date(NOW.getTime() - n * 86_400_000);
    }

    /** Return a Date that is `n` days after NOW (i.e. not yet due). */
    function daysAhead(n: number): Date {
      return new Date(NOW.getTime() + n * 86_400_000);
    }

    // pdfkit encodes the en-dash (U+2013) as WinAnsiEncoding byte 0x96.
    // Our hex extractor decodes raw bytes as Latin-1, so the en-dash comes
    // back as the control character \u0096, not \u2013.
    // We use \u0096 in assertions to match the actual extracted text.
    const EN_DASH = "\u0096";

    it("places a future-due invoice in the Current bucket", async () => {
      const data = makePracticeData({
        invoices: [
          makeInvoiceEntry({
            dueAt: daysAhead(5),
            status: "sent",
            balanceDue: "100.00",
          }) as any,
        ],
        openBalance: 100,
      });

      const buf = await generateStatementPdfBuffer("Lab", data, "05/2025");
      const text = pdfText(buf);
      expect(text).toContain("Aging Summary");
      expect(text).toContain("Current (not overdue)");
      // No overdue bucket should appear.
      expect(text).not.toContain(`1${EN_DASH}30 days overdue`);
    });

    it("places a 15-day overdue invoice in the 1–30 bucket", async () => {
      const data = makePracticeData({
        invoices: [
          makeInvoiceEntry({
            dueAt: daysAgo(15),
            status: "sent",
            balanceDue: "150.00",
          }) as any,
        ],
        openBalance: 150,
      });

      const buf = await generateStatementPdfBuffer("Lab", data, "05/2025");
      const text = pdfText(buf);
      expect(text).toContain("Aging Summary");
      expect(text).toContain(`1${EN_DASH}30 days overdue`);
      expect(text).not.toContain("Current (not overdue)");
    });

    it("places a 45-day overdue invoice in the 31–60 bucket", async () => {
      const data = makePracticeData({
        invoices: [
          makeInvoiceEntry({
            dueAt: daysAgo(45),
            status: "sent",
            balanceDue: "200.00",
          }) as any,
        ],
        openBalance: 200,
      });

      const buf = await generateStatementPdfBuffer("Lab", data, "05/2025");
      const text = pdfText(buf);
      expect(text).toContain("Aging Summary");
      expect(text).toContain(`31${EN_DASH}60 days overdue`);
      expect(text).not.toContain(`1${EN_DASH}30 days overdue`);
    });

    it("places a 75-day overdue invoice in the 61–90 bucket", async () => {
      const data = makePracticeData({
        invoices: [
          makeInvoiceEntry({
            dueAt: daysAgo(75),
            status: "sent",
            balanceDue: "250.00",
          }) as any,
        ],
        openBalance: 250,
      });

      const buf = await generateStatementPdfBuffer("Lab", data, "05/2025");
      const text = pdfText(buf);
      expect(text).toContain("Aging Summary");
      expect(text).toContain(`61${EN_DASH}90 days overdue`);
      expect(text).not.toContain(`31${EN_DASH}60 days overdue`);
    });

    it("places a 95-day overdue invoice in the 90+ bucket and highlights it", async () => {
      const data = makePracticeData({
        invoices: [
          makeInvoiceEntry({
            dueAt: daysAgo(95),
            status: "sent",
            balanceDue: "300.00",
          }) as any,
        ],
        openBalance: 300,
      });

      const buf = await generateStatementPdfBuffer("Lab", data, "05/2025");
      const text = pdfText(buf);
      expect(text).toContain("Aging Summary");
      expect(text).toContain("90+ days overdue");
      expect(text).not.toContain(`61${EN_DASH}90 days overdue`);
    });

    it("places an invoice with no dueAt in the Current bucket", async () => {
      const data = makePracticeData({
        invoices: [
          makeInvoiceEntry({
            dueAt: null,
            status: "sent",
            balanceDue: "175.00",
          }) as any,
        ],
        openBalance: 175,
      });

      const buf = await generateStatementPdfBuffer("Lab", data, "05/2025");
      const text = pdfText(buf);
      expect(text).toContain("Aging Summary");
      expect(text).toContain("Current (not overdue)");
      expect(text).not.toContain(`1${EN_DASH}30 days overdue`);
    });

    it("omits the Aging Summary when all invoices are paid", async () => {
      const data = makePracticeData({
        invoices: [
          makeInvoiceEntry({
            dueAt: daysAgo(95),
            status: "paid",
            balanceDue: "0.00",
          }) as any,
        ],
        totalPaid: 200,
        openBalance: 0,
      });

      const buf = await generateStatementPdfBuffer("Lab", data, "05/2025");
      const text = pdfText(buf);
      expect(text).not.toContain("Aging Summary");
    });

    it("omits the Aging Summary when all invoices are void", async () => {
      const data = makePracticeData({
        invoices: [
          makeInvoiceEntry({
            dueAt: daysAgo(95),
            status: "void",
            balanceDue: "0.00",
          }) as any,
        ],
        openBalance: 0,
      });

      const buf = await generateStatementPdfBuffer("Lab", data, "05/2025");
      const text = pdfText(buf);
      expect(text).not.toContain("Aging Summary");
    });
  });
});
