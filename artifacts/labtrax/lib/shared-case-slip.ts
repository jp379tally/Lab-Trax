import {
  escapeSlipHtml as esc, formatRxNoteScanDate, IMPLANT_FIELDS, IMPLANT_FIELD_LABELS, implantFieldText, describeToothAssignments,
  renderSharedSlip, SHARED_SLIP_CSS, slipToothChart, withImplantElements, type SlipTemplate,
} from "@workspace/case-taxonomy";
import { buildCaseCardHtml, formatProviderPreferences, shouldIncludeProviderPreferencesOnLabSlip, type CaseCardData } from "./case-pdf";
import { resilientFetch } from "./query-client";

interface TemplateEnvelope { template?: unknown; isCustom?: boolean | null }
export interface SlipContext {
  caseId?: string;
  labOrganizationId?: string | null;
  step?: string | null;
  stepShade?: string | null;
  dueTime?: string | null;
  doctorPreferences?: string | null;
  providerOrganizationContact?: Record<string, unknown> | null;
}
const LABELS: Record<string, string> = {
  ...IMPLANT_FIELD_LABELS, patient: "Patient", doctor: "Doctor", dueDate: "Due Date", priority: "Priority",
  step: "Step", restorativeType: "Restorative Type", teeth: "Tooth Number(s)", material: "Material", shade: "Shade",
  gingivialShade: "Gingival Shade", rxNotes: "Rx Notes", remakeNotes: "Remake Notes", doctorInfo: "Doctor Information",
  providerPreferences: "Provider Preferences", invoiceNumber: "Invoice Number", invoiceDate: "Invoice Date",
  invoiceStatus: "Invoice Status", invoiceTotal: "Invoice Total", invoiceBalanceDue: "Balance Due",
  invoicePaymentStatus: "Payment Status", invoiceLineItems: "Invoice Line Items",
};
function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let value = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    value += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63] +
      (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : "=") + (i + 2 < bytes.length ? alphabet[n & 63] : "=");
  }
  return value;
}
async function json(path: string) {
  const res = await resilientFetch(path);
  if (!res.ok) throw Object.assign(new Error(`Could not load print data (${res.status}).`), { status: res.status });
  const result = await res.json();
  return result.data ?? result;
}
/** Both system printing and PDF sharing use this same shared desktop layout. */
export async function buildSharedCaseSlipHtml(d: CaseCardData, envelope: TemplateEnvelope | null, context: SlipContext = {}): Promise<string> {
  if (envelope?.isCustom === false) return buildCaseCardHtml(d);
  const candidate = envelope?.template as SlipTemplate | undefined;
  if (!candidate || candidate.version !== 2 || !Array.isArray(candidate.elements)) return buildCaseCardHtml(d);
  const template: SlipTemplate = { ...candidate, elements: withImplantElements(candidate.elements) };
  const restorations = d.restorations ?? [];
  const rxEntries = d.rxNoteEntries?.length
    ? d.rxNoteEntries
    : d.rxNotes?.trim()
      ? [{
          id: "legacy-rx-note",
          caseId: context.caseId ?? "",
          noteText: d.rxNotes,
          scannedAt: null,
          provenance: "legacy",
        }]
      : [];
  const rxText = rxEntries
    .map((entry) => `${formatRxNoteScanDate(entry.scannedAt)}\n${entry.noteText}`)
    .join("\n\n");
  const joined = (key: "restorationType" | "material" | "shade" | "toothNumber") =>
    [...new Set(restorations.map((row) => row[key]).filter(Boolean))].join(", ");
  const date = d.dueDate ? new Date(d.dueDate).toLocaleDateString("en-US", { timeZone: "UTC" }) : "—";
  const preferencesEnabled = shouldIncludeProviderPreferencesOnLabSlip(d.printProviderPreferencesOnLabSlips, envelope);
  const values: Record<string, string> = {
    caseNumber: `Case ${d.caseNumber || "—"}`, patient: d.patientName || "—", doctor: d.doctorName || "—",
    dueDate: date + (context.dueTime ? ` · ${context.dueTime}` : ""), priority: d.priority === "rush" ? "Rush" : "Normal", step: context.step ? context.step.replaceAll("_", " ") + (context.step === "wax_setup" && context.stepShade ? ` · Shade: ${context.stepShade}` : "") : "—",
    restorativeType: [joined("restorationType"), describeToothAssignments(restorations.map((r) => ({
      toothNumber: r.toothNumber ?? "", restorationType: r.restorationType ?? "",
      material: r.material, shade: r.shade, restorationSubtype: r.restorationSubtype,
    })), d.bridgeConnectors)].filter(Boolean).join(" · "), teeth: joined("toothNumber"), material: joined("material"), shade: joined("shade"),
    gingivialShade: d.gingivialShade || "", rxNotes: rxText, remakeNotes: d.remakeNotes || "",
    providerPreferences: preferencesEnabled ? formatProviderPreferences(d.providerDoctorPreferences) : "",
    ...Object.fromEntries(IMPLANT_FIELDS.map((field) => [field, implantFieldText(restorations, field)])),
  };
  const images = new Map<string, string>();
  for (const element of template.elements.filter((el) => el.visible && el.kind === "image")) {
    if (!context.labOrganizationId) throw new Error("The lab's protected template images could not be loaded.");
    const res = await resilientFetch(`/api/organizations/${encodeURIComponent(context.labOrganizationId)}/case-print-template/images/${encodeURIComponent(element.id)}${context.caseId ? `?caseId=${encodeURIComponent(context.caseId)}` : ""}`);
    if (!res.ok) throw new Error(`Could not load a protected template image (${res.status}).`);
    const type = res.headers.get("Content-Type") || "image/png";
    images.set(element.id, `data:${type};base64,${base64(new Uint8Array(await res.arrayBuffer()))}`);
  }
  let invoice: Record<string, any> | null = null;
  let invoiceAccessRestricted = false;
  if (template.elements.some((el) => el.visible && el.kind.startsWith("invoice")) && context.caseId) {
    try {
      const invoices = await json(`/api/invoices?caseId=${encodeURIComponent(context.caseId)}`);
      const first = Array.isArray(invoices) ? invoices[0] : invoices?.invoices?.[0];
      if (first?.id) invoice = await json(`/api/invoices/${encodeURIComponent(first.id)}`);
    } catch (error) {
      if ((error as { status?: number }).status !== 403) throw error;
      invoiceAccessRestricted = true;
    }
  }
  const money = (amount: unknown) => Number(amount ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const contact = context.providerOrganizationContact ?? {};
  const body = renderSharedSlip(template, (el) => {
    if (el.kind === "rxNotes") {
      return rxEntries.length
        ? {
            caption: LABELS.rxNotes,
            text: rxText,
            html: `<div class="lt-rx-note-history">${rxEntries.map((entry) =>
              `<div class="lt-rx-note-row"><span class="lt-rx-note-date">${esc(formatRxNoteScanDate(entry.scannedAt))}</span><span class="lt-rx-note-text">${esc(entry.noteText)}</span></div>`
            ).join("")}</div>`,
          }
        : null;
    }
    if (el.kind.startsWith("invoice") && invoiceAccessRestricted) return { caption: LABELS[el.kind], text: "Invoice access restricted" };
    if (el.kind === "image") return { graphic: true, html: `<img alt="" src="${esc(images.get(el.id))}" style="width:100%;height:100%;object-fit:contain;opacity:${el.opacity ?? 1}"/>` };
    if (el.kind === "toothChart") return { graphic: true, html: slipToothChart(new Set((joined("toothNumber").match(/\d+/g) ?? []))) };
    if (el.kind === "barcode") {
      const barcode = d.casePanBarcode || d.caseNumber || "";
      return { graphic: true, html: `<div style="display:flex;height:65%;align-items:end;justify-content:center;gap:2px">${Array.from(barcode).map((ch) => `<span style="background:#111;width:${ch.charCodeAt(0) % 2 ? 2 : 3}px;height:100%"></span>`).join("")}</div><div style="text-align:center">${esc(barcode)}</div>` };
    }
    if (el.kind === "doctorInfo") {
      const parts = [
        d.doctorName,
        el.showPracticeName !== false ? contact.name : null,
        el.showAddress !== false ? [contact.addressLine1, contact.addressLine2, contact.city, contact.state, contact.zip].filter(Boolean).join(", ") : null,
        el.showPhone !== false ? contact.phone : null, el.showEmail !== false ? contact.billingEmail : null,
        context.doctorPreferences ? `Doctor Profile Notes: ${context.doctorPreferences}` : null,
      ].filter(Boolean);
      return { caption: LABELS[el.kind], text: parts.join("\n") };
    }
    if (el.kind === "invoiceLineItems") {
      if (!invoice) return { caption: LABELS[el.kind], text: "No invoice" };
      const columns = el.showColumns ?? ["description", "quantity", "unitPrice", "lineTotal"];
      const labels: Record<string, string> = { description: "Description", quantity: "Qty", unitPrice: "Unit Price", lineTotal: "Total" };
      const items: Record<string, any>[] = invoice.items ?? invoice.lineItems ?? [];
      return { caption: LABELS[el.kind], text: items.map((item) => String(item.description ?? "")).join("\n"),
        html: `<div class="lt-el-cap">${LABELS[el.kind]}</div><table><thead><tr>${columns.map((key) => `<th>${esc(labels[key] ?? key)}</th>`).join("")}</tr></thead><tbody>${items.map((item) => `<tr>${columns.map((key) => `<td>${esc(key === "unitPrice" || key === "lineTotal" ? money(item[key]) : item[key])}</td>`).join("")}</tr>`).join("")}</tbody></table>` };
    }
    if (el.kind.startsWith("invoice")) {
      const invoiceValues: Record<string, string> = invoice ? {
        invoiceNumber: invoice.invoiceNumber ?? "", invoiceDate: invoice.issuedAt ? new Date(invoice.issuedAt).toLocaleDateString("en-US") : "",
        invoiceStatus: invoice.status ?? "", invoiceTotal: money(invoice.total), invoiceBalanceDue: money(invoice.balanceDue),
        invoicePaymentStatus: invoice.status === "void" ? "Voided" : invoice.status === "paid" || Number(invoice.balanceDue) <= 0 ? "Paid" : "Unpaid",
      } : {};
      return { caption: LABELS[el.kind], text: invoice ? invoiceValues[el.kind] || "—" : "No invoice" };
    }
    const text = values[el.kind];
    if (!text && ((IMPLANT_FIELDS as readonly string[]).includes(el.kind) || el.kind === "gingivialShade" || el.kind === "providerPreferences")) return null;
    return text !== undefined ? { caption: el.kind === "caseNumber" ? undefined : LABELS[el.kind], text: text || "—" } : null;
  });
  return `<!doctype html><html><head><meta charset="utf-8"/><style>body{margin:0;font-family:Helvetica,Arial,sans-serif}${SHARED_SLIP_CSS}th,td{padding:6px;text-align:left;border-bottom:1px solid #ddd}svg{width:100%;height:100%}</style></head><body>${body}</body></html>`;
}
