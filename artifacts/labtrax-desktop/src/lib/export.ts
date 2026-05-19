import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export function downloadCsv(filename: string, rows: Array<Record<string, string | number | null | undefined>>) {
  if (rows.length === 0) {
    const blob = new Blob([""], { type: "text/csv;charset=utf-8;" });
    triggerDownload(blob, filename);
    return;
  }
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  const csv = lines.join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, filename);
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, "_").replace(/^_+|_+$/g, "") || "export";
}

export interface StatementPdfOptions {
  practiceName: string;
  generatedAt: Date;
  filtersDescription?: string;
  totals: {
    billed: number;
    paid: number;
    open: number;
    overdue: number;
  };
  invoices: Array<{
    invoiceNumber: string;
    issuedAt: string;
    dueAt: string;
    status: string;
    total: string;
    balanceDue: string;
    patientName?: string | null;
    billTo?: string | null;
  }>;
}

function fmtMoney(n: number | string): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(v)) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(v);
}

export interface BuiltStatementPdf {
  blob: Blob;
  filename: string;
  /** Base64 string (no data URL prefix). */
  base64: string;
}

export function buildStatementPdf(opts: StatementPdfOptions): BuiltStatementPdf {
  const doc = buildStatementDoc(opts);
  const filename = `statement-${safeFilename(opts.practiceName)}-${opts.generatedAt.toISOString().slice(0, 10)}.pdf`;
  const arrayBuffer = doc.output("arraybuffer") as ArrayBuffer;
  const blob = new Blob([arrayBuffer], { type: "application/pdf" });
  const base64 = arrayBufferToBase64(arrayBuffer);
  return { blob, filename, base64 };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

export function downloadStatementPdf(opts: StatementPdfOptions) {
  const built = buildStatementPdf(opts);
  triggerDownload(built.blob, built.filename);
}

export interface InvoicePdfLineItem {
  item?: string | null;
  description: string;
  quantity: number | string;
  unitPrice: number | string;
  lineTotal: number | string;
}

export interface InvoicePdfOptions {
  invoiceNumber: string;
  labName: string;
  practiceName: string;
  patientName?: string | null;
  billTo?: string | null;
  teeth?: string | null;
  shade?: string | null;
  caseNotes?: string | null;
  issuedAt?: string | null;
  dueAt?: string | null;
  status: string;
  items: InvoicePdfLineItem[];
  subtotal: number | string;
  tax?: number | string | null;
  discount?: number | string | null;
  credits?: number | string | null;
  total: number | string;
  balanceDue?: number | string | null;
  notes?: string | null;
  generatedAt: Date;
  /** Full URL of the lab logo; shown in the top-right header when provided. */
  logoUrl?: string | null;
}

export interface BuiltInvoicePdf {
  blob: Blob;
  filename: string;
  base64: string;
}

export function buildInvoicePdf(opts: InvoicePdfOptions): BuiltInvoicePdf {
  const doc = buildInvoiceDoc(opts);
  const filename = `invoice-${safeFilename(opts.invoiceNumber)}.pdf`;
  const arrayBuffer = doc.output("arraybuffer") as ArrayBuffer;
  const blob = new Blob([arrayBuffer], { type: "application/pdf" });
  const base64 = arrayBufferToBase64(arrayBuffer);
  return { blob, filename, base64 };
}

export function downloadInvoicePdf(opts: InvoicePdfOptions) {
  const built = buildInvoicePdf(opts);
  triggerDownload(built.blob, built.filename);
}

// Open the PDF in a new browser tab/window so the user can review
// what the invoice will look like without saving or downloading
// anything. The blob URL is revoked a few seconds later so we don't
// leak memory; by then the new tab has already loaded the bytes.
export function previewInvoicePdf(opts: InvoicePdfOptions) {
  const built = buildInvoicePdf(opts);
  const url = URL.createObjectURL(built.blob);
  const win = window.open(url, "_blank", "noopener,noreferrer");
  // Pop-up blocked → fall back to a same-tab navigation so the user
  // still sees the preview.
  if (!win) {
    window.location.href = url;
  }
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// Open the PDF in a hidden iframe and immediately trigger the
// browser's print dialog. Avoids opening a visible tab the user
// then has to close. Iframe is removed after the print dialog
// closes (or after a generous timeout as a safety net).
export function printInvoicePdf(opts: InvoicePdfOptions) {
  const built = buildInvoicePdf(opts);
  const url = URL.createObjectURL(built.blob);
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.src = url;
  const cleanup = () => {
    URL.revokeObjectURL(url);
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
  };
  iframe.onload = () => {
    try {
      const w = iframe.contentWindow;
      if (!w) {
        cleanup();
        return;
      }
      w.focus();
      w.print();
      // Some browsers block until print dialog closes; others return
      // immediately. Either way, clean up after a delay.
      setTimeout(cleanup, 60_000);
    } catch {
      cleanup();
    }
  };
  document.body.appendChild(iframe);
}

function buildInvoiceDoc(opts: InvoicePdfOptions) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;

  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.text("Invoice", margin, 50);

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120);
  doc.text(`#${opts.invoiceNumber}`, margin, 66);
  doc.setTextColor(0);

  // Lab logo (top-right) or lab name text
  if (opts.logoUrl) {
    try {
      // logoUrl should be a pre-fetched base64 data URL; render as image
      doc.addImage(opts.logoUrl, margin, 30, 0, 36);
    } catch {
      // fall back to text if image fails
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text(opts.labName, pageWidth - margin, 50, { align: "right" });
      doc.setFont("helvetica", "normal");
    }
  } else {
    // Lab (right-aligned)
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text(opts.labName, pageWidth - margin, 50, { align: "right" });
    doc.setFont("helvetica", "normal");
  }
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    `Generated ${opts.generatedAt.toLocaleDateString("en-US")}`,
    pageWidth - margin,
    66,
    { align: "right" },
  );
  doc.setTextColor(0);

  // Bill-to / patient block
  let y = 100;
  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text("BILL TO", margin, y);
  doc.text("PATIENT", margin + 220, y);
  doc.setTextColor(0);
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  const billToValue = (opts.billTo && opts.billTo.trim()) || opts.practiceName;
  doc.text(billToValue, margin, y + 14);
  doc.text(
    (opts.patientName && opts.patientName.trim()) || "—",
    margin + 220,
    y + 14,
  );
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(120);
  if (billToValue !== opts.practiceName) {
    doc.text(opts.practiceName, margin, y + 28);
  }
  doc.setTextColor(0);
  y += 50;

  // Meta row: Issued / Due / Status / Teeth / Shade
  const metaPairs: Array<[string, string]> = [
    ["Issued", fmtDate(opts.issuedAt) || "—"],
    ["Due", fmtDate(opts.dueAt) || "—"],
    ["Status", opts.status],
  ];
  if (opts.teeth && opts.teeth.trim()) {
    metaPairs.push(["Teeth", opts.teeth.trim()]);
  }
  if (opts.shade && opts.shade.trim()) {
    metaPairs.push(["Shade", opts.shade.trim()]);
  }
  const colW = (pageWidth - margin * 2) / metaPairs.length;
  metaPairs.forEach(([label, value], i) => {
    const x = margin + colW * i;
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(label.toUpperCase(), x, y);
    doc.setFontSize(10);
    doc.setTextColor(0);
    doc.text(value, x, y + 14);
  });
  y += 28;

  if (opts.caseNotes && opts.caseNotes.trim()) {
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text("CASE NOTES", margin, y);
    doc.setFontSize(9);
    doc.setTextColor(0);
    const wrapped = doc.splitTextToSize(
      opts.caseNotes.trim(),
      pageWidth - margin * 2,
    );
    doc.text(wrapped, margin, y + 12);
    y += 12 + wrapped.length * 11 + 4;
  }

  // Line items
  autoTable(doc, {
    startY: y + 8,
    head: [["Item", "Description", "Qty", "Unit price", "Total"]],
    body: opts.items.map((it) => [
      (it.item && String(it.item).trim()) || "—",
      it.description,
      String(it.quantity),
      fmtMoney(it.unitPrice as number | string),
      fmtMoney(it.lineTotal as number | string),
    ]),
    styles: { fontSize: 9, cellPadding: 6 },
    headStyles: { fillColor: [40, 44, 52], textColor: 255 },
    columnStyles: {
      0: { cellWidth: 110 },
      2: { halign: "right", cellWidth: 40 },
      3: { halign: "right", cellWidth: 80 },
      4: { halign: "right", cellWidth: 80 },
    },
    margin: { left: margin, right: margin },
  });

  const afterTable = (doc as unknown as { lastAutoTable?: { finalY: number } })
    .lastAutoTable;
  let totalsY = (afterTable?.finalY ?? y + 8) + 16;

  // Totals block (right column)
  const totalsX = pageWidth - margin - 200;
  const valueX = pageWidth - margin;
  const writeRow = (label: string, value: string, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(bold ? 11 : 10);
    doc.text(label, totalsX, totalsY);
    doc.text(value, valueX, totalsY, { align: "right" });
    totalsY += bold ? 18 : 16;
  };
  writeRow("Subtotal", fmtMoney(opts.subtotal));
  if (Number(opts.tax ?? 0) > 0) writeRow("Tax", fmtMoney(opts.tax ?? 0));
  if (Number(opts.discount ?? 0) > 0)
    writeRow("Discount", `-${fmtMoney(opts.discount ?? 0)}`);
  if (Number(opts.credits ?? 0) > 0)
    writeRow("Credits", `-${fmtMoney(opts.credits ?? 0)}`);
  doc.setDrawColor(220);
  doc.line(totalsX, totalsY - 8, valueX, totalsY - 8);
  const grandTotal = (
    Number(opts.total ?? 0) - Number(opts.credits ?? 0)
  ).toFixed(2);
  writeRow("Total", fmtMoney(grandTotal), true);
  if (opts.balanceDue !== undefined && opts.balanceDue !== null) {
    const bal = Math.max(0, Number(opts.balanceDue) - Number(opts.credits ?? 0));
    writeRow("Balance due", fmtMoney(bal.toFixed(2)));
  }

  if (opts.notes && opts.notes.trim()) {
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text("NOTES", margin, totalsY + 12);
    doc.setFontSize(9);
    doc.setTextColor(0);
    const wrapped = doc.splitTextToSize(
      opts.notes.trim(),
      pageWidth - margin * 2,
    );
    doc.text(wrapped, margin, totalsY + 26);
  }

  return doc;
}

