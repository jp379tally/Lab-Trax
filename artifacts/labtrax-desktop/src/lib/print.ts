import printCss from "@/styles/print.css?raw";
import { formatDate, formatDateTime, formatMoney, statusLabel } from "./format";
import {
  buildHighlightedToothValue,
  deriveRxSummary,
  formatRxTeethLabel,
  formatRxTeethWithShades,
} from "./rx-summary";
import type {
  CaseAttachment,
  CaseEvent,
  CaseRestoration,
  Invoice,
  LabCase,
} from "./types";
import {
  type PrintLayoutConfig,
  loadPrintLayoutConfig,
} from "./print-layout";
import {
  PAGE_H as TPL_PAGE_H,
  PAGE_W as TPL_PAGE_W,
  type CasePrintTemplate,
} from "./case-print-template";
import { getApiOrigin } from "./api";

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openPrintWindow(opts: {
  title: string;
  body: string;
  extraCss?: string;
  bodyClass?: string;
}): void {
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) {
    window.alert(
      "Pop-ups must be allowed in this browser to print from LabTrax.",
    );
    return;
  }
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(opts.title)}</title>
<style>${printCss}${opts.extraCss ? `\n${opts.extraCss}` : ""}</style>
</head>
<body class="${opts.bodyClass ?? "lt-print"}">${opts.body}</body>
</html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
  // Give the document a tick to lay out before invoking print so the
  // print preview reflects the styles. Some browsers (Chromium/Electron)
  // need a microtask gap before print() to avoid blank previews.
  w.focus();
  window.setTimeout(() => {
    try {
      w.print();
    } catch {
      /* user cancelled or pop-up blocker — ignore */
    }
  }, 200);
}

