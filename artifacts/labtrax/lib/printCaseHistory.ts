// Print helper for the mobile case History tab.
//
// `buildCaseHistoryHtml` produces a self-contained HTML document from the
// case object and its merged events list. The structure and inline CSS mirror
// the desktop `lib/print.ts` history output, adapted for mobile paper sizes
// rendered by expo-print's WebView engine.
//
// `printCaseHistory` wraps `Print.printAsync` so the call site stays a single
// await.
import * as Print from "expo-print";

// ─── Minimal local types (mirror the DetailedCase / DetailEvent shapes) ────────

export interface PrintableEvent {
  id: string;
  eventType?: string | null;
  actorInitials?: string | null;
  actorName?: string | null;
  metadataJson?: unknown;
  occurredAt?: string | null;
  createdAt?: string | null;
}

export interface PrintableCaseHeader {
  caseNumber?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  doctorName?: string | null;
  status?: string | null;
  priority?: string | null;
}

export interface PrintableNote {
  id: string;
  noteText?: string | null;
  visibility?: string | null;
}

// ─── Local formatting helpers ─────────────────────────────────────────────────

function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${mm}/${dd}/${d.getFullYear()} ${time}`;
}

function titleCaseLocal(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function fmtAuditTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.toISOString().replace(".000Z", "Z")} (UTC)`;
}

function fmtDoctorIdentity(displayName: unknown, identity: unknown): string {
  const name =
    typeof displayName === "string" && displayName.trim()
      ? displayName.trim()
      : "Unassigned";
  return typeof identity === "string" && identity.trim()
    ? `${name} [${identity.trim()}]`
    : name;
}

// Mirror formatEventType from the case detail screen.
function formatEventType(eventType?: string | null): string {
  if (!eventType) return "Event";
  if (eventType === "status_changed") return "Location Changed";
  if (eventType === "internal_exception_opened_note") {
    return "Internal Exception — Issue";
  }
  if (eventType === "internal_exception_note_added") {
    return "Internal Exception Note";
  }
  if (eventType === "internal_exception_resolution_note_added") {
    return "Internal Exception — Resolution Note";
  }
  return titleCaseLocal(eventType);
}

function isInternalExceptionNoteEvent(eventType?: string | null): boolean {
  return [
    "internal_exception_opened_note",
    "internal_exception_note_added",
    "internal_exception_resolution_note_added",
  ].includes(eventType ?? "");
}

// Mirror eventNoteId / eventDescription from the case detail screen so the
// printed history shows the same note bodies as the on-screen timeline.
function eventNoteId(meta: Record<string, unknown>): string | null {
  return (
    (typeof meta.noteId === "string" && meta.noteId) ||
    (typeof meta.caseNoteId === "string" && meta.caseNoteId) ||
    (typeof meta.id === "string" && meta.id) ||
    null
  );
}

