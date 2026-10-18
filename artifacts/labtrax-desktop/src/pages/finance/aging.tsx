import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, Download, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { formatDate, formatMoney } from "@/lib/format";
import { localTimeZone, todayIsoDate } from "@/lib/ap";
import type {
  AgingBucketKey,
  ApAgingReport,
  ApAgingRow,
  ArAgingReport,
  ArAgingRow,
} from "@/lib/ap-types";

type Side = "ap" | "ar";
type View = "summary" | "detail";

function requestedAgingSide(search: string): Side | null {
  const side = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("side");
  return side === "ar" || side === "ap" ? side : null;
}

export default function AgingPage() {
  return (
    <FinanceShell>
      {({ organizationId }) => <AgingContent organizationId={organizationId} />}
    </FinanceShell>
  );
}

function AgingContent({ organizationId }: { organizationId: string }) {
  // Other screens link here with ?side=ar (Receive Payments' "View
  // Receivables Aging") to open the A/R report directly.
  const search = useSearch();
  const requestedSide = requestedAgingSide(search);
  const [side, setSide] = useState<Side>(requestedSide ?? "ap");
  useEffect(() => {
    if (requestedSide) setSide(requestedSide);
  }, [requestedSide]);
  const [view, setView] = useState<View>("summary");
  const [asOf, setAsOf] = useState(todayIsoDate());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const params = new URLSearchParams({
    organizationId,
    asOf,
    // Without the zone the server would read "as of today" as midnight UTC
    // and leave out everything recorded today.
    timeZone: localTimeZone(),
    detail: view === "detail" ? "true" : "false",
  });

  const report = useQuery({
    queryKey: ["finance", "aging", side, params.toString()],
    queryFn: () =>
      apiFetch<ApAgingReport | ArAgingReport>(
        `/finance/reports/${side}-aging?${params.toString()}`,
      ),
  });

  const data = report.data;
  const buckets = data?.buckets ?? [];
  // Only the A/R report can be approximate, so only it carries limitations.
  const limitations = data && "limitations" in data ? data.limitations : undefined;

  function toggle(rowId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function exportCsv() {
    if (!data) return;
    const header = [
      side === "ap" ? "Vendor" : "Customer",
      ...buckets.map((bucket) => bucket.label),
      "Total",
      "Unapplied credit",
    ];
    const lines = [header.join(",")];
    for (const row of data.rows) {
      const name = side === "ap" ? (row as ApAgingRow).vendorName : (row as ArAgingRow).customerName;
      lines.push(
        [
          `"${name.replace(/"/g, '""')}"`,
          ...buckets.map((bucket) => row.buckets[bucket.key]),
          row.total,
          row.unappliedCredit,
        ].join(","),
      );
    }
    lines.push(
      [
        '"Total"',
        ...buckets.map((bucket) => data.totals[bucket.key]),
        data.total,
        data.unappliedCreditTotal,
      ].join(","),
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${side}-aging-${asOf}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md bg-secondary p-0.5">
          <button
            type="button"
            onClick={() => setSide("ap")}
            className={`px-3 h-8 text-sm rounded ${
              side === "ap" ? "bg-card shadow-sm font-medium" : "text-muted-foreground"
            }`}
          >
            A/P — what we owe
          </button>
          <button
            type="button"
            onClick={() => setSide("ar")}
            className={`px-3 h-8 text-sm rounded ${
              side === "ar" ? "bg-card shadow-sm font-medium" : "text-muted-foreground"
            }`}
          >
            A/R — what we're owed
          </button>
        </div>
        <div className="inline-flex rounded-md bg-secondary p-0.5">
          <button
            type="button"
            onClick={() => setView("summary")}
            className={`px-3 h-8 text-sm rounded ${
              view === "summary" ? "bg-card shadow-sm font-medium" : "text-muted-foreground"
            }`}
          >
            Summary
          </button>
          <button
            type="button"
            onClick={() => setView("detail")}
            className={`px-3 h-8 text-sm rounded ${
              view === "detail" ? "bg-card shadow-sm font-medium" : "text-muted-foreground"
            }`}
          >
            Detail
          </button>
        </div>
        <label className="text-sm text-muted-foreground flex items-center gap-2">
          As of
          <input
            type="date"
            value={asOf}
            onChange={(event) => setAsOf(event.target.value)}
            className="h-9 px-2 rounded-md bg-secondary text-sm"
          />
        </label>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!data?.rows.length}
          className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-secondary text-sm disabled:opacity-50"
        >
          <Download size={14} /> Export CSV
        </button>
      </div>

      {report.isLoading && (
        <p className="text-muted-foreground">
          <Loader2 size={16} className="inline animate-spin mr-2" />
          Building the aging report…
        </p>
      )}
      {report.isError && (
        <p className="text-destructive">
          Could not build this report.{" "}
          <button type="button" className="underline" onClick={() => report.refetch()}>
            Try again
          </button>
        </p>
      )}

      {!!limitations?.length && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm">
          <AlertTriangle size={15} className="mt-0.5 text-amber-600 shrink-0" />
          <div className="space-y-1">
            {limitations.map((limitation) => (
              <p key={limitation.code}>{limitation.message}</p>
            ))}
          </div>
        </div>
      )}

      {data && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border text-sm">
            <span className="font-semibold">
              {side === "ap" ? "A/P Aging" : "A/R Aging"}
            </span>
            <span className="text-muted-foreground">
              {" "}
              · {data.basis} basis · by due date · as of {formatDate(data.asOf)}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="text-left font-medium px-4 py-2">
                    {side === "ap" ? "Vendor" : "Customer"}
                  </th>
                  {buckets.map((bucket) => (
                    <th key={bucket.key} className="text-right font-medium py-2">
                      {bucket.label}
                    </th>
                  ))}
                  <th className="text-right font-medium py-2">Total</th>
                  <th className="text-right font-medium px-4 py-2">Unapplied credit</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const rowId =
                    side === "ap"
                      ? (row as ApAgingRow).vendorId
                      : (row as ArAgingRow).customerId;
                  const name =
                    side === "ap"
                      ? (row as ApAgingRow).vendorName
                      : (row as ArAgingRow).customerName;
                  const details =
                    side === "ap"
                      ? (row as ApAgingRow).bills ?? []
                      : (row as ArAgingRow).invoices ?? [];
                  const open = expanded.has(rowId);
                  return (
                    <>
                      <tr key={rowId} className="border-t border-border">
                        <td className="px-4 py-2.5">
                          {view === "detail" && details.length ? (
                            <button
                              type="button"
                              onClick={() => toggle(rowId)}
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              {name}
                            </button>
                          ) : (
                            name
                          )}
                          {side === "ap" && !(row as ApAgingRow).vendorIsActive && (
                            <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                              inactive
                            </span>
                          )}
                        </td>
                        {buckets.map((bucket) => (
                          <BucketCell
                            key={bucket.key}
                            bucketKey={bucket.key}
                            amount={row.buckets[bucket.key]}
                          />
                        ))}
                        <td className="py-2.5 text-right tabular-nums font-medium">
                          {formatMoney(row.total)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                          {Number(row.unappliedCredit) > 0
                            ? formatMoney(row.unappliedCredit)
                            : ""}
                        </td>
                      </tr>
                      {open &&
                        details.map((detail: any) => (
                          <tr key={detail.id} className="bg-secondary/20 text-[13px]">
                            <td className="pl-10 pr-4 py-1.5 text-muted-foreground">
                              {detail.billNumber ?? detail.invoiceNumber ?? detail.id}
                              {" · due "}
                              {formatDate(detail.dueDate ?? detail.dueAt ?? detail.issuedAt)}
                            </td>
                            {buckets.map((bucket) => (
                              <td
                                key={bucket.key}
                                className="py-1.5 text-right tabular-nums text-muted-foreground"
                              >
                                {detail.bucket === bucket.key
                                  ? formatMoney(detail.outstanding)
                                  : ""}
                              </td>
                            ))}
                            <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                              {formatMoney(detail.outstanding)}
                            </td>
                            <td />
                          </tr>
                        ))}
                    </>
                  );
                })}
                {!data.rows.length && (
                  <tr>
                    <td
                      colSpan={buckets.length + 3}
                      className="px-4 py-12 text-center text-muted-foreground"
                    >
                      Nothing outstanding as of {formatDate(data.asOf)}.
                    </td>
                  </tr>
                )}
              </tbody>
              {!!data.rows.length && (
                <tfoot>
                  <tr className="border-t-2 border-border bg-secondary/30 font-semibold">
                    <td className="px-4 py-2.5">Total</td>
                    {buckets.map((bucket) => (
                      <td key={bucket.key} className="py-2.5 text-right tabular-nums">
                        {formatMoney(data.totals[bucket.key])}
                      </td>
                    ))}
                    <td className="py-2.5 text-right tabular-nums">
                      {formatMoney(data.total)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {Number(data.unappliedCreditTotal) > 0
                        ? formatMoney(data.unappliedCreditTotal)
                        : ""}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="px-4 py-2.5 border-t border-border text-xs text-muted-foreground">
            {side === "ap"
              ? "This total is the lab's accounts payable liability. Unapplied vendor credits are listed beside it, never netted into what is owed."
              : "This total is the lab's accounts receivable asset. Unapplied customer credits are listed beside it, never netted into what is owed."}
          </div>
        </div>
      )}
    </div>
  );
}

function BucketCell({
  bucketKey,
  amount,
}: {
  bucketKey: AgingBucketKey;
  amount: string;
}) {
  const value = Number(amount);
  const overdue = bucketKey !== "current" && value > 0;
  return (
    <td
      className={`py-2.5 text-right tabular-nums ${
        bucketKey === "d90_plus" && value > 0 ? "text-destructive font-medium" : ""
      } ${overdue && bucketKey !== "d90_plus" ? "text-amber-700 dark:text-amber-400" : ""}`}
    >
      {value > 0 ? formatMoney(amount) : ""}
    </td>
  );
}
