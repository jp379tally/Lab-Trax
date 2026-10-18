import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  CalendarDays,
  Download,
  DollarSign,
  FileSpreadsheet,
  FileText,
  Info,
  Layers,
  TrendingDown,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  getGetStatsCaseCategoriesQueryKey,
  getGetStatsSalesForecastQueryKey,
  useGetStatsCaseCategories,
  useGetStatsRemakes,
  useGetStatsRevenueSeries,
  useGetStatsSalesForecast,
  useGetStatsSummary,
  useGetStatsWeekdayVolume,
} from "@workspace/api-client-react";
import type { StatsCaseCategory, StatsRemakesResultDataRecordsItem } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import type { Membership, Organization } from "@/lib/types";
import { formatCalendarDate, formatMoney } from "@/lib/format";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DateRangePicker,
  type DateRange,
} from "@/components/reports/DateRangePicker";
import {
  RemakeDateRangeFilter,
  defaultRemakeDateRange,
  DEFAULT_REMAKE_DATE_PRESET,
  type RemakeDateRange,
} from "@/components/stats/RemakeDateRangeFilter";
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
import {
  buildExcludedDaysTooltip,
} from "@/lib/stats-excluded-days";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const ADMIN_ROLES = new Set(["owner", "admin"]);
const OWNER_ROLES = new Set(["owner"]);

const DEFAULT_REVENUE_LOW = 85_000;
const DEFAULT_REVENUE_HIGH = 95_000;
const REVENUE_COLOR_RED = "#ef4444";
const REVENUE_COLOR_YELLOW = "#eab308";
const REVENUE_COLOR_GREEN = "#22c55e";
const FORECAST_COLOR = "#d1d5db";

function revenueColor(value: number, lo = DEFAULT_REVENUE_LOW, hi = DEFAULT_REVENUE_HIGH): string {
  if (value > hi) return REVENUE_COLOR_GREEN;
  if (value >= lo) return REVENUE_COLOR_YELLOW;
  return REVENUE_COLOR_RED;
}

const REMAKE_REASON_OPTIONS = [
  { key: "fit_contacts", label: "Fit: Contacts" },
  { key: "fit_occlusion", label: "Fit: Occlusion" },
  { key: "fit_margins", label: "Fit: Margins" },
  { key: "shade_wrong", label: "Shade Wrong" },
  { key: "wrong_material_doctor", label: "Wrong Material (Doctor)" },
  { key: "wrong_material_lab", label: "Wrong Material (Lab)" },
  { key: "crown_broke", label: "Crown Broke" },
  { key: "bridge_broke", label: "Bridge Broke" },
  { key: "denture_broke", label: "Denture Broke" },
  { key: "partial_broke", label: "Partial Broke" },
  { key: "denture_fit_occlusion", label: "Denture Fit: Occlusion" },
  { key: "denture_fit_intaglio", label: "Denture Fit: Intaglio" },
  { key: "partial_fit_occlusion", label: "Partial Fit: Occlusion" },
  { key: "partial_fit_intaglio", label: "Partial Fit: Intaglio" },
  { key: "denture_tissue_color", label: "Denture Tissue Color" },
  { key: "partial_tissue_color", label: "Partial Tissue Color" },
  { key: "denture_material_wrong", label: "Denture Material Wrong" },
  { key: "partial_material_wrong", label: "Partial Material Wrong" },
  { key: "other", label: "Other" },
] as const;

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

const CASE_TYPE_COLORS: Record<string, string> = {
  Restorative: "hsl(150 55% 42%)",
  Removable: "hsl(32 90% 52%)",
  Ortho: "hsl(262 60% 55%)",
  Implant: "hsl(199 80% 45%)",
  Other: "hsl(220 10% 55%)",
};

