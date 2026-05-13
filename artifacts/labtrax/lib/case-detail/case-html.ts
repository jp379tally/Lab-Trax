// Print/PDF HTML builders extracted from `app/case/[id].tsx`. Pure
// string-builders so they can be snapshot-tested without rendering the
// screen or invoking expo-print.

import { CaseStatus, getStationInfo, cleanDoctorDisplay, ActivityEntry } from "../data";

interface MinimalCase {
  caseNumber?: string | number;
  patientName?: string;
  patientInitials?: string;
  doctorName?: string;
  toothIndices?: string;
  shade?: string;
  material?: string;
  dueDate?: string;
  notes?: string;
  status?: CaseStatus;
  createdAt?: number;
  activityLog?: ActivityEntry[];
  routeHistory?: { station: CaseStatus; timestamp: number }[];
}

export function buildCaseLabelHtml(caseRecord: MinimalCase | null | undefined): string {
  return `<html><head><style>
      body { font-family: Arial, sans-serif; padding: 20px; }
      .label { border: 2px solid #111; border-radius: 12px; padding: 20px; max-width: 400px; }
      .title { font-size: 26px; font-weight: bold; margin-bottom: 12px; }
      .row { font-size: 17px; margin: 6px 0; }
    </style></head><body>
      <div class="label">
        <div class="title">Case #${caseRecord?.caseNumber || ""}</div>
        <div class="row"><strong>Patient:</strong> ${caseRecord?.patientName || caseRecord?.patientInitials || ""}</div>
        <div class="row"><strong>Doctor:</strong> ${cleanDoctorDisplay(caseRecord?.doctorName || "")}</div>
        <div class="row"><strong>Teeth:</strong> ${caseRecord?.toothIndices || ""}</div>
        <div class="row"><strong>Shade:</strong> ${caseRecord?.shade || ""}</div>
        <div class="row"><strong>Material:</strong> ${caseRecord?.material || ""}</div>
        <div class="row"><strong>Due:</strong> ${caseRecord?.dueDate || ""}</div>
        ${caseRecord?.notes ? `<div class="row"><strong>Notes:</strong> ${caseRecord.notes}</div>` : ""}
      </div>
    </body></html>`;
}

