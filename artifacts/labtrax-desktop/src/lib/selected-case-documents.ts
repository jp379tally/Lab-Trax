import QRCode from "qrcode";
import { apiFetch, apiFetchArrayBuffer, getApiOrigin, serverAssetUrl } from "./api";
import { coerceCasePrintTemplate } from "./case-print-template";
import { coerceInvoiceTemplate } from "./invoice-template";
import type { InvoicePdfOptions } from "./export";
import { printCaseCardAdvanced, printCaseOverview, type PrintDocument } from "./print";
import { loadPrintLayoutConfig } from "./print-layout";
import type { CaseAttachment, CaseRestoration, Invoice, LabCase, Organization } from "./types";

export type PrintableCase = LabCase & {
  restorations?: CaseRestoration[];
  attachments?: CaseAttachment[];
  notes?: Array<{ noteText?: string | null; visibility?: string | null; createdAt?: string | null; authorName?: string | null }>;
};

/** Order-preserving, fail-closed preparation with no more than four workers. */
export async function mapPrintSelection<T>(
  ids: readonly string[],
  prepare: (id: string) => Promise<T>,
  progress: (done: number, total: number) => void = () => {},
): Promise<T[]> {
  const captured = [...new Set(ids)];
  const results: T[] = new Array(captured.length);
  let next = 0;
  let done = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(4, captured.length) }, async () => {
    while (next < captured.length && !failure) {
      const index = next++;
      try {
        results[index] = await prepare(captured[index]);
        progress(++done, captured.length);
      } catch (error) {
        failure = error;
      }
    }
  }));
  if (failure) throw failure;
  return results;
}

function unwrap<T>(value: T | { data: T }): T {
  return (value as { data?: T }).data ?? value as T;
}

async function currentCase(id: string): Promise<PrintableCase> {
  const lc = await apiFetch<PrintableCase>(`/cases/${encodeURIComponent(id)}`);
  if (lc.id !== id || !lc.caseNumber || !Array.isArray(lc.restorations) || !Array.isArray(lc.attachments) || !Array.isArray(lc.notes)) {
    throw new Error(`Could not load complete case details (${id}). Refresh Cases and retry.`);
  }
  return lc;
}

async function currentInvoice(lc: PrintableCase): Promise<Invoice | null> {
  const invoices = await apiFetch<Invoice[]>(`/invoices?caseId=${encodeURIComponent(lc.id)}`);
  if (!Array.isArray(invoices)) throw new Error(`Invalid invoice response for case ${lc.caseNumber}. Retry printing.`);
  // Only an explicitly successful empty list means "missing". 403/404 and
  // network failures must abort, never masquerade as a missing invoice.
  if (!invoices.length) return null;
  const inv = await apiFetch<Invoice>(`/invoices/${encodeURIComponent(invoices[0].id)}`);
  if (inv.id !== invoices[0].id || inv.caseId !== lc.id || !Array.isArray(inv.items)) {
    throw new Error(`Could not load complete invoice details for case ${lc.caseNumber}. Retry printing.`);
  }
  if (inv.labOrganizationId !== invoices[0].labOrganizationId || inv.providerOrganizationId !== invoices[0].providerOrganizationId) {
    throw new Error(`Invoice billing organization changed while preparing case ${lc.caseNumber}. Retry printing to load current branding.`);
  }
  // Detail supplies persisted financial data; the list supplies joined
  // organization display names (the detail route deliberately omits them).
  // Never borrow a practice name if reassignment changed it between requests.
  return {
    ...inv,
    labOrganization: inv.labOrganization ?? (
      inv.labOrganizationId === invoices[0].labOrganizationId ? invoices[0].labOrganization : null
    ),
    providerOrganization: inv.providerOrganization ?? (
      inv.providerOrganizationId === invoices[0].providerOrganizationId ? invoices[0].providerOrganization : null
    ),
  };
}

async function imageDataUrl(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  // API-hosted template images require the same bearer/refresh boundary as
  // document requests. Public logos live outside /api.
  const resolved = serverAssetUrl(url);
  const path = new URL(resolved).pathname;
  let blob: Blob;
  const apiOrigin = getApiOrigin() || window.location.origin;
  if (path.startsWith("/api/") && new URL(resolved).origin === apiOrigin) {
    const { buffer, headers } = await apiFetchArrayBuffer(path.slice(4));
    blob = new Blob([buffer], { type: headers.get("Content-Type") ?? "image/png" });
  } else {
    const response = await fetch(resolved, { credentials: "include" });
    if (!response.ok) throw new Error("A required invoice image could not be loaded. Check access and retry.");
    blob = await response.blob();
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read invoice image. Retry printing."));
    reader.readAsDataURL(blob);
  });
  // Validate before the jsPDF renderer, which historically skips bad images.
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return dataUrl;
}

