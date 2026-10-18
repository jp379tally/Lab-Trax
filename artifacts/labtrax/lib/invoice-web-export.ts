import { getApiUrl } from "@/lib/query-client";
import type { CanonicalInvoice } from "@workspace/api-client-react";

export const INVOICE_PAGE_SIZES = [25, 50, 100] as const;
export const INVOICE_EXPORT_BATCH = 100;
const MAX_BATCHES = 10_000;

export function pagerItems(page: number, pageCount: number): (number | "gap")[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const items: (number | "gap")[] = [1];
  const lo = Math.max(2, page - 1);
  const hi = Math.min(pageCount - 1, page + 1);
  if (lo > 2) items.push("gap");
  for (let n = lo; n <= hi; n++) items.push(n);
  if (hi < pageCount - 1) items.push("gap");
  items.push(pageCount);
  return items;
}

/** Quote a CSV cell and neutralise spreadsheet formula triggers. */
export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export type ExportProgress = { loaded: number; total: number | null };

type Page = { rows: CanonicalInvoice[]; total: number; hasMore: boolean };

function abortError(): Error {
  const e = new Error("Export cancelled");
  e.name = "AbortError";
  return e;
}

/** Validate an /api/invoices body. A bare array is the complete legacy shape. */
export function parseInvoicePage(body: unknown): Page | CanonicalInvoice[] {
  const page = (body && typeof body === "object" && "data" in (body as object) ? (body as { data: unknown }).data : body) as
    | { rows?: unknown; total?: unknown; hasMore?: unknown }
    | unknown[]
    | null;
  if (Array.isArray(page)) return page as CanonicalInvoice[];
  if (!page || !Array.isArray(page.rows) || typeof page.total !== "number" || !Number.isInteger(page.total) || page.total < 0 || typeof page.hasMore !== "boolean") {
    throw new Error("The export stopped early: the server returned an unexpected response.");
  }
  return { rows: page.rows as CanonicalInvoice[], total: page.total, hasMore: page.hasMore };
}

/** Bounded walk of every matching row; throws rather than returning a partial set. */
export async function fetchAllInvoiceRows(opts: {
  fetchPage: (b: { limit: number; offset: number }) => Promise<Page | CanonicalInvoice[]>;
  signal: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
}): Promise<CanonicalInvoice[]> {
  const rows: CanonicalInvoice[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | null = null;
  for (let n = 0; n < MAX_BATCHES; n++) {
    if (opts.signal.aborted) throw abortError();
    const res = await opts.fetchPage({ limit: INVOICE_EXPORT_BATCH, offset: rows.length });
    if (opts.signal.aborted) throw abortError();
    if (Array.isArray(res)) {
      if (n !== 0) throw new Error("The export stopped early: the server changed response format.");
      opts.onProgress?.({ loaded: res.length, total: res.length });
      return res;
    }
    if (!res || !Array.isArray(res.rows) || !Number.isInteger(res.total) || res.total < 0 || typeof res.hasMore !== "boolean") {
      throw new Error("The export stopped early: the server returned an unexpected response.");
    }
    if (expectedTotal === null) expectedTotal = res.total;
    else if (expectedTotal !== res.total) throw new Error("The export stopped early: the invoice list changed while exporting. Try again.");
    for (const row of res.rows) {
      if (seen.has(row.id)) throw new Error("The export stopped early: duplicate rows were returned. Try again.");
      seen.add(row.id);
    }
    rows.push(...res.rows);
    opts.onProgress?.({ loaded: rows.length, total: expectedTotal });
    if (!res.hasMore) {
      if (rows.length !== expectedTotal) throw new Error(`The export is incomplete: received ${rows.length} of ${expectedTotal} rows.`);
      return rows;
    }
    if (res.rows.length === 0) throw new Error("The export stopped early: the server returned no rows.");
  }
  throw new Error("The export stopped early: too many batches.");
}

export function invoicesToCsv(rows: CanonicalInvoice[]): string {
  const header = ["Invoice #", "Practice", "Issued", "Due", "Status", "Total", "Balance"];
  const lines = [header.map(csvCell).join(",")];
  for (const i of rows) {
    const practice = i.providerOrganization?.displayName ?? i.providerOrganization?.name ?? "";
    lines.push([i.invoiceNumber, practice, i.issuedAt ?? i.createdAt, i.dueAt, i.status, i.total, i.balanceDue ?? i.total].map(csvCell).join(","));
  }
  return "\ufeff" + lines.join("\r\n");
}

/** Existing desktop create-invoice editor, opened through its deep link. */
export function newInvoiceDesktopUrl(): string {
  const url = new URL("/desktop/invoices", getApiUrl());
  url.searchParams.set("newInvoice", "1");
  return url.href;
}
