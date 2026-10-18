import jsPDF from "jspdf";
import { formatInvoiceDate } from "./invoice-date";
import autoTable from "jspdf-autotable";
import {
  coerceInvoiceTemplate,
  DEFAULT_INVOICE_TEMPLATE,
  type InvoiceTemplate,
} from "./invoice-template";
import { statementPeriodLabel } from "./invoice-due-date";
import {
  coerceStatementTemplate,
  DEFAULT_STATEMENT_TEMPLATE,
  type StatementTemplate,
} from "./statement-template";
import {
  coerceCorrespondenceTemplate,
  DEFAULT_CORRESPONDENCE_TEMPLATE,
  resolveMergeFields,
  type CorrespondenceTemplate,
} from "./correspondence-template";

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
  /** Full URL of the lab logo; shown when provided. */
  logoUrl?: string | null;
  /** Per-lab visual statement template. Null/undefined uses the built-in default. */
  template?: StatementTemplate | null;
  /** Map of extraImage.url → data-URL bytes. */
  extraImageDataUrls?: Record<string, string>;
  /** Lab name for the header fallback when no logo is available. */
  labName?: string;
  recipientType?: "practice" | "doctor";
  labContact?: {
    displayName?: string | null;
    legalName?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    phone?: string | null;
    billingEmail?: string | null;
    additionalEmails?: string[];
    accountNumber?: string | null;
    licenseNumber?: string | null;
  } | null;
  practiceContact?: StatementPdfOptions["labContact"];
  doctorContact?: {
    displayName?: string | null;
    phones?: string[];
    emails?: string[];
  } | null;
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
  toothLabel?: string | null;
  description: string;
  quantity: number | string;
  unitPrice: number | string;
  lineTotal: number | string;
  isDiscount?: boolean;
  subItems?: InvoicePdfLineItem[];
}

export interface InvoicePdfOptions {
  invoiceNumber: string;
  labName: string;
  practiceName: string;
  patientName?: string | null;
  billTo?: string | null;
  teeth?: string | null;
  shade?: string | null;
  material?: string | null;
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
  /** Logo size for this PDF. null/undefined treated as "medium". (Legacy preset; ignored when `template` is supplied.) */
  logoPdfSize?: "small" | "medium" | "large" | null;
  /**
   * Per-lab visual invoice template (Task #751). Drives layout of every
   * section + watermark/extra images. Null/undefined uses the built-in
   * default, which matches the historical hard-coded layout.
   */
  template?: InvoiceTemplate | null;
  /**
   * Map of `extraImage.url` → data-URL bytes (PNG/JPEG/etc.). When
   * present, those bytes are embedded onto the page. URLs without a
   * pre-loaded data URL are silently skipped so PDF rendering never
   * fails on a missing image.
   */
  extraImageDataUrls?: Record<string, string>;
  /**
   * The linked case's caseNumber (e.g. "25-001"). Used to build the QR URL
   * embedded in the invoice PDF so the code resolves to the correct case even
   * when the invoice number diverges from the case number.
   */
  caseNumber?: string | null;
  /**
   * PNG data URL of the QR code image to embed in the bottom-right corner
   * of the invoice PDF. Encodes the case deep-link URL so recipients can
   * scan to open the case directly in LabTrax.
   */
  qrCodeDataUrl?: string | null;
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

/**
 * Build the invoice "meta" row label/value pairs shown under the bill-to
 * block. Issued / Due / Status are always present; Teeth, Shade, and
 * Material are appended only when the invoice's display-metadata snapshot
 * carries them (e.g. populated by the AI prescription intake / iTero import).
 *
 * Pulled out of `buildInvoiceDoc` as a pure function so the shade/material
 * rendering rules are unit-testable without rendering a full jsPDF document.
 */
export function buildInvoiceMetaPairs(
  opts: Pick<
    InvoicePdfOptions,
    "issuedAt" | "dueAt" | "status" | "teeth" | "shade" | "material"
  >,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    ["Issued", formatInvoiceDate(opts.issuedAt)],
    ["Due", formatInvoiceDate(opts.dueAt)],
    ["Status", opts.status],
  ];
  if (opts.teeth && opts.teeth.trim()) pairs.push(["Teeth", opts.teeth.trim()]);
  if (opts.shade && opts.shade.trim()) pairs.push(["Shade", opts.shade.trim()]);
  if (opts.material && opts.material.trim())
    pairs.push(["Material", opts.material.trim()]);
  return pairs;
}

