// PDF generation + sharing helpers for the mobile case-detail screen.
//
// Two pure HTML builders (`buildCaseCardHtml`, `buildInvoiceHtml`) render a
// print-ready document from already-extracted case/invoice data, and two thin
// wrappers turn HTML into a shareable PDF:
//   - `generatePdf(html, { base64 })` → expo-print
//   - `sharePdf(uri)`                 → expo-sharing (OS share sheet)
//
// The builders are deliberately self-contained (local esc/format helpers, no
// theme tokens) so they are fully unit-testable and so this file's inline CSS
// hex colours stay out of the `app/**` + `components/**` lint:hex scan. The
// share flow mirrors `open-attachment.ts` (isAvailableAsync → shareAsync with a
// PDF mime type / UTI).
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

// ─── Local formatting helpers (kept independent of the screen) ────────────────
function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtMoney(v?: string | number | null): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `$${n.toFixed(2)}`;
}

function titleCaseLocal(s?: string | null): string {
  if (!s) return "";
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

const DOC_CSS = `
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    margin: 0;
    padding: 32px;
    font-size: 13px;
    line-height: 1.5;
  }
  .doc-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 2px solid #1a1a1a;
    padding-bottom: 12px;
    margin-bottom: 20px;
  }
  .doc-title { font-size: 22px; font-weight: 700; margin: 0; }
  .doc-sub { font-size: 12px; color: #666; margin: 2px 0 0; }
  .lab-name { font-size: 14px; font-weight: 600; text-align: right; }
  .badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    background: #eef0f2;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .case-id-box {
    display: inline-block;
    border: 1px solid #cfd3d8;
    border-radius: 6px;
    padding: 6px 14px;
    font-family: "Courier New", Courier, monospace;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 0.12em;
  }
  .meta-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 24px;
    margin: 16px 0 20px;
  }
  .meta-row { display: flex; justify-content: space-between; border-bottom: 1px solid #eee; padding: 4px 0; }
  .meta-label { color: #777; }
  .meta-value { font-weight: 600; text-align: right; }
  .section-title {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #777;
    margin: 22px 0 6px;
  }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { padding: 7px 8px; text-align: left; border-bottom: 1px solid #e6e8ea; font-size: 12px; }
  th { color: #777; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
  td.num, th.num { text-align: right; }
  .totals { margin-top: 14px; width: 100%; }
  .totals td { border: none; padding: 3px 8px; }
  .totals .total-row td { font-size: 15px; font-weight: 700; border-top: 2px solid #1a1a1a; padding-top: 8px; }
  .rx-block { background: #f7f8f9; border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; }
  .empty { color: #999; font-style: italic; }
`;

function docShell(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><style>${DOC_CSS}</style></head><body>${body}</body></html>`;
}

// ─── Case work-order card ─────────────────────────────────────────────────────
export interface CaseCardRestoration {
  toothNumber?: string | null;
  restorationType?: string | null;
  material?: string | null;
  shade?: string | null;
  quantity?: number | null;
}

export interface CaseCardData {
  caseNumber?: string | null;
  patientName?: string | null;
  doctorName?: string | null;
  dueDate?: string | null;
  expectedDeliveryDate?: string | null;
  priority?: string | null;
  status?: string | null;
  rxNotes?: string | null;
  restorations?: CaseCardRestoration[] | null;
  labName?: string | null;
}

export function buildCaseCardHtml(d: CaseCardData): string {
  const rows: Array<[string, string]> = [
    ["Patient", esc(d.patientName || "—")],
    ["Doctor", esc(d.doctorName || "—")],
    ["Status", esc(titleCaseLocal(d.status) || "—")],
    ["Priority", esc(titleCaseLocal(d.priority) || "Standard")],
    ["Due", esc(fmtDate(d.dueDate))],
    ["Expected delivery", esc(fmtDate(d.expectedDeliveryDate))],
  ];
  const meta = rows
    .map(
      ([label, value]) =>
        `<div class="meta-row"><span class="meta-label">${label}</span><span class="meta-value">${value}</span></div>`,
    )
    .join("");

  const restorations = d.restorations ?? [];
  const restRows = restorations.length
    ? restorations
        .map(
          (r) =>
            `<tr><td>${esc(r.toothNumber || "—")}</td><td>${esc(
              titleCaseLocal(r.restorationType) || "—",
            )}</td><td>${esc(r.material || "—")}</td><td>${esc(r.shade || "—")}</td><td class="num">${esc(
              r.quantity ?? 1,
            )}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="empty">No restorations recorded.</td></tr>`;

  const rx =
    d.rxNotes && d.rxNotes.trim()
      ? `<div class="section-title">Rx Instructions</div><div class="rx-block">${esc(d.rxNotes.trim())}</div>`
      : "";

  const body = `
    <div class="doc-header">
      <div>
        <h1 class="doc-title">Work Order</h1>
        <p class="doc-sub">Case detail &amp; restoration summary</p>
      </div>
      <div class="lab-name">${esc(d.labName || "")}</div>
    </div>
    <div class="case-id-box">#${esc(d.caseNumber || "—")}</div>
    <div class="meta-grid">${meta}</div>
    <div class="section-title">Restorations</div>
    <table>
      <thead><tr><th>Tooth</th><th>Type</th><th>Material</th><th>Shade</th><th class="num">Qty</th></tr></thead>
      <tbody>${restRows}</tbody>
    </table>
    ${rx}
  `;
  return docShell(`Work Order #${d.caseNumber ?? ""}`, body);
}

// ─── Invoice document ─────────────────────────────────────────────────────────
export interface InvoicePdfLine {
  description?: string | null;
  toothNumbers?: string | null;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  lineTotal?: number | string | null;
}

export interface InvoicePdfData {
  invoiceNumber?: string | null;
  status?: string | null;
  issuedAt?: string | null;
  dueAt?: string | null;
  total?: number | string | null;
  balanceDue?: number | string | null;
  items?: InvoicePdfLine[] | null;
  patientName?: string | null;
  caseNumber?: string | null;
  labName?: string | null;
}

export function buildInvoiceHtml(d: InvoicePdfData): string {
  const items = d.items ?? [];
  const itemRows = items.length
    ? items
        .map((li) => {
          const desc = li.description || "Item";
          const tooth = li.toothNumbers ? ` · #${li.toothNumbers}` : "";
          return `<tr><td>${esc(desc)}${esc(tooth)}</td><td class="num">${esc(
            li.quantity ?? 1,
          )}</td><td class="num">${esc(fmtMoney(li.unitPrice))}</td><td class="num">${esc(
            fmtMoney(li.lineTotal),
          )}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="4" class="empty">No line items.</td></tr>`;

  const body = `
    <div class="doc-header">
      <div>
        <h1 class="doc-title">Invoice</h1>
        <p class="doc-sub">${d.invoiceNumber ? `#${esc(d.invoiceNumber)}` : ""}</p>
      </div>
      <div>
        <div class="lab-name">${esc(d.labName || "")}</div>
        ${d.status ? `<div style="text-align:right;margin-top:6px;"><span class="badge">${esc(titleCaseLocal(d.status))}</span></div>` : ""}
      </div>
    </div>
    <div class="meta-grid">
      <div class="meta-row"><span class="meta-label">Patient</span><span class="meta-value">${esc(d.patientName || "—")}</span></div>
      <div class="meta-row"><span class="meta-label">Case #</span><span class="meta-value">${esc(d.caseNumber || "—")}</span></div>
      <div class="meta-row"><span class="meta-label">Issued</span><span class="meta-value">${esc(fmtDate(d.issuedAt))}</span></div>
      <div class="meta-row"><span class="meta-label">Due</span><span class="meta-value">${esc(fmtDate(d.dueAt))}</span></div>
    </div>
    <div class="section-title">Line Items</div>
    <table>
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <table class="totals">
      <tr><td class="num" style="width:80%">Total</td><td class="num">${esc(fmtMoney(d.total))}</td></tr>
      <tr class="total-row"><td class="num">Balance Due</td><td class="num">${esc(fmtMoney(d.balanceDue))}</td></tr>
    </table>
  `;
  return docShell(`Invoice ${d.invoiceNumber ?? ""}`, body);
}

// ─── PDF generation + sharing ─────────────────────────────────────────────────
export interface GeneratedPdf {
  uri: string;
  base64?: string;
}

// Render HTML to a temporary PDF file. Pass { base64: true } to also receive the
// base-64 encoded bytes (used for the email-invoice attachment path).
export async function generatePdf(
  html: string,
  opts?: { base64?: boolean },
): Promise<GeneratedPdf> {
  const result = await Print.printToFileAsync({ html, base64: opts?.base64 });
  return { uri: result.uri, base64: (result as { base64?: string }).base64 };
}

// Hand a generated PDF to the OS share sheet. Throws when sharing is
// unavailable so callers can surface a clear message.
export async function sharePdf(
  uri: string,
  opts?: { dialogTitle?: string },
): Promise<void> {
  let available = false;
  try {
    available = await Sharing.isAvailableAsync();
  } catch {
    available = false;
  }
  if (!available) {
    throw new Error("Sharing isn't available on this device.");
  }
  await Sharing.shareAsync(uri, {
    mimeType: "application/pdf",
    UTI: "com.adobe.pdf",
    dialogTitle: opts?.dialogTitle,
  });
}