function formatEventTitle(eventType: string | null | undefined): string {
  if (!eventType) return "Event";
  // Mirror the in-app label: the desktop "Locate Case" action records
  // a status_changed event, but users think of it as locating the case
  // at a station — show it as "Location Changed" in the printed history.
  if (eventType === "status_changed") return "Location Changed";
  return eventType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function eventMetaLine(event: CaseEvent): string {
  const meta =
    event.metadataJson && typeof event.metadataJson === "object"
      ? (event.metadataJson as Record<string, unknown>)
      : {};
  const t = event.eventType || "";
  if (t === "status_changed" && meta.fromStatus && meta.toStatus) {
    return `${statusLabel(String(meta.fromStatus))} → ${statusLabel(String(meta.toStatus))}`;
  }
  if (t === "note_added" && meta.visibility) {
    return meta.visibility === "internal_lab_only"
      ? "Internal note (lab only)"
      : "Note shared with provider";
  }
  if (t.includes("attachment") && meta.fileName) {
    return String(meta.fileName);
  }
  if (t.includes("restoration")) {
    const parts = [
      meta.restorationType,
      meta.toothNumber ? `Tooth ${meta.toothNumber}` : null,
      meta.material,
    ].filter(Boolean);
    if (parts.length) return parts.join(" · ");
  }
  if (t.includes("invoice") && meta.invoiceNumber) {
    return `Invoice ${meta.invoiceNumber}`;
  }
  if (t === "location_changed" && meta.toLocation) {
    return `Location: ${meta.toLocation}`;
  }
  return "";
}

function caseHeaderHtml(labCase: LabCase): string {
  const patient = `${labCase.patientFirstName ?? ""} ${
    labCase.patientLastName ?? ""
  }`.trim();
  return `
<h1>Case ${escapeHtml(labCase.caseNumber)}</h1>
<div class="lt-meta">
  ${escapeHtml(patient || "Unknown patient")} · Dr. ${escapeHtml(
    labCase.doctorName || "—",
  )} · ${escapeHtml(statusLabel(labCase.status))}${
    labCase.priority === "rush" ? " · RUSH" : ""
  }
</div>`;
}

// ── Case History ────────────────────────────────────────────────────────────

export function printCaseHistory(
  labCase: LabCase,
  events: CaseEvent[],
): void {
  // Chronological = oldest → newest, with explicit date+time on every row.
  const sorted = [...events].sort((a, b) => {
    const ta = new Date(a.occurredAt || a.createdAt || 0).getTime();
    const tb = new Date(b.occurredAt || b.createdAt || 0).getTime();
    return ta - tb;
  });

  const rows = sorted
    .map((e) => {
      const when = formatDateTime(e.occurredAt || e.createdAt);
      const what = formatEventTitle(e.eventType);
      const meta = eventMetaLine(e);
      const actor = e.actorInitials ? ` · ${escapeHtml(e.actorInitials)}` : "";
      return `
<div class="lt-event">
  <div class="lt-event-when">${escapeHtml(when)}</div>
  <div>
    <div class="lt-event-what">${escapeHtml(what)}${actor}</div>
    ${meta ? `<div class="lt-event-meta">${escapeHtml(meta)}</div>` : ""}
  </div>
</div>`;
    })
    .join("");

  const body = `
${caseHeaderHtml(labCase)}
<h2>Case History</h2>
${rows || '<div class="lt-muted">No activity logged.</div>'}
<div class="lt-meta lt-small" style="margin-top:18px">Printed ${escapeHtml(
    formatDateTime(new Date().toISOString()),
  )} · ${sorted.length} event${sorted.length === 1 ? "" : "s"}</div>`;

  openPrintWindow({
    title: `Case ${labCase.caseNumber} — History`,
    body,
  });
}

// ── Invoice ─────────────────────────────────────────────────────────────────

export function printInvoice(
  invoice: Invoice,
  labCase: LabCase | null,
  options: {
    items?: Array<{
      description: string;
      quantity: number | string;
      unitPrice: number | string;
      lineTotal: number | string;
    }>;
  } = {},
): void {
  const items = options.items ?? [];
  const itemRows = items.length
    ? items
        .map(
          (it) => `
<tr>
  <td>${escapeHtml(it.description)}</td>
  <td class="lt-right lt-mono">${escapeHtml(String(it.quantity))}</td>
  <td class="lt-right lt-mono">${escapeHtml(formatMoney(it.unitPrice))}</td>
  <td class="lt-right lt-mono">${escapeHtml(formatMoney(it.lineTotal))}</td>
</tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="lt-muted">No line items on this invoice yet.</td></tr>`;

  const headerCase = labCase ? caseHeaderHtml(labCase) : "";
  const issued = invoice.issuedAt
    ? formatDate(invoice.issuedAt)
    : "Not yet issued";

  const body = `
${headerCase}
<h2>Invoice ${escapeHtml(invoice.invoiceNumber)}</h2>
<div class="lt-row"><div class="lt-label">Status</div><div class="lt-value">${escapeHtml(statusLabel(invoice.status))}</div></div>
<div class="lt-row"><div class="lt-label">Issued</div><div class="lt-value">${escapeHtml(issued)}</div></div>
${invoice.dueDate ? `<div class="lt-row"><div class="lt-label">Due</div><div class="lt-value">${escapeHtml(formatDate(invoice.dueDate))}</div></div>` : ""}

<table>
  <thead>
    <tr>
      <th>Description</th>
      <th class="lt-right">Qty</th>
      <th class="lt-right">Unit</th>
      <th class="lt-right">Line Total</th>
    </tr>
  </thead>
  <tbody>${itemRows}</tbody>
  <tfoot>
    <tr>
      <td colspan="3" class="lt-right"><strong>Subtotal</strong></td>
      <td class="lt-right lt-mono">${escapeHtml(formatMoney(invoice.subtotal))}</td>
    </tr>
    <tr>
      <td colspan="3" class="lt-right"><strong>Total</strong></td>
      <td class="lt-right lt-mono"><strong>${escapeHtml(formatMoney(invoice.total))}</strong></td>
    </tr>
    <tr>
      <td colspan="3" class="lt-right">Balance Due</td>
      <td class="lt-right lt-mono">${escapeHtml(formatMoney(invoice.balanceDue))}</td>
    </tr>
  </tfoot>
</table>
<div class="lt-meta lt-small" style="margin-top:18px">Printed ${escapeHtml(
    formatDateTime(new Date().toISOString()),
  )}</div>`;

  openPrintWindow({
    title: `Invoice ${invoice.invoiceNumber}`,
    body,
  });
}

// ── Case Label (4in × 2in) ──────────────────────────────────────────────────

export function printCaseLabel(
  labCase: LabCase,
  extras: { material?: string | null; teeth?: string | null } = {},
): void {
  const patient = `${labCase.patientFirstName ?? ""} ${
    labCase.patientLastName ?? ""
  }`.trim();
  const due = labCase.dueDate ? formatDate(labCase.dueDate) : "—";
  const material = extras.material ?? labCase.restorationMaterials ?? "";
  const teeth = extras.teeth ?? labCase.teeth ?? "";

  const body = `
<div class="lt-label-header">
  <div class="lt-label-case">${escapeHtml(labCase.caseNumber)}</div>
  <div class="lt-label-date">${escapeHtml(
    formatDate(new Date().toISOString()),
  )}</div>
</div>
<div class="lt-label-patient">${escapeHtml(patient || "—")}${
    labCase.priority === "rush"
      ? ' <span style="font-size:10px;font-weight:700;color:#b91c1c">RUSH</span>'
      : ""
  }</div>
<div class="lt-label-doctor">Dr. ${escapeHtml(labCase.doctorName || "—")}</div>
<div class="lt-label-grid">
  <div><div class="lt-label-key">Status</div>${escapeHtml(statusLabel(labCase.status))}</div>
  <div><div class="lt-label-key">Due</div>${escapeHtml(due)}</div>
  ${material ? `<div><div class="lt-label-key">Material</div>${escapeHtml(material)}</div>` : ""}
  ${teeth ? `<div><div class="lt-label-key">Teeth</div>${escapeHtml(teeth)}</div>` : ""}
</div>`;

  openPrintWindow({
    title: `Label — ${labCase.caseNumber}`,
    bodyClass: "lt-label-page",
    extraCss: `@page { size: 4in 2in; margin: 0; }
html, body { margin: 0; padding: 0; }`,
    body,
  });
}

// ── Case Card (6in × 6in) ────────────────────────────────────────────────────

/**
 * Parse a teeth string into a Set of adult numeric tooth IDs (1–32).
 * Inlined here so it works in a plain-TS file with no React imports.
 */
function parseAdultTeeth(value: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  for (const rawPart of value.split(/[,\s]+/)) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((s) => s.trim());
      if (!a || !b) continue;
      const numA = Number(a);
      const numB = Number(b);
      if (Number.isInteger(numA) && Number.isInteger(numB)) {
        const lo = Math.min(numA, numB);
        const hi = Math.max(numA, numB);
        for (let n = lo; n <= hi; n++) {
          if (n >= 1 && n <= 32) out.add(String(n));
        }
      }
      continue;
    }
    const n = Number(part);
    if (Number.isInteger(n) && n >= 1 && n <= 32) out.add(String(n));
  }
  return out;
}