export function buildInvoicesPdf(options: InvoicePdfOptions[]): Blob {
  if (!options.length) throw new Error("No invoices to print.");
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  options.forEach((opts, index) => {
    if (index) doc.addPage();
    buildInvoiceDoc(opts, doc, true);
  });
  return doc.output("blob");
}

function buildInvoiceDoc(opts: InvoicePdfOptions, doc = new jsPDF({ unit: "pt", format: "letter" }), strictAssets = false) {
  const template = coerceInvoiceTemplate(opts.template ?? DEFAULT_INVOICE_TEMPLATE);
  const { boxes, logo, extraImages } = template;
  const extraDataUrls = opts.extraImageDataUrls ?? {};

  const setOpacity = (a: number) => {
    const gs = doc as unknown as {
      GState?: (o: { opacity: number }) => unknown;
      setGState?: (s: unknown) => void;
    };
    if (gs.GState && gs.setGState) gs.setGState(gs.GState({ opacity: a }));
  };

  // ── Watermark logo (drawn first, behind content) ─────────────────────
  if (opts.logoUrl && logo.mode === "watermark") {
    try {
      setOpacity(logo.opacity);
      doc.addImage(opts.logoUrl, logo.x, logo.y, logo.w, logo.h);
      setOpacity(1);
    } catch (error) {
      if (strictAssets) throw error;
      /* watermark is decorative */
    }
  }

  // ── Extra images (signatures, stamps, etc.) ──────────────────────────
  for (const img of extraImages) {
    const dataUrl = extraDataUrls[img.url];
    if (!dataUrl) continue;
    try {
      if (img.opacity < 1) setOpacity(img.opacity);
      doc.addImage(dataUrl, img.x, img.y, img.w, img.h);
      if (img.opacity < 1) setOpacity(1);
    } catch (error) {
      if (strictAssets) throw error;
      /* skip broken image */
    }
  }

  // ── Custom text blocks ───────────────────────────────────────────────
  for (const tb of template.customTexts ?? []) {
    if (!tb.text || !tb.text.trim()) continue;
    doc.setFontSize(tb.fontSize);
    doc.setFont("helvetica", tb.bold ? "bold" : "normal");
    doc.setTextColor(0);

    const jsPdfAlign = tb.align === "center" ? "center" : tb.align === "right" ? "right" : "left";
    const textX =
      tb.align === "center"
        ? tb.x + tb.w / 2
        : tb.align === "right"
        ? tb.x + tb.w
        : tb.x;

    // Split text to fit within the box width, then clip to box height.
    const lines = doc.splitTextToSize(tb.text.trim(), tb.w);
    const lineH = tb.fontSize * 1.3;
    const maxLines = Math.max(1, Math.floor(tb.h / lineH));
    const visibleLines = lines.slice(0, maxLines) as string[];

    doc.text(visibleLines, textX, tb.y + tb.fontSize, { align: jsPdfAlign });
    doc.setFont("helvetica", "normal");
  }

  // ── Header box ───────────────────────────────────────────────────────
  const hdr = boxes.header;
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.text("Invoice", hdr.x, hdr.y + 20);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120);
  doc.text(`#${opts.invoiceNumber}`, hdr.x, hdr.y + 36);
  doc.setTextColor(0);

  // ── Header-mode logo (or lab-name text fallback) ─────────────────────
  if (opts.logoUrl && logo.mode === "header") {
    try {
      doc.addImage(opts.logoUrl, logo.x, logo.y, logo.w, logo.h);
    } catch (error) {
      if (strictAssets) throw error;
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text(opts.labName, logo.x + logo.w, logo.y + 20, { align: "right" });
      doc.setFont("helvetica", "normal");
    }
  } else if (logo.mode === "header") {
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text(opts.labName, logo.x + logo.w, logo.y + 20, { align: "right" });
    doc.setFont("helvetica", "normal");
  }
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    `Generated ${String(opts.generatedAt.getMonth() + 1).padStart(2, "0")}/${String(opts.generatedAt.getDate()).padStart(2, "0")}/${opts.generatedAt.getFullYear()}`,
    logo.x + logo.w,
    logo.y + logo.h + 8,
    { align: "right" },
  );
  doc.setTextColor(0);

  // ── Bill-to / Patient ────────────────────────────────────────────────
  const bt = boxes.billTo;
  const billToValue = (opts.billTo && opts.billTo.trim()) || opts.practiceName;
  const halfW = Math.min(220, bt.w / 2);
  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text("BILL TO", bt.x, bt.y);
  doc.text("PATIENT", bt.x + halfW, bt.y);
  doc.setTextColor(0);
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text(billToValue, bt.x, bt.y + 14);
  doc.text(
    (opts.patientName && opts.patientName.trim()) || "—",
    bt.x + halfW,
    bt.y + 14,
  );
  doc.setFont("helvetica", "normal");
  if (billToValue !== opts.practiceName) {
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(opts.practiceName, bt.x, bt.y + 28);
    doc.setTextColor(0);
  }

  // ── Meta row ─────────────────────────────────────────────────────────
  const m = boxes.meta;
  const metaPairs = buildInvoiceMetaPairs(opts);
  const colW = m.w / metaPairs.length;
  metaPairs.forEach(([label, value], i) => {
    const x = m.x + colW * i;
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(label.toUpperCase(), x, m.y);
    doc.setFontSize(10);
    doc.setTextColor(0);
    doc.text(value, x, m.y + 14);
  });

  // ── Statement period note (below meta row) ───────────────────────────
  if (opts.issuedAt) {
    const period = statementPeriodLabel(opts.issuedAt);
    doc.setFontSize(7.5);
    doc.setTextColor(100);
    doc.text(
      `Will be included on your ${period} statement, generated at end of month.`,
      m.x,
      m.y + 28,
      { maxWidth: m.w },
    );
    doc.setTextColor(0);
  }

  // ── Case notes (above items) ─────────────────────────────────────────
  let postNotesY = boxes.items.y;
  // Flow variable-length notes across pages rather than drawing beyond the
  // bottom edge. Keep the QR/footer region free on every continuation page.
  const bottom = doc.internal.pageSize.getHeight() - 125;
  const writeFlowText = (text: string, x: number, y: number, width: number): number => {
    const lines = doc.splitTextToSize(text, width) as string[];
    for (const line of lines) {
      if (y > bottom) {
        doc.addPage();
        y = 48;
      }
      doc.text(line, x, y);
      y += 11;
    }
    return y;
  };
  if (opts.caseNotes && opts.caseNotes.trim()) {
    const notesY = m.y + m.h + 6;
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text("CASE NOTES", m.x, notesY);
    doc.setFontSize(9);
    doc.setTextColor(0);
    const startPage = doc.getNumberOfPages();
    const endY = writeFlowText(opts.caseNotes.trim(), m.x, notesY + 12, m.w);
    postNotesY = doc.getNumberOfPages() === startPage
      ? Math.max(postNotesY, endY + 4)
      : endY + 4;
  }

  // ── Line-items table ─────────────────────────────────────────────────
  const it = boxes.items;
  const itemsStartY = Math.max(it.y, postNotesY);
  const pageWidth = doc.internal.pageSize.getWidth();
  const tableBody: string[][] = [];
  const isSubItemRow: boolean[] = [];
  const isSubtotalRow: boolean[] = [];
  for (const row of opts.items) {
    tableBody.push([
      (row.item && String(row.item).trim()) || "—",
      row.toothLabel != null ? row.toothLabel : row.toothNumber != null ? String(row.toothNumber) : "—",
      `${row.isDiscount ? "Discount: " : ""}${row.description}`,
      String(row.quantity),
      fmtMoney(row.unitPrice as number | string),
      fmtMoney(row.lineTotal as number | string),
    ]);
    isSubItemRow.push(false);
    isSubtotalRow.push(false);
    const subs = row.subItems ?? [];
    for (const sub of subs) {
      tableBody.push([
        (sub.item && String(sub.item).trim()) ? `↳ ${String(sub.item).trim()}` : "↳",
        sub.toothNumber != null ? String(sub.toothNumber) : "—",
        `${sub.isDiscount ? "Discount: " : ""}${sub.description}`,
        String(sub.quantity),
        fmtMoney(sub.unitPrice as number | string),
        fmtMoney(sub.lineTotal as number | string),
      ]);
      isSubItemRow.push(true);
      isSubtotalRow.push(false);
    }
    if (subs.length > 0) {
      const groupTotal = Number(row.lineTotal) + subs.reduce((s, sub) => s + Number(sub.lineTotal), 0);
      tableBody.push(["", "", "— Subtotal", "", "", fmtMoney(groupTotal)]);
      isSubItemRow.push(false);
      isSubtotalRow.push(true);
    }
  }
  autoTable(doc, {
    startY: itemsStartY,
    head: [["Item", "Tooth #", "Description", "Qty", "Unit price", "Total"]],
    body: tableBody,
    styles: { fontSize: 9, cellPadding: 6 },
    headStyles: { fillColor: [40, 44, 52], textColor: 255 },
    columnStyles: {
      0: { cellWidth: Math.max(60, it.w * 0.18) },
      1: { halign: "right", cellWidth: 44 },
      3: { halign: "right", cellWidth: 36 },
      4: { halign: "right", cellWidth: 76 },
      5: { halign: "right", cellWidth: 76 },
    },
    margin: { top: 48, bottom: 125, left: it.x, right: pageWidth - (it.x + it.w) },
    didParseCell: (data) => {
      if (data.section === "body") {
        if (isSubItemRow[data.row.index]) {
          data.cell.styles.textColor = [100, 100, 100];
          data.cell.styles.fontSize = 8;
          data.cell.styles.fillColor = [248, 250, 252];
          if (data.column.index === 0) {
            data.cell.styles.cellPadding = { top: 3, bottom: 3, right: 4, left: 16 };
          }
        } else if (isSubtotalRow[data.row.index]) {
          data.cell.styles.fillColor = [230, 232, 235];
          data.cell.styles.textColor = [80, 80, 80];
          data.cell.styles.fontSize = 8;
          data.cell.styles.cellPadding = { top: 4, bottom: 4, right: 6, left: 6 };
          if (data.column.index === 2) {
            data.cell.styles.fontStyle = "italic";
          }
          if (data.column.index === 5) {
            data.cell.styles.fontStyle = "bold";
            data.cell.styles.halign = "right";
          }
        }
      }
    },
  });

  // ── Totals block ─────────────────────────────────────────────────────
  const t = boxes.totals;
  const afterTable = (doc as unknown as { lastAutoTable?: { finalY: number } })
    .lastAutoTable;
  let totalsY = Math.max(t.y, (afterTable?.finalY ?? itemsStartY) + 16);
  if (totalsY + 130 > bottom) {
    doc.addPage();
    totalsY = 48;
  }
  const totalsX = t.x;
  const valueX = t.x + t.w;
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

  // ── Notes ────────────────────────────────────────────────────────────
  if (opts.notes && opts.notes.trim()) {
    const notesX = boxes.items.x;
    const notesW = boxes.items.w;
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text("NOTES", notesX, totalsY + 12);
    doc.setFontSize(9);
    doc.setTextColor(0);
    writeFlowText(opts.notes.trim(), notesX, totalsY + 26, notesW);
  }

  // ── QR code ──────────────────────────────────────────────────────────
  if (opts.qrCodeDataUrl) {
    const qrSize = 60;
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = boxes.items.x;
    const qrX = pageWidth - margin - qrSize;
    const qrY = pageHeight - margin - qrSize - 10;
    try {
      doc.addImage(opts.qrCodeDataUrl, "PNG", qrX, qrY, qrSize, qrSize);
      doc.setFontSize(7);
      doc.setTextColor(130);
      const qrLabel = opts.caseNumber
        ? `Scan to open case ${opts.caseNumber}`
        : "Scan to open case";
      doc.text(qrLabel, qrX + qrSize / 2, qrY + qrSize + 8, { align: "center" });
    } catch (error) {
      if (strictAssets) throw error;
      // silently skip if image embedding fails
    }
  }

  return doc;
}

