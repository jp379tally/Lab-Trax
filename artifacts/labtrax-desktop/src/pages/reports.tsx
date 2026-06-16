import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  Clock,
  DollarSign,
  Download,
  Loader2,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { Invoice, LabCase, MeResponse, Organization } from "@/lib/types";
import { formatMoney, statusLabel } from "@/lib/format";
import { downloadCsv } from "@/lib/export";
import {
  DateRangePicker,
  defaultRange,
  rangeLabel,
  type DateRange,
} from "@/components/reports/DateRangePicker";

const BILLING_ROLES = new Set(["owner", "admin", "billing"]);

const TABS = [
  { key: "summary", label: "Summary" },
  { key: "production", label: "Production" },
  { key: "sales", label: "Sales" },
  { key: "pnl", label: "Profit & Loss" },
  { key: "balance-sheet", label: "Balance Sheet" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function ReportsPage() {
  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });
  const memberships = meQuery.data?.memberships ?? [];
  const billingLabs = useMemo(
    () =>
      memberships
        .filter(
          (m) =>
            m.status === "active" &&
            m.organization?.type === "lab" &&
            BILLING_ROLES.has(m.role),
        )
        .map((m) => m.organization!)
        .filter(Boolean) as Organization[],
    [memberships],
  );

  const [tab, setTab] = useState<TabKey>("summary");
  const [orgId, setOrgId] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>(() => defaultRange());

  useEffect(() => {
    if (!orgId && billingLabs.length > 0) {
      setOrgId(billingLabs[0]!.id);
    }
  }, [billingLabs, orgId]);

  const isBilling = billingLabs.length > 0;

  return (
    <div className="px-8 py-7 max-w-[1500px] mx-auto">
      <div className="flex items-start justify-between mb-5 gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Production, sales, and financial statements for your lab.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {isBilling && billingLabs.length > 1 && (
            <select
              value={orgId || ""}
              onChange={(e) => setOrgId(e.target.value || null)}
              className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
            >
              {billingLabs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName || o.name}
                </option>
              ))}
            </select>
          )}
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      </div>

      <div className="border-b border-border mb-5">
        <nav className="flex gap-1 -mb-px overflow-x-auto">
          {TABS.filter((t) => isBilling || t.key === "summary").map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`px-3.5 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
      </div>

      {!isBilling && (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <div className="text-base font-medium mb-1">Reports are restricted</div>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            You need an admin, owner, or billing role on a lab organization to
            see Reports. Ask your lab admin to grant you access.
          </p>
        </div>
      )}

      {tab === "summary" && isBilling && (
        <SummaryTab
          billingLabs={billingLabs}
          memberships={memberships}
          range={range}
        />
      )}
      {tab !== "summary" && isBilling && orgId && (
        <>
          {tab === "production" && (
            <ProductionTab organizationId={orgId} range={range} />
          )}
          {tab === "sales" && (
            <SalesTab organizationId={orgId} range={range} />
          )}
          {tab === "pnl" && <PnlTab organizationId={orgId} range={range} />}
          {tab === "balance-sheet" && (
            <BalanceSheetTab organizationId={orgId} range={range} />
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────── Summary tab ───────────────────────────
//
// Preserves the original cross-org dashboard view that this page used
// to be: aggregated KPIs, a monthly revenue chart, status breakdown,
// and a sales-by-organization table. Available to any authenticated
// user (the per-org sales calls quietly fall back when the caller
// lacks billing access on a given org).
interface SalesReport {
  totalSales: string;
  openBalance: string;
  invoices: number;
  paidInvoices: number;
  openInvoices: number;
}

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

function SummaryTab({
  billingLabs,
  memberships,
  range,
}: {
  billingLabs: Organization[];
  memberships: MeResponse["memberships"];
  range: DateRange;
}) {
  const allLabOrgs = useMemo(
    () =>
      memberships
        .filter((m) => m.status === "active" && m.organization?.type === "lab")
        .map((m) => m.organization!)
        .filter(Boolean) as Organization[],
    [memberships],
  );
  const queryOrgs = billingLabs.length > 0 ? billingLabs : allLabOrgs;

  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });
  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });

  const salesQuery = useQuery({
    queryKey: [
      "reports",
      "sales",
      queryOrgs.map((o) => o.id),
      range.from,
      range.to,
    ],
    enabled: queryOrgs.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        queryOrgs.map(async (org) => {
          const params = new URLSearchParams({
            organizationId: org.id,
            dateFrom: range.from,
            dateTo: range.to,
          });
          try {
            const r = await apiFetch<SalesReport>(
              `/invoices/reports/sales?${params}`,
            );
            return { org, report: r };
          } catch {
            return { org, report: null };
          }
        }),
      );
      return results;
    },
  });

  const fromMs = new Date(range.from).getTime();
  const toMs = new Date(range.to).getTime();
  const filteredCases = (casesQuery.data ?? []).filter((c) => {
    const t = c.createdAt ? new Date(c.createdAt).getTime() : 0;
    return t >= fromMs && t <= toMs;
  });
  const filteredInvoices = (invoicesQuery.data ?? []).filter((i) => {
    const ts = i.issuedAt || i.createdAt;
    if (!ts) return false;
    const t = new Date(ts).getTime();
    return t >= fromMs && t <= toMs;
  });

  const statusCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of filteredCases) {
      map.set(c.status, (map.get(c.status) ?? 0) + 1);
    }
    return STATUS_ORDER.map((s) => ({ status: s, count: map.get(s) ?? 0 }));
  }, [filteredCases]);
  const maxStatusCount = Math.max(1, ...statusCounts.map((s) => s.count));

  const monthly = useMemo(() => {
    const map = new Map<string, { label: string; revenue: number }>();
    for (const i of filteredInvoices) {
      const ts = i.issuedAt || i.createdAt;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString("en-US", {
        month: "short",
        year: "2-digit",
      });
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

  const turnaround = useMemo(() => {
    const SHIPPED = new Set(["shipped", "delivered"]);
    const eligible = filteredCases.filter(
      (c) => SHIPPED.has(c.status) && c.createdAt && c.updatedAt,
    );
    if (eligible.length === 0) return null;
    const totalMs = eligible.reduce(
      (sum, c) =>
        sum +
        (new Date(c.updatedAt!).getTime() - new Date(c.createdAt!).getTime()),
      0,
    );
    return totalMs / eligible.length / 86400_000;
  }, [filteredCases]);

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
      {
        totalSales: 0,
        openBalance: 0,
        invoices: 0,
        paidInvoices: 0,
        openInvoices: 0,
      },
    );
  }, [salesQuery.data]);

  const isLoading = casesQuery.isLoading || invoicesQuery.isLoading;
  const filterDesc = `Range: ${rangeLabel(range)}`;
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
    <>
      <p className="text-xs text-muted-foreground -mt-2 mb-5">{filterDesc}</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <KpiCard
          label="Total sales"
          value={formatMoney(aggregateSales.totalSales)}
          icon={DollarSign}
          tone="success"
        />
        <KpiCard
          label="Open balance"
          value={formatMoney(aggregateSales.openBalance)}
          icon={Activity}
          tone="warning"
        />
        <KpiCard
          label="Cases"
          value={String(filteredCases.length)}
          icon={BarChart3}
          tone="primary"
        />
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
            <div className="text-sm text-muted-foreground py-10 text-center">
              No invoices in this range.
            </div>
          )}
          {monthly.length > 0 && (
            <div className="flex items-end gap-3 h-48">
              {monthly.map((m) => (
                <div
                  key={m.label}
                  className="flex-1 flex flex-col items-center gap-1.5 min-w-0"
                >
                  <div className="text-[10px] text-muted-foreground tabular-nums">
                    {m.revenue >= 1000
                      ? `${(m.revenue / 1000).toFixed(1)}k`
                      : m.revenue.toFixed(0)}
                  </div>
                  <div
                    className="w-full bg-primary/70 hover:bg-primary/90 rounded-t-md transition-colors"
                    style={{
                      height: `${Math.max(2, (m.revenue / maxRevenue) * 100)}%`,
                    }}
                    title={`${m.label}: ${formatMoney(m.revenue)}`}
                  />
                  <div className="text-[10px] text-muted-foreground">
                    {m.label}
                  </div>
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
                  <span className="text-muted-foreground">
                    {statusLabel(s.status)}
                  </span>
                  <span className="tabular-nums font-medium">{s.count}</span>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary"
                    style={{
                      width: `${(s.count / maxStatusCount) * 100}%`,
                    }}
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
                <td
                  colSpan={5}
                  className="px-5 py-8 text-center text-muted-foreground"
                >
                  <Loader2 size={16} className="inline animate-spin mr-2" />
                  Loading sales…
                </td>
              </tr>
            )}
            {!salesQuery.isLoading && (salesQuery.data ?? []).length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-5 py-8 text-center text-muted-foreground"
                >
                  No lab organizations with billing access.
                </td>
              </tr>
            )}
            {(salesQuery.data ?? []).map((row) => (
              <tr key={row.org.id} className="border-t border-border">
                <td className="px-5 py-3 font-medium">
                  {row.org.displayName || row.org.name}
                </td>
                <td className="py-3 text-right tabular-nums">
                  {row.report?.invoices ?? "—"}
                </td>
                <td className="py-3 text-right tabular-nums text-success">
                  {row.report?.paidInvoices ?? "—"}
                </td>
                <td className="py-3 text-right tabular-nums text-warning">
                  {row.report?.openInvoices ?? "—"}
                </td>
                <td className="px-5 py-3 text-right tabular-nums font-medium">
                  {row.report ? (
                    formatMoney(row.report.totalSales)
                  ) : (
                    <span className="text-muted-foreground text-xs">
                      no access
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

// ───────────────────────── Production tab ─────────────────────────
interface ProductionRow {
  restorationType: string;
  count: number;
  units: number;
  cases: number;
  revenue: string;
}
interface ProductionResponse {
  from: string;
  to: string;
  items: ProductionRow[];
  crownsRollup: {
    count: number;
    units: number;
    cases: number;
    revenue: string;
  } | null;
  totals: { count: number; units: number; cases: number; revenue: string };
}

function ProductionTab({
  organizationId,
  range,
}: {
  organizationId: string;
  range: DateRange;
}) {
  const params = new URLSearchParams({
    organizationId,
    dateFrom: range.from,
    dateTo: range.to,
  });
  const q = useQuery({
    queryKey: [
      "reports",
      "production",
      organizationId,
      range.from,
      range.to,
    ],
    queryFn: () =>
      apiFetch<ProductionResponse>(
        `/cases/reports/production-by-type?${params}`,
      ),
  });
  const data = q.data;
  const maxRevenue = Math.max(
    1,
    ...(data?.items ?? []).map((i) => Number(i.revenue)),
  );
  const filterDesc = `Range: ${rangeLabel(range)}`;
  const dateStamp = new Date().toISOString().slice(0, 10);

  function exportCsv() {
    if (!data) return;
    const rows: Array<Record<string, string | number>> = data.items.map(
      (i) => ({
        "Restoration type": i.restorationType,
        Count: i.count,
        Units: i.units,
        Cases: i.cases,
        Revenue: i.revenue,
        Filters: filterDesc,
      }),
    );
    if (data.crownsRollup) {
      rows.push({
        "Restoration type": "Crowns (rollup)",
        Count: data.crownsRollup.count,
        Units: data.crownsRollup.units,
        Cases: data.crownsRollup.cases,
        Revenue: data.crownsRollup.revenue,
        Filters: filterDesc,
      });
    }
    rows.push({
      "Restoration type": "TOTAL",
      Count: data.totals.count,
      Units: data.totals.units,
      Cases: data.totals.cases,
      Revenue: data.totals.revenue,
      Filters: filterDesc,
    });
    downloadCsv(`production-by-type-${dateStamp}.csv`, rows);
  }

  return (
    <>
      <p className="text-xs text-muted-foreground -mt-2 mb-5">{filterDesc}</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <KpiCard
          label="Restorations"
          value={data ? String(data.totals.count) : "—"}
          icon={BarChart3}
          tone="primary"
        />
        <KpiCard
          label="Units produced"
          value={data ? String(data.totals.units) : "—"}
          icon={BarChart3}
          tone="primary"
        />
        <KpiCard
          label="Cases"
          value={data ? String(data.totals.cases) : "—"}
          icon={Activity}
          tone="neutral"
        />
        <KpiCard
          label="Revenue"
          value={data ? formatMoney(data.totals.revenue) : "—"}
          icon={DollarSign}
          tone="success"
        />
      </div>

      <section className="bg-card border border-border rounded-xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">By restoration type</h2>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!data || data.items.length === 0}
            className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium hover:bg-secondary disabled:opacity-50"
          >
            <Download size={12} /> CSV
          </button>
        </header>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="text-left font-medium px-5 py-2.5">Type</th>
              <th className="text-right font-medium py-2.5">Count</th>
              <th className="text-right font-medium py-2.5">Units</th>
              <th className="text-right font-medium py-2.5">Cases</th>
              <th className="text-right font-medium px-5 py-2.5">Revenue</th>
              <th className="text-right font-medium pr-5 py-2.5 w-1/4">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-8 text-center text-muted-foreground"
                >
                  <Loader2 size={16} className="inline animate-spin mr-2" />
                  Loading…
                </td>
              </tr>
            )}
            {!q.isLoading && (!data || data.items.length === 0) && (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-8 text-center text-muted-foreground"
                >
                  No restorations recorded in this range.
                </td>
              </tr>
            )}
            {(data?.items ?? []).map((r) => (
              <tr key={r.restorationType} className="border-t border-border">
                <td className="px-5 py-3 font-medium">{r.restorationType}</td>
                <td className="py-3 text-right tabular-nums">{r.count}</td>
                <td className="py-3 text-right tabular-nums text-muted-foreground">
                  {r.units}
                </td>
                <td className="py-3 text-right tabular-nums text-muted-foreground">
                  {r.cases}
                </td>
                <td className="px-5 py-3 text-right tabular-nums">
                  {formatMoney(r.revenue)}
                </td>
                <td className="pr-5 py-3">
                  <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary"
                      style={{
                        width: `${(Number(r.revenue) / maxRevenue) * 100}%`,
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {data?.crownsRollup && (
              <tr className="border-t border-border bg-secondary/30">
                <td className="px-5 py-3 font-semibold">Crowns (rollup)</td>
                <td className="py-3 text-right tabular-nums font-semibold">
                  {data.crownsRollup.count}
                </td>
                <td className="py-3 text-right tabular-nums font-semibold text-muted-foreground">
                  {data.crownsRollup.units}
                </td>
                <td className="py-3 text-right tabular-nums font-semibold text-muted-foreground">
                  {data.crownsRollup.cases}
                </td>
                <td className="px-5 py-3 text-right tabular-nums font-semibold">
                  {formatMoney(data.crownsRollup.revenue)}
                </td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}

// ─────────────────────────── Sales tab ───────────────────────────
interface SalesSeriesPoint {
  periodStart: string;
  gross: string;
  discounts: string;
  net: string;
  tax: string;
  count: number;
  avg: string;
}
interface SalesSeriesResponse {
  from: string;
  to: string;
  groupBy: "day" | "week" | "month";
  series: SalesSeriesPoint[];
  totals: {
    gross: string;
    discounts: string;
    net: string;
    tax: string;
    count: number;
    avg: string;
  };
}

function SalesTab({
  organizationId,
  range,
}: {
  organizationId: string;
  range: DateRange;
}) {
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month">("month");
  // Send the user's local IANA time zone so day/week/month buckets line
  // up with the lab's calendar instead of UTC.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const params = new URLSearchParams({
    organizationId,
    dateFrom: range.from,
    dateTo: range.to,
    groupBy,
    timeZone,
  });
  const q = useQuery({
    queryKey: [
      "reports",
      "sales-series",
      organizationId,
      range.from,
      range.to,
      groupBy,
      timeZone,
    ],
    queryFn: () =>
      apiFetch<SalesSeriesResponse>(
        `/invoices/reports/sales-series?${params}`,
      ),
  });
  const data = q.data;
  const maxNet = Math.max(1, ...(data?.series ?? []).map((p) => Number(p.net)));
  const filterDesc = `Range: ${rangeLabel(range)} · grouped by ${groupBy}`;
  const dateStamp = new Date().toISOString().slice(0, 10);

  function fmtPeriod(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    if (groupBy === "month") {
      return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    }
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "2-digit",
    });
  }

  function exportCsv() {
    if (!data) return;
    const rows = data.series.map((p) => ({
      Period: fmtPeriod(p.periodStart),
      Gross: p.gross,
      Discounts: p.discounts,
      Net: p.net,
      Tax: p.tax,
      Invoices: p.count,
      "Avg invoice": p.avg,
      Filters: filterDesc,
    }));
    rows.push({
      Period: "TOTAL",
      Gross: data.totals.gross,
      Discounts: data.totals.discounts,
      Net: data.totals.net,
      Tax: data.totals.tax,
      Invoices: data.totals.count,
      "Avg invoice": data.totals.avg,
      Filters: filterDesc,
    });
    downloadCsv(`sales-${groupBy}-${dateStamp}.csv`, rows);
  }

  return (
    <>
      <div className="flex items-center justify-between mb-3 -mt-2">
        <p className="text-xs text-muted-foreground">{filterDesc}</p>
        <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
          {(["day", "week", "month"] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGroupBy(g)}
              className={`px-3 py-1.5 capitalize ${
                groupBy === g
                  ? "bg-primary text-primary-foreground"
                  : "bg-card hover:bg-secondary"
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <KpiCard
          label="Net sales"
          value={data ? formatMoney(data.totals.net) : "—"}
          icon={DollarSign}
          tone="success"
        />
        <KpiCard
          label="Gross"
          value={data ? formatMoney(data.totals.gross) : "—"}
          icon={Activity}
          tone="primary"
        />
        <KpiCard
          label="Discounts"
          value={data ? formatMoney(data.totals.discounts) : "—"}
          icon={Activity}
          tone="warning"
        />
        <KpiCard
          label="Avg invoice"
          value={data ? formatMoney(data.totals.avg) : "—"}
          icon={BarChart3}
          tone="neutral"
        />
      </div>

      <section className="bg-card border border-border rounded-xl p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold">Net sales over time</h2>
        </div>
        {q.isLoading && (
          <div className="text-sm text-muted-foreground py-10 text-center">
            <Loader2 size={16} className="inline animate-spin mr-2" />
            Loading…
          </div>
        )}
        {!q.isLoading && (!data || data.series.length === 0) && (
          <div className="text-sm text-muted-foreground py-10 text-center">
            No invoiced sales in this range.
          </div>
        )}
        {data && data.series.length > 0 && (
          <div className="flex items-end gap-2 h-56 overflow-x-auto">
            {data.series.map((p) => (
              <div
                key={p.periodStart}
                className="flex flex-col items-center gap-1.5 min-w-[40px]"
              >
                <div className="text-[10px] text-muted-foreground tabular-nums">
                  {Number(p.net) >= 1000
                    ? `${(Number(p.net) / 1000).toFixed(1)}k`
                    : Number(p.net).toFixed(0)}
                </div>
                <div
                  className="w-8 bg-primary/30 hover:bg-primary/50 rounded-t-md transition-colors"
                  style={{
                    height: `${Math.max(2, (Number(p.net) / maxNet) * 100)}%`,
                  }}
                  title={`${fmtPeriod(p.periodStart)}: ${formatMoney(p.net)}`}
                />
                <div className="text-[10px] text-muted-foreground whitespace-nowrap">
                  {fmtPeriod(p.periodStart)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="bg-card border border-border rounded-xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">Breakdown</h2>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!data || data.series.length === 0}
            className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium hover:bg-secondary disabled:opacity-50"
          >
            <Download size={12} /> CSV
          </button>
        </header>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="text-left font-medium px-5 py-2.5">Period</th>
              <th className="text-right font-medium py-2.5">Gross</th>
              <th className="text-right font-medium py-2.5">Discounts</th>
              <th className="text-right font-medium py-2.5">Net</th>
              <th className="text-right font-medium py-2.5">Tax</th>
              <th className="text-right font-medium py-2.5">Invoices</th>
              <th className="text-right font-medium px-5 py-2.5">Avg</th>
            </tr>
          </thead>
          <tbody>
            {(data?.series ?? []).map((p) => (
              <tr key={p.periodStart} className="border-t border-border">
                <td className="px-5 py-2.5 font-medium">
                  {fmtPeriod(p.periodStart)}
                </td>
                <td className="py-2.5 text-right tabular-nums">
                  {formatMoney(p.gross)}
                </td>
                <td className="py-2.5 text-right tabular-nums text-warning">
                  {Number(p.discounts) > 0 ? formatMoney(p.discounts) : "—"}
                </td>
                <td className="py-2.5 text-right tabular-nums font-medium">
                  {formatMoney(p.net)}
                </td>
                <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                  {Number(p.tax) > 0 ? formatMoney(p.tax) : "—"}
                </td>
                <td className="py-2.5 text-right tabular-nums">{p.count}</td>
                <td className="px-5 py-2.5 text-right tabular-nums">
                  {formatMoney(p.avg)}
                </td>
              </tr>
            ))}
            {data && data.series.length > 0 && (
              <tr className="border-t border-border bg-secondary/30">
                <td className="px-5 py-2.5 font-semibold">Total</td>
                <td className="py-2.5 text-right tabular-nums font-semibold">
                  {formatMoney(data.totals.gross)}
                </td>
                <td className="py-2.5 text-right tabular-nums font-semibold">
                  {formatMoney(data.totals.discounts)}
                </td>
                <td className="py-2.5 text-right tabular-nums font-semibold">
                  {formatMoney(data.totals.net)}
                </td>
                <td className="py-2.5 text-right tabular-nums font-semibold">
                  {formatMoney(data.totals.tax)}
                </td>
                <td className="py-2.5 text-right tabular-nums font-semibold">
                  {data.totals.count}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums font-semibold">
                  {formatMoney(data.totals.avg)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}

// ─────────────────────────── P&L tab ───────────────────────────
interface PnlBlock {
  revenue: string;
  invoiceCount: number;
  cogs: Array<{ name: string; amount: string }>;
  cogsTotal: string;
  grossProfit: string;
  grossMargin: number;
  opex: Array<{ name: string; amount: string }>;
  opexTotal: string;
  netIncome: string;
  netMargin: number;
}
interface PnlResponse extends PnlBlock {
  from: string;
  to: string;
  previous: (PnlBlock & { from: string; to: string }) | null;
}

function PnlTab({
  organizationId,
  range,
}: {
  organizationId: string;
  range: DateRange;
}) {
  const [comparePrev, setComparePrev] = useState(false);
  const params = new URLSearchParams({
    organizationId,
    dateFrom: range.from,
    dateTo: range.to,
  });
  if (comparePrev) params.set("comparePrevious", "true");
  const q = useQuery({
    queryKey: [
      "reports",
      "pnl",
      organizationId,
      range.from,
      range.to,
      comparePrev,
    ],
    queryFn: () =>
      apiFetch<PnlResponse>(`/finance/reports/profit-loss?${params}`),
  });
  const data = q.data;
  const prev = data?.previous ?? null;
  const filterDesc = `Range: ${rangeLabel(range)}${
    comparePrev ? " · vs previous period" : ""
  }`;
  const dateStamp = new Date().toISOString().slice(0, 10);

  function exportCsv() {
    if (!data) return;
    const rows: Array<Record<string, string | number>> = [];
    rows.push({ Section: "Revenue", Line: "Invoiced revenue", Amount: data.revenue });
    rows.push({ Section: "Revenue", Line: "Total revenue", Amount: data.revenue });
    for (const c of data.cogs) {
      rows.push({ Section: "Cost of goods sold", Line: c.name, Amount: c.amount });
    }
    rows.push({ Section: "Cost of goods sold", Line: "Total COGS", Amount: data.cogsTotal });
    rows.push({ Section: "Gross profit", Line: "Gross profit", Amount: data.grossProfit });
    for (const o of data.opex) {
      rows.push({ Section: "Operating expenses", Line: o.name, Amount: o.amount });
    }
    rows.push({ Section: "Operating expenses", Line: "Total OpEx", Amount: data.opexTotal });
    rows.push({ Section: "Net income", Line: "Net income", Amount: data.netIncome });
    if (prev) {
      rows.push({ Section: "Previous", Line: "Revenue", Amount: prev.revenue });
      rows.push({ Section: "Previous", Line: "COGS", Amount: prev.cogsTotal });
      rows.push({ Section: "Previous", Line: "Gross profit", Amount: prev.grossProfit });
      rows.push({ Section: "Previous", Line: "OpEx", Amount: prev.opexTotal });
      rows.push({ Section: "Previous", Line: "Net income", Amount: prev.netIncome });
    }
    for (const r of rows) r.Filters = filterDesc;
    downloadCsv(`profit-loss-${dateStamp}.csv`, rows);
  }

  function pct(v: number): string {
    return `${(v * 100).toFixed(1)}%`;
  }
  function delta(curr: string, previous: string | undefined): string | null {
    if (previous === undefined) return null;
    const c = Number(curr);
    const p = Number(previous);
    if (!Number.isFinite(c) || !Number.isFinite(p)) return null;
    if (p === 0) return c === 0 ? "—" : "+∞";
    const pctChange = ((c - p) / Math.abs(p)) * 100;
    const sign = pctChange >= 0 ? "+" : "";
    return `${sign}${pctChange.toFixed(1)}%`;
  }

  return (
    <>
      <div className="flex items-center justify-between mb-5 -mt-2 gap-3 flex-wrap">
        <p className="text-xs text-muted-foreground">{filterDesc}</p>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={comparePrev}
              onChange={(e) => setComparePrev(e.target.checked)}
              className="rounded border-border"
            />
            Compare to previous period
          </label>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!data}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium hover:bg-secondary border border-border disabled:opacity-50"
          >
            <Download size={12} /> CSV
          </button>
        </div>
      </div>

      {q.isLoading && (
        <div className="text-sm text-muted-foreground py-12 text-center">
          <Loader2 size={16} className="inline animate-spin mr-2" />
          Loading…
        </div>
      )}

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              {prev && (
                <thead>
                  <tr className="bg-secondary/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left font-medium px-5 py-2"></th>
                    <th className="text-right font-medium px-5 py-2">
                      Current
                    </th>
                    <th className="text-right font-medium px-5 py-2">
                      Previous
                    </th>
                    <th className="text-right font-medium px-5 py-2 w-20">
                      Δ
                    </th>
                  </tr>
                </thead>
              )}
              <tbody>
                <SectionHeader
                  label="Revenue"
                  amount={data.revenue}
                  prevAmount={prev?.revenue}
                  delta={delta(data.revenue, prev?.revenue)}
                />
                <PnlLine
                  label="Invoiced revenue"
                  amount={data.revenue}
                  prevAmount={prev?.revenue}
                  showPrev={!!prev}
                  muted
                />
                <SectionHeader
                  label="Cost of goods sold"
                  amount={data.cogsTotal}
                  prevAmount={prev?.cogsTotal}
                  delta={delta(data.cogsTotal, prev?.cogsTotal)}
                  negative
                />
                {data.cogs.length === 0 && (
                  <tr>
                    <td
                      colSpan={prev ? 4 : 2}
                      className="px-5 py-2.5 text-xs text-muted-foreground italic"
                    >
                      No COGS-tagged expenses in this range.
                    </td>
                  </tr>
                )}
                {data.cogs.map((c) => {
                  const prevC = prev?.cogs.find((x) => x.name === c.name);
                  return (
                    <PnlLine
                      key={c.name}
                      label={c.name}
                      amount={c.amount}
                      prevAmount={prevC?.amount}
                      showPrev={!!prev}
                      muted
                    />
                  );
                })}
                <SectionHeader
                  label="Gross profit"
                  amount={data.grossProfit}
                  prevAmount={prev?.grossProfit}
                  delta={delta(data.grossProfit, prev?.grossProfit)}
                  emphasis
                />
                <SectionHeader
                  label="Operating expenses"
                  amount={data.opexTotal}
                  prevAmount={prev?.opexTotal}
                  delta={delta(data.opexTotal, prev?.opexTotal)}
                  negative
                />
                {data.opex.length === 0 && (
                  <tr>
                    <td
                      colSpan={prev ? 4 : 2}
                      className="px-5 py-2.5 text-xs text-muted-foreground italic"
                    >
                      No operating expenses in this range.
                    </td>
                  </tr>
                )}
                {data.opex.map((o) => {
                  const prevO = prev?.opex.find((x) => x.name === o.name);
                  return (
                    <PnlLine
                      key={o.name}
                      label={o.name}
                      amount={o.amount}
                      prevAmount={prevO?.amount}
                      showPrev={!!prev}
                      muted
                    />
                  );
                })}
                <SectionHeader
                  label="Net income"
                  amount={data.netIncome}
                  prevAmount={prev?.netIncome}
                  delta={delta(data.netIncome, prev?.netIncome)}
                  emphasis
                />
              </tbody>
            </table>
          </div>

          <div className="space-y-3">
            <KpiCard
              label="Revenue"
              value={formatMoney(data.revenue)}
              sub={prev ? `vs ${formatMoney(prev.revenue)}` : undefined}
              icon={DollarSign}
              tone="success"
            />
            <KpiCard
              label="Gross margin"
              value={pct(data.grossMargin)}
              sub={prev ? `vs ${pct(prev.grossMargin)}` : undefined}
              icon={Activity}
              tone="primary"
            />
            <KpiCard
              label="Net margin"
              value={pct(data.netMargin)}
              sub={prev ? `vs ${pct(prev.netMargin)}` : undefined}
              icon={Activity}
              tone={Number(data.netIncome) >= 0 ? "success" : "warning"}
            />
            <KpiCard
              label="Invoices"
              value={String(data.invoiceCount)}
              sub={prev ? `vs ${prev.invoiceCount}` : undefined}
              icon={BarChart3}
              tone="neutral"
            />
          </div>
        </div>
      )}
    </>
  );
}

function SectionHeader({
  label,
  amount,
  prevAmount,
  delta,
  negative,
  emphasis,
}: {
  label: string;
  amount: string;
  prevAmount?: string;
  delta?: string | null;
  negative?: boolean;
  emphasis?: boolean;
}) {
  const fmt = (v: string) =>
    negative ? `(${formatMoney(v)})` : formatMoney(v);
  return (
    <tr
      className={`border-t border-border ${
        emphasis ? "bg-primary/10" : "bg-secondary/40"
      }`}
    >
      <td className="px-5 py-2.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </td>
      <td
        className={`px-5 py-2.5 text-right tabular-nums font-semibold ${
          emphasis ? "text-base" : ""
        }`}
      >
        {fmt(amount)}
      </td>
      {prevAmount !== undefined && (
        <>
          <td className="px-5 py-2.5 text-right tabular-nums font-semibold text-muted-foreground">
            {fmt(prevAmount)}
          </td>
          <td className="px-5 py-2.5 text-right tabular-nums text-xs text-muted-foreground">
            {delta ?? "—"}
          </td>
        </>
      )}
    </tr>
  );
}

function PnlLine({
  label,
  amount,
  prevAmount,
  showPrev,
  muted,
}: {
  label: string;
  amount: string;
  prevAmount?: string;
  showPrev?: boolean;
  muted?: boolean;
}) {
  return (
    <tr className="border-t border-border/60">
      <td
        className={`pl-10 pr-5 py-2 text-sm ${
          muted ? "text-muted-foreground" : ""
        }`}
      >
        {label}
      </td>
      <td className="px-5 py-2 text-right tabular-nums text-sm">
        {formatMoney(amount)}
      </td>
      {showPrev && (
        <>
          <td className="px-5 py-2 text-right tabular-nums text-sm text-muted-foreground">
            {prevAmount !== undefined ? formatMoney(prevAmount) : "—"}
          </td>
          <td />
        </>
      )}
    </tr>
  );
}

// ──────────────────────── Balance sheet tab ────────────────────────
interface BalanceSheetResponse {
  asOf: string;
  assets: {
    cashAccounts: Array<{ accountId: string; name: string; balance: string }>;
    cashTotal: string;
    accountsReceivable: string;
    total: string;
  };
  liabilities: {
    items: Array<{ name: string; amount: string }>;
    customerCredits?: string;
    total: string;
  };
  equity: {
    retainedEarnings: string;
    ownerContributions?: string;
    total: string;
  };
}

function BalanceSheetTab({
  organizationId,
  range,
}: {
  organizationId: string;
  range: DateRange;
}) {
  // Balance sheet is a single point in time = end of the selected
  // range. range.to is an ISO UTC instant for local end-of-day, so
  // slicing the UTC string would shift the date for users west of UTC.
  // Format using local calendar parts instead.
  const toLocal = new Date(range.to);
  const asOfDate = `${toLocal.getFullYear()}-${String(toLocal.getMonth() + 1).padStart(2, "0")}-${String(toLocal.getDate()).padStart(2, "0")}`;
  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const params = new URLSearchParams({ organizationId, asOfDate, timeZone });
  const q = useQuery({
    queryKey: [
      "reports",
      "balance-sheet",
      organizationId,
      asOfDate,
      timeZone,
    ],
    queryFn: () =>
      apiFetch<BalanceSheetResponse>(
        `/finance/reports/balance-sheet?${params}`,
      ),
  });
  const data = q.data;
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filterDesc = `As of ${asOfDate}`;

  function exportCsv() {
    if (!data) return;
    const rows: Array<Record<string, string | number>> = [];
    rows.push({ Section: "Assets", Line: "Cash & equivalents", Amount: data.assets.cashTotal });
    for (const c of data.assets.cashAccounts) {
      rows.push({ Section: "Assets", Line: `  ${c.name}`, Amount: c.balance });
    }
    rows.push({ Section: "Assets", Line: "Accounts receivable", Amount: data.assets.accountsReceivable });
    rows.push({ Section: "Assets", Line: "Total assets", Amount: data.assets.total });
    for (const item of data.liabilities.items) {
      rows.push({ Section: "Liabilities", Line: `  ${item.name}`, Amount: item.amount });
    }
    rows.push({ Section: "Liabilities", Line: "Total liabilities", Amount: data.liabilities.total });
    rows.push({ Section: "Equity", Line: "Retained earnings", Amount: data.equity.retainedEarnings });
    if (data.equity.ownerContributions !== undefined) {
      rows.push({ Section: "Equity", Line: "Owner contributions", Amount: data.equity.ownerContributions });
    }
    rows.push({ Section: "Equity", Line: "Total equity", Amount: data.equity.total });
    for (const r of rows) r.Filters = filterDesc;
    downloadCsv(`balance-sheet-${dateStamp}.csv`, rows);
  }

  return (
    <>
      <div className="flex items-center justify-between mb-5 -mt-2">
        <p className="text-xs text-muted-foreground">{filterDesc}</p>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!data}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium hover:bg-secondary border border-border disabled:opacity-50"
        >
          <Download size={12} /> CSV
        </button>
      </div>

      {q.isLoading && (
        <div className="text-sm text-muted-foreground py-12 text-center">
          <Loader2 size={16} className="inline animate-spin mr-2" />
          Loading…
        </div>
      )}

      {data && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <section className="bg-card border border-border rounded-xl overflow-hidden">
            <header className="px-5 py-3 border-b border-border bg-secondary/40 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Assets
            </header>
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-t border-border bg-secondary/20">
                  <td className="px-5 py-2 font-medium">
                    Cash & equivalents
                  </td>
                  <td className="px-5 py-2 text-right tabular-nums font-medium">
                    {formatMoney(data.assets.cashTotal)}
                  </td>
                </tr>
                {data.assets.cashAccounts.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-10 py-2 text-xs text-muted-foreground italic">
                      No bank accounts.
                    </td>
                  </tr>
                )}
                {data.assets.cashAccounts.map((c) => (
                  <tr key={c.accountId} className="border-t border-border/60">
                    <td className="pl-10 pr-5 py-2 text-muted-foreground">
                      {c.name}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums">
                      {formatMoney(c.balance)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-border">
                  <td className="px-5 py-2 font-medium">
                    Accounts receivable
                  </td>
                  <td className="px-5 py-2 text-right tabular-nums font-medium">
                    {formatMoney(data.assets.accountsReceivable)}
                  </td>
                </tr>
                <tr className="border-t border-border bg-primary/10">
                  <td className="px-5 py-3 font-semibold">Total assets</td>
                  <td className="px-5 py-3 text-right tabular-nums font-semibold text-base">
                    {formatMoney(data.assets.total)}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="bg-card border border-border rounded-xl overflow-hidden">
            <header className="px-5 py-3 border-b border-border bg-secondary/40 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Liabilities & equity
            </header>
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-t border-border bg-secondary/20">
                  <td className="px-5 py-2 font-medium">Liabilities</td>
                  <td className="px-5 py-2 text-right tabular-nums font-medium">
                    {formatMoney(data.liabilities.total)}
                  </td>
                </tr>
                {data.liabilities.items.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-10 py-2 text-xs text-muted-foreground italic">
                      No outstanding liabilities tracked. Loans and AP aren't yet modelled.
                    </td>
                  </tr>
                )}
                {data.liabilities.items.map((item) => (
                  <tr key={item.name} className="border-t border-border/60">
                    <td className="pl-10 pr-5 py-2 text-muted-foreground">
                      {item.name}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums">
                      {formatMoney(item.amount)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-border bg-secondary/20">
                  <td className="px-5 py-2 font-medium">Equity</td>
                  <td className="px-5 py-2 text-right tabular-nums font-medium">
                    {formatMoney(data.equity.total)}
                  </td>
                </tr>
                <tr className="border-t border-border/60">
                  <td className="pl-10 pr-5 py-2 text-muted-foreground">
                    Retained earnings
                  </td>
                  <td className="px-5 py-2 text-right tabular-nums">
                    {formatMoney(data.equity.retainedEarnings)}
                  </td>
                </tr>
                {data.equity.ownerContributions !== undefined && (
                  <tr className="border-t border-border/60">
                    <td className="pl-10 pr-5 py-2 text-muted-foreground">
                      Owner contributions
                      <span className="ml-1 text-[10px] text-muted-foreground/70">
                        (balancing)
                      </span>
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums">
                      {formatMoney(data.equity.ownerContributions)}
                    </td>
                  </tr>
                )}
                <tr className="border-t border-border bg-primary/10">
                  <td className="px-5 py-3 font-semibold">
                    Total liabilities & equity
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums font-semibold text-base">
                    {formatMoney(
                      Number(data.liabilities.total) + Number(data.equity.total),
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      )}
    </>
  );
}

// ─────────────────────────── Shared bits ───────────────────────────
function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
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
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            {label}
          </div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">
            {value}
          </div>
          {sub && (
            <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
              {sub}
            </div>
          )}
        </div>
        <div
          className={`h-10 w-10 rounded-lg flex items-center justify-center ${cls}`}
        >
          <Icon size={18} />
        </div>
      </div>
    </div>
  );
}