function toothCell(num: number, selected: boolean): string {
  const cls = selected ? "lt-tooth sel" : "lt-tooth";
  return `<span class="${cls}">${num}</span>`;
}

function buildToothChart(selected: Set<string>): string {
  // Upper arch: 1–16 left to right
  const upper = Array.from({ length: 16 }, (_, i) => i + 1);
  // Lower arch: 32–17 left to right (mirrors the upper)
  const lower = Array.from({ length: 16 }, (_, i) => 32 - i);

  const upperRow = upper.map((n) => toothCell(n, selected.has(String(n)))).join("");
  const lowerRow = lower.map((n) => toothCell(n, selected.has(String(n)))).join("");

  return `
<div class="lt-tooth-chart">
  <div class="lt-tooth-row">${upperRow}</div>
  <div class="lt-tooth-divider"></div>
  <div class="lt-tooth-row">${lowerRow}</div>
</div>`;
}

const CARD_CSS = `
@page { size: 6in 6in; margin: 0.2in; }

.lt-card-page {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #111;
  font-size: 11px;
  line-height: 1.4;
  margin: 0;
  padding: 0;
}

.lt-card-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  border-bottom: 2px solid #111;
  padding-bottom: 4px;
  margin-bottom: 6px;
}

.lt-card-case-num {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
}

.lt-card-header-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.lt-card-date {
  font-size: 9px;
  color: #555;
}

.lt-card-badge {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border: 1px solid #333;
  border-radius: 3px;
  padding: 1px 5px;
  color: #333;
}

.lt-card-badge.rush {
  background: #b91c1c;
  border-color: #b91c1c;
  color: #fff;
}

.lt-card-section {
  font-size: 8px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #555;
  border-bottom: 1px solid #ddd;
  padding-bottom: 1px;
  margin: 8px 0 4px;
}

.lt-card-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px 12px;
}

.lt-card-field {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.lt-card-key {
  font-size: 8px;
  color: #777;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.lt-card-val {
  font-size: 11px;
  font-weight: 500;
  color: #111;
}

.lt-tooth-chart {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.lt-tooth-row {
  display: flex;
  gap: 2px;
}

.lt-tooth {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  font-size: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  border: 1px solid #bbb;
  border-radius: 2px;
  color: #555;
  background: #fff;
  box-sizing: border-box;
}

.lt-tooth.sel {
  background: #1e3a5f;
  border-color: #1e3a5f;
  color: #fff;
  font-weight: 700;
}

.lt-tooth-divider {
  height: 3px;
  border-top: 1px dashed #ccc;
  margin: 1px 0;
}

.lt-card-footer {
  font-size: 8px;
  color: #888;
  margin-top: 10px;
  border-top: 1px solid #eee;
  padding-top: 4px;
}
`;