export const GROUP_BY_OPTIONS = [
  { key: "day", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
  { key: "year", label: "Yearly" },
] as const;
type GroupBy = (typeof GROUP_BY_OPTIONS)[number]["key"];

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function formatRemakeRate(totalRemakes: number, totalCases: number): string {
  if (totalCases === 0) return "—";
  const rate = (totalRemakes / totalCases) * 100;
  if (rate > 0 && rate < 0.1) return "< 0.1%";
  return `${rate.toFixed(1)}%`;
}

/**
 * The Stats analytics dashboard, rendered as a tab inside the Reports page.
 *
 * The lab selection is owned by the Reports page (so switching tabs keeps the
 * selected lab), while every Stats-specific filter — category, material,
 * group-by and the date range — is independent from the finance tabs. Dates
 * and grouping are owned by the Reports URL; category and material stay local.
 */
export function StatsTab({
  billingLabs,
  memberships,
  orgId,
  onOrgChange,
  onViewForecast,
  range,
  onRangeChange,
  groupBy,
  onGroupChange,
}: {
  billingLabs: Organization[];
  memberships: Membership[];
  orgId: string | null;
  onOrgChange: (orgId: string | null) => void;
  /** Switches the Reports page to the Forecast tab (same page, no navigation). */
  onViewForecast?: () => void;
  range: DateRange;
  onRangeChange: (range: DateRange) => void;
  groupBy: GroupBy;
  onGroupChange: (groupBy: GroupBy) => void;
}) {
  const [category, setCategory] = useState<StatsCaseCategory | "">("");
  const [material, setMaterial] = useState<string>("");

  const isBilling = billingLabs.length > 0;
  const isAdminForOrg = useMemo(() => {
    if (!orgId) return false;
    return memberships.some(
      (m) =>
        m.status === "active" &&
        m.organization?.id === orgId &&
        m.organization?.type === "lab" &&
        ADMIN_ROLES.has(m.role),
    );
  }, [memberships, orgId]);

  const isOwnerForOrg = useMemo(() => {
    if (!orgId) return false;
    return memberships.some(
      (m) =>
        m.status === "active" &&
        m.organization?.id === orgId &&
        m.organization?.type === "lab" &&
        OWNER_ROLES.has(m.role),
    );
  }, [memberships, orgId]);

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
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card p-3 shadow-sm sm:p-4">
        <p className="text-sm text-muted-foreground">
          Business and production analytics for your lab.
        </p>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none sm:justify-end">
          {isBilling && billingLabs.length > 1 && (
            <select
              value={orgId || ""}
              onChange={(e) => onOrgChange(e.target.value || null)}
              data-testid="stats-org-select"
              className="h-9 min-w-0 max-w-full rounded-lg border border-border/70 bg-background px-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            className="h-9 min-w-0 max-w-full rounded-lg border border-border/70 bg-background px-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            className="h-9 min-w-0 max-w-full rounded-lg border border-border/70 bg-background px-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            onChange={(e) => onGroupChange(e.target.value as GroupBy)}
            data-testid="stats-groupby-select"
            className="h-9 min-w-0 max-w-full rounded-lg border border-border/70 bg-background px-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {GROUP_BY_OPTIONS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
          <DateRangePicker value={range} onChange={onRangeChange} />
        </div>
      </div>

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
          isAdmin={isAdminForOrg}
          isOwner={isOwnerForOrg}
          onViewForecast={onViewForecast}
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
  isAdmin,
  isOwner,
  onViewForecast,
}: {
  organizationId: string;
  orgName: string;
  range: DateRange;
  groupBy: GroupBy;
  category: StatsCaseCategory | undefined;
  material: string | undefined;
  isAdmin: boolean;
  isOwner: boolean;
  onViewForecast?: () => void;
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

  // Fetch org settings for revenue target thresholds.
  const orgSettingsQuery = useQuery<{ revenueTargetLow?: number | null; revenueTargetHigh?: number | null }>({
    queryKey: ["org-settings", organizationId],
    queryFn: () => apiFetch(`/organizations/${organizationId}`),
    staleTime: 60_000,
    enabled: !!organizationId,
  });
  const revenueLow = orgSettingsQuery.data?.revenueTargetLow ?? null;
  const revenueHigh = orgSettingsQuery.data?.revenueTargetHigh ?? null;

  // Remake-specific filter state (separate from main category/material filters).
  // Date range and doctor are scoped to this section only — they must never
  // affect `range`/`baseParams`, which drive the rest of the Stats page.
  const [remakeDateRange, setRemakeDateRange] = useState<RemakeDateRange>(() =>
    defaultRemakeDateRange(),
  );
  const [remakeDoctor, setRemakeDoctor] = useState<string>("");
  const [remakeReasonKey, setRemakeReasonKey] = useState<string>("");
  const [remakeRecharged, setRemakeRecharged] = useState<"yes" | "no" | "">("");
  const [remakeReturnedToLab, setRemakeReturnedToLab] = useState<"yes" | "no" | "">("");
  const [remakeCat, setRemakeCat] = useState<"crown_bridge" | "removable" | "implant" | "">("");
  const [remakeGroupBy, setRemakeGroupBy] = useState<"week" | "month">("week");

  // Doctor drill-down panel state (month-bar click → per-doctor revenue).
  const [selectedPeriod, setSelectedPeriod] = useState<{
    periodStart: string;
    periodEnd: string;
    label: string;
    totalRevenue: string;
  } | null>(null);
  const [drillDownSort, setDrillDownSort] = useState<"revenue" | "az">("revenue");

  // Reset selected period when the org, date range, or groupBy changes.
  useEffect(() => {
    setSelectedPeriod(null);
  }, [organizationId, range.from, range.to, groupBy]);

  // Fetch per-doctor revenue when a bar is selected.
  const doctorRevenueQuery = useQuery<{
    periodStart: string;
    periodEnd: string;
    doctors: Array<{ doctorName: string; revenue: string; invoiceCount: number }>;
  } | null>({
    queryKey: ["stats", "revenue-by-doctor", organizationId, selectedPeriod?.periodStart, selectedPeriod?.periodEnd],
    queryFn: () => {
      if (!selectedPeriod) return Promise.resolve(null);
      const params = new URLSearchParams({
        organizationId,
        periodStart: selectedPeriod.periodStart,
        periodEnd: selectedPeriod.periodEnd,
        timeZone,
      });
      return apiFetch(`/stats/revenue-by-doctor?${params}`);
    },
    enabled: !!selectedPeriod,
  });

  const remakesHasFilters =
    !!remakeReasonKey ||
    !!remakeRecharged ||
    !!remakeReturnedToLab ||
    !!remakeCat ||
    !!remakeDoctor ||
    remakeDateRange.preset !== DEFAULT_REMAKE_DATE_PRESET;

  // Doctor options are scoped to the selected date window only (no other
  // remake filter applied), so the dropdown never lists a doctor with zero
  // remakes in the current window.
  const remakeDoctorOptionsParams = {
    organizationId,
    ...(remakeDateRange.preset !== "all"
      ? { dateFrom: remakeDateRange.from, dateTo: remakeDateRange.to }
      : {}),
    timeZone,
  };
  const remakeDoctorOptionsQuery = useGetStatsRemakes(remakeDoctorOptionsParams, {
    query: {
      queryKey: ["stats", "remakes", "doctor-options", remakeDoctorOptionsParams],
      enabled: isAdmin,
    },
  });
  const remakeDoctorOptions = useMemo(() => {
    const names = (remakeDoctorOptionsQuery.data?.data?.byDoctor ?? []).map(
      (d) => d.doctorName,
    );
    if (remakeDoctor && !names.includes(remakeDoctor)) names.push(remakeDoctor);
    return names;
  }, [remakeDoctorOptionsQuery.data, remakeDoctor]);

  const remakesParams = {
    organizationId,
    ...(remakeDateRange.preset !== "all"
      ? { dateFrom: remakeDateRange.from, dateTo: remakeDateRange.to }
      : {}),
    timeZone,
    groupBy: remakeGroupBy,
    ...(remakeReasonKey ? { reasonKey: remakeReasonKey } : {}),
    ...(remakeRecharged ? { recharged: remakeRecharged } : {}),
    ...(remakeReturnedToLab ? { returnedToLab: remakeReturnedToLab } : {}),
    ...(remakeCat ? { remakeCategory: remakeCat } : {}),
    ...(remakeDoctor ? { doctorName: remakeDoctor } : {}),
  };
  const remakesQuery = useGetStatsRemakes(remakesParams, {
    query: { queryKey: ["stats", "remakes", remakesParams], enabled: isAdmin },
  });

  // Sales forecast is admin+owner (server enforces ADMIN_ROLES on
  // GET /stats/sales-forecast). Fetch when the user is an admin or owner of the selected lab.
  const forecastParams = { organizationId, timeZone };
  const forecastQuery = useGetStatsSalesForecast(forecastParams, {
    query: {
      queryKey: getGetStatsSalesForecastQueryKey(forecastParams),
      enabled: isAdmin,
    },
  });
  const forecastMonth = forecastQuery.data?.data?.month;
  const forecastYear = forecastQuery.data?.data?.year;
  const remakes = remakesQuery.data?.data;

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
    <div className="min-w-0 space-y-4">
      {/* ── Export toolbar ────────────────────────────────────────── */}
      <div className="flex justify-end">
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
        className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
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
          label="Avg daily sales"
          value={summary ? formatMoney(summary.averageDailyRevenue) : "—"}
          sub={
            summary?.salesCutoffDate
              ? `through ${summary.salesCutoffDate}`
              : undefined
          }
          loading={summaryQuery.isLoading}
          tooltip={buildExcludedDaysTooltip(summary?.excludedDays)}
        />
        <MetricCard
          icon={BarChart3}
          label="Avg case value"
          value={summary ? formatMoney(summary.averageCaseValue) : "—"}
          loading={summaryQuery.isLoading}
        />
        <MetricCard
          icon={CalendarDays}
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
          icon={TrendingUp}
          label="Busiest weekday"
          value={summary?.busiestWeekdayLabel ?? "—"}
          loading={summaryQuery.isLoading}
        />
        <MetricCard
          icon={TrendingDown}
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
        {isAdmin && (
          <MetricCard
            icon={TrendingUp}
            label="Monthly forecast"
            value={
              forecastQuery.isLoading
                ? "…"
                : !forecastMonth || forecastMonth.insufficientData
                  ? "—"
                  : formatMoney(forecastMonth.forecast)
            }
            sub={
              !forecastQuery.isLoading && forecastMonth?.insufficientData
                ? "insufficient data"
                : undefined
            }
            loading={false}
            linkLabel="View full forecast"
            onLinkClick={onViewForecast}
          />
        )}
        {isAdmin && (
          <MetricCard
            icon={TrendingUp}
            label="Annual forecast"
            value={
              forecastQuery.isLoading
                ? "…"
                : !forecastYear || forecastYear.insufficientData
                  ? "—"
                  : formatMoney(forecastYear.forecast)
            }
            sub={
              !forecastQuery.isLoading && forecastYear?.insufficientData
                ? "insufficient data"
                : undefined
            }
            loading={false}
          />
        )}
      </div>
      {summaryQuery.isError && (
        <div
          className="rounded-lg border border-destructive/30 bg-card px-4 py-3 text-sm text-destructive"
          role="status"
          data-testid="stats-summary-error"
        >
          Could not load summary metrics. Try refreshing the report.
        </div>
      )}

      {/* ── Revenue over time ─────────────────────────────────────── */}
      <ChartCard
        title="Sales over time"
        subtitle="Invoiced revenue (non-void invoices) bucketed by the selected period. Legacy mobile invoice blobs are excluded."
        loading={revenueQuery.isLoading}
        error={revenueQuery.isError}
        empty={!revenue || revenue.series.length === 0}
        emptyTestId="stats-revenue-empty"
      >
        {revenue && revenue.series.length > 0 && (() => {
          type ChartEntry = {
            period: string;
            periodStart: string;
            revenue: string;
            invoiceCount: number;
            isForecast?: boolean;
          };

          // Build the sorted actual series.
          const sorted: ChartEntry[] = [...revenue.series].sort((a, b) =>
            a.periodStart.localeCompare(b.periodStart),
          );

          // Append 3 greyed-out forecast bars when groupBy=month and forecast data is available.
          let combinedSeries: ChartEntry[] = sorted;
          if (groupBy === "month" && forecastMonth && !forecastMonth.insufficientData && sorted.length > 0) {
            const lastEntry = sorted[sorted.length - 1]!;
            // lastEntry.period is "YYYY-MM"
            const parts = lastEntry.period.split("-").map(Number);
            const lastYr = parts[0]!;
            const lastMo = parts[1]!; // 1-based
            const extras: ChartEntry[] = [];
            for (let i = 1; i <= 3; i++) {
              const moIdx = (lastMo - 1 + i); // 0-based from Jan
              const nextYr = lastYr + Math.floor(moIdx / 12);
              const nextMo = moIdx % 12; // 0-based
              const periodKey = `${nextYr}-${String(nextMo + 1).padStart(2, "0")}`;
              const periodStart = new Date(Date.UTC(nextYr, nextMo, 1)).toISOString();
              extras.push({
                period: periodKey,
                periodStart,
                revenue: String(forecastMonth.forecast),
                invoiceCount: 0,
                isForecast: true,
              });
            }
            combinedSeries = [...sorted, ...extras];
          }

          const rawMax = Math.max(...combinedSeries.map((s) => Number(s.revenue)));
          const revHigh = revenueHigh ?? DEFAULT_REVENUE_HIGH;
          const revLow = revenueLow ?? DEFAULT_REVENUE_LOW;
          const chartMax = Math.max(rawMax * 1.1, revHigh * 1.05);
          const fmtK = (v: number) => v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `$${(v / 1_000).toFixed(0)}k` : `$${v}`;

          const hasForecastBars = combinedSeries.some((d) => d.isForecast);

          return (
            <>
              {/* Legend */}
              <div className="flex items-center gap-4 mb-3 flex-wrap">
                {[
                  { color: REVENUE_COLOR_RED, label: `< ${fmtK(revLow)}` },
                  { color: REVENUE_COLOR_YELLOW, label: `${fmtK(revLow)}–${fmtK(revHigh)}` },
                  { color: REVENUE_COLOR_GREEN, label: `> ${fmtK(revHigh)}` },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                    {item.label}
                  </div>
                ))}
                {hasForecastBars && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: FORECAST_COLOR }} />
                    Forecasted
                  </div>
                )}
                {groupBy === "month" && (
                  <span className="ml-auto text-xs text-muted-foreground italic">
                    Click a bar to see revenue by doctor
                  </span>
                )}
              </div>
              {/* Threshold sentinel — same revLow/revHigh variables used for ReferenceLine y props;
                  accessible in tests without fighting recharts SVG rendering in jsdom */}
              <span
                className="sr-only"
                data-testid="revenue-chart-thresholds"
                data-low={revLow}
                data-high={revHigh}
              />
              <ChartContainer
                config={
                  {
                    revenue: { label: "Revenue", color: "hsl(199 80% 45%)" },
                  } satisfies ChartConfig
                }
                className="w-full h-[280px] aspect-auto"
              >
                <BarChart data={combinedSeries} margin={{ left: 8, right: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="period" tickLine={false} axisLine={false} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={70}
                    domain={[0, chartMax]}
                    tickFormatter={(v: number) => formatMoney(v)}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value, _name, item) => {
                          const entry = item?.payload as ChartEntry | undefined;
                          const label = formatMoney(Number(value));
                          return entry?.isForecast ? `${label} (forecast)` : label;
                        }}
                      />
                    }
                  />
                  <Bar
                    dataKey={(d: ChartEntry) => Number(d.revenue)}
                    name="Revenue"
                    radius={[3, 3, 0, 0]}
                    cursor={groupBy === "month" ? "pointer" : "default"}
                    onClick={(data: ChartEntry) => {
                      if (data.isForecast) return;
                      if (groupBy !== "month") return;
                      const ps = new Date(data.periodStart);
                      const pe = new Date(Date.UTC(ps.getUTCFullYear(), ps.getUTCMonth() + 1, 1));
                      setSelectedPeriod({
                        periodStart: data.periodStart,
                        periodEnd: pe.toISOString(),
                        label: data.period,
                        totalRevenue: data.revenue,
                      });
                      setDrillDownSort("revenue");
                    }}
                  >
                    {combinedSeries.map((d) => (
                      <Cell
                        key={d.period}
                        fill={d.isForecast ? FORECAST_COLOR : revenueColor(Number(d.revenue), revLow, revHigh)}
                        opacity={d.isForecast ? 0.75 : 1}
                        stroke={selectedPeriod?.label === d.period && !d.isForecast ? "#374151" : "none"}
                        strokeWidth={2}
                      />
                    ))}
                  </Bar>
                  <ReferenceLine
                    y={revHigh}
                    stroke={REVENUE_COLOR_GREEN}
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                    label={{ value: fmtK(revHigh), position: "insideTopRight", fontSize: 10, fill: REVENUE_COLOR_GREEN }}
                  />
                  <ReferenceLine
                    y={revLow}
                    stroke={REVENUE_COLOR_YELLOW}
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                    label={{ value: fmtK(revLow), position: "insideTopRight", fontSize: 10, fill: REVENUE_COLOR_YELLOW }}
                  />
                </BarChart>
              </ChartContainer>
            </>
          );
        })()}
      </ChartCard>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* ── Cases by category ───────────────────────────────────── */}
        <ChartCard
          title="Cases by category"
          subtitle="Canonical + legacy cases; unclassifiable legacy cases appear as Uncategorized / Legacy."
        className="min-w-0"
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
        className="min-w-0"
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

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2" data-testid="stats-case-analytics-grid">
      {/* ── By case type ──────────────────────────────────────────── */}
      <ChartCard
        title="By case type"
        subtitle="Canonical cases only (legacy cases have no restoration rows and are excluded)."
        className="min-w-0"
        loading={categoriesQuery.isLoading}
        error={categoriesQuery.isError}
        empty={!categories || !categories.caseTypes || categories.caseTypes.length === 0}
        emptyTestId="stats-casetypes-empty"
      >
        {categories && categories.caseTypes && categories.caseTypes.length > 0 && (
          <ChartContainer
            data-testid="stats-casetypes-chart"
            config={Object.fromEntries(
              categories.caseTypes.map((t) => [
                t.label,
                {
                  label: t.label,
                  color: CASE_TYPE_COLORS[t.label] ?? "hsl(220 10% 55%)",
                },
              ]),
            )}
            className="w-full aspect-auto"
            style={{ height: Math.max(132, categories.caseTypes.length * 38) }}
          >
            <BarChart
              data={categories.caseTypes}
              layout="vertical"
              margin={{ top: 4, right: 20, bottom: 4, left: 0 }}
            >
              <CartesianGrid horizontal={false} strokeDasharray="3 3" />
              <XAxis
                type="number"
                allowDecimals={false}
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={{ fontSize: 13 }}
                tickLine={false}
                axisLine={false}
                width={92}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="count" name="Cases" radius={[0, 4, 4, 0]}>
                {categories.caseTypes.map((t) => (
                  <Cell
                    key={t.label}
                    fill={CASE_TYPE_COLORS[t.label] ?? "hsl(220 10% 55%)"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </ChartCard>

      {/* ── Weekday volume ────────────────────────────────────────── */}
      <ChartCard
        title="Case volume by weekday"
        subtitle="Cases received per weekday, split by category."
        className="min-w-0"
        loading={weekdayQuery.isLoading}
        error={weekdayQuery.isError}
        empty={!weekday || weekday.totalCases === 0}
        emptyTestId="stats-weekday-empty"
      >
        {weekday && weekday.totalCases > 0 && (() => {
          // Flatten byCategory into top-level keys so Bar can use string
          // dataKeys that match the ChartConfig — required for the legend
          // to resolve category labels correctly.
          const flatWeekdays = weekday.weekdays.map((d) => ({
            label: d.label,
            ...Object.fromEntries(
              CATEGORY_OPTIONS.map((c) => [c.key, d.byCategory[c.key] ?? 0]),
            ),
          }));
          return (
            <ChartContainer
              config={Object.fromEntries(
                CATEGORY_OPTIONS.map((c) => [
                  c.key,
                  { label: c.label, color: CATEGORY_COLORS[c.key]! },
                ]),
              )}
              className="w-full h-[240px] aspect-auto"
            >
              <BarChart data={flatWeekdays} margin={{ left: 8, right: 8, bottom: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                {CATEGORY_OPTIONS.map((c) => (
                  <Bar
                    key={c.key}
                    dataKey={c.key}
                    name={c.label}
                    stackId="cases"
                    fill={CATEGORY_COLORS[c.key]}
                  />
                ))}
              </BarChart>
            </ChartContainer>
          );
        })()}
      </ChartCard>
      </div>

      {/* ── Remakes (owner/admin only) ────────────────────────────── */}
      {isAdmin && (
        <div data-testid="stats-remakes" className="min-w-0 space-y-4">
          <section className="rounded-xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
            <div className="mb-4 flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Activity className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold tracking-tight">Remakes</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Remade cases received in this period (canonical + legacy).
                </p>
              </div>
            </div>

            {/* Filter bar */}
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <select
                className="h-9 min-w-0 w-full rounded-lg border border-border/70 bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
                value={remakeGroupBy}
                onChange={(e) => setRemakeGroupBy(e.target.value as "week" | "month")}
                aria-label="Group by"
              >
                <option value="week">By week</option>
                <option value="month">By month</option>
              </select>
              <RemakeDateRangeFilter value={remakeDateRange} onChange={setRemakeDateRange} />
              <select
                className="h-9 min-w-0 w-full rounded-lg border border-border/70 bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto sm:max-w-[220px]"
                value={remakeDoctor}
                onChange={(e) => setRemakeDoctor(e.target.value)}
                aria-label="Doctor"
                data-testid="stats-remakes-doctor-select"
              >
                <option value="">All doctors</option>
                {remakeDoctorOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <select
                className="h-9 min-w-0 w-full rounded-lg border border-border/70 bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
                value={remakeCat}
                onChange={(e) => setRemakeCat(e.target.value as "crown_bridge" | "removable" | "implant" | "")}
                aria-label="Remake type"
                data-testid="stats-remakes-type-select"
              >
                <option value="">All types</option>
                <option value="crown_bridge">Crown &amp; Bridge</option>
                <option value="removable">Removable</option>
                <option value="implant">Implant</option>
              </select>
              <select
                className="h-9 min-w-0 w-full rounded-lg border border-border/70 bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto sm:max-w-[240px]"
                value={remakeReasonKey}
                onChange={(e) => setRemakeReasonKey(e.target.value)}
                aria-label="Reason"
              >
                <option value="">All reasons</option>
                {REMAKE_REASON_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
              <select
                className="h-9 min-w-0 w-full rounded-lg border border-border/70 bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
                value={remakeRecharged}
                onChange={(e) => setRemakeRecharged(e.target.value as "yes" | "no" | "")}
                aria-label="Recharged"
              >
                <option value="">All (recharged/not)</option>
                <option value="yes">Recharged</option>
                <option value="no">Not recharged</option>
              </select>
              <select
                className="h-9 min-w-0 w-full rounded-lg border border-border/70 bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
                value={remakeReturnedToLab}
                onChange={(e) => setRemakeReturnedToLab(e.target.value as "yes" | "no" | "")}
                aria-label="Returned to lab"
              >
                <option value="">All (returned/not)</option>
                <option value="yes">Returned to lab</option>
                <option value="no">Not returned</option>
              </select>
              {remakesHasFilters && (
                <button
                  type="button"
                  className="h-9 rounded-lg border border-border/70 bg-background px-3 text-sm text-muted-foreground shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setRemakeDateRange(defaultRemakeDateRange());
                    setRemakeDoctor("");
                    setRemakeReasonKey("");
                    setRemakeRecharged("");
                    setRemakeReturnedToLab("");
                    setRemakeCat("");
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          </section>

          {/* Summary */}
          {remakesQuery.isLoading ? (
              <div className="flex min-h-40 items-center justify-center rounded-xl border border-border/70 bg-card text-sm text-muted-foreground shadow-sm">
                Loading…
              </div>
          ) : remakesQuery.isError ? (
              <div className="flex min-h-40 items-center justify-center rounded-xl border border-destructive/30 bg-card text-sm text-destructive shadow-sm">
                Could not load remakes.
              </div>
          ) : !remakes || remakes.totalRemakes === 0 ? (
              <div
                className="flex min-h-40 items-center justify-center rounded-xl border border-border/70 bg-card text-center text-sm text-muted-foreground shadow-sm"
                data-testid="stats-remakes-empty"
              >
                No remakes in this period
              </div>
          ) : (
            <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="stats-remakes-summary">
                  <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-sm">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
                      <Activity className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total remakes</div>
                      <div className="mt-1 text-2xl font-bold tabular-nums" data-testid="stats-remakes-total">
                        {remakes.totalRemakes}
                      </div>
                      <div className="text-xs text-muted-foreground" data-testid="stats-remakes-rate">
                        {(summary?.totalCases ?? 0) === 0
                          ? "—"
                          : `${formatRemakeRate(remakes.totalRemakes, summary!.totalCases)} of ${summary!.totalCases} cases`}
                      </div>
                    </div>
                  </div>
                  <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-sm">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                      <TrendingUp className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recharged</div>
                      <div className="mt-1 text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                        {remakes.rechargedRemakes}
                      </div>
                    </div>
                  </div>
                  <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-sm">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400">
                      <TrendingDown className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Not recharged</div>
                      <div className="mt-1 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-400">
                        {remakes.nonRechargedRemakes}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Remake reasons */}
                <section className="rounded-xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
                  <div className="mb-4 flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
                      <FileText className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold">Remake reasons</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Grouped by reason, most frequent first.
                      </p>
                    </div>
                  </div>
                  {remakes.remakeReasons.length === 0 ? (
                    <div className="flex min-h-20 items-center justify-center text-sm text-muted-foreground">
                      No reasons recorded
                    </div>
                  ) : (
                    <div
                      className="space-y-3"
                      data-testid="stats-remakes-reasons"
                    >
                      {(() => {
                        const maxCount = Math.max(...remakes.remakeReasons.map((reason) => reason.count), 1);
                        const barColors = ["#1685ee", "#8b5cf6", "#fb923c", "#22a879", "#ec4899"];
                        return remakes.remakeReasons.map((r, index) => {
                          const percent = Math.max(3, Math.round((r.count / maxCount) * 100));
                          return (
                            <div
                              key={r.reason}
                              className="grid grid-cols-[minmax(0,1.3fr)_minmax(64px,3fr)_2rem] items-center gap-3 text-sm sm:grid-cols-[minmax(0,1.1fr)_minmax(100px,3fr)_2.5rem]"
                            >
                              <span className="min-w-0 break-words text-foreground">{r.reason}</span>
                              <div
                                className="h-3 overflow-hidden rounded-full bg-secondary"
                                role="img"
                                aria-label={`${r.count} ${r.count === 1 ? "remake" : "remakes"}`}
                              >
                                <div
                                  className="h-full rounded-full transition-[width]"
                                  style={{
                                    width: `${percent}%`,
                                    backgroundColor: barColors[index % barColors.length],
                                  }}
                                />
                              </div>
                              <span className="text-right font-semibold tabular-nums">{r.count}</span>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  )}
                </section>

                {/* Charts */}
                {(remakes.timeSeries.length > 0 ||
                  (remakes.byType && remakes.byType.length > 0) ||
                  (remakes.byDoctor && remakes.byDoctor.length > 0)) && (
                  <div className="space-y-4">
                    {/* Trend + By type side by side */}
                    {(remakes.timeSeries.length > 0 ||
                      (remakes.byType && remakes.byType.length > 0)) && (
                      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        {/* Trend over time */}
                        {remakes.timeSeries.length > 0 && (
                          <section className="min-w-0 rounded-xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
                            <div className="mb-3 flex items-start gap-3">
                              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                                <BarChart3 className="h-5 w-5" aria-hidden="true" />
                              </span>
                              <div>
                                <h3 className="text-sm font-semibold">Remake trend</h3>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  Remakes per {remakeGroupBy}
                                </p>
                              </div>
                            </div>
                            <ChartContainer
                              config={{ count: { label: "Remakes", color: "hsl(var(--chart-1))" } }}
                              className="h-[220px] w-full aspect-auto"
                            >
                              <BarChart data={remakes.timeSeries} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
                                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                                <XAxis dataKey="period" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={28} />
                                <ChartTooltip content={<ChartTooltipContent />} />
                                <Bar dataKey="count" fill="var(--color-count)" radius={[3, 3, 0, 0]} />
                              </BarChart>
                            </ChartContainer>
                          </section>
                        )}

                        {/* By type */}
                        {remakes.byType && remakes.byType.length > 0 && (
                          <section className="min-w-0 rounded-xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
                            <div className="mb-3 flex items-start gap-3">
                              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
                                <Layers className="h-5 w-5" aria-hidden="true" />
                              </span>
                              <div>
                                <h3 className="text-sm font-semibold">By type</h3>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  Remakes by case category
                                </p>
                              </div>
                            </div>
                            {(() => {
                              const TYPE_COLORS: Record<string, string> = {
                                Restorative: CATEGORY_COLORS.crown_bridge,
                                Removable: CATEGORY_COLORS.removable,
                                Implant: CATEGORY_COLORS.implants,
                                Other: CATEGORY_COLORS.other,
                              };
                              const cfg = Object.fromEntries(
                                remakes.byType!.map((t) => [
                                  t.typeName,
                                  { label: t.typeName, color: TYPE_COLORS[t.typeName] ?? CATEGORY_COLORS.other },
                                ])
                              );
                              return (
                                <ChartContainer
                                  config={cfg}
                                  className="w-full aspect-auto"
                                  style={{ height: Math.max(156, remakes.byType!.length * 38) }}
                                >
                                  <BarChart data={remakes.byType} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 0 }}>
                                    <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                                    <YAxis type="category" dataKey="typeName" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={88} />
                                    <ChartTooltip content={<ChartTooltipContent />} />
                                    <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                                      {remakes.byType!.map((t) => (
                                        <Cell key={t.typeName} fill={TYPE_COLORS[t.typeName] ?? CATEGORY_COLORS.other} />
                                      ))}
                                    </Bar>
                                  </BarChart>
                                </ChartContainer>
                              );
                            })()}
                          </section>
                        )}
                      </div>
                    )}

                    {/* By doctor — full width */}
                    {remakes.byDoctor && remakes.byDoctor.length > 0 && (
                      <section className="min-w-0 rounded-xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
                        <div className="mb-3 flex items-start gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
                            <UsersRound className="h-5 w-5" aria-hidden="true" />
                          </span>
                          <div>
                            <h3 className="text-sm font-semibold">By doctor</h3>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              Most-remade doctors (top 10)
                            </p>
                          </div>
                        </div>
                        {(() => {
                          const top10 = remakes.byDoctor!.slice(0, 10);
                          const DOCTOR_COLOR = "hsl(var(--chart-2))";
                          return (
                            <ChartContainer
                              config={{ count: { label: "Remakes", color: DOCTOR_COLOR } }}
                              className="w-full aspect-auto"
                              style={{ height: Math.max(176, top10.length * 30) }}
                            >
                              <BarChart data={top10} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 0 }}>
                                <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                                <YAxis type="category" dataKey="doctorName" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={140} />
                                <ChartTooltip content={<ChartTooltipContent />} />
                                <Bar dataKey="count" fill={DOCTOR_COLOR} radius={[0, 3, 3, 0]} />
                              </BarChart>
                            </ChartContainer>
                          );
                        })()}
                      </section>
                    )}
                  </div>
                )}
              </>
          )}

      {/* ── Doctor drill-down Sheet ───────────────────────────── */}
      <Sheet
        open={!!selectedPeriod}
        onOpenChange={(open) => { if (!open) setSelectedPeriod(null); }}
      >
        <SheetContent side="right" className="w-[400px] sm:w-[400px] overflow-y-auto flex flex-col">
          <SheetHeader className="mb-4 pr-6">
            <SheetTitle>
              Sales —{" "}
              {selectedPeriod
                ? new Date(selectedPeriod.periodStart).toLocaleDateString("en-US", {
                    month: "long",
                    year: "numeric",
                    timeZone: "UTC",
                  })
                : ""}
            </SheetTitle>
            <SheetDescription>
              {selectedPeriod ? `Total: ${formatMoney(selectedPeriod.totalRevenue)}` : "Revenue by doctor for this month."}
            </SheetDescription>
          </SheetHeader>

          {/* Sort toggle */}
          <div className="flex gap-2 mb-4">
            <button
              className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${drillDownSort === "revenue" ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-muted"}`}
              onClick={() => setDrillDownSort("revenue")}
            >
              By Sales
            </button>
            <button
              className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${drillDownSort === "az" ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-muted"}`}
              onClick={() => setDrillDownSort("az")}
            >
              A–Z
            </button>
          </div>

          {/* Content */}
          {doctorRevenueQuery.isLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-12 bg-muted rounded-lg animate-pulse" />
              ))}
            </div>
          ) : doctorRevenueQuery.isError ? (
            <div className="text-sm text-red-600 text-center py-8">
              Could not load doctor breakdown.
            </div>
          ) : !doctorRevenueQuery.data?.doctors.length ? (
            <div className="text-sm text-muted-foreground text-center py-8">
              No revenue data for this period.
            </div>
          ) : (
            <div className="space-y-0.5 overflow-y-auto flex-1">
              {(() => {
                const UNLINKED = "Unlinked / Manual";
                const data = doctorRevenueQuery.data!.doctors;
                const unlinked = data.find((d) => d.doctorName === UNLINKED);
                const others = data.filter((d) => d.doctorName !== UNLINKED);
                const sorted =
                  drillDownSort === "az"
                    ? [...others].sort((a, b) => a.doctorName.localeCompare(b.doctorName))
                    : others; // already sorted by revenue descending from server
                const allRows = unlinked ? [...sorted, unlinked] : sorted;
                return allRows.map((d) => (
                  <div
                    key={d.doctorName}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm truncate ${d.doctorName === UNLINKED ? "text-muted-foreground italic" : ""}`}>
                        {d.doctorName}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {d.invoiceCount} {d.invoiceCount === 1 ? "invoice" : "invoices"}
                      </div>
                    </div>
                    <div className="font-semibold tabular-nums text-sm shrink-0">
                      {formatMoney(d.revenue)}
                    </div>
                  </div>
                ));
              })()}
            </div>
          )}
        </SheetContent>
      </Sheet>

          {/* Records table */}
          {remakes && remakes.records.length > 0 && (
            <section className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 p-4 sm:p-5">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <FileText className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold">Remake records</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Individual remakes, newest first. Click a case number to open it.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-background px-3 py-2 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    const headers = ["Doctor", "Case #", "Original #", "Date", "Reason", "Category", "Recharged", "Returned", "Source"];
                    const rows = remakes.records.map((rec: StatsRemakesResultDataRecordsItem) => [
                      rec.doctorName ?? "",
                      rec.caseNumber ?? "",
                      rec.originalCaseNumber ?? "",
                      rec.receivedAt
                        ? formatCalendarDate(rec.receivedAt)
                        : "",
                      rec.reason ?? "",
                      rec.category ? rec.category.replace("_", " & ") : "",
                      rec.recharged ? "Yes" : "No",
                      rec.returnedToLab ? "Yes" : "No",
                      rec.source ?? "",
                    ]);
                    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
                    const csv = [headers.map(escape).join(","), ...rows.map((r: string[]) => r.map(escape).join(","))].join("\r\n");
                    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "remake-records.csv";
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Export CSV
                </button>
              </div>
              <div className="max-h-[400px] overflow-x-auto overflow-y-auto">
                <table className="w-full min-w-[940px] text-sm" data-testid="stats-remakes-records">
                  <thead className="sticky top-0 bg-muted/70 backdrop-blur-sm">
                    <tr>
                      <th className="whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Doctor</th>
                      <th className="whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Case #</th>
                      <th className="whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Original #</th>
                      {/* Neutral "Date": the server sends this as the remake's
                          receivedAt, which equals createdAt for ordinary cases but
                          is the mobile row's updatedAt for promoted legacy cases —
                          so it cannot be labelled "Created". */}
                      <th className="whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Date</th>
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reason</th>
                      <th className="whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Category</th>
                      <th className="whitespace-nowrap px-4 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recharged</th>
                      <th className="whitespace-nowrap px-4 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Returned</th>
                      <th className="whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Source</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {remakes.records.map((rec) => (
                      <tr key={rec.id} className="transition-colors hover:bg-muted/40">
                        <td className="max-w-[200px] px-4 py-2.5 text-sm">
                          {rec.doctorName ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono font-medium">
                          <a
                            href={`/cases/${rec.id}`}
                            className="text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={(e) => {
                              e.preventDefault();
                              window.dispatchEvent(new CustomEvent("navigate", { detail: { to: `/cases/${rec.id}` } }));
                            }}
                          >
                            {rec.caseNumber}
                          </a>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-muted-foreground">
                          {rec.originalCaseNumber ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                          {formatCalendarDate(rec.receivedAt)}
                        </td>
                        <td className="max-w-[280px] px-4 py-2.5">
                          <span className="block whitespace-normal">{rec.reason}</span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground capitalize">
                          {rec.category ? rec.category.replace("_", " & ") : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          {rec.recharged ? (
                            <span className="font-medium text-emerald-700 dark:text-emerald-400" aria-label="Yes">✓</span>
                          ) : (
                            <span className="text-muted-foreground" aria-label="No">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          {rec.returnedToLab ? (
                            <span className="font-medium text-blue-700 dark:text-blue-400" aria-label="Yes">✓</span>
                          ) : (
                            <span className="text-muted-foreground" aria-label="No">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground capitalize">
                          {rec.source}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
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
  linkLabel,
  onLinkClick,
  tooltip,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
  changePct?: number | null;
  loading?: boolean;
  linkLabel?: string;
  /** Switches to another tab in-page — Stats lives inside the Reports page. */
  onLinkClick?: () => void;
  tooltip?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/70 bg-card p-3 shadow-sm sm:p-4">
      <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium uppercase tracking-wide">
        <Icon className="h-3.5 w-3.5" />
        {label}
        {tooltip && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3 w-3 cursor-default shrink-0" />
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="max-w-[260px] text-left"
              >
                {tooltip}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
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
      {linkLabel && onLinkClick && (
        <div className="mt-2 pt-2 border-t border-border">
          <button
            type="button"
            onClick={onLinkClick}
            className="text-xs text-primary hover:underline font-medium"
            data-testid="forecast-view-details-link"
          >
            {linkLabel} →
          </button>
        </div>
      )}
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
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  loading?: boolean;
  error?: boolean;
  empty?: boolean;
  emptyTestId?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`min-w-0 rounded-xl border border-border/70 bg-card p-4 shadow-sm sm:p-5${className ? ` ${className}` : ""}`}>
      <div className="mb-3">
        <div className="text-sm font-semibold tracking-tight">{title}</div>
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