function fmtDate(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US");
}

function buildStatementDoc(opts: StatementPdfOptions) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;

  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("Statement", margin, 50);

  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text(opts.practiceName, margin, 70);

  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Generated ${opts.generatedAt.toLocaleString("en-US")}`, margin, 86);
  if (opts.filtersDescription) {
    doc.text(opts.filtersDescription, margin, 100);
  }
  doc.setTextColor(0);

  const summaryY = opts.filtersDescription ? 124 : 110;
  const colWidth = (pageWidth - margin * 2) / 4;
  const summary: Array<[string, string]> = [
    ["Billed", fmtMoney(opts.totals.billed)],
    ["Paid", fmtMoney(opts.totals.paid)],
    ["Open balance", fmtMoney(opts.totals.open)],
    ["Overdue", fmtMoney(opts.totals.overdue)],
  ];
  summary.forEach(([label, value], i) => {
    const x = margin + colWidth * i;
    doc.setDrawColor(220);
    doc.setFillColor(248, 248, 250);
    doc.roundedRect(x, summaryY, colWidth - 8, 50, 4, 4, "FD");
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(label.toUpperCase(), x + 10, summaryY + 18);
    doc.setFontSize(13);
    doc.setTextColor(0);
    doc.setFont("helvetica", "bold");
    doc.text(value, x + 10, summaryY + 38);
    doc.setFont("helvetica", "normal");
  });

  autoTable(doc, {
    startY: summaryY + 70,
    head: [["Invoice", "Patient", "Issued", "Due", "Status", "Total", "Open"]],
    body: opts.invoices.map((i) => {
      const patient = (i.patientName && i.patientName.trim()) || "—";
      const billTo = i.billTo && i.billTo.trim() ? i.billTo.trim() : "";
      const invoiceCell =
        billTo && billTo !== opts.practiceName
          ? `${i.invoiceNumber}\nBill to: ${billTo}`
          : i.invoiceNumber;
      return [
        invoiceCell,
        patient,
        i.issuedAt,
        i.dueAt,
        i.status,
        fmtMoney(i.total),
        Number(i.balanceDue) > 0 ? fmtMoney(i.balanceDue) : "—",
      ];
    }),
    styles: { fontSize: 9, cellPadding: 6, valign: "top" },
    headStyles: { fillColor: [40, 44, 52], textColor: 255 },
    columnStyles: {
      5: { halign: "right" },
      6: { halign: "right" },
    },
    margin: { left: margin, right: margin },
  });

  return doc;
}
