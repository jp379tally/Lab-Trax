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
  toothNumber?: number | null;
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
  /** Logo size for this PDF. null/undefined treated as "medium". */
  logoPdfSize?: "small" | "medium" | "large" | null;
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

// Open the PDF in a dedicated popup window (separate from the main
// LabTrax window/tab) with a LabTrax-branded header bar and a clear
// Close button, so the user always has an obvious way back. Returns
// `true` if the popup opened, or `false` if the browser blocked it —
// the caller is responsible for telling the user how to allow popups.
export function previewInvoicePdf(opts: InvoicePdfOptions): boolean {
  const built = buildInvoicePdf(opts);
  const pdfUrl = URL.createObjectURL(built.blob);

  // Sized roughly like a US-Letter page; both Electron's child
  // BrowserWindow and a regular browser honour `width`/`height` /
  // `popup=yes`, which is what forces a separate window rather than
  // a sibling tab.
  const width = 900;
  const height = 1100;
  const left =
    typeof window !== "undefined" && typeof window.screenX === "number"
      ? Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2))
      : 0;
  const top =
    typeof window !== "undefined" && typeof window.screenY === "number"
      ? Math.max(0, window.screenY + Math.round((window.outerHeight - height) / 2))
      : 0;
  const features = `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;

  const win = window.open("about:blank", "labtrax-invoice-preview", features);
  if (!win) {
    URL.revokeObjectURL(pdfUrl);
    return false;
  }

  const title = `Invoice ${built.filename.replace(/\.pdf$/i, "").replace(/^invoice-/, "")}`;
  const invoiceLabel = opts.invoiceNumber ? `Invoice ${opts.invoiceNumber}` : "Invoice preview";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtmlAttr(title)}</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0f172a; color: #f8fafc;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .lt-preview-bar { display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; background: #0b1220; border-bottom: 1px solid #1e293b; height: 48px;
    box-sizing: border-box; }
  .lt-preview-title { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; }
  .lt-preview-brand { font-weight: 700; letter-spacing: 0.02em; color: #60a5fa; }
  .lt-preview-sep { color: #475569; }
  .lt-preview-close { display: inline-flex; align-items: center; gap: 6px;
    background: #ef4444; color: #fff; border: 0; border-radius: 6px;
    padding: 6px 12px; font-size: 13px; font-weight: 600; cursor: pointer;
    font-family: inherit; }
  .lt-preview-close:hover { background: #dc2626; }
  .lt-preview-close:focus { outline: 2px solid #fca5a5; outline-offset: 2px; }
  .lt-preview-frame { display: block; width: 100%; height: calc(100% - 48px); border: 0; background: #1e293b; }
</style>
</head>
<body>
  <div class="lt-preview-bar">
    <div class="lt-preview-title">
      <span class="lt-preview-brand">LabTrax</span>
      <span class="lt-preview-sep">·</span>
      <span>${escapeHtmlAttr(invoiceLabel)}</span>
    </div>
    <button type="button" class="lt-preview-close" id="lt-close" aria-label="Close preview window">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      Close
    </button>
  </div>
  <iframe class="lt-preview-frame" src="${escapeHtmlAttr(pdfUrl)}" title="${escapeHtmlAttr(invoiceLabel)}"></iframe>
  <script>
    (function() {
      var btn = document.getElementById('lt-close');
      if (btn) btn.addEventListener('click', function() { window.close(); });
      window.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') window.close();
      });
      window.addEventListener('unload', function() {
        try { if (window.opener && !window.opener.closed) window.opener.focus(); } catch (_) {}
      });
    })();
  </script>
</body>
</html>`;

  try {
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
  } catch {
    // If we can't write into the popup for any reason, fall back to
    // loading the raw PDF inside it — the popup itself is still a
    // separate window with the browser's native close affordance.
    try {
      win.location.href = pdfUrl;
    } catch {
      /* ignore */
    }
  }

  // Revoke the PDF blob URL once the popup closes (or after a generous
  // safety-net timeout if we can't observe the close). We also try to
  // hook the popup's `unload` from the opener side as a backup.
  const revoke = () => URL.revokeObjectURL(pdfUrl);
  let revoked = false;
  const safeRevoke = () => {
    if (revoked) return;
    revoked = true;
    revoke();
  };
  try {
    win.addEventListener("unload", safeRevoke);
  } catch {
    /* cross-origin or detached — fall through to timer */
  }
  const poll = window.setInterval(() => {
    if (win.closed) {
      window.clearInterval(poll);
      safeRevoke();
    }
  }, 1000);
  window.setTimeout(() => {
    window.clearInterval(poll);
    safeRevoke();
  }, 5 * 60_000);

  return true;
}

function escapeHtmlAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

  // Logo height per size setting
  const LOGO_HEIGHTS: Record<string, number> = { small: 28, medium: 40, large: 56 };
  const LOGO_MAX_WIDTHS: Record<string, number> = { small: 90, medium: 130, large: 180 };
  const logoSizeKey = opts.logoPdfSize ?? "medium";
  const logoH = LOGO_HEIGHTS[logoSizeKey] ?? 40;
  const logoMaxW = LOGO_MAX_WIDTHS[logoSizeKey] ?? 130;

  // Lab logo (top-right) or lab name text
  if (opts.logoUrl) {
    try {
      // Place logo flush with the right margin, auto-width from height
      const logoX = pageWidth - margin - logoMaxW;
      doc.addImage(opts.logoUrl, logoX, 30, 0, logoH);
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
    head: [["Item", "Tooth #", "Description", "Qty", "Unit price", "Total"]],
    body: opts.items.map((it) => [
      (it.item && String(it.item).trim()) || "—",
      it.toothNumber != null ? String(it.toothNumber) : "—",
      it.description,
      String(it.quantity),
      fmtMoney(it.unitPrice as number | string),
      fmtMoney(it.lineTotal as number | string),
    ]),
    styles: { fontSize: 9, cellPadding: 6 },
    headStyles: { fillColor: [40, 44, 52], textColor: 255 },
    columnStyles: {
      0: { cellWidth: 100 },
      1: { halign: "right", cellWidth: 44 },
      3: { halign: "right", cellWidth: 36 },
      4: { halign: "right", cellWidth: 76 },
      5: { halign: "right", cellWidth: 76 },
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