function fmtDate(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

/** Formats a Date as "MM/DD/YYYY, h:mm AM/PM" for "Generated …" export stamps. */
function fmtGeneratedAt(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${mm}/${dd}/${yyyy}, ${timeStr}`;
}

// ── Template-aware statement PDF ─────────────────────────────────────────────

/**
 * Builds a statement PDF using the per-lab template layout.
 * Returns true when the preview window opened successfully.
 */
export function previewStatementLayoutPdf(opts: StatementPdfOptions): boolean {
  const doc = buildStatementDoc(opts);
  doc.output("dataurlnewwindow", { filename: "statement-preview.pdf" });
  return true;
}

// ── Correspondence PDF ────────────────────────────────────────────────────────

export interface CorrespondencePdfOptions {
  labName: string;
  practiceName: string;
  patientName?: string;
  balance?: string;
  dueDate?: string;
  invoiceNumber?: string;
  date: string;
  generatedAt: Date;
  logoUrl?: string | null;
  template?: CorrespondenceTemplate | null;
  extraImageDataUrls?: Record<string, string>;
}

export function previewCorrespondencePdf(opts: CorrespondencePdfOptions): boolean {
  const tpl = coerceCorrespondenceTemplate(opts.template ?? null);
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const extraImageDataUrls = opts.extraImageDataUrls ?? {};

  // ── Logo ─────────────────────────────────────────────────────────────────────
  if (opts.logoUrl) {
    const logoData = extraImageDataUrls[opts.logoUrl] ?? null;
    if (logoData) {
      const logo = tpl.logo;
      if (logo.mode === "watermark") {
        (doc as any).setGState?.(new (doc as any).GState({ opacity: logo.opacity }));
        doc.addImage(logoData, "PNG", logo.x, logo.y, logo.w, logo.h);
        (doc as any).setGState?.(new (doc as any).GState({ opacity: 1 }));
      } else {
        doc.addImage(logoData, "PNG", logo.x, logo.y, logo.w, logo.h);
      }
    }
  }

  // ── Extra images ─────────────────────────────────────────────────────────────
  for (const img of tpl.extraImages) {
    const data = extraImageDataUrls[img.url];
    if (!data) continue;
    try {
      (doc as any).setGState?.(new (doc as any).GState({ opacity: img.opacity }));
      doc.addImage(data, "PNG", img.x, img.y, img.w, img.h);
      (doc as any).setGState?.(new (doc as any).GState({ opacity: 1 }));
    } catch { /* skip */ }
  }

  // ── Custom text blocks ────────────────────────────────────────────────────────
  for (const tb of tpl.customTexts) {
    if (!tb.text?.trim()) continue;
    doc.setFontSize(tb.fontSize);
    doc.setFont("helvetica", tb.bold ? "bold" : "normal");
    doc.setTextColor(0);
    const lines = doc.splitTextToSize(tb.text, tb.w);
    doc.text(lines, tb.align === "right" ? tb.x + tb.w : tb.align === "center" ? tb.x + tb.w / 2 : tb.x, tb.y + tb.fontSize, { align: tb.align });
  }

  const mergeCtx = {
    practiceName: opts.practiceName,
    patientName: opts.patientName,
    balance: opts.balance,
    dueDate: opts.dueDate,
    labName: opts.labName,
    date: opts.date,
    invoiceNumber: opts.invoiceNumber,
  };

  // ── Letter header ─────────────────────────────────────────────────────────────
  const lh = tpl.boxes.letterHeader;
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0);
  doc.text(opts.labName, lh.x, lh.y + 20);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");

  // ── Date block ────────────────────────────────────────────────────────────────
  const db = tpl.boxes.dateBlock;
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(0);
  doc.text(opts.date, db.x, db.y + 14);

  // ── Recipient block ───────────────────────────────────────────────────────────
  const rb = tpl.boxes.recipientBlock;
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(0);
  doc.text(opts.practiceName, rb.x, rb.y + 14);
  if (opts.patientName) {
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(`RE: Patient ${opts.patientName}`, rb.x, rb.y + 30);
    doc.setTextColor(0);
  }

  // ── Body block ────────────────────────────────────────────────────────────────
  const bb = tpl.boxes.bodyBlock;
  const resolvedBody = resolveMergeFields(tpl.bodyText, mergeCtx);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(0);
  const bodyLines = doc.splitTextToSize(resolvedBody, bb.w);
  doc.text(bodyLines, bb.x, bb.y + 14);

  // ── Closing block ─────────────────────────────────────────────────────────────
  const cb = tpl.boxes.closingBlock;
  const resolvedClosing = resolveMergeFields(tpl.closingText, mergeCtx);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(0);
  const closingLines = doc.splitTextToSize(resolvedClosing, cb.w);
  doc.text(closingLines, cb.x, cb.y + 14);

  doc.output("dataurlnewwindow", { filename: "correspondence-preview.pdf" });
  return true;
}

function buildStatementDoc(opts: StatementPdfOptions) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const template = coerceStatementTemplate(opts.template);
  const nonblank = (value?: string | null) => value?.trim() || null;
  const contactLines = (contact: StatementPdfOptions["labContact"]) => {
    if (!contact) return [];
    const lines = [
      nonblank(contact.displayName),
      contact.legalName && contact.legalName !== contact.displayName
        ? `Legal name: ${contact.legalName}`
        : null,
      nonblank(contact.addressLine1),
      nonblank(contact.addressLine2),
      [contact.city, contact.state, contact.zip].filter(Boolean).join(", ") || null,
      contact.phone ? `Phone: ${contact.phone}` : null,
      contact.billingEmail ? `Billing email: ${contact.billingEmail}` : null,
      ...(contact.additionalEmails ?? []).filter((email) => email !== contact.billingEmail).map((email) => `Additional email: ${email}`),
      contact.accountNumber ? `Account #: ${contact.accountNumber}` : null,
      contact.licenseNumber ? `License #: ${contact.licenseNumber}` : null,
    ];
    return lines.filter((line): line is string => !!line);
  };
  const writeBox = (
    box: StatementTemplate["boxes"][keyof StatementTemplate["boxes"]],
    lines: string[],
    size = 9,
  ) => {
    if (!lines.length) return;
    const available = Math.max(1, Math.floor(box.h / (size + 1)));
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    doc.setTextColor(0);
    doc.text(lines.slice(0, available), box.x + 5, box.y + size + 2, {
      maxWidth: Math.max(1, box.w - 10),
      lineHeightFactor: 1.1,
    });
  };
  const addImage = (
    url: string | null | undefined,
    box: Pick<StatementTemplate["logo"], "x" | "y" | "w" | "h">,
    opacity = 1,
  ) => {
    if (!url) return;
    let opacityApplied = false;
    try {
      if (opacity < 1) {
        doc.setGState(new (doc as any).GState({ opacity }));
        opacityApplied = true;
      }
      doc.addImage(url, "AUTO", box.x, box.y, box.w, box.h, undefined, "MEDIUM");
    } catch { /* image loading is validated before this renderer is called */ }
    finally {
      if (opacityApplied) {
        try {
          doc.setGState(new (doc as any).GState({ opacity: 1 }));
        } catch { /* do not let a graphics-state reset hide the rest of the preview */ }
      }
    }
  };

  if (template.logo.mode === "watermark") addImage(opts.logoUrl, template.logo, template.logo.opacity);
  for (const image of template.extraImages) addImage(opts.extraImageDataUrls?.[image.url], image, image.opacity);
  for (const block of template.customTexts) {
    writeBox(block, block.text ? [block.text] : [], block.fontSize);
  }
  if (template.logo.mode === "header") addImage(opts.logoUrl, template.logo, template.logo.opacity);
  const recipientLines = opts.recipientType === "doctor"
    ? [
        nonblank(opts.doctorContact?.displayName),
        ...(opts.doctorContact?.phones ?? []).map((phone) => `Phone: ${phone}`),
        ...(opts.doctorContact?.emails ?? []).map((email) => `Email: ${email}`),
        "Practice context",
        ...contactLines(opts.practiceContact),
      ].filter((line): line is string => !!line)
    : contactLines(opts.practiceContact);
  const transactionRows = opts.invoices.map((invoice) => {
    const patient = (invoice.patientName && invoice.patientName.trim()) || "—";
    const billTo = invoice.billTo && invoice.billTo.trim() ? invoice.billTo.trim() : "";
    return [
      billTo && billTo !== opts.practiceName ? `${invoice.invoiceNumber}\nBill to: ${billTo}` : invoice.invoiceNumber,
      patient,
      invoice.issuedAt,
      invoice.dueAt,
      invoice.status,
      fmtMoney(invoice.total),
      Number(invoice.balanceDue) > 0 ? fmtMoney(invoice.balanceDue) : "—",
    ];
  });

  for (const section of template.sections.filter((item) => item.enabled)) {
    const title = section.title.trim() || "Section";
    if (section.contentMode === "custom" || section.type === "custom") {
      writeBox(section.box, [title, section.customText?.trim() || ""].filter(Boolean), 9);
      continue;
    }
    switch (section.generatedType) {
      case "stmtHeader":
        writeBox(section.box, [
          title,
          opts.labName || "",
          `For: ${opts.practiceName}`,
          `Generated: ${fmtGeneratedAt(opts.generatedAt)}`,
          ...(opts.filtersDescription ? [opts.filtersDescription] : []),
        ].filter(Boolean), 10);
        break;
      case "labInfo":
        writeBox(section.box, [title, ...contactLines(opts.labContact)], 8.5);
        break;
      case "practiceInfo":
        writeBox(section.box, [title, ...recipientLines], 8.5);
        break;
      case "balanceSummary":
        writeBox(section.box, [
          title,
          `Billed: ${fmtMoney(opts.totals.billed)}    Paid: ${fmtMoney(opts.totals.paid)}    Open balance: ${fmtMoney(opts.totals.open)}`,
          `Overdue: ${fmtMoney(opts.totals.overdue)}`,
        ], 9);
        break;
      case "transactions": {
        const tx = section.box;
        writeBox({ ...tx, h: 18 }, [title], 9);
        autoTable(doc, {
          startY: tx.y + 20,
          head: [["Invoice", "Patient", "Issued", "Due", "Status", "Total", "Open"]],
          body: transactionRows,
          styles: { fontSize: 8, cellPadding: 4, valign: "top" },
          headStyles: { fillColor: [40, 44, 52], textColor: 255 },
          columnStyles: { 5: { halign: "right" }, 6: { halign: "right" } },
          margin: { left: tx.x, right: 612 - tx.x - tx.w },
          tableWidth: tx.w,
        });
        break;
      }
      case "aging":
        writeBox(section.box, [
          title,
          `Current: ${fmtMoney(Math.max(0, opts.totals.open - opts.totals.overdue))}    90+ days: ${fmtMoney(opts.totals.overdue)}`,
        ], 8);
        break;
      case "totals":
        writeBox(section.box, [
          title,
          `Billed: ${fmtMoney(opts.totals.billed)}`,
          `Paid: ${fmtMoney(opts.totals.paid)}`,
          `Balance due: ${fmtMoney(opts.totals.open)}`,
        ], 8.5);
        break;
      case "footer":
        writeBox(section.box, [title], 8);
        break;
    }
  }

  return doc;
}
