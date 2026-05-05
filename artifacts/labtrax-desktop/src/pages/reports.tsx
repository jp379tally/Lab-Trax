import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, BarChart3, Clock, DollarSign, Download, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { Invoice, LabCase, MeResponse } from "@/lib/types";
import { formatMoney, statusLabel } from "@/lib/format";
import { downloadCsv } from "@/lib/export";

const STATUS_ORDER: Array<LabCase["status"]> = [
  "received",
  "in_design",
  "in_milling",
  "in_porcelain",
  "qc",
  "shipped",
  "delivered",
  "on_hold",
  "remake",
  "cancelled",
];

const RANGE_OPTIONS = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
  { value: "all", label: "All time" },
];

interface SalesReport {
  totalSales: string;
  openBalance: string;
  invoices: number;
  paidInvoices: number;
  openInvoices: number;
}

export default function ReportsPage() {
  const [range, setRange] = useState<string>("90");

  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });
  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });
  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });

  const memberships = meQuery.data?.memberships ?? [];
  const labOrgs = useMemo(
    () =>
      memberships
        .filter((m) => m.status === "active" && m.organization?.type === "lab")
        .map((m) => m.organization!)
        .filter(Boolean),
    [memberships],
  );

  const dateRange = useMemo(() => {
    if (range === "all") return null;
    const days = Number(range);
    const to = new Date();
    const from = new Date(Date.now() - days * 86400_000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [range]);

  const salesQuery = useQuery({
    queryKey: ["reports", "sales", labOrgs.map((o) => o.id), dateRange],
    enabled: labOrgs.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        labOrgs.map(async (org) => {
          const params = new URLSearchParams({ organizationId: org.id });
          if (dateRange) {
            params.set("dateFrom", dateRange.from);
            params.set("dateTo", dateRange.to);
          }
          try {
            const r = await apiFetch<SalesReport>(`/invoices/reports/sales?${params}`);
            return { org, report: r };
          } catch {
            return { org, report: null };
          }
        }),
      );
      return results;
    },
  });

  const cases = casesQuery.data ?? [];
  const filteredCases = useMemo(() => {
    if (!dateRange) return cases;
    const fromMs = new Date(dateRange.from).getTime();
    return cases.filter((c) => {
      const t = c.createdAt ? new Date(c.createdAt).getTime() : 0;
      return t >= fromMs;
    });
  }, [cases, dateRange]);

  const statusCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of filteredCases) {
      map.set(c.status, (map.get(c.status) ?? 0) + 1);
    }
    return STATUS_ORDER.map((s) => ({ status: s, count: map.get(s) ?? 0 }));
  }, [filteredCases]);
  const maxStatusCount = Math.max(1, ...statusCounts.map((s) => s.count));

  const invoices = invoicesQuery.data ?? [];
  const filteredInvoices = useMemo(() => {
    if (!dateRange) return invoices;
    const fromMs = new Date(dateRange.from).getTime();
    return invoices.filter((i) => {
      const t = (i.issuedAt || i.createdAt) ? new Date(i.issuedAt || i.createdAt!).getTime() : 0;
      return t >= fromMs;
    });
  }, [invoices, dateRange]);

  // Monthly revenue trend (last 12 months / current range buckets by month)
  const monthly = useMemo(() => {
    const map = new Map<string, { label: string; revenue: number }>();
    for (const i of filteredInvoices) {
      const ts = i.issuedAt || i.createdAt;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      const cur = map.get(key) ?? { label, revenue: 0 };
      cur.revenue += Number(i.total ?? 0);
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([_, v]) => v);
  }, [filteredInvoices]);
  const maxRevenue = Math.max(1, ...monthly.map((m) => m.revenue));

  // Turnaround: avg days received -> shipped/delivered for cases in range
  const turnaround = useMemo(() => {
    const SHIPPED = new Set(["shipped", "delivered"]);
    const eligible = filteredCases.filter((c) => SHIPPED.has(c.status) && c.createdAt && c.updatedAt);
    if (eligible.length === 0) return null;
    const totalMs = eligible.reduce((sum, c) => sum + (new Date(c.updatedAt!).getTime() - new Date(c.createdAt!).getTime()), 0);
    return totalMs / eligible.length / 86400_000;
  }, [filteredCases]);

  // Aggregate sales totals
  const aggregateSales = useMemo(() => {
    const rows = salesQuery.data ?? [];
    return rows.reduce(
      (acc, r) => {
        if (!r.report) return acc;
        acc.totalSales += Number(r.report.totalSales);
        acc.openBalance += Number(r.report.openBalance);
        acc.invoices += r.report.invoices;
        acc.paidInvoices += r.report.paidInvoices;
        acc.openInvoices += r.report.openInvoices;
        return acc;
      },
      { totalSales: 0, openBalance: 0, invoices: 0, paidInvoices: 0, openInvoices: 0 },
    );
  }, [salesQuery.data]);

  const isLoading = casesQuery.isLoading || invoicesQuery.isLoading || meQuery.isLoading;

  const rangeLabel = RANGE_OPTIONS.find((o) => o.value === range)?.label ?? range;
  const filterDesc = `Range: ${rangeLabel}${dateRange ? ` (${dateRange.from.slice(0, 10)} → ${dateRange.to.slice(0, 10)})` : ""}`;
  const dateStamp = new Date().toISOString().slice(0, 10);

  function exportSalesByOrgCsv() {
    const rows = (salesQuery.data ?? []).map((row) => ({
      Organization: row.org.displayName || row.org.name,
      Invoices: row.report?.invoices ?? "",
      "Paid invoices": row.report?.paidInvoices ?? "",
      "Open invoices": row.report?.openInvoices ?? "",
      "Total sales": row.report ? Number(row.report.totalSales).toFixed(2) : "",
      "Open balance": row.report ? Number(row.report.openBalance).toFixed(2) : "",
      Filters: filterDesc,
    }));
    downloadCsv(`sales-by-organization-${dateStamp}.csv`, rows);
  }

  function exportMonthlyRevenueCsv() {
    const rows = monthly.map((m) => ({
      Month: m.label,
      Revenue: m.revenue.toFixed(2),
      Filters: filterDesc,
    }));
    downloadCsv(`monthly-revenue-${dateStamp}.csv`, rows);
  }

  function exportProductionByStatusCsv() {
    const rows = statusCounts.map((s) => ({
      Status: statusLabel(s.status),
      Count: s.count,
      Filters: filterDesc,
    }));
    downloadCsv(`production-by-status-${dateStamp}.csv`, rows);
  }

  return (
    <div className="px-8 py-7 max-w-[1500px] mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Production, revenue, and turnaround across your lab organizations.
          </p>
        </div>
        <select
          value={range}
          onChange={(e) => setRange(e.target.value)}
          className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
        >
          {RANGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground -mt-4 mb-5">{filterDesc}</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <KpiCard label="Total sales" value={formatMoney(aggregateSales.totalSales)} icon={DollarSign} tone="success" />
        <KpiCard label="Open balance" value={formatMoney(aggregateSales.openBalance)} icon={Activity} tone="warning" />
        <KpiCard label="Cases" value={String(filteredCases.length)} icon={BarChart3} tone="primary" />
        <KpiCard
          label="Avg turnaround"
          value={turnaround ? `${turnaround.toFixed(1)} days` : "—"}
          icon={Clock}
          tone="neutral"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-6">
        <section className="lg:col-span-2 bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold">Monthly revenue</h2>
            <button
              type="button"
              onClick={exportMonthlyRevenueCsv}
              disabled={monthly.length === 0}
              className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium hover:bg-secondary disabled:opacity-50"
            >
              <Download size={12} /> CSV
            </button>
          </div>
          {isLoading && (
            <div className="text-sm text-muted-foreground py-10 text-center">
              <Loader2 size={16} className="inline animate-spin mr-2" />
              Loading…
            </div>
          )}
          {!isLoading && monthly.length === 0 && (
            <div className="text-sm text-muted-foreground py-10 text-center">No invoices in this range.</div>
          )}
          {monthly.length > 0 && (
            <div className="flex items-end gap-3 h-48">
              {monthly.map((m) => (
                <div key={m.label} className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
                  <div className="text-[10px] text-muted-foreground tabular-nums">
                    {m.revenue >= 1000 ? `${(m.revenue / 1000).toFixed(1)}k` : m.revenue.toFixed(0)}
                  </div>
                  <div
                    className="w-full bg-primary/20 hover:bg-primary/30 rounded-t-md transition-colors"
                    style={{ height: `${Math.max(2, (m.revenue / maxRevenue) * 100)}%` }}
                    title={`${m.label}: ${formatMoney(m.revenue)}`}
                  />
                  <div className="text-[10px] text-muted-foreground">{m.label}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold">Production by status</h2>
            <button
              type="button"
              onClick={exportProductionByStatusCsv}
              className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium hover:bg-secondary"
            >
              <Download size={12} /> CSV
            </button>
          </div>
          <ul className="space-y-2.5">
            {statusCounts.map((s) => (
              <li key={s.status}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-muted-foreground">{statusLabel(s.status)}</span>
                  <span className="tabular-nums font-medium">{s.count}</span>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${(s.count / maxStatusCount) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="bg-card border border-border rounded-xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">Sales by organization</h2>
          <button
            type="button"
            onClick={exportSalesByOrgCsv}
            disabled={(salesQuery.data ?? []).length === 0}
            className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium hover:bg-secondary disabled:opacity-50"
          >
            <Download size={12} /> CSV
          </button>
        </header>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="text-left font-medium px-5 py-2.5">Organization</th>
              <th className="text-right font-medium py-2.5">Invoices</th>
              <th className="text-right font-medium py-2.5">Paid</th>
              <th className="text-right font-medium py-2.5">Open</th>
              <th className="text-right font-medium px-5 py-2.5">Total sales</th>
            </tr>
          </thead>
          <tbody>
            {salesQuery.isLoading && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-muted-foreground">
                  <Loader2 size={16} className="inline animate-spin mr-2" />
                  Loading sales…
                </td>
              </tr>
            )}
            {!salesQuery.isLoading && (salesQuery.data ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-muted-foreground">
                  No lab organizations with billing access.
                </td>
              </tr>
            )}
            {(salesQuery.data ?? []).map((row) => (
              <tr key={row.org.id} className="border-t border-border">
                <td className="px-5 py-3 font-medium">{row.org.displayName || row.org.name}</td>
                <td className="py-3 text-right tabular-nums">{row.report?.invoices ?? "—"}</td>
                <td className="py-3 text-right tabular-nums text-success">{row.report?.paidInvoices ?? "—"}</td>
                <td className="py-3 text-right tabular-nums text-warning">{row.report?.openInvoices ?? "—"}</td>
                <td className="px-5 py-3 text-right tabular-nums font-medium">
                  {row.report ? formatMoney(row.report.totalSales) : <span className="text-muted-foreground text-xs">no access</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function KpiCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  tone: "primary" | "success" | "warning" | "neutral";
}) {
  const cls =
    tone === "success"
      ? "bg-success/15 text-success"
      : tone === "warning"
        ? "bg-warning/20 text-warning"
        : tone === "primary"
          ? "bg-primary/10 text-primary"
          : "bg-secondary text-foreground";
  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
        </div>
        <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${cls}`}>
          <Icon size={18} />
        </div>
      </div>
    </div>
  );
}
