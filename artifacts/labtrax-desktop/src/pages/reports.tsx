import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  ClipboardList,
  Clock,
  Cog,
  DollarSign,
  Download,
  FileText,
  Landmark,
  Loader2,
  Minus,
  Percent,
  Scale,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { Invoice, LabCase, MeResponse, Organization } from "@/lib/types";
import { formatMoney, statusLabel } from "@/lib/format";
import { downloadCsv } from "@/lib/export";
import {
  DateRangePicker,
  rangeLabel,
  type DateRange,
} from "@/components/reports/DateRangePicker";
import { SalesInvoicesPanel } from "@/components/reports/SalesInvoicesPanel";
import { StatsTab } from "@/components/reports/StatsTab";
import { useReportFilters, type SalesGrouping } from "@/components/reports/useReportFilters";
import {
  useGetInvoiceDiscountsReport,
  useGetInvoiceSalesSeries,
} from "@workspace/api-client-react";
const BILLING_ROLES = new Set(["owner", "admin", "billing"]);

const TABS = [
  { key: "summary", label: "Summary", icon: ClipboardList },
  { key: "production", label: "Production", icon: Cog },
  { key: "sales", label: "Sales", icon: BarChart3 },
  { key: "forecast", label: "Forecast", icon: TrendingUp, adminOnly: true },
  { key: "pnl", label: "Profit & Loss", icon: Scale },
  { key: "balance-sheet", label: "Balance Sheet", icon: Landmark },
  { key: "stats", label: "Stats", icon: Activity },
] as const;

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
  // Labs where the caller is an admin or owner — matches the server's ADMIN_ROLES gate.
  const adminLabs = useMemo(
    () =>
      memberships
        .filter(
          (m) =>
            m.status === "active" &&
            m.organization?.type === "lab" &&
            (m.role === "admin" || m.role === "owner"),
        )
        .map((m) => m.organization!)
        .filter(Boolean) as Organization[],
    [memberships],
  );

  const {
    tab, setTab, orgId, setOrgId, range, setRange, groupBy, setGroupBy,
    statsRange, setStatsRange, statsGroupBy, setStatsGroupBy,
    forecastOrgId, setForecastOrgId,
    summaryGroupBy, setSummaryGroupBy,
  } = useReportFilters(billingLabs[0]?.id ?? null, adminLabs);

  const isBilling = billingLabs.length > 0;
  const isAdmin = adminLabs.length > 0;

  return (
    <div className="reports-frame @container mx-auto max-w-[1500px] px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[1.7rem] font-bold tracking-tight leading-tight">Reports</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Production, sales, and financial statements for your lab.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {/*
            The Stats tab renders its own filter bar (lab, category, material,
            group-by and its own date range), so the shared header controls
            step aside for it. The forecast is now-based, so neither the lab
            picker nor the date range applies there.
          */}
          {tab !== "forecast" && tab !== "stats" && isBilling && billingLabs.length > 1 && (
            <select
              value={orgId || ""}
              onChange={(e) => setOrgId(e.target.value || null)}
              aria-label="Report lab"
              className="reports-date-control h-9 min-w-0 max-w-full rounded-lg border border-border/70 bg-card px-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {billingLabs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName || o.name}
                </option>
              ))}
            </select>
          )}
          {tab !== "forecast" && tab !== "stats" && (
            <DateRangePicker value={range} onChange={setRange} />
          )}
        </div>
      </div>

      <div className="mb-5 rounded-xl border border-border/70 bg-card p-1.5 shadow-sm">
        <nav aria-label="Report sections" className="flex gap-1 overflow-x-auto">
          {TABS.filter(
            (t) =>
              (isBilling || t.key === "summary") &&
              (!("adminOnly" in t && t.adminOnly) || isAdmin),
          ).map((t) => {
            const active = tab === t.key;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-current={active ? "page" : undefined}
                className={`inline-flex shrink-0 items-center gap-2 rounded-lg border-b-2 px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active
                    ? "border-primary bg-primary/5 text-primary"
                    : "border-transparent text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
                }`}
              >
                <Icon size={15} aria-hidden="true" />
                {t.label}
              </button>
            );
          })}
        </nav>
      </div>

      {!isBilling && (
        <div
          className="bg-card border border-border rounded-xl p-12 text-center"
          data-testid="reports-restricted"
        >
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
          chartGroupBy={summaryGroupBy}
          onGroupChange={setSummaryGroupBy}
        />
      )}
      {tab === "forecast" && isAdmin && (
        <ForecastTab adminLabs={adminLabs} orgId={forecastOrgId ?? ""} onOrgChange={setForecastOrgId} />
      )}

      {tab !== "summary" && tab !== "forecast" && isBilling && orgId && (
        <>
          {tab === "production" && (
            <ProductionTab organizationId={orgId} range={range} />
          )}
          {tab === "sales" && (
            <SalesTab organizationId={orgId} range={range} groupBy={groupBy} onGroupChange={setGroupBy} />
          )}
          {tab === "pnl" && <PnlTab organizationId={orgId} range={range} />}
          {tab === "balance-sheet" && (
            <BalanceSheetTab organizationId={orgId} range={range} />
          )}
          {tab === "stats" && (
            <StatsTab
              billingLabs={billingLabs}
              memberships={memberships}
              orgId={orgId}
              onOrgChange={setOrgId}
              range={statsRange}
              onRangeChange={setStatsRange}
              groupBy={statsGroupBy}
              onGroupChange={setStatsGroupBy}
              onViewForecast={isAdmin ? () => setTab("forecast") : undefined}
            />
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────── Forecast tab ───────────────────────────
//
// Admin+owner sales pace projection. The server (GET /stats/sales-forecast)
// does ALL the math — this component only picks the lab + timezone and
// renders the numbers it returns.
interface ForecastPreviousPeriod {
  periodStart: string;
  comparableSales: string;
  comparableBusinessDays: number;
  averagePerBusinessDay: string;
}
interface ForecastPeriod {
  periodStart: string;
  periodToDateSales: string;
  elapsedBusinessDays: number;
  totalBusinessDays: number;
  averagePerBusinessDay: string;
  forecast: string;
  insufficientData: boolean;
  paceChangePct: number | null;
  previousPeriod: ForecastPreviousPeriod | null;
}
interface ForecastResult {
  organizationId: string;
  timeZone: string;
  asOf: string;
  week: ForecastPeriod;
  month: ForecastPeriod;
  year: ForecastPeriod;
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function ForecastTab({ adminLabs, orgId, onOrgChange }: {
  adminLabs: Organization[];
  orgId: string;
  onOrgChange: (orgId: string) => void;
}) {
  const activeOrgId =
    orgId && adminLabs.some((o) => o.id === orgId)
      ? orgId
      : (adminLabs[0]?.id ?? "");
  const timeZone = useMemo(() => localTimeZone(), []);

  const q = useQuery({
    queryKey: ["reports", "sales-forecast", activeOrgId, timeZone],
    enabled: !!activeOrgId,
    queryFn: () => {
      const params = new URLSearchParams({
        organizationId: activeOrgId,
        timeZone,
      });
      return apiFetch<ForecastResult>(`/stats/sales-forecast?${params}`);
    },
  });
  const data = q.data;

  return (
    <>
      {adminLabs.length > 1 && (
        <div className="mb-5">
          <select
            value={activeOrgId}
            onChange={(e) => onOrgChange(e.target.value)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            {adminLabs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.displayName || o.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <p className="text-xs text-muted-foreground mb-5">
        Based on saved invoice totals through the last completed business day.
        Today's invoices enter the forecast after that day closes. The projection
        uses Monday–Friday business days and your lab's closed-day calendar.
      </p>

      {q.isLoading && (
        <div className="text-sm text-muted-foreground py-16 text-center">
          <Loader2 size={16} className="inline animate-spin mr-2" />
          Loading forecast…
        </div>
      )}

      {q.isError && (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <div className="text-base font-medium mb-1">
            Couldn’t load the forecast
          </div>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            The sales forecaster is available to lab admins and owners only.
            Refresh to try again.
          </p>
        </div>
      )}

      {data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <ForecastCard title="This week" period={data.week} />
          <ForecastCard title="This month" period={data.month} />
          <ForecastCard title="This year" period={data.year} />
        </div>
      )}
    </>
  );
}

function ForecastCard({
  title,
  period,
}: {
  title: string;
  period: ForecastPeriod;
}) {
  // "This week" → "last week", etc. — labels the comparable prior period.
  const priorLabel = title.toLowerCase().replace(/^this\b/, "last");
  return (
    <section className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <TrendingUp size={16} className="text-muted-foreground" />
      </div>
      <div className="text-3xl font-semibold tracking-tight tabular-nums">
        {period.insufficientData ? "—" : formatMoney(period.forecast)}
      </div>
      <div className="text-xs text-muted-foreground mt-1 mb-3">
        Projected {title.toLowerCase()} sales
      </div>

      {!period.insufficientData && (
        <div className="mb-4">
          <PaceTrend pct={period.paceChangePct} priorLabel={priorLabel} />
        </div>
      )}

      {period.insufficientData ? (
        <div className="text-sm text-muted-foreground">
          Not enough data yet to project this period.
        </div>
      ) : (
        <dl className="space-y-2 text-sm">
          <ForecastRow
            label="Sales so far"
            value={formatMoney(period.periodToDateSales)}
          />
          <ForecastRow
            label="Avg / business day"
            value={formatMoney(period.averagePerBusinessDay)}
          />
          <ForecastRow
            label="Business days"
            value={`${period.elapsedBusinessDays} of ${period.totalBusinessDays}`}
          />
        </dl>
      )}
    </section>
  );
}

function ForecastRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums font-medium">{value}</dd>
    </div>
  );
}

// Pace-trend chip: the current per-business-day pace vs the prior comparable
// period (server-computed). Null = no comparable prior sales to trend against.
function PaceTrend({
  pct,
  priorLabel,
}: {
  pct: number | null;
  priorLabel: string;
}) {
  if (pct === null) {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Minus size={13} />
        <span>No comparison for {priorLabel}</span>
      </div>
    );
  }
  const up = pct > 0;
  const flat = pct === 0;
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  const color = flat
    ? "text-muted-foreground"
    : up
      ? "text-emerald-600 dark:text-emerald-500"
      : "text-red-600 dark:text-red-500";
  const word = flat ? "flat" : up ? "up" : "down";
  const magnitude = `${Math.abs(pct).toFixed(1)}%`;
  return (
    <div
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${color}`}
    >
      <Icon size={13} />
      <span>
        Pace {word}
        {flat ? "" : ` ${magnitude}`} vs {priorLabel}
      </span>
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

interface SummaryResult {
  totalCases: number;
  avgTurnaroundDays: number | null;
  eligibleTurnaroundCaseCount: number | null;
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
  chartGroupBy,
  onGroupChange,
}: {
  billingLabs: Organization[];
  memberships: MeResponse["memberships"];
  range: DateRange;
  chartGroupBy: SalesGrouping;
  onGroupChange: (groupBy: SalesGrouping) => void;
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

  const summaryQuery = useQuery({
    queryKey: [
      "reports",
      "summary",
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
            return await apiFetch<SummaryResult>(`/stats/summary?${params}`);
          } catch {
            return null;
          }
        }),
      );
      return results.filter(Boolean) as SummaryResult[];
    },
  });

  const fromMs = new Date(range.from).getTime();
  const toMs = new Date(range.to).getTime();
  const filteredCases = (casesQuery.data ?? []).filter((c) => {
    const t = c.createdAt ? new Date(c.createdAt).getTime() : 0;
    return t >= fromMs && t <= toMs;
  });
  const filteredInvoices = (invoicesQuery.data ?? []).filter((i) => {
    // Exclude voided invoices so the revenue chart below always agrees with
    // the "Total sales" KPI card, which is computed server-side by
    // /invoices/reports/sales using the same exclusion.
    if (i.status === "void") return false;
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

  const isAdminOrOwner = useMemo(
    () =>
      memberships.some(
        (m) =>
          m.status === "active" &&
          m.organization?.type === "lab" &&
          (m.role === "admin" || m.role === "owner"),
      ),
    [memberships],
  );

  const rangeSpanDays = useMemo(() => {
    const from = new Date(range.from).getTime();
    const to = new Date(range.to).getTime();
    if (Number.isNaN(from) || Number.isNaN(to)) return 9999;
    return Math.abs(to - from) / 86_400_000;
  }, [range.from, range.to]);

  const showGroupByToggle = isAdminOrOwner && rangeSpanDays <= 62;


  const activeGroupBy: "day" | "week" | "month" = showGroupByToggle ? chartGroupBy : "month";

  const monthly = useMemo(() => {
    const map = new Map<string, { label: string; revenue: number }>();
    for (const i of filteredInvoices) {
      const ts = i.issuedAt || i.createdAt;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yyyy = d.getFullYear();
      const label = `${mm}/${yyyy}`;
      const cur = map.get(key) ?? { label, revenue: 0 };
      cur.revenue += Number(i.total ?? 0);
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([_, v]) => v);
  }, [filteredInvoices]);

  const daily = useMemo(() => {
    const map = new Map<string, { label: string; revenue: number }>();
    for (const i of filteredInvoices) {
      const ts = i.issuedAt || i.createdAt;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const label = `${mm}/${dd}`;
      const cur = map.get(key) ?? { label, revenue: 0 };
      cur.revenue += Number(i.total ?? 0);
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([_, v]) => v);
  }, [filteredInvoices]);

  const weekly = useMemo(() => {
    const map = new Map<string, { label: string; revenue: number; weekStart: Date }>();
    for (const i of filteredInvoices) {
      const ts = i.issuedAt || i.createdAt;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) continue;
      const dow = d.getDay();
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - dow);
      weekStart.setHours(0, 0, 0, 0);
      const key = weekStart.toISOString().slice(0, 10);
      const wsMm = String(weekStart.getMonth() + 1).padStart(2, "0");
      const wsDd = String(weekStart.getDate()).padStart(2, "0");
      const label = `${wsMm}/${wsDd}`;
      const cur = map.get(key) ?? { label, revenue: 0, weekStart };
      cur.revenue += Number(i.total ?? 0);
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([_, v]) => v);
  }, [filteredInvoices]);

  const chartBars = activeGroupBy === "day" ? daily : activeGroupBy === "week" ? weekly : monthly;

  const avgTurnaround = useMemo((): { days: number; count: number } | null => {
    const rows = (summaryQuery.data ?? []).filter(
      (r): r is SummaryResult & { avgTurnaroundDays: number; eligibleTurnaroundCaseCount: number } =>
        r.avgTurnaroundDays != null && r.eligibleTurnaroundCaseCount != null && r.eligibleTurnaroundCaseCount > 0,
    );
    if (rows.length === 0) return null;
    const totalEligible = rows.reduce((sum, r) => sum + r.eligibleTurnaroundCaseCount, 0);
    if (totalEligible === 0) return null;
    const weighted = rows.reduce(
      (sum, r) => sum + r.avgTurnaroundDays * r.eligibleTurnaroundCaseCount,
      0,
    );
    return { days: weighted / totalEligible, count: totalEligible };
  }, [summaryQuery.data]);

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
          value={avgTurnaround != null ? `${avgTurnaround.days.toFixed(1)} days` : "—"}
          sub={avgTurnaround != null ? `${avgTurnaround.count} eligible case${avgTurnaround.count === 1 ? "" : "s"}` : undefined}
          icon={Clock}
          tone="neutral"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-6">
        <section className="lg:col-span-2 bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold">
                {activeGroupBy === "day"
                  ? "Daily revenue"
                  : activeGroupBy === "week"
                    ? "Weekly revenue"
                    : "Monthly revenue"}
              </h2>
              {showGroupByToggle && (
                <div className="inline-flex rounded-md border border-border text-xs overflow-hidden">
                  {(["day", "week", "month"] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => onGroupChange(g)}
                      className={`px-2.5 py-1 font-medium transition-colors ${
                        activeGroupBy === g
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-secondary"
                      }`}
                    >
                      {g === "day" ? "Day" : g === "week" ? "Week" : "Month"}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={exportMonthlyRevenueCsv}
              disabled={chartBars.length === 0}
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
          {!isLoading && chartBars.length === 0 && (
            <div className="text-sm text-muted-foreground py-10 text-center">
              No invoices in this range.
            </div>
          )}
          {chartBars.length > 0 && (
            <ResponsiveContainer width="100%" height={192}>
              <BarChart
                data={chartBars}
                margin={{ top: 4, right: 8, left: 8, bottom: 0 }}
              >
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tickFormatter={(v: number) => {
                    if (v >= 1_000_000)
                      return `$${(v / 1_000_000).toFixed(1)}M`;
                    if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
                    return `$${v.toFixed(0)}`;
                  }}
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                />
                <Tooltip
                  formatter={(value: number) => [formatMoney(value), "Revenue"]}
                  cursor={{ fill: "hsl(var(--muted))" }}
                />
                <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
                  {chartBars.map((entry) => (
                    <Cell
                      key={entry.label}
                      fill="hsl(var(--primary))"
                      fillOpacity={0.75}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
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
  const billed = useQuery({
    queryKey: ["reports", "production-billed-total", organizationId, range.from, range.to],
    queryFn: () => apiFetch<{ totalSales: string }>(
      `/invoices/reports/sales?${params}`,
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
    if (!data && !billed.data) return;
    const rows: Array<Record<string, string | number>> = (data?.items ?? []).map(
      (i) => ({
        "Restoration type": i.restorationType,
        Count: i.count,
        Units: i.units,
        Cases: i.cases,
        "Estimated production value": i.revenue,
        Filters: filterDesc,
      }),
    );
    if (data?.crownsRollup) {
      rows.push({
        "Restoration type": "Crowns (rollup)",
        Count: data.crownsRollup.count,
        Units: data.crownsRollup.units,
        Cases: data.crownsRollup.cases,
        "Estimated production value": data.crownsRollup.revenue,
        Filters: filterDesc,
      });
    }
    if (data) rows.push({
      "Restoration type": "PRODUCTION TOTAL",
      Count: data.totals.count,
      Units: data.totals.units,
      Cases: data.totals.cases,
      "Estimated production value": data.totals.revenue,
      Filters: filterDesc,
    });
    if (billed.data) rows.push({
      "Restoration type": "BILLED INVOICES (issued in range; not allocated by type)",
      "Billed total": billed.data.totalSales,
      Filters: filterDesc,
    });
    downloadCsv(`production-by-type-${dateStamp}.csv`, rows);
  }

  return (
    <>
      <p className="text-xs text-muted-foreground -mt-2 mb-5">{filterDesc}</p>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
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
          label="Estimated production value"
          value={data ? formatMoney(data.totals.revenue) : "—"}
          icon={DollarSign}
          tone="success"
        />
        <KpiCard
          label="Billed invoices"
          value={billed.data ? formatMoney(billed.data.totalSales) : billed.isError ? "Unavailable" : "—"}
          icon={DollarSign}
          tone="primary"
        />
      </div>

      <section className="bg-card border border-border rounded-xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">By restoration type</h2>
            <p className="text-xs text-muted-foreground">
              Estimated values use case received dates and restoration prices. Billed invoices use issue dates and include saved rush, manual, and nested charges; those fees are not assigned to a restoration type.
            </p>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!data && !billed.data}
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
              <th className="text-right font-medium px-5 py-2.5">Estimated value</th>
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
export function formatSalesPeriod(
  iso: string,
  groupBy: "day" | "week" | "month",
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(iso);
  if (!match) return iso;

  const [, yyyy, mm, dd] = match;
  if (groupBy === "month") return `${mm}/${yyyy}`;
  return `${mm}/${dd}/${yyyy}`;
}

function SalesTab({
  organizationId,
  range,
  groupBy,
  onGroupChange,
}: {
  organizationId: string;
  range: DateRange;
  groupBy: SalesGrouping;
  onGroupChange: (groupBy: SalesGrouping) => void;
}) {

  // Send the user's local IANA time zone so day/week/month buckets line
  // up with the lab's calendar instead of UTC.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const params = {
    organizationId,
    dateFrom: range.from,
    dateTo: range.to,
    groupBy,
    timeZone,
  } as const;
  const q = useGetInvoiceSalesSeries(params, {
    query: {
      queryKey: ["reports", "sales-series", organizationId, range.from, range.to, groupBy, timeZone],
    },
  });
  const discountParams = {
    ...params,
  };
  const discountsQuery = useGetInvoiceDiscountsReport(discountParams, {
    query: {
      queryKey: ["reports", "discounts", organizationId, range.from, range.to, groupBy, timeZone],
    },
  });
  const data = q.data?.data;
  const discounts = discountsQuery.data?.data;
  const filterDesc = `Range: ${rangeLabel(range)} · grouped by ${groupBy}`;
  const dateStamp = new Date().toISOString().slice(0, 10);

  function fmtPeriod(iso: string): string {
    return formatSalesPeriod(iso, groupBy);
  }

  function exportCsv() {
    if (!data) return;
    const rows = data.series.map((p) => ({
      Period: fmtPeriod(p.periodStart),
      "Billed total": p.billedTotal,
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
      "Billed total": data.totals.billedTotal,
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

  function exportDiscountsCsv() {
    if (!discounts) return;
    const rows: Array<Record<string, string | number>> = [
      ...discounts.series.map((p) => ({
        Section: "Period",
        Period: fmtPeriod(p.periodStart),
        Item: "",
        Practice: "",
        Doctor: "",
        Amount: p.amount,
        Count: p.count,
        Filters: filterDesc,
      })),
      ...discounts.items.map((item) => ({
        Section: "Item",
        Period: "",
        Item: item.item,
        Practice: "",
        Doctor: "",
        Amount: item.amount,
        Count: item.count,
        Filters: filterDesc,
      })),
      ...discounts.practices.map((practice) => ({
        Section: "Practice",
        Period: "",
        Item: "",
        Practice: practice.practiceName ?? "Unassigned practice",
        Doctor: practice.doctorName ?? "",
        Amount: practice.amount,
        Count: practice.count,
        Filters: filterDesc,
      })),
      {
        Section: "Total",
        Period: "",
        Item: "",
        Practice: "",
        Doctor: "",
        Amount: discounts.totals.amount,
        Count: discounts.totals.count,
        Filters: filterDesc,
      },
    ];
    downloadCsv(`discounts-${groupBy}-${dateStamp}.csv`, rows);
  }

  return (
    <>
      <div className="mb-3 -mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-xs text-muted-foreground">{filterDesc}</p>
        <div
          className="inline-flex shrink-0 overflow-hidden rounded-lg border border-border bg-card text-xs shadow-sm"
          role="group"
          aria-label="Sales grouping"
        >
          {(["day", "week", "month"] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => onGroupChange(g)}
              aria-pressed={groupBy === g}
              className={`px-3 py-2 capitalize transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                groupBy === g
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      <div className="sales-metric-grid mb-6 grid grid-cols-1 gap-3">
        <SalesMetricCard
          label="Billed total"
          value={data ? formatMoney(data.totals.billedTotal) : "—"}
          series={data?.series.map((point) => point.billedTotal) ?? []}
          metric="billedTotal"
          icon={DollarSign}
          tone="green"
        />
        <SalesMetricCard
          label="Net sales"
          value={data ? formatMoney(data.totals.net) : "—"}
          series={data?.series.map((point) => point.net) ?? []}
          metric="net"
          icon={DollarSign}
          tone="blue"
        />
        <SalesMetricCard
          label="Gross"
          value={data ? formatMoney(data.totals.gross) : "—"}
          series={data?.series.map((point) => point.gross) ?? []}
          metric="gross"
          icon={TrendingUp}
          tone="purple"
        />
        <SalesMetricCard
          label="Discounts"
          value={data ? formatMoney(data.totals.discounts) : "—"}
          series={data?.series.map((point) => point.discounts) ?? []}
          metric="discounts"
          icon={Percent}
          tone="amber"
        />
        <SalesMetricCard
          label="Avg invoice"
          value={data ? formatMoney(data.totals.avg) : "—"}
          series={data?.series.map((point) => point.avg) ?? []}
          metric="avg"
          icon={FileText}
          tone="slate"
          className="sales-metric-average"
        />
      </div>

      <SalesInvoicesPanel
        organizationId={organizationId}
        dateFrom={range.from}
        dateTo={range.to}
        datePreset={range.preset}
      />

      <section className="bg-card border border-border rounded-xl overflow-hidden mb-6">
        <header className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">Discounts given</h2>
          <button
            type="button"
            onClick={exportDiscountsCsv}
            disabled={!discounts}
            aria-label="Export discounts CSV"
            className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium hover:bg-secondary disabled:opacity-50"
          >
            <Download size={12} /> CSV
          </button>
        </header>
        <div className="p-5">
          {discountsQuery.isError ? (
            <div className="mb-4 text-sm text-destructive" role="alert">
              Couldn't load discounts.{" "}
              <button
                type="button"
                onClick={() => discountsQuery.refetch()}
                className="underline"
              >
                Retry
              </button>
            </div>
          ) : discountsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading discounts…</p>
          ) : discounts ? (
            <>
              <div className="mb-5">
                <p className="text-xs text-muted-foreground">Total discounts</p>
                <p className="text-2xl font-semibold tabular-nums">
                  {formatMoney(discounts.totals.amount)}
                </p>
              </div>
              {discounts.totals.count === 0 ? (
                <p className="mb-5 text-sm text-muted-foreground">
                  No discounts were given in this range.
                </p>
              ) : null}
              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    By period
                  </h3>
                  {discounts.series.length ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          <th className="py-2 text-left font-medium">Period</th>
                          <th className="py-2 text-right font-medium">Amount</th>
                          <th className="py-2 text-right font-medium">Invoices</th>
                        </tr>
                      </thead>
                      <tbody>
                        {discounts.series.map((period) => (
                          <tr key={period.periodStart} className="border-t border-border">
                            <td className="py-2">{fmtPeriod(period.periodStart)}</td>
                            <td className="py-2 text-right tabular-nums">
                              {formatMoney(period.amount)}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {period.count}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-sm text-muted-foreground">No period totals.</p>
                  )}
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    By discount item
                  </h3>
                  {discounts.items.length ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          <th className="py-2 text-left font-medium">Item</th>
                          <th className="py-2 text-right font-medium">Amount</th>
                          <th className="py-2 text-right font-medium">Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {discounts.items.map((item) => (
                          <tr key={item.item} className="border-t border-border">
                            <td className="py-2">{item.item}</td>
                            <td className="py-2 text-right tabular-nums">
                              {formatMoney(item.amount)}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {item.count}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-sm text-muted-foreground">No discount items.</p>
                  )}
                </div>
                <div className="lg:col-span-2">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    By practice and doctor
                  </h3>
                  {discounts.practices.length ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          <th className="py-2 text-left font-medium">Practice</th>
                          <th className="py-2 text-left font-medium">Doctor</th>
                          <th className="py-2 text-right font-medium">Amount</th>
                          <th className="py-2 text-right font-medium">Invoices</th>
                        </tr>
                      </thead>
                      <tbody>
                        {discounts.practices.map((practice) => (
                          <tr
                            key={`${practice.practiceId ?? "none"}-${practice.doctorName ?? "none"}`}
                            className="border-t border-border"
                          >
                            <td className="py-2">
                              {practice.practiceName ?? "Unassigned practice"}
                            </td>
                            <td className="py-2">
                              {practice.doctorName ?? "—"}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {formatMoney(practice.amount)}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {practice.count}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-sm text-muted-foreground">No practice totals.</p>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </section>

      {q.isError && (
        <div className="mb-4 text-sm text-destructive" role="alert">
          Couldn't load the sales metrics and breakdown.{" "}
          <button type="button" onClick={() => q.refetch()} className="underline">Retry</button>
        </div>
      )}

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
              <th className="text-right font-semibold py-2.5">Billed total</th>
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
                <td className="py-2.5 text-right tabular-nums font-semibold">
                  {formatMoney(p.billedTotal)}
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
                  {formatMoney(data.totals.billedTotal)}
                </td>
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
  basis?: string;
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
  // Revenue is recognized when an invoice is issued and expense when a bill is
  // entered, so say which basis the reader is looking at.
  const filterDesc = `Range: ${rangeLabel(range)}${
    comparePrev ? " · vs previous period" : ""
  }${data?.basis ? ` · ${data.basis} basis` : ""}`;
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
  basis?: string;
  assets: {
    cashAccounts: Array<{ accountId: string; name: string; balance: string }>;
    cashTotal: string;
    accountsReceivable: string;
    total: string;
  };
  liabilities: {
    items: Array<{ name: string; amount: string }>;
    customerCredits?: string;
    accountsPayable?: string;
    total: string;
  };
  equity: {
    retainedEarnings: string;
    ownerContributions?: string;
    total: string;
  };
  limitations?: Array<{ code: string; message: string }>;
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
  const [asOfY, asOfM, asOfD] = asOfDate.split("-");
  const filterDesc = `As of ${asOfM}/${asOfD}/${asOfY}`;

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
        <p className="text-xs text-muted-foreground">
          {filterDesc}
          {data?.basis ? ` · ${data.basis} basis` : ""}
        </p>
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

      {!!data?.limitations?.length && (
        <div className="mb-5 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs space-y-1">
          <p className="font-medium">What this report can't tell you</p>
          {data.limitations.map((limitation) => (
            <p key={limitation.code} className="text-muted-foreground">
              {limitation.message}
            </p>
          ))}
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
                      No outstanding liabilities. Unpaid vendor bills appear here as
                      accounts payable; loans and fixed assets aren't modelled.
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
type SalesMetricKey = "billedTotal" | "net" | "gross" | "discounts" | "avg";
type SalesMetricTone = "green" | "blue" | "purple" | "amber" | "slate";

export function buildSalesSparklinePoints(
  values: readonly (number | string)[],
): string | null {
  if (values.length < 2) return null;
  const numbers = values.map((value) => Number(value));
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const spread = max - min || 1;
  return numbers
    .map((value, index) => {
      const x = (index / (numbers.length - 1)) * 100;
      const y = 21 - ((value - min) / spread) * 18;
      return `${x},${y}`;
    })
    .join(" ");
}

function SalesMetricCard({
  label,
  value,
  series,
  metric,
  icon: Icon,
  tone,
  className = "",
}: {
  label: string;
  value: string;
  series: readonly (number | string)[];
  metric: SalesMetricKey;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  tone: SalesMetricTone;
  className?: string;
}) {
  const points = buildSalesSparklinePoints(series);
  const toneClasses: Record<SalesMetricTone, { icon: string; line: string }> = {
    green: {
      icon: "bg-emerald-600 text-white",
      line: "text-emerald-600 dark:text-emerald-400",
    },
    blue: {
      icon: "bg-blue-600 text-white",
      line: "text-blue-600 dark:text-blue-400",
    },
    purple: {
      icon: "bg-violet-600 text-white",
      line: "text-violet-600 dark:text-violet-400",
    },
    amber: {
      icon: "bg-amber-500 text-white",
      line: "text-amber-600 dark:text-amber-400",
    },
    slate: {
      icon: "bg-slate-600 text-white",
      line: "text-slate-600 dark:text-slate-300",
    },
  };
  return (
    <div
      className={`relative flex min-h-[112px] min-w-0 gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-sm sm:p-5 ${className}`}
      data-testid={`sales-metric-${metric}`}
    >
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${toneClasses[tone].icon}`}>
        <Icon size={19} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 pb-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
          {label}
        </div>
        <div
          className="mt-1 break-words text-[clamp(1.25rem,2vw,1.7rem)] font-bold leading-tight tabular-nums tracking-tight text-foreground"
          data-testid={`sales-metric-value-${metric}`}
        >
          {value}
        </div>
      </div>
      {points && (
        <svg
          className={`absolute bottom-3 right-4 h-7 w-24 ${toneClasses[tone].line}`}
          viewBox="0 0 100 24"
          preserveAspectRatio="none"
          aria-hidden="true"
          data-testid={`sales-sparkline-${metric}`}
        >
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

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