interface RegisteredUserShape {
  id?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

interface BuildHistoryInput {
  caseItem: MinimalCase;
  customStationLabels?: Record<string, string>;
  registeredUsers?: RegisteredUserShape[];
  now?: Date;
}

export function buildCaseHistoryHtml(input: BuildHistoryInput): string {
  const { caseItem, customStationLabels, registeredUsers = [], now = new Date() } = input;
  const stationLabel = caseItem.status
    ? getStationInfo(caseItem.status, customStationLabels).label
    : "";

  const fmtDate = (ts: number | undefined | null): string => {
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "—";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "—";
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })}`;
  };
  const escapeHtml = (s: string): string =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const safeActivityLog = Array.isArray(caseItem.activityLog) ? caseItem.activityLog : [];
  const safeRouteHistory = Array.isArray(caseItem.routeHistory) ? caseItem.routeHistory : [];
  const entries = safeActivityLog.length > 0
    ? [...safeActivityLog].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    : [...safeRouteHistory]
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
        .map((rh) => ({
          id: String(rh.timestamp),
          type: "station_change" as const,
          timestamp: rh.timestamp,
          description: `Case moved to ${getStationInfo(rh.station, customStationLabels).label}`,
          station: rh.station,
          user: undefined as string | undefined,
        }));

  const typeLabel: Record<string, string> = {
    created: "Created",
    scan: "Scanned",
    station_change: "Station Change",
    note: "Note",
    photo: "Photo",
    video: "Video",
    barcode_assigned: "Barcode Assigned",
    barcode_unassigned: "Barcode Removed",
    invoice_paid: "Invoice Paid",
    invoice_attached: "Invoice Attached",
    tracking_added: "Tracking Added",
    courtesy_text: "Courtesy Text",
    exocad_linked: "Exocad Linked",
    exocad_shared: "Exocad Shared",
  };

  const rows = entries
    .map((e) => {
      const matchingUser = e.user
        ? registeredUsers.find(
            (u) => u.id === e.user || u.username?.toLowerCase() === (e.user ?? "").toLowerCase(),
          )
        : null;
      const userDisplay = matchingUser
        ? [matchingUser.firstName, matchingUser.lastName].filter(Boolean).join(" ") ||
          matchingUser.username ||
          (e.user ?? "")
        : (e.user ?? "");
      const eType: string = (e as { type?: string }).type ?? "";
      const label = typeLabel[eType] || eType.replace(/_/g, " ");
      const stationStr = e.station ? getStationInfo(e.station, customStationLabels).label : "";
      return `<tr>
          <td class="ts">${escapeHtml(fmtDate(e.timestamp))}</td>
          <td class="ev">${escapeHtml(label)}${stationStr ? ` <span class="meta">(${escapeHtml(stationStr)})</span>` : ""}</td>
          <td class="desc">${escapeHtml((e as { description?: string }).description || "")}</td>
          <td class="user">${escapeHtml(userDisplay)}</td>
        </tr>`;
    })
    .join("");

  const printedAtStr = `${now.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })}`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; padding: 24px; color: #111; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { font-size: 12px; color: #666; margin-bottom: 18px; }
  .summary { background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 10px; padding: 12px 16px; margin-bottom: 18px; }
  .summary-row { display: flex; flex-wrap: wrap; gap: 18px 28px; font-size: 13px; }
  .summary-row div { min-width: 140px; }
  .summary-row strong { color: #111; }
  .summary-row span { color: #555; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead th { text-align: left; background: #F1F5F9; padding: 8px 10px; border-bottom: 1px solid #CBD5E1; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #475569; }
  tbody td { padding: 8px 10px; border-bottom: 1px solid #F1F5F9; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #FAFAFA; }
  .ts { white-space: nowrap; color: #475569; width: 150px; }
  .ev { color: #111; font-weight: 600; width: 150px; }
  .meta { color: #94A3B8; font-weight: 400; font-size: 11px; }
  .desc { color: #1F2937; }
  .user { color: #475569; white-space: nowrap; width: 120px; text-align: right; }
  .empty { padding: 24px; text-align: center; color: #94A3B8; font-size: 13px; }
  .footer { margin-top: 24px; font-size: 10px; color: #94A3B8; text-align: center; }
</style></head>
<body>
  <h1>Case History — #${escapeHtml(String(caseItem.caseNumber || ""))}</h1>
  <div class="sub">Printed ${escapeHtml(printedAtStr)}</div>
  <div class="summary">
    <div class="summary-row">
      <div><strong>Patient:</strong> <span>${escapeHtml(caseItem.patientName || caseItem.patientInitials || "")}</span></div>
      <div><strong>Provider:</strong> <span>${escapeHtml(cleanDoctorDisplay(caseItem.doctorName || ""))}</span></div>
      <div><strong>Current Station:</strong> <span>${escapeHtml(stationLabel)}</span></div>
      <div><strong>Material:</strong> <span>${escapeHtml(caseItem.material || "")}</span></div>
      <div><strong>Teeth:</strong> <span>${escapeHtml(caseItem.toothIndices || "")}</span></div>
      <div><strong>Shade:</strong> <span>${escapeHtml(caseItem.shade || "")}</span></div>
      <div><strong>Due Date:</strong> <span>${escapeHtml(caseItem.dueDate || "")}</span></div>
      <div><strong>Created:</strong> <span>${escapeHtml(fmtDate(caseItem.createdAt || 0))}</span></div>
    </div>
  </div>
  ${entries.length > 0 ? `<table>
    <thead><tr><th>When</th><th>Event</th><th>Detail</th><th>By</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : `<div class="empty">No history entries yet.</div>`}
  <div class="footer">LabTrax · Case #${escapeHtml(String(caseItem.caseNumber || ""))} · ${entries.length} ${entries.length === 1 ? "entry" : "entries"}</div>
</body></html>`;
}
