import { useInfiniteQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { apiFetch } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import type { DateRangePresetKey } from "@/components/reports/DateRangePicker";
import { useRef, useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import {
  buildSalesInvoiceExportRows,
  fetchAllSalesInvoicePages,
  type SalesInvoicePage,
} from "@workspace/api-client-react";
import { downloadCsv } from "@/lib/export";

export const SALES_INVOICES_PAGE_SIZE = 50;

const SALES_INVOICES_EXPORT_PAGE_SIZE = 100;
export function salesInvoicesKey(
  organizationId: string,
  dateFrom: string,
  dateTo: string,
) {
  return ["invoices", "reports", "sales-invoices", organizationId, dateFrom, dateTo] as const;
}

export async function fetchSalesInvoicePage(
  organizationId: string,
  dateFrom: string,
  dateTo: string,
  offset: number,
  limit = SALES_INVOICES_PAGE_SIZE,
): Promise<SalesInvoicePage> {
  const params = new URLSearchParams({
    organizationId,
    dateFrom,
    dateTo,
    offset: String(offset),
    limit: String(limit),
  });
  const res = await apiFetch<{ data: SalesInvoicePage } | SalesInvoicePage>(
    `/invoices/reports/sales-invoices?${params}`,
  );
  return "data" in res ? res.data : res;
}

function statusBadgeClass(status: string): string {
  switch (status.toLowerCase()) {
    case "paid":
    case "zero_balance":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "overdue":
      return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "partially_paid":
      return "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300";
    case "open":
    case "sent":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    default:
      return "border-border bg-secondary/70 text-foreground";
  }
}

export function SalesInvoicesPanel({
  organizationId,
  dateFrom,
  dateTo,
  datePreset = "custom",
}: {
  organizationId: string;
  dateFrom: string;
  dateTo: string;
  datePreset?: DateRangePresetKey;
}) {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const q = useInfiniteQuery({
    queryKey: salesInvoicesKey(organizationId, dateFrom, dateTo),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchSalesInvoicePage(organizationId, dateFrom, dateTo, pageParam),
    getNextPageParam: (last) =>
      last.hasMore ? last.offset + last.rows.length : undefined,
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const pages = q.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.rows);
  const first = pages[0];
  const nextFailed = q.isFetchNextPageError;
  const initialError = q.isError && pages.length === 0;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const selectedRangeRef = useRef({ dateFrom, dateTo });
  selectedRangeRef.current = { dateFrom, dateTo };

  async function exportInvoices() {
    if (exporting) return;
    const exportDateFrom = dateFrom;
    const exportDateTo = dateTo;
    setExporting(true);
    setExportError(null);
    try {
      const result = await fetchAllSalesInvoicePages(
        (offset, limit) => fetchSalesInvoicePage(
          organizationId,
          exportDateFrom,
          exportDateTo,
          offset,
          limit,
        ),
        SALES_INVOICES_EXPORT_PAGE_SIZE,
      );
      if (
        selectedRangeRef.current.dateFrom !== exportDateFrom ||
        selectedRangeRef.current.dateTo !== exportDateTo
      ) {
        throw new Error("The selected date range changed during export. Please start again.");
      }
      downloadCsv(
        `sales-invoices-${exportDateFrom.slice(0, 10)}-${exportDateTo.slice(0, 10)}.csv`,
        buildSalesInvoiceExportRows(result, exportDateFrom, exportDateTo),
      );
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Couldn't export invoices. Please try again.",
      );
    } finally {
      setExporting(false);
    }
  }

  function openInvoice(invoiceId: string) {
    const returnParams = new URLSearchParams(search);
    Object.entries({
      tab: "sales",
      preset: datePreset,
      from: dateFrom,
      to: dateTo,
      org: organizationId,
    }).forEach(([key, value]) => returnParams.set(key, value));
    const targetParams = new URLSearchParams({
      previewId: invoiceId,
      returnTo: `/reports?${returnParams.toString()}`,
    });
    // Save the active in-memory report filters onto the history entry so the
    // browser Back button restores the same range as the preview's close action.
    setLocation(`/reports?${returnParams.toString()}`, { replace: true });
    setLocation(`/invoices?${targetParams.toString()}`);
  }

  return (
    <section
      className="mb-6 overflow-hidden rounded-xl border border-border/80 bg-card shadow-sm"
      data-testid="sales-invoices"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-border px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileText size={17} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight">Invoices behind billed total</h2>
            {first && (
              <p className="mt-1 text-xs text-muted-foreground tabular-nums" data-testid="sales-invoices-caption">
                Showing {rows.length} of {first.total} invoice{first.total === 1 ? "" : "s"} · Billed total{" "}
                <span className="font-semibold text-foreground">{formatMoney(first.billedTotal)}</span>
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void exportInvoices()}
          disabled={exporting}
          aria-label="Export invoices CSV"
          data-testid="sales-invoices-export"
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-foreground shadow-sm transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {exporting ? "Preparing…" : "Export CSV"}
        </button>
      </header>

      {exportError && (
        <div className="px-5 py-2 text-sm text-destructive" role="alert" data-testid="sales-invoices-export-error">
          {exportError}
        </div>
      )}
      {q.isLoading && (
        <div className="text-sm text-muted-foreground py-10 text-center" data-testid="sales-invoices-loading">
          <Loader2 size={16} className="inline animate-spin mr-2" />
          Loading invoices…
        </div>
      )}

      {initialError && (
        <div className="py-10 text-center" role="alert" data-testid="sales-invoices-error">
          <div className="text-sm font-medium mb-1">Couldn't load invoices</div>
          <button
            type="button"
            onClick={() => q.refetch()}
            className="h-8 px-3 rounded-md bg-secondary text-sm hover:bg-secondary/70"
          >
            Retry
          </button>
        </div>
      )}

      {q.isError && pages.length > 0 && !nextFailed && (
        <div className="px-5 py-3 text-sm" role="alert">
          Couldn't refresh invoices. Showing previously loaded results.{" "}
          <button type="button" onClick={() => q.refetch()} className="underline">Retry</button>
        </div>
      )}

      {first && rows.length === 0 && (
        <div className="text-sm text-muted-foreground py-10 text-center" data-testid="sales-invoices-empty">
          No invoiced sales in this range.
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[740px] text-sm">
            <thead>
              <tr className="bg-secondary/55 text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
                <th className="px-5 py-2.5 text-left font-semibold">Invoice</th>
                <th className="py-2.5 text-left font-semibold">Issued</th>
                <th className="py-2.5 text-left font-semibold">Practice</th>
                <th className="hidden py-2.5 text-left font-semibold md:table-cell">Doctor</th>
                <th className="py-2.5 text-left font-semibold">Status</th>
                <th className="px-5 py-2.5 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border/70 transition-colors hover:bg-secondary/25" data-testid="sales-invoice-row">
                  <td className="px-5 py-2.5 font-medium">
                    <button
                      type="button"
                      onClick={() => openInvoice(r.id)}
                      aria-label={`Open invoice ${r.invoiceNumber}`}
                      data-testid={`sales-invoice-open-${r.id}`}
                      className="rounded-sm text-left font-semibold text-primary hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {r.invoiceNumber}
                    </button>
                  </td>
                  <td className="whitespace-nowrap py-2.5 tabular-nums text-muted-foreground">{new Date(r.issuedAt).toLocaleDateString()}</td>
                  <td className="max-w-[220px] whitespace-normal break-words py-2.5 pr-3">{r.practiceName ?? "—"}</td>
                  <td className="hidden max-w-[220px] whitespace-normal break-words py-2.5 pr-3 md:table-cell">{r.doctorName ?? "—"}</td>
                  <td className="py-2.5">
                    <span
                      className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-semibold capitalize leading-none ${statusBadgeClass(r.status)}`}
                      data-testid="sales-invoice-status"
                      data-status={r.status}
                    >
                      {r.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-5 py-2.5 text-right font-semibold tabular-nums text-foreground">{formatMoney(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextFailed && (
        <div className="px-5 py-3 border-t border-border text-sm flex items-center justify-between" role="alert" data-testid="sales-invoices-next-error">
          <span>Couldn't load more invoices. Loaded rows are kept.</span>
          <button
            type="button"
            onClick={() => q.fetchNextPage()}
            className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/70"
          >
            Retry
          </button>
        </div>
      )}

      {q.hasNextPage && !nextFailed && (
        <div className="px-5 py-3 border-t border-border text-center">
          <button
            type="button"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetching}
            className="h-8 px-4 rounded-md bg-secondary text-sm hover:bg-secondary/70 disabled:opacity-50"
          >
            {q.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}