export function printCaseCard(
  labCase: LabCase,
  extras: {
    restorations?: CaseRestoration[];
    notes?: Array<{
      noteText?: string | null;
      visibility?: string | null;
      createdAt?: string | null;
    }>;
  } = {},
): void {
  const patient = `${labCase.patientFirstName ?? ""} ${
    labCase.patientLastName ?? ""
  }`.trim();

  // Prefer derived summary when restorations are supplied so we can show
  // restorative-type bucket + per-tooth shade inline. Falls back to the
  // denormalized labCase.* strings when no restorations are passed.
  const restorations = extras.restorations ?? [];
  const summary = deriveRxSummary(restorations);
  const restorativeType =
    summary.restorativeType ?? labCase.restorationTypes ?? "";
  const materialLabel =
    summary.materials.length > 0
      ? summary.materials.join(", ")
      : labCase.restorationMaterials ?? "";
  const shadeLabel = summary.shades.join(", ");
  const teethBase =
    summary.teeth.length > 0 || summary.isFullArch
      ? formatRxTeethLabel(summary)
      : labCase.teeth ?? "";
  const teethLabel = formatRxTeethWithShades(restorations, teethBase);

  const selected = parseAdultTeeth(
    summary.teeth.length > 0 || summary.isFullArch
      ? buildHighlightedToothValue(summary)
      : labCase.teeth,
  );
  const isRush = labCase.priority === "rush";

  const badgeHtml = isRush
    ? `<span class="lt-card-badge rush">Rush</span>`
    : `<span class="lt-card-badge">${escapeHtml(statusLabel(labCase.status))}</span>`;

  const header = `
<div class="lt-card-header">
  <div class="lt-card-case-num">Case ${escapeHtml(labCase.caseNumber)}</div>
  <div class="lt-card-header-right">
    <span class="lt-card-date">Printed ${escapeHtml(formatDate(new Date().toISOString()))}</span>
    ${badgeHtml}
  </div>
</div>`;

  const detailsGrid = `
<div class="lt-card-section">Case Details</div>
<div class="lt-card-grid">
  <div class="lt-card-field"><span class="lt-card-key">Patient</span><span class="lt-card-val">${escapeHtml(patient || "—")}</span></div>
  <div class="lt-card-field"><span class="lt-card-key">Doctor</span><span class="lt-card-val">${escapeHtml(labCase.doctorName || "—")}</span></div>
  <div class="lt-card-field"><span class="lt-card-key">Status</span><span class="lt-card-val">${escapeHtml(statusLabel(labCase.status))}</span></div>
  <div class="lt-card-field"><span class="lt-card-key">Priority</span><span class="lt-card-val">${escapeHtml(isRush ? "Rush" : "Normal")}</span></div>
  <div class="lt-card-field"><span class="lt-card-key">Due Date</span><span class="lt-card-val">${escapeHtml(formatDate(labCase.dueDate))}</span></div>
  <div class="lt-card-field"><span class="lt-card-key">Created</span><span class="lt-card-val">${escapeHtml(formatDate(labCase.createdAt))}</span></div>
</div>`;

  const teethKey = summary.isFullArch ? "Tooth Coverage" : "Tooth Number(s)";
  // Always render all four Rx slots so it's obvious at a glance whether a
  // field is set or missing on the label — print "—" for empty values
  // instead of hiding the row.
  const rxGrid = `
<div class="lt-card-section">RX Summary</div>
<div class="lt-card-grid">
  <div class="lt-card-field"><span class="lt-card-key">Restorative Type</span><span class="lt-card-val">${escapeHtml(restorativeType || "—")}</span></div>
  <div class="lt-card-field"><span class="lt-card-key">${escapeHtml(teethKey)}</span><span class="lt-card-val">${escapeHtml(teethLabel || "—")}</span></div>
  <div class="lt-card-field"><span class="lt-card-key">Material</span><span class="lt-card-val">${escapeHtml(materialLabel || "—")}</span></div>
  <div class="lt-card-field"><span class="lt-card-key">${escapeHtml(summary.shades.length > 1 ? "Shades" : "Shade")}</span><span class="lt-card-val">${escapeHtml(shadeLabel || "—")}</span></div>
</div>`;

  const toothChartSection = `
<div class="lt-card-section">Tooth Chart</div>
${buildToothChart(selected)}`;

  // Notes section — prefer the full notes array if provided, else fall back
  // to the denormalized caseNotes string on the LabCase object.
  const notesArr = extras.notes;
  let notesSection = "";
  if (notesArr !== undefined) {
    notesSection = `\n<div class="lt-card-section">Notes</div>\n`;
    if (notesArr.length === 0) {
      notesSection += `<div style="font-size:10px;color:#777;margin-top:2px">No notes yet.</div>`;
    } else {
      notesSection += notesArr
        .map((n) => {
          const when = n.createdAt ? formatDateTime(n.createdAt) : "";
          const vis =
            n.visibility === "internal_lab_only" ? "Internal" : "Shared";
          return `<div style="margin-bottom:6px">
  <div style="font-size:8px;color:#777;margin-bottom:1px">${escapeHtml(when)}${when ? " · " : ""}${vis}</div>
  <div style="font-size:10px;white-space:pre-wrap">${escapeHtml(n.noteText || "")}</div>
</div>`;
        })
        .join("");
    }
  } else if (labCase.caseNotes) {
    notesSection = `\n<div class="lt-card-section">Notes</div>\n<div style="font-size:10px;white-space:pre-wrap">${escapeHtml(labCase.caseNotes)}</div>`;
  }

  const footer = `<div class="lt-card-footer">LabTrax · Case ${escapeHtml(labCase.caseNumber)} · Printed ${escapeHtml(formatDateTime(new Date().toISOString()))}</div>`;

  const body = `${header}${detailsGrid}${rxGrid}${toothChartSection}${notesSection}\n${footer}`;

  openPrintWindow({
    title: `Case ${labCase.caseNumber} — Label`,
    bodyClass: "lt-card-page",
    extraCss: CARD_CSS,
    body,
  });
}

// ── Advanced printable card (drag-and-scale template) ─────────────────
//
// Renders the same data as printCaseCard but positions each section in
// absolutely-placed boxes driven by a per-lab CasePrintTemplate. The
// page is 8.5×11 in (816×1056 CSS px @ 96 dpi); zero page margin lets
// boxes use absolute coordinates verbatim.

const ADVANCED_CARD_CSS = `
@page { size: letter; margin: 0; }
html, body { margin: 0; padding: 0; }
.lt-adv-page {
  position: relative;
  width: ${TPL_PAGE_W}px;
  height: ${TPL_PAGE_H}px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #111;
  background: #fff;
}
.lt-adv-box {
  position: absolute;
  box-sizing: border-box;
  overflow: hidden;
}
.lt-adv-section-title {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #555;
  border-bottom: 1px solid #ddd;
  margin: 0 0 4px;
  padding-bottom: 2px;
}
.lt-adv-case-num {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
}
.lt-adv-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border: 1px solid #333;
  border-radius: 3px;
  padding: 1px 6px;
  color: #333;
}
.lt-adv-badge.rush {
  background: #b91c1c;
  border-color: #b91c1c;
  color: #fff;
}
.lt-adv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 16px;
}
.lt-adv-field { display: flex; flex-direction: column; }
.lt-adv-key {
  font-size: 8px;
  color: #777;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.lt-adv-val { font-size: 11px; font-weight: 500; color: #111; }
.lt-adv-notes { font-size: 10px; white-space: pre-wrap; line-height: 1.4; }
.lt-adv-notes-empty { font-size: 10px; color: #888; font-style: italic; }
.lt-adv-barcode {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.4em;
  text-align: center;
}
.lt-adv-barcode-bars {
  height: 28px;
  margin: 4px 0 2px;
  background: repeating-linear-gradient(
    to right,
    #111 0 2px,
    #fff 2px 4px,
    #111 4px 7px,
    #fff 7px 8px,
    #111 8px 10px,
    #fff 10px 14px
  );
}
.lt-adv-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
`;

function boxStyle(box: { x: number; y: number; w: number; h: number }, extra = ""): string {
  return `left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;${extra}`;
}

function resolveImageUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http") || url.startsWith("data:")) return url;
  // Template image URLs are `/api/organizations/.../images/<id>`. In a
  // print window opened with window.open(""), relative URLs resolve
  // against about:blank and break, so we need an absolute origin.
  const origin = getApiOrigin();
  return origin ? `${origin}${url}` : url;
}

export function printCaseCardAdvanced(
  labCase: LabCase,
  extras: {
    restorations?: CaseRestoration[];
    notes?: Array<{
      noteText?: string | null;
      visibility?: string | null;
      createdAt?: string | null;
    }>;
  },
  template: CasePrintTemplate,
): void {
  const patient = `${labCase.patientFirstName ?? ""} ${
    labCase.patientLastName ?? ""
  }`.trim();

  const restorations = extras.restorations ?? [];
  const summary = deriveRxSummary(restorations);
  const restorativeType = summary.restorativeType ?? labCase.restorationTypes ?? "";
  const materialLabel =
    summary.materials.length > 0
      ? summary.materials.join(", ")
      : labCase.restorationMaterials ?? "";
  const shadeLabel = summary.shades.join(", ");
  const teethBase =
    summary.teeth.length > 0 || summary.isFullArch
      ? formatRxTeethLabel(summary)
      : labCase.teeth ?? "";
  const teethLabel = formatRxTeethWithShades(restorations, teethBase);
  const selected = parseAdultTeeth(
    summary.teeth.length > 0 || summary.isFullArch
      ? buildHighlightedToothValue(summary)
      : labCase.teeth,
  );
  const isRush = labCase.priority === "rush";

  const sections: string[] = [];

  if (template.boxes.header.visible) {
    const b = template.boxes.header;
    const badge = isRush
      ? `<span class="lt-adv-badge rush">Rush</span>`
      : `<span class="lt-adv-badge">${escapeHtml(statusLabel(labCase.status))}</span>`;
    sections.push(`<div class="lt-adv-box" style="${boxStyle(b, "display:flex;align-items:baseline;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:4px")}">
  <div class="lt-adv-case-num">Case ${escapeHtml(labCase.caseNumber)}</div>
  <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
    <span style="font-size:9px;color:#555">Printed ${escapeHtml(formatDate(new Date().toISOString()))}</span>
    ${badge}
  </div>
</div>`);
  }

  if (template.boxes.caseDetails.visible) {
    const b = template.boxes.caseDetails;
    sections.push(`<div class="lt-adv-box" style="${boxStyle(b)}">
  <div class="lt-adv-section-title">Case Details</div>
  <div class="lt-adv-grid">
    <div class="lt-adv-field"><span class="lt-adv-key">Patient</span><span class="lt-adv-val">${escapeHtml(patient || "—")}</span></div>
    <div class="lt-adv-field"><span class="lt-adv-key">Doctor</span><span class="lt-adv-val">${escapeHtml(labCase.doctorName || "—")}</span></div>
    <div class="lt-adv-field"><span class="lt-adv-key">Status</span><span class="lt-adv-val">${escapeHtml(statusLabel(labCase.status))}</span></div>
    <div class="lt-adv-field"><span class="lt-adv-key">Priority</span><span class="lt-adv-val">${escapeHtml(isRush ? "Rush" : "Normal")}</span></div>
    <div class="lt-adv-field"><span class="lt-adv-key">Due Date</span><span class="lt-adv-val">${escapeHtml(formatDate(labCase.dueDate))}</span></div>
    <div class="lt-adv-field"><span class="lt-adv-key">Created</span><span class="lt-adv-val">${escapeHtml(formatDate(labCase.createdAt))}</span></div>
  </div>
</div>`);
  }

  if (template.boxes.rxSummary.visible) {
    const b = template.boxes.rxSummary;
    const teethKey = summary.isFullArch ? "Tooth Coverage" : "Tooth Number(s)";
    sections.push(`<div class="lt-adv-box" style="${boxStyle(b)}">
  <div class="lt-adv-section-title">RX Summary</div>
  <div class="lt-adv-grid">
    <div class="lt-adv-field"><span class="lt-adv-key">Restorative Type</span><span class="lt-adv-val">${escapeHtml(restorativeType || "—")}</span></div>
    <div class="lt-adv-field"><span class="lt-adv-key">${escapeHtml(teethKey)}</span><span class="lt-adv-val">${escapeHtml(teethLabel || "—")}</span></div>
    <div class="lt-adv-field"><span class="lt-adv-key">Material</span><span class="lt-adv-val">${escapeHtml(materialLabel || "—")}</span></div>
    <div class="lt-adv-field"><span class="lt-adv-key">${escapeHtml(summary.shades.length > 1 ? "Shades" : "Shade")}</span><span class="lt-adv-val">${escapeHtml(shadeLabel || "—")}</span></div>
  </div>
</div>`);
  }

  if (template.boxes.toothChart.visible) {
    const b = template.boxes.toothChart;
    sections.push(`<div class="lt-adv-box" style="${boxStyle(b)}">
  <div class="lt-adv-section-title">Tooth Chart</div>
  ${buildToothChart(selected)}
</div>`);
  }

  if (template.boxes.notes.visible) {
    const b = template.boxes.notes;
    let notesHtml = "";
    const notesArr = extras.notes;
    if (notesArr && notesArr.length > 0) {
      notesHtml = notesArr
        .map((n) => {
          const when = n.createdAt ? formatDateTime(n.createdAt) : "";
          const vis = n.visibility === "internal_lab_only" ? "Internal" : "Shared";
          return `<div style="margin-bottom:5px">
  <div style="font-size:8px;color:#777;margin-bottom:1px">${escapeHtml(when)}${when ? " · " : ""}${vis}</div>
  <div class="lt-adv-notes">${escapeHtml(n.noteText || "")}</div>
</div>`;
        })
        .join("");
    } else if (labCase.caseNotes) {
      notesHtml = `<div class="lt-adv-notes">${escapeHtml(labCase.caseNotes)}</div>`;
    } else {
      notesHtml = `<div class="lt-adv-notes-empty">No notes.</div>`;
    }
    sections.push(`<div class="lt-adv-box" style="${boxStyle(b)}">
  <div class="lt-adv-section-title">Notes</div>
  ${notesHtml}
</div>`);
  }

  if (template.boxes.barcode.visible) {
    const b = template.boxes.barcode;
    sections.push(`<div class="lt-adv-box" style="${boxStyle(b, "display:flex;flex-direction:column;justify-content:center")}">
  <div class="lt-adv-barcode-bars"></div>
  <div class="lt-adv-barcode">${escapeHtml(labCase.caseNumber)}</div>
</div>`);
  }

  for (const img of template.extraImages) {
    sections.push(`<div class="lt-adv-box" style="${boxStyle(img, `opacity:${img.opacity}`)}">
  <img src="${escapeHtml(resolveImageUrl(img.url))}" class="lt-adv-img" alt="" />
</div>`);
  }

  const body = `<div class="lt-adv-page">${sections.join("\n")}</div>`;

  openPrintWindow({
    title: `Case ${labCase.caseNumber} — Label`,
    bodyClass: "",
    extraCss: ADVANCED_CARD_CSS,
    body,
  });
}

