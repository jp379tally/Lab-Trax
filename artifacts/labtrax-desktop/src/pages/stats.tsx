import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  CalendarDays,
  Download,
  DollarSign,
  FileSpreadsheet,
  FileText,
  Layers,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import {
  getGetStatsCaseCategoriesQueryKey,
  useGetStatsCaseCategories,
  useGetStatsRevenueSeries,
  useGetStatsSummary,
  useGetStatsWeekdayVolume,
} from "@workspace/api-client-react";
import type { StatsCaseCategory } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import type { MeResponse, Organization } from "@/lib/types";
import { formatMoney } from "@/lib/format";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  DateRangePicker,
  defaultRange,
  type DateRange,
} from "@/components/reports/DateRangePicker";
import {
  downloadCategoryCsv,
  downloadMaterialCsv,
  downloadRevenueCsv,
  downloadStatsPdf,
  type StatsCategoriesData,
  type StatsExportFilters,
  type StatsRevenueData,
  type StatsSummaryData,
  type StatsWeekdayData,
} from "@/lib/stats-export";

const BILLING_ROLES = new Set(["owner", "admin", "billing"]);

const CATEGORY_OPTIONS: Array<{ key: StatsCaseCategory; label: string }> = [
  { key: "implants", label: "Implants" },
  { key: "zirconia", label: "Zirconia" },
  { key: "crown_bridge", label: "Crown & Bridge" },
  { key: "removable", label: "Removable" },
  { key: "other", label: "Other" },
  { key: "uncategorized", label: "Uncategorized / Legacy" },
];

const CATEGORY_COLORS: Record<string, string> = {
  implants: "hsl(262 60% 55%)",
  zirconia: "hsl(199 80% 45%)",
  crown_bridge: "hsl(150 55% 42%)",
  removable: "hsl(32 90% 52%)",
  other: "hsl(220 10% 55%)",
  uncategorized: "hsl(220 10% 75%)",
};

const GROUP_BY_OPTIONS = [
  { key: "day", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
  { key: "year", label: "Yearly" },
] as const;
type GroupBy = (typeof GROUP_BY_OPTIONS)[number]["key"];

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export default function StatsPage() {
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

  const [orgId, setOrgId] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>(() => defaultRange());
  const [groupBy, setGroupBy] = useState<GroupBy>("month");
  const [category, setCategory] = useState<StatsCaseCategory | "">("");
  const [material, setMaterial] = useState<string>("");

  useEffect(() => {
    if (!orgId && billingLabs.length > 0) {
      setOrgId(billingLabs[0]!.id);
    }
  }, [billingLabs, orgId]);

  const isBilling = billingLabs.length > 0;

  const timeZone = useMemo(() => localTimeZone(), []);
  // Unfiltered materials list for the dropdown options — deliberately NOT
  // filtered by category/material, so picking a material never collapses
  // its own option list.
  const materialOptionsParams = {
    organizationId: orgId ?? "",
    dateFrom: range.from,
    dateTo: range.to,
    timeZone,
  };
  const materialOptionsQuery = useGetStatsCaseCategories(
    materialOptionsParams,
    {
      query: {
        queryKey: getGetStatsCaseCategoriesQueryKey(materialOptionsParams),
        enabled: isBilling && !!orgId,
      },
    },
  );
  const materialOptions = useMemo(() => {
    const names = (materialOptionsQuery.data?.data?.materials ?? []).map(
      (m) => m.material,
    );
    if (material && !names.includes(material)) names.push(material);
    return names;
  }, [materialOptionsQuery.data, material]);

  return (
    <div className="px-8 py-7 max-w-[1500px] mx-auto">
      <div className="flex items-start justify-between mb-5 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stats</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Business and production analytics for your lab.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {isBilling && billingLabs.length > 1 && (
            <select
              value={orgId || ""}
              onChange={(e) => setOrgId(e.target.value || null)}
              data-testid="stats-org-select"
              className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
            >
              {billingLabs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName || o.name}
                </option>
              ))}
            </select>
          )}
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as StatsCaseCategory | "")}
            data-testid="stats-category-select"
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            <option value="">All categories</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <select
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            data-testid="stats-material-select"
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            <option value="">All materials</option>
            {materialOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            data-testid="stats-groupby-select"
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            {GROUP_BY_OPTIONS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      </div>

      {!isBilling && !meQuery.isLoading && (
        <div
          className="bg-card border border-border rounded-xl p-12 text-center"
          data-testid="stats-restricted"
        >
          <div className="text-base font-medium mb-1">Stats are restricted</div>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            You need an admin, owner, or billing role on a lab organization to
            see Stats. Ask your lab admin to grant you access.
          </p>
        </div>
      )}

      {isBilling && orgId && (
        <StatsBody
          organizationId={orgId}
          orgName={(() => {
            const org = billingLabs.find((o) => o.id === orgId);
            return org ? org.displayName || org.name : "Lab";
          })()}
          range={range}
          groupBy={groupBy}
          category={category || undefined}
          material={material || undefined}
        />
      )}
    </div>
  );
}

