// Web-only presentation helpers for the invoice register/detail. Mirrors the
// desktop register: patient/billTo/teeth/material come from display metadata,
// with linked case data as a fallback.
import type { CanonicalInvoice } from "@workspace/api-client-react";

export type LinkedCaseLike = {
  patientName?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  doctorName?: string | null;
  restorations?: Array<{
    toothNumber?: string | number | null;
    restorationType?: string | null;
    restorationSubtype?: string | null;
    material?: string | null;
  }> | null;
} | null | undefined;

type Line = { description?: string | null; toothLabel?: string | null; toothNumber?: number | string | null };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

export function metaOf(inv: CanonicalInvoice): Record<string, unknown> {
  const m = (inv as { displayMetadata?: unknown }).displayMetadata ?? (inv as { displayMetadataJson?: unknown }).displayMetadataJson;
  return m && typeof m === "object" ? (m as Record<string, unknown>) : {};
}

export function patientOf(inv: CanonicalInvoice, c?: LinkedCaseLike): string {
  const fromMeta = str(metaOf(inv).patientName);
  if (fromMeta) return fromMeta;
  const fromCase = str(c?.patientName) || [str(c?.patientFirstName), str(c?.patientLastName)].filter(Boolean).join(" ");
  return fromCase || str((inv as { patientName?: unknown }).patientName);
}

export function doctorOf(inv: CanonicalInvoice, c?: LinkedCaseLike): string {
  const r = inv as Record<string, unknown>;
  return str(r.doctorIdentity) || str(r.doctorDisplayName) || str(r.doctorName)
    || str(metaOf(inv).billTo) || str(metaOf(inv).doctorName) || str(c?.doctorName);
}

export function toothOf(inv: CanonicalInvoice, c?: LinkedCaseLike): string {
  const teeth = str(metaOf(inv).teeth);
  if (teeth) return teeth;
  const lines = (inv.lineItems ?? inv.items ?? []) as Line[];
  const labels = lines.map((l) => str(l.toothLabel) || str(l.toothNumber)).filter(Boolean);
  if (labels.length) return [...new Set(labels)].join(", ");
  const rest = (c?.restorations ?? []).map((r) => str(r.toothNumber)).filter(Boolean);
  return [...new Set(rest)].join(", ");
}

export function restorationOf(inv: CanonicalInvoice, c?: LinkedCaseLike): string {
  const meta = metaOf(inv);
  const type = str(meta.caseType) || str(meta.caseSubtype);
  if (type) return [type, str(meta.material)].filter(Boolean).join(" · ");
  const r = c?.restorations?.[0];
  if (r) {
    const t = str(r.restorationType) || str(r.restorationSubtype);
    if (t) return [t, str(r.material)].filter(Boolean).join(" · ");
  }
  const first = ((inv.lineItems ?? inv.items ?? []) as Line[])[0];
  return str(first?.description);
}

export function registerRestoration(inv: CanonicalInvoice): string {
  const t = toothOf(inv);
  return [restorationOf(inv), t ? `Tooth ${t}` : ""].filter(Boolean).join(" · ") || "—";
}

export type InvoiceLayoutMode = "sheet" | "side";
export const WIDE_BREAKPOINT = 960;
export function invoiceLayoutMode(width: number): InvoiceLayoutMode {
  return width >= WIDE_BREAKPOINT ? "side" : "sheet";
}

export function paymentActionState(inv: CanonicalInvoice, canWrite: boolean): { visible: boolean; enabled: boolean } {
  const status = (inv.status ?? "").toLowerCase();
  const balance = Number(inv.balanceDue ?? inv.total ?? 0);
  const closed = status === "paid" || status === "void" || Boolean(inv.frozen) || !(balance > 0);
  return { visible: canWrite && !closed, enabled: Boolean(inv.caseId) };
}

/** Overdue only when still collectible: not paid/void/draft/frozen, positive balance, past due. */
export function isInvoiceOverdue(inv: CanonicalInvoice, now: Date = new Date()): boolean {
  const status = (inv.status ?? "").toLowerCase();
  if (status === "paid" || status === "void" || status === "draft" || inv.frozen) return false;
  if (!(Number(inv.balanceDue ?? inv.total ?? 0) > 0)) return false;
  if (!inv.dueAt) return false;
  const due = new Date(inv.dueAt).getTime();
  return Number.isFinite(due) && due < now.getTime();
}