// ── Full Lab Slip (letter-size, mirrors the on-screen Lab Slip tab) ─────────

const OVERVIEW_CSS = `
@page { size: letter; margin: 0.55in; }

.lt-ov-page {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #111;
  font-size: 12px;
  line-height: 1.45;
  margin: 0;
  padding: 0;
}

.lt-ov-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  border-bottom: 2px solid #111;
  padding-bottom: 6px;
  margin-bottom: 10px;
}

.lt-ov-case-num {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
}

.lt-ov-header-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
}

.lt-ov-date { font-size: 10px; color: #555; }

.lt-ov-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border: 1px solid #333;
  border-radius: 3px;
  padding: 1px 6px;
  color: #333;
}
.lt-ov-badge.rush { background: #b91c1c; border-color: #b91c1c; color: #fff; }

.lt-ov-section {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #555;
  border-bottom: 1px solid #ddd;
  padding-bottom: 2px;
  margin: 14px 0 6px;
}

.lt-ov-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 18px;
}

.lt-ov-field { display: flex; flex-direction: column; gap: 1px; }
.lt-ov-key {
  font-size: 9px;
  color: #777;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.lt-ov-val { font-size: 12px; font-weight: 500; color: #111; }

.lt-ov-notes-empty {
  font-size: 11px;
  color: #777;
  border: 1px dashed #ccc;
  border-radius: 4px;
  padding: 6px 10px;
}
.lt-ov-note {
  border: 1px solid #e2e2e2;
  border-radius: 4px;
  padding: 6px 10px;
  margin-bottom: 6px;
  font-size: 11px;
}
.lt-ov-note-meta {
  font-size: 9px;
  color: #777;
  margin-bottom: 2px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.lt-ov-note-text { white-space: pre-wrap; }

.lt-tooth-chart { margin-top: 6px; display: flex; flex-direction: column; gap: 3px; }
.lt-tooth-row { display: flex; gap: 3px; }
.lt-tooth {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  border: 1px solid #bbb;
  border-radius: 3px;
  color: #555;
  background: #fff;
  box-sizing: border-box;
}
.lt-tooth.sel { background: #1e3a5f; border-color: #1e3a5f; color: #fff; font-weight: 700; }
.lt-tooth-divider { height: 4px; border-top: 1px dashed #ccc; margin: 2px 0; }

.lt-ov-footer {
  font-size: 9px;
  color: #888;
  margin-top: 14px;
  border-top: 1px solid #eee;
  padding-top: 4px;
}
`;

const FONT_SIZE_PX: Record<string, string> = {
  sm: "12px",
  md: "16px",
  lg: "22px",
};

