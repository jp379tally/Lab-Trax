import printCss from "@/styles/print.css?raw";
import { formatDate, formatDateTime, formatMoney, statusLabel } from "./format";
import type {
  CaseAttachment,
  CaseEvent,
  CaseRestoration,
  Invoice,
  LabCase,
} from "./types";

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

// ── Per-tab generic printers ────────────────────────────────────────────────

export function printOverview(labCase: LabCase): string {
  const patient = `${labCase.patientFirstName ?? ""} ${
    labCase.patientLastName ?? ""
  }`.trim();
  return `
<h2>Overview</h2>
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
  openPrintWindow({
    title: `Case ${args.labCase.caseNumber} — ${
      args.tab.charAt(0).toUpperCase() + args.tab.slice(1)
    }`,
    body,
  });
}
