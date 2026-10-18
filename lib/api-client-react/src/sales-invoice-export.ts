import type { SalesInvoicePage, SalesInvoiceRow } from "./generated/api.schemas";

const MAX_EXPORT_PAGES = 10_000;

export interface SalesInvoiceExport {
  rows: SalesInvoiceRow[];
  expectedCount: number;
  expectedAmount: string;
  exportedCount: number;
  exportedAmount: string;
}

function amountToCents(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Sales invoice totals were invalid; the CSV was not created.");
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) {
    throw new Error("Sales invoice totals were too large to reconcile; the CSV was not created.");
  }
  return match[1] === "-" ? -cents : cents;
}

function centsToAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

/**
 * Fetch every matching sales-invoice page and refuse to return a partial or
 * internally inconsistent export.
 */
export async function fetchAllSalesInvoicePages(
  fetchPage: (offset: number, limit: number) => Promise<SalesInvoicePage>,
  pageSize = 100,
): Promise<SalesInvoiceExport> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("The sales invoice export page size is invalid.");
  }

  const rows: SalesInvoiceRow[] = [];
  const ids = new Set<string>();
  let expectedCount: number | undefined;
  let expectedAmountCents: number | undefined;
  let offset = 0;

  for (let pageNumber = 0; pageNumber < MAX_EXPORT_PAGES; pageNumber += 1) {
    const page = await fetchPage(offset, pageSize);
    const pageAmountCents = amountToCents(page.billedTotal);
    if (!Number.isInteger(page.total) || page.total < 0 || page.offset !== offset) {
      throw new Error("Sales invoice pages changed while preparing the export. Please try again.");
    }
    if (page.rows.length > pageSize || (page.hasMore && page.rows.length === 0)) {
      throw new Error("The sales invoice export stopped before all pages were loaded.");
    }

    if (expectedCount === undefined) {
      expectedCount = page.total;
      expectedAmountCents = pageAmountCents;
    } else if (page.total !== expectedCount || pageAmountCents !== expectedAmountCents) {
      throw new Error("Sales totals changed while preparing the export. Please try again.");
    }

    for (const row of page.rows) {
      if (ids.has(row.id)) {
        throw new Error("Sales invoice pages overlapped while preparing the export. Please try again.");
      }
      ids.add(row.id);
      rows.push(row);
    }

    const hasMoreByCount = offset + page.rows.length < page.total;
    if (page.hasMore !== hasMoreByCount) {
      throw new Error("Sales invoice pages changed while preparing the export. Please try again.");
    }
    if (!page.hasMore) {
      const exportedAmountCents = rows.reduce((sum, row) => sum + amountToCents(row.total), 0);
      if (rows.length !== expectedCount || exportedAmountCents !== expectedAmountCents) {
        throw new Error("The invoice count or amount did not reconcile to the selected Sales total. Please try again.");
      }
      return {
        rows,
        expectedCount,
        expectedAmount: centsToAmount(expectedAmountCents),
        exportedCount: rows.length,
        exportedAmount: centsToAmount(exportedAmountCents),
      };
    }

    offset += page.rows.length;
  }

  throw new Error("The sales invoice export stopped before all pages were loaded.");
}

export type SalesInvoiceExportCsvRow = Record<
  string,
  string | number
>;

const CSV_COLUMNS = [
  "record_type",
  "invoice_id",
  "invoice_number",
  "effective_issued_date",
  "practice",
  "doctor",
  "status",
  "persisted_total",
  "selected_date_from",
  "selected_date_to",
  "expected_invoice_count",
  "expected_persisted_total",
  "exported_invoice_count",
  "exported_persisted_total",
  "reconciliation_result",
] as const;

export function buildSalesInvoiceExportRows(
  result: SalesInvoiceExport,
  dateFrom: string,
  dateTo: string,
): SalesInvoiceExportCsvRow[] {
  const invoiceRows = result.rows.map((row) => ({
    record_type: "invoice",
    invoice_id: row.id,
    invoice_number: row.invoiceNumber,
    effective_issued_date: row.issuedAt,
    practice: row.practiceName ?? "",
    doctor: row.doctorName ?? "",
    status: row.status,
    persisted_total: centsToAmount(amountToCents(row.total)),
    selected_date_from: dateFrom,
    selected_date_to: dateTo,
    expected_invoice_count: "",
    expected_persisted_total: "",
    exported_invoice_count: "",
    exported_persisted_total: "",
    reconciliation_result: "",
  }));

  return [
    ...invoiceRows,
    {
      record_type: "reconciliation",
      invoice_id: "",
      invoice_number: "",
      effective_issued_date: "",
      practice: "",
      doctor: "",
      status: "",
      persisted_total: "",
      selected_date_from: dateFrom,
      selected_date_to: dateTo,
      expected_invoice_count: result.expectedCount,
      expected_persisted_total: result.expectedAmount,
      exported_invoice_count: result.exportedCount,
      exported_persisted_total: result.exportedAmount,
      reconciliation_result: "MATCH",
    },
  ];
}

/** CSV serializer shared by native mobile and browser downloads. */
export function salesInvoiceExportRowsToCsv(rows: SalesInvoiceExportCsvRow[]): string {
  const escape = (value: string | number): string => {
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `\uFEFF${[
    CSV_COLUMNS.map(escape).join(","),
    ...rows.map((row) => CSV_COLUMNS.map((column) => escape(row[column] ?? "")).join(",")),
  ].join("\n")}`;
}