function eventDescription(
  ev: PrintableEvent,
  notesById?: Map<string, PrintableNote>,
): string | null {
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (typeof ev.metadataJson === "string" && ev.metadataJson.trim()) {
    try {
      const parsed = JSON.parse(ev.metadataJson);
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch {
      return ev.metadataJson;
    }
  }
  if (!meta) return null;
  if (ev.eventType === "invoice_dates_repaired") {
    return `Issued: ${fmtAuditTimestamp(meta.previousIssuedAt)} → ${fmtAuditTimestamp(meta.correctedIssuedAt)} · Due: ${fmtAuditTimestamp(meta.previousDueAt)} → ${fmtAuditTimestamp(meta.correctedDueAt)}`;
  }
  if (ev.eventType === "invoice_payments_deleted") {
    const count = typeof meta.deletedCount === "number" ? meta.deletedCount : null;
    const parts = [
      count === 1
        ? "1 cleared payment deleted"
        : count != null
          ? `${count} cleared payments deleted`
          : "Cleared payments deleted",
    ];
    if (typeof meta.previousStatus === "string" && meta.previousStatus) {
      parts.push(`Previous status: ${titleCaseLocal(meta.previousStatus)}`);
    }
    if (
      typeof meta.reversedDepositCount === "number" &&
      meta.reversedDepositCount > 0
    ) {
      parts.push(
        `${meta.reversedDepositCount} linked deposit${meta.reversedDepositCount === 1 ? "" : "s"} reversed`,
      );
    }
    return parts.join(" · ");
  }
  if (ev.eventType === "invoice_doctor_identity_repaired") {
    return `Doctor: ${fmtDoctorIdentity(meta.previousDoctorDisplayName, meta.previousDoctorIdentity)} → ${fmtDoctorIdentity(meta.correctedDoctorDisplayName, meta.correctedDoctorIdentity)}`;
  }
  const from = meta.fromStatus ?? meta.from ?? meta.previousStatus;
  const to = meta.toStatus ?? meta.to ?? meta.newStatus ?? meta.status;
  if (typeof to === "string" && to) {
    return typeof from === "string" && from
      ? `${titleCaseLocal(from)} → ${titleCaseLocal(to)}`
      : titleCaseLocal(to);
  }
  if (ev.eventType === "note_added") {
    const noteId = eventNoteId(meta);
    if (noteId && notesById) {
      const matched = notesById.get(noteId);
      if (matched) return matched.noteText?.trim() || null;
      // Note id present but withheld from this viewer (internal lab-only note
      // hidden from a provider): never reveal the body from raw metadata.
      return null;
    }
  }
  if (isInternalExceptionNoteEvent(ev.eventType)) {
    if (typeof meta.noteText === "string" && meta.noteText) return meta.noteText;
    if (typeof meta.note === "string" && meta.note) return meta.note;
    if (typeof meta.description === "string" && meta.description) {
      return meta.description;
    }
  }
  if (typeof meta.noteText === "string" && meta.noteText) return meta.noteText;
  if (typeof meta.note === "string" && meta.note) return meta.note;
  if (typeof meta.message === "string" && meta.message) return meta.message;
  if (typeof meta.description === "string" && meta.description) return meta.description;
  if (typeof meta.fileName === "string" && meta.fileName) return meta.fileName;
  return null;
}

// Invoice lifecycle events (`invoice_updated` / `invoice_voided`, written by the
// server's bulk invoice-status handler) carry the affected invoice number in
// their metadata. Surface it in the printed history so a shared/printed record
// shows WHICH invoice changed, mirroring the on-screen mobile History tab.
function eventInvoiceNumber(ev: PrintableEvent): string | null {
  if (
    ev.eventType !== "invoice_updated" &&
    ev.eventType !== "invoice_voided" &&
    ev.eventType !== "invoice_dates_repaired" &&
    ev.eventType !== "invoice_payments_deleted" &&
    ev.eventType !== "invoice_doctor_identity_repaired"
  ) {
    return null;
  }
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (typeof ev.metadataJson === "string" && ev.metadataJson.trim()) {
    try {
      const parsed = JSON.parse(ev.metadataJson);
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!meta) return null;
  return typeof meta.invoiceNumber === "string" && meta.invoiceNumber
    ? meta.invoiceNumber
    : null;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

const HISTORY_CSS = `
* { box-sizing: border-box; }
body {
  font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: #111;
  margin: 0;
  padding: 32px;
  font-size: 13px;
  line-height: 1.5;
}
.doc-header {
  border-bottom: 2px solid #111;
  padding-bottom: 10px;
  margin-bottom: 6px;
}
.doc-title {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 2px;
}
.doc-meta {
  color: #555;
  font-size: 11px;
}
h2 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #555;
  border-bottom: 1px solid #ddd;
  padding-bottom: 3px;
  margin: 18px 0 8px;
  font-weight: 600;
}
.event {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed #eee;
}
.event:last-child { border-bottom: 0; }
.event-when {
  color: #555;
  font-size: 10px;
  padding-top: 2px;
}
.event-what {
  font-weight: 600;
  font-size: 12px;
  color: #111;
}
.event-invoice {
  color: #555;
  font-size: 11px;
  font-weight: 500;
}
.event-actor {
  color: #777;
  font-size: 10px;
}
.event-desc {
  color: #444;
  font-size: 11px;
  margin-top: 2px;
}
.empty { color: #888; font-style: italic; }
.footer {
  font-size: 10px;
  color: #888;
  margin-top: 20px;
  border-top: 1px solid #eee;
  padding-top: 6px;
}
`;

// ─── HTML builder ─────────────────────────────────────────────────────────────

export function buildCaseHistoryHtml(
  c: PrintableCaseHeader,
  events: PrintableEvent[],
  notes: PrintableNote[] = [],
): string {
  const patientName = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim() || "Unnamed patient";
  const doctorLine = c.doctorName ? `Dr. ${c.doctorName}` : null;
  const metaParts = [patientName, doctorLine].filter(Boolean);

  // Index the viewer-authorized notes by id so `note_added` rows resolve their
  // body from the visible notes payload (the server withholds internal lab-only
  // notes from non-lab viewers).
  const notesById = new Map<string, PrintableNote>();
  for (const n of notes) if (n?.id) notesById.set(n.id, n);

  // Chronological: oldest → newest
  const sorted = [...events].sort((a, b) => {
    const ta = new Date(a.occurredAt ?? a.createdAt ?? 0).getTime();
    const tb = new Date(b.occurredAt ?? b.createdAt ?? 0).getTime();
    return ta - tb;
  });

  const eventRows = sorted
    .map((ev) => {
      const when = fmtDateTime(ev.occurredAt ?? ev.createdAt);
      const what = formatEventType(ev.eventType);
      const desc = eventDescription(ev, notesById);
      const invoiceNumber = eventInvoiceNumber(ev);
      const metadataAuthor =
        typeof (ev.metadataJson as any)?.authorName === "string" &&
        (ev.metadataJson as any).authorName
          ? (ev.metadataJson as any).authorName
          : null;
      const actor = metadataAuthor ?? ev.actorName ?? ev.actorInitials ?? null;
      return `
<div class="event">
  <div class="event-when">${esc(when)}</div>
  <div>
    <div class="event-what">${esc(what)}</div>
    ${invoiceNumber ? `<div class="event-invoice">${esc(invoiceNumber)}</div>` : ""}
    ${actor ? `<div class="event-actor">${esc(actor)}</div>` : ""}
    ${desc ? `<div class="event-desc">${esc(desc)}</div>` : ""}
  </div>
</div>`;
    })
    .join("");

  const now = fmtDateTime(new Date().toISOString());
  const body = `
<div class="doc-header">
  <div class="doc-title">Case ${esc(c.caseNumber ?? "—")}</div>
  <div class="doc-meta">${esc(metaParts.join(" · "))}</div>
</div>
<h2>Case History</h2>
${eventRows || '<div class="empty">No activity logged.</div>'}
<div class="footer">Printed ${esc(now)} · ${sorted.length} event${sorted.length === 1 ? "" : "s"}</div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><style>${HISTORY_CSS}</style></head><body>${body}</body></html>`;
}

// ─── Print entry point ────────────────────────────────────────────────────────

export async function printCaseHistory(
  c: PrintableCaseHeader,
  events: PrintableEvent[],
  notes: PrintableNote[] = [],
): Promise<void> {
  const html = buildCaseHistoryHtml(c, events, notes);
  await Print.printAsync({ html });
}