export function printCaseOverview(
  labCase: LabCase,
  extras: {
    restorations?: CaseRestoration[];
    notes?: Array<{
      noteText?: string | null;
      visibility?: string | null;
      createdAt?: string | null;
      authorName?: string | null;
    }>;
  } = {},
  config?: PrintLayoutConfig,
): void {
  const layout = config ?? loadPrintLayoutConfig();

  const patient = `${labCase.patientFirstName ?? ""} ${
    labCase.patientLastName ?? ""
  }`.trim();
  const isRush = labCase.priority === "rush";
  const restorations = extras.restorations ?? [];
  const summary = deriveRxSummary(restorations);
  const teethLabel = formatRxTeethWithShades(
    restorations,
    formatRxTeethLabel(summary),
  );
  const highlighted = parseAdultTeeth(buildHighlightedToothValue(summary));

  const badgeHtml = isRush
    ? `<span class="lt-ov-badge rush">Rush</span>`
    : `<span class="lt-ov-badge">${escapeHtml(statusLabel(labCase.status))}</span>`;

  const header = `
<div class="lt-ov-header">
  <div class="lt-ov-case-num">Case ${escapeHtml(labCase.caseNumber)}</div>
  <div class="lt-ov-header-right">
    <span class="lt-ov-date">Printed ${escapeHtml(formatDate(new Date().toISOString()))}</span>
    ${badgeHtml}
  </div>
</div>`;

  // ── Resolve field values keyed by field id ─────────────────────────────────
  const teethKey = summary.isFullArch ? "Tooth coverage" : "Tooth number(s)";
  const fieldValues: Record<string, { key: string; value: string }> = {
    patient:         { key: "Patient",         value: patient || "—" },
    doctor:          { key: "Doctor",           value: labCase.doctorName || "—" },
    status:          { key: "Status",           value: statusLabel(labCase.status) },
    priority:        { key: "Priority",         value: isRush ? "Rush" : "Normal" },
    dueDate:         { key: "Due Date",         value: formatDate(labCase.dueDate) },
    created:         { key: "Created",          value: formatDate(labCase.createdAt) },
    casePanBarcode:  { key: "Case Pan Barcode", value: labCase.casePanBarcode ?? "" },
    restorativeType: { key: "Restorative Type", value: summary.restorativeType ?? "Other" },
    material:        { key: summary.materials.length > 1 ? "Materials" : "Material", value: summary.materials.length > 0 ? summary.materials.join(", ") : "—" },
    shade:           { key: summary.shades.length > 1 ? "Shades" : "Shade",          value: summary.shades.length > 0 ? summary.shades.join(", ") : "—" },
    toothNumbers:    { key: teethKey,           value: teethLabel || "—" },
    rxNotes:         { key: "Rx Notes",         value: (labCase.caseNotes ?? "").trim() || "—" },
  };

  function renderField(id: string, fontSize: string, fullWidth: boolean): string {
    const fv = fieldValues[id];
    if (!fv) return "";
    // casePanBarcode: skip if empty
    if (id === "casePanBarcode" && !labCase.casePanBarcode) return "";
    const spanStyle = fontSize !== "sm" ? ` style="font-size:${FONT_SIZE_PX[fontSize] ?? "12px"}"` : "";
    const colStyle = fullWidth ? ` style="grid-column:1/-1"` : "";
    return `<div class="lt-ov-field"${colStyle}><span class="lt-ov-key">${escapeHtml(fv.key)}</span><span class="lt-ov-val"${spanStyle}>${escapeHtml(fv.value)}</span></div>`;
  }

  // ── Build details grid from config ─────────────────────────────────────────
  const detailFields = layout.fields.filter((f) => f.section === "details" && f.visible);
  const detailRows = detailFields.map((f) => renderField(f.id, f.fontSize, f.fullWidth)).join("\n");
  const detailsGrid = `
<div class="lt-ov-section">Case Details</div>
<div class="lt-ov-grid">
${detailRows}
</div>`;

  // ── Build Rx grid from config ──────────────────────────────────────────────
  // Always render the Rx grid so configured fields show with "—" placeholders
  // even on sparse cases. Editing happens in the Restorations tab.
  let rxSection = `<div class="lt-ov-section">Rx Summary</div>`;
  const rxFields = layout.fields.filter((f) => f.section === "rx" && f.visible);
  const rxRows = rxFields.map((f) => renderField(f.id, f.fontSize, f.fullWidth)).join("\n");
  rxSection += `<div class="lt-ov-grid">\n${rxRows}\n</div>`;

  // ── Tooth chart ────────────────────────────────────────────────────────────
  const chartSection = layout.showToothChart
    ? `<div class="lt-ov-section">Tooth Chart</div>${buildToothChart(highlighted)}`
    : "";

  // ── Notes ──────────────────────────────────────────────────────────────────
  let notesSection = "";
  if (layout.showNotes) {
    const notesArr = extras.notes ?? [];
    notesSection = `<div class="lt-ov-section">Notes</div>`;
    if (notesArr.length === 0) {
      notesSection += `<div class="lt-ov-notes-empty">No notes yet.</div>`;
    } else {
      const sorted = [...notesArr].sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });
      notesSection += sorted
        .map((n) => {
          const when = n.createdAt ? formatDateTime(n.createdAt) : "";
          const vis =
            n.visibility === "internal_lab_only" ? "Lab only" : "Shared";
          const author = n.authorName ? ` · ${escapeHtml(n.authorName)}` : "";
          return `<div class="lt-ov-note">
  <div class="lt-ov-note-meta">${escapeHtml(vis)}${author}${when ? ` · ${escapeHtml(when)}` : ""}</div>
  <div class="lt-ov-note-text">${escapeHtml(n.noteText || "—")}</div>
</div>`;
        })
        .join("");
    }
  }

  const footer = `<div class="lt-ov-footer">LabTrax · Case ${escapeHtml(labCase.caseNumber)} · Printed ${escapeHtml(formatDateTime(new Date().toISOString()))}</div>`;

  const body = `${header}${detailsGrid}${rxSection}${chartSection}${notesSection}${footer}`;

  openPrintWindow({
    title: `Case ${labCase.caseNumber} — Lab Slip`,
    bodyClass: "lt-ov-page",
    extraCss: OVERVIEW_CSS,
    body,
  });
}

// ── Per-tab generic printers ────────────────────────────────────────────────