export function invoicePrintOptions(
  inv: Invoice,
  lc: PrintableCase,
  assets: Pick<InvoicePdfOptions, "logoUrl" | "logoPdfSize" | "template" | "extraImageDataUrls" | "qrCodeDataUrl"> = {},
): InvoicePdfOptions {
  const dm = inv.displayMetadata ?? inv.displayMetadataJson;
  return {
    invoiceNumber: inv.invoiceNumber,
    labName: inv.labOrganization?.name ?? "",
    practiceName: inv.providerOrganization?.name ?? "",
    patientName: dm?.patientName ?? (`${lc.patientFirstName ?? ""} ${lc.patientLastName ?? ""}`.trim() || null),
    billTo: dm?.billTo ?? inv.providerOrganization?.name ?? null,
    teeth: dm?.teeth ?? lc.teeth ?? null,
    shade: dm?.shade ?? null,
    material: dm?.material ?? null,
    caseNotes: dm?.caseNotes ?? lc.caseNotes ?? null,
    issuedAt: inv.issuedAt ?? null,
    dueAt: inv.dueDate ?? inv.dueAt ?? null,
    status: inv.status,
    items: inv.items ?? [],
    subtotal: inv.subtotal ?? 0,
    tax: inv.tax,
    discount: inv.discount,
    total: inv.total ?? 0,
    balanceDue: inv.balanceDue,
    notes: inv.notes,
    generatedAt: new Date(),
    caseNumber: lc.caseNumber,
    ...assets,
  };
}

export async function prepareSelectedInvoices(ids: readonly string[], progress?: (done: number, total: number) => void) {
  const labs = new Map<string, Promise<Pick<InvoicePdfOptions, "logoUrl" | "logoPdfSize" | "template" | "extraImageDataUrls">>>();
  const prepared = await mapPrintSelection(ids, async (id) => {
    const lc = await currentCase(id);
    try {
      const inv = await currentInvoice(lc);
      if (!inv) return { missing: lc.caseNumber, options: null };
      const labId = inv.labOrganizationId;
      if (!labId) throw new Error("Invoice has no lab.");
      if (!labs.has(labId)) labs.set(labId, (async () => {
        const lab = unwrap(await apiFetch<Organization & { logoPdfSize?: InvoicePdfOptions["logoPdfSize"] } | { data: Organization & { logoPdfSize?: InvoicePdfOptions["logoPdfSize"] } }>(
          `/organizations/${encodeURIComponent(labId)}`,
        ));
        const response = unwrap(await apiFetch<{ template: unknown } | { data: { template: unknown } }>(
          `/organizations/${encodeURIComponent(labId)}/invoice-template`,
        ));
        if (!response || !("template" in response)) throw new Error("Could not load the invoice layout. Retry printing.");
        const template = coerceInvoiceTemplate(response.template);
        const extraImageDataUrls: Record<string, string> = {};
        // Sequential within each lab keeps total asset requests bounded too.
        for (const image of template.extraImages) extraImageDataUrls[image.url] = await imageDataUrl(image.url);
        return {
          template,
          extraImageDataUrls,
          logoPdfSize: lab.logoPdfSize,
          logoUrl: lab.logoUrl && (lab.logoplacements == null || lab.logoplacements.includes("invoices"))
            ? await imageDataUrl(lab.logoUrl) : null,
        };
      })());
      const assets = await labs.get(labId)!;
      const qrCodeDataUrl = await QRCode.toDataURL(
        `${window.location.origin}/cases/${encodeURIComponent(lc.caseNumber)}`,
        { margin: 1, width: 120 },
      );
      return { missing: null, options: invoicePrintOptions(inv, lc, { ...assets, qrCodeDataUrl }) };
    } catch (error) {
      throw new Error(`Case ${lc.caseNumber}: ${error instanceof Error ? error.message : "Could not prepare invoice"}. No documents printed. Check access or connection and retry.`);
    }
  }, progress);
  return {
    missing: prepared.flatMap((entry) => entry.missing ? [entry.missing] : []),
    options: prepared.flatMap((entry) => entry.options ? [entry.options] : []),
  };
}

export async function prepareSelectedLabSlips(
  ids: readonly string[],
  isAdmin: boolean,
  progress?: (done: number, total: number) => void,
): Promise<PrintDocument[]> {
  const templates = new Map<string, Promise<{ template: unknown; isCustom: boolean }>>();
  const config = loadPrintLayoutConfig();
  return mapPrintSelection(ids, async (id) => {
    const lc = await currentCase(id);
    try {
      if (!lc.labOrganizationId) throw new Error("Case has no lab.");
      const labId = lc.labOrganizationId;
      if (!templates.has(labId)) templates.set(labId, apiFetch<
        { template: unknown; isCustom: boolean } | { data: { template: unknown; isCustom: boolean } }
      >(`/organizations/${encodeURIComponent(labId)}/case-print-template?caseId=${encodeURIComponent(lc.id)}`).then(unwrap));
      const response = await templates.get(labId)!;
      if (!response || typeof response.isCustom !== "boolean" || !("template" in response)) {
        throw new Error("Could not load the lab-slip layout. Retry printing.");
      }
      const template = coerceCasePrintTemplate(response.template);
      const needsInvoice = response.isCustom && template.elements.some((el) => el.visible && el.kind.startsWith("invoice"));
      const extras = { restorations: lc.restorations, attachments: lc.attachments, notes: lc.notes, isAdmin };
      const doc = response.isCustom
        ? await printCaseCardAdvanced(lc, { ...extras, invoice: needsInvoice ? await currentInvoice(lc) : null }, template, true)
        : printCaseOverview(lc, extras, config, true);
      if (!doc) throw new Error("Lab slip could not be rendered.");
      return doc;
    } catch (error) {
      throw new Error(`Case ${lc.caseNumber}: ${error instanceof Error ? error.message : "Could not prepare lab slip"}. No documents printed. Check access or connection and retry.`);
    }
  }, progress);
}