function StatsBody({
  organizationId,
  orgName,
  range,
  groupBy,
  category,
  material,
}: {
  organizationId: string;
  orgName: string;
  range: DateRange;
  groupBy: GroupBy;
  category: StatsCaseCategory | undefined;
  material: string | undefined;
}) {
  const timeZone = useMemo(() => localTimeZone(), []);
  const baseParams = {
    organizationId,
    dateFrom: range.from,
    dateTo: range.to,
    timeZone,
    category,
    material,
  };

  const summaryQuery = useGetStatsSummary(baseParams);
  const categoriesQuery = useGetStatsCaseCategories(baseParams);
  const revenueQuery = useGetStatsRevenueSeries({
    ...baseParams,
    groupBy,
  });
  const weekdayQuery = useGetStatsWeekdayVolume(baseParams);

  const summary = summaryQuery.data?.data;
  const categories = categoriesQuery.data?.data;
  const revenue = revenueQuery.data?.data;
  const weekday = weekdayQuery.data?.data;

  const exportFilters: StatsExportFilters = {
    orgName,
    dateFrom: range.from,
    dateTo: range.to,
    groupByLabel:
      GROUP_BY_OPTIONS.find((g) => g.key === groupBy)?.label ?? groupBy,
    categoryLabel: category
      ? (CATEGORY_OPTIONS.find((c) => c.key === category)?.label ?? category)
      : null,
    material: material ?? null,
  };

  return (
    <div className="space-y-6">
      {/* ── Export toolbar ────────────────────────────────────────── */}
      <div className="flex justify-end -mb-2">
        <ExportMenu
          filters={exportFilters}
          summary={summary ?? null}
          categories={categories ?? null}
          revenue={revenue ?? null}
          weekday={weekday ?? null}
          loading={
            summaryQuery.isLoading ||
            categoriesQuery.isLoading ||
            revenueQuery.isLoading ||
            weekdayQuery.isLoading
          }
        />
      </div>
      {/* ── Summary cards ─────────────────────────────────────────── */}
      <div
        className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3"
        data-testid="stats-summary-cards"
      >
        <MetricCard
          icon={Layers}
          label="Total cases"
          value={summary ? String(summary.totalCases) : "—"}
          sub={
            summary && summary.legacyCases > 0
              ? `${summary.legacyCases} legacy`
              : undefined
          }
          changePct={summary?.previousPeriod?.casesChangePct ?? null}
          loading={summaryQuery.isLoading}
        />
        <MetricCard
          icon={DollarSign}
          label="Total sales"
          value={summary ? formatMoney(summary.totalRevenue) : "—"}
          sub={summary ? `${summary.invoiceCount} invoices` : undefined}
          changePct={summary?.previousPeriod?.revenueChangePct ?? null}
          loading={summaryQuery.isLoading}
        />
        <MetricCard
          icon={Activity}
          label="Avg case value"
          value={summary ? formatMoney(summary.averageCaseValue) : "—"}
          loading={summaryQuery.isLoading}
        />
        <MetricCard
          icon={BarChart3}
          label="Top case type"
          value={summary?.topCategoryLabel ?? "—"}
          sub={
            summary?.topCategoryCount
              ? `${summary.topCategoryCount} cases`
              : undefined
          }
          loading={summaryQuery.isLoading}
        />
        <MetricCard
          icon={CalendarDays}
          label="Busiest weekday"
          value={summary?.busiestWeekdayLabel ?? "—"}
          loading={summaryQuery.isLoading}
        />
        <MetricCard
          icon={TrendingUp}
          label="Prev period sales"
          value={
            summary?.previousPeriod
              ? formatMoney(summary.previousPeriod.totalRevenue)
              : "—"
          }
          sub={
            summary?.previousPeriod
              ? `${summary.previousPeriod.totalCases} cases`
              : undefined
          }
          loading={summaryQuery.isLoading}
        />
      </div>

      {/* ── Revenue over time ─────────────────────────────────────── */}
      <ChartCard
        title="Sales over time"
        subtitle="Invoiced revenue (non-void invoices) bucketed by the selected period. Legacy mobile invoice blobs are excluded."
        loading={revenueQuery.isLoading}
        error={revenueQuery.isError}
        empty={!revenue || revenue.series.length === 0}
        emptyTestId="stats-revenue-empty"
      >
        {revenue && revenue.series.length > 0 && (
          <ChartContainer
            config={
              {
                revenue: { label: "Revenue", color: "hsl(199 80% 45%)" },
              } satisfies ChartConfig
            }
            className="w-full h-[280px] aspect-auto"
          >
            <AreaChart data={revenue.series} margin={{ left: 8, right: 8 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="period" tickLine={false} axisLine={false} />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={70}
                tickFormatter={(v: number) => formatMoney(v)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) => formatMoney(Number(value))}
                  />
                }
              />
              <Area
                dataKey={(d: { revenue: string }) => Number(d.revenue)}
                name="Revenue"
                type="monotone"
                stroke="var(--color-revenue)"
                fill="var(--color-revenue)"
                fillOpacity={0.15}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </ChartCard>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* ── Cases by category ───────────────────────────────────── */}
        <ChartCard
          title="Cases by category"
          subtitle="Canonical + legacy cases; unclassifiable legacy cases appear as Uncategorized / Legacy."
          loading={categoriesQuery.isLoading}
          error={categoriesQuery.isError}
          empty={!categories || categories.totalCases === 0}
          emptyTestId="stats-categories-empty"
        >
          {categories && categories.totalCases > 0 && (
            <ChartContainer
              config={
                {
                  count: { label: "Cases", color: "hsl(150 55% 42%)" },
                } satisfies ChartConfig
              }
              className="w-full h-[260px] aspect-auto"
            >
              <BarChart
                data={categories.categories.filter((c) => c.count > 0)}
                margin={{ left: 8, right: 8 }}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" name="Cases" radius={[4, 4, 0, 0]} fill="var(--color-count)" />
              </BarChart>
            </ChartContainer>
          )}
        </ChartCard>

        {/* ── Material breakdown ──────────────────────────────────── */}
        <ChartCard
          title="Material breakdown"
          subtitle="Units by normalized material (canonical restorations only)."
          loading={categoriesQuery.isLoading}
          error={categoriesQuery.isError}
          empty={!categories || categories.materials.length === 0}
          emptyTestId="stats-materials-empty"
        >
          {categories && categories.materials.length > 0 && (
            <div className="space-y-2" data-testid="stats-materials-list">
              {categories.materials.slice(0, 8).map((m) => {
                const max = Number(categories.materials[0]?.units || 1);
                const pct = Math.max(4, Math.round((m.units / max) * 100));
                return (
                  <div key={m.material} className="flex items-center gap-3">
                    <div className="w-40 text-sm truncate">{m.material}</div>
                    <div className="flex-1 h-5 bg-secondary rounded overflow-hidden">
                      <div
                        className="h-full rounded bg-primary/70"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="w-16 text-right text-sm tabular-nums">
                      {m.units}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ChartCard>
      </div>

      {/* ── Weekday volume ────────────────────────────────────────── */}
      <ChartCard
        title="Case volume by weekday"
        subtitle="Cases received per weekday, split by category."
        loading={weekdayQuery.isLoading}
        error={weekdayQuery.isError}
        empty={!weekday || weekday.totalCases === 0}
        emptyTestId="stats-weekday-empty"
      >
        {weekday && weekday.totalCases > 0 && (
          <ChartContainer
            config={Object.fromEntries(
              CATEGORY_OPTIONS.map((c) => [
                c.key,
                { label: c.label, color: CATEGORY_COLORS[c.key]! },
              ]),
            )}
            className="w-full h-[280px] aspect-auto"
          >
            <BarChart data={weekday.weekdays} margin={{ left: 8, right: 8 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {CATEGORY_OPTIONS.map((c) => (
                <Bar
                  key={c.key}
                  dataKey={(d: { byCategory: Record<string, number> }) =>
                    d.byCategory[c.key] ?? 0
                  }
                  name={c.label}
                  stackId="cases"
                  fill={CATEGORY_COLORS[c.key]}
                />
              ))}
            </BarChart>
          </ChartContainer>
        )}
      </ChartCard>
    </div>
  );
}

function ExportMenu({
  filters,
  summary,
  categories,
  revenue,
  weekday,
  loading,
}: {
  filters: StatsExportFilters;
  summary: StatsSummaryData | null;
  categories: StatsCategoriesData | null;
  revenue: StatsRevenueData | null;
  weekday: StatsWeekdayData | null;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const hasRevenue = !!revenue && revenue.series.length > 0;
  const hasCategories = !!categories && categories.totalCases > 0;
  const hasMaterials = !!categories && categories.materials.length > 0;
  const hasAnything =
    hasRevenue || hasCategories || hasMaterials || !!summary;

  function itemClass(enabled: boolean): string {
    return `w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded-md ${
      enabled
        ? "hover:bg-secondary cursor-pointer"
        : "opacity-50 cursor-not-allowed"
    }`;
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        data-testid="stats-export-trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={loading || !hasAnything}
        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed border border-transparent"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Download className="h-4 w-4" />
        Export
      </button>
      {open && (
        <div
          role="menu"
          data-testid="stats-export-menu"
          className="absolute right-0 top-full mt-1 w-64 bg-card border border-border rounded-lg shadow-lg p-1 z-50"
        >
          <div className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Spreadsheet (CSV)
          </div>
          <button
            type="button"
            role="menuitem"
            data-testid="stats-export-revenue-csv"
            disabled={!hasRevenue}
            className={itemClass(hasRevenue)}
            onClick={() => {
              if (!revenue) return;
              downloadRevenueCsv(revenue, filters);
              setOpen(false);
            }}
          >
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            Sales over time
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="stats-export-categories-csv"
            disabled={!hasCategories}
            className={itemClass(hasCategories)}
            onClick={() => {
              if (!categories) return;
              downloadCategoryCsv(categories, filters);
              setOpen(false);
            }}
          >
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            Cases by category
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="stats-export-materials-csv"
            disabled={!hasMaterials}
            className={itemClass(hasMaterials)}
            onClick={() => {
              if (!categories) return;
              downloadMaterialCsv(categories, filters);
              setOpen(false);
            }}
          >
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            Material breakdown
          </button>
          <div className="my-1 border-t border-border" />
          <div className="px-3 pt-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Report
          </div>
          <button
            type="button"
            role="menuitem"
            data-testid="stats-export-pdf"
            disabled={!hasAnything}
            className={itemClass(hasAnything)}
            onClick={() => {
              downloadStatsPdf({
                filters,
                summary,
                revenue,
                categories,
                weekday,
                generatedAt: new Date(),
              });
              setOpen(false);
            }}
          >
            <FileText className="h-4 w-4 text-muted-foreground" />
            Full report (PDF)
          </button>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  changePct,
  loading,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
  changePct?: number | null;
  loading?: boolean;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium uppercase tracking-wide">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold tabular-nums truncate">
        {loading ? "…" : value}
      </div>
      <div className="mt-1 flex items-center gap-2 min-h-[1rem]">
        {typeof changePct === "number" && (
          <span
            className={`inline-flex items-center gap-0.5 text-xs font-medium ${
              changePct >= 0 ? "text-emerald-600" : "text-red-600"
            }`}
          >
            {changePct >= 0 ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {changePct >= 0 ? "+" : ""}
            {changePct}%
          </span>
        )}
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </div>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  loading,
  error,
  empty,
  emptyTestId,
  children,
}: {
  title: string;
  subtitle?: string;
  loading?: boolean;
  error?: boolean;
  empty?: boolean;
  emptyTestId?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="mb-4">
        <div className="text-sm font-semibold">{title}</div>
        {subtitle && (
          <div className="text-xs text-muted-foreground mt-0.5">{subtitle}</div>
        )}
      </div>
      {loading ? (
        <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : error ? (
        <div className="h-[200px] flex items-center justify-center text-sm text-red-600">
          Could not load this chart. Try adjusting the filters.
        </div>
      ) : empty ? (
        <div
          className="h-[200px] flex flex-col items-center justify-center text-center"
          data-testid={emptyTestId}
        >
          <div className="text-sm font-medium">No data for this period</div>
          <div className="text-xs text-muted-foreground mt-1 max-w-xs">
            Try a wider date range or clear the category/material filters.
          </div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}