export function printOverview(labCase: LabCase): string {
  const patient = `${labCase.patientFirstName ?? ""} ${
    labCase.patientLastName ?? ""
  }`.trim();
  return `
<h2>Lab Slip</h2>
<div class="lt-row"><div class="lt-label">Patient</div><div class="lt-value">${escapeHtml(patient || "—")}</div></div>
<div class="lt-row"><div class="lt-label">Doctor</div><div class="lt-value">${escapeHtml(labCase.doctorName || "—")}</div></div>
<div class="lt-row"><div class="lt-label">Status</div><div class="lt-value">${escapeHtml(statusLabel(labCase.status))}</div></div>
<div class="lt-row"><div class="lt-label">Priority</div><div class="lt-value">${escapeHtml(labCase.priority === "rush" ? "Rush" : "Normal")}</div></div>
<div class="lt-row"><div class="lt-label">Due Date</div><div class="lt-value">${escapeHtml(formatDate(labCase.dueDate))}</div></div>
<div class="lt-row"><div class="lt-label">Created</div><div class="lt-value">${escapeHtml(formatDateTime(labCase.createdAt))}</div></div>
${labCase.restorationTypes ? `<div class="lt-row"><div class="lt-label">Type</div><div class="lt-value">${escapeHtml(labCase.restorationTypes)}</div></div>` : ""}
${labCase.restorationMaterials ? `<div class="lt-row"><div class="lt-label">Material</div><div class="lt-value">${escapeHtml(labCase.restorationMaterials)}</div></div>` : ""}
${labCase.teeth ? `<div class="lt-row"><div class="lt-label">Teeth</div><div class="lt-value">${escapeHtml(labCase.teeth)}</div></div>` : ""}
${Number(labCase.totalPrice ?? 0) > 0 ? `<div class="lt-row"><div class="lt-label">Total</div><div class="lt-value">${escapeHtml(formatMoney(labCase.totalPrice))}</div></div>` : ""}
`;
}

export function printRestorationsTable(
  restorations: CaseRestoration[],
): string {
  if (!restorations.length) {
    return `<h2>Restorations</h2><div class="lt-muted">No restorations on this case.</div>`;
  }
  const rows = restorations
    .map(
      (r) => `
<tr>
  <td class="lt-mono">${escapeHtml(r.toothNumber)}</td>
  <td>${escapeHtml(r.restorationType)}</td>
  <td>${escapeHtml(r.material || "—")}</td>
  <td>${escapeHtml(r.shade || "—")}</td>
  <td class="lt-right lt-mono">${escapeHtml(String(r.quantity))}</td>
  <td class="lt-right lt-mono">${escapeHtml(formatMoney(r.unitPrice))}</td>
</tr>`,
    )
    .join("");
  return `
<h2>Restorations</h2>
<table>
  <thead><tr>
    <th>Tooth</th><th>Type</th><th>Material</th><th>Shade</th>
    <th class="lt-right">Qty</th><th class="lt-right">Unit</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

export function printNotesList(
  notes: Array<{
    noteText?: string | null;
    visibility?: string | null;
    createdAt?: string | null;
  }>,
): string {
  if (!notes.length) {
    return `<h2>Notes</h2><div class="lt-muted">No notes on this case.</div>`;
  }
  const rows = notes
    .map(
      (n) => `
<div class="lt-event">
  <div class="lt-event-when">${escapeHtml(formatDateTime(n.createdAt))}</div>
  <div>
    <div class="lt-event-what">${escapeHtml(
      n.visibility === "internal_lab_only" ? "Internal note" : "Shared note",
    )}</div>
    <div class="lt-event-meta" style="white-space:pre-wrap">${escapeHtml(n.noteText || "—")}</div>
  </div>
</div>`,
    )
    .join("");
  return `<h2>Notes</h2>${rows}`;
}

export function printAttachmentsList(attachments: CaseAttachment[]): string {
  if (!attachments.length) {
    return `<h2>Files</h2><div class="lt-muted">No attachments on this case.</div>`;
  }
  const rows = attachments
    .map(
      (a) => `
<tr>
  <td>${escapeHtml(a.fileName)}</td>
  <td>${escapeHtml(a.fileType || "—")}</td>
  <td>${escapeHtml(a.visibility === "internal_lab_only" ? "Lab only" : "Shared")}</td>
  <td>${escapeHtml(a.uploaderName || "—")}</td>
  <td>${escapeHtml(formatDateTime(a.createdAt))}</td>
</tr>`,
    )
    .join("");
  return `
<h2>Files</h2>
<table>
  <thead><tr>
    <th>File</th><th>Type</th><th>Visibility</th><th>Uploaded by</th><th>Uploaded</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

export function printTabContent(args: {
  labCase: LabCase;
  tab: "overview" | "restorations" | "notes" | "files";
  restorations: CaseRestoration[];
  attachments: CaseAttachment[];
  notes: Array<{
    noteText?: string | null;
    visibility?: string | null;
    createdAt?: string | null;
  }>;
}): void {
  let body = caseHeaderHtml(args.labCase);
  switch (args.tab) {
    case "overview":
      body += printOverview(args.labCase);
      break;
    case "restorations":
      body += printRestorationsTable(args.restorations);
      break;
    case "notes":
      body += printNotesList(args.notes);
      break;
    case "files":
      body += printAttachmentsList(args.attachments);
      break;
  }
  body += `<div class="lt-meta lt-small" style="margin-top:18px">Printed ${escapeHtml(
    formatDateTime(new Date().toISOString()),
  )}</div>`;
  const tabTitle =
    args.tab === "overview"
      ? "Lab Slip"
      : args.tab.charAt(0).toUpperCase() + args.tab.slice(1);
  openPrintWindow({
    title: `Case ${args.labCase.caseNumber} — ${tabTitle}`,
    body,
  });
}
