// Stats & Analytics — mobile parity for the desktop Stats dashboard.
//
// Read-only, billing-role gated (owner/admin/billing — the server enforces
// BILLING_ROLES on every /api/stats/* endpoint via requireAnyRole). Uses the
// generated hooks, which return the `{ ok, data }` envelope, so every read is
// `query.data?.data?.X`. Charts are lightweight View-based bars (no charting
// library on mobile).
import React, { useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  useGetStatsSummary,
  getGetStatsSummaryQueryKey,
  useGetStatsCaseCategories,
  getGetStatsCaseCategoriesQueryKey,
  useGetStatsRevenueSeries,
  getGetStatsRevenueSeriesQueryKey,
  useGetStatsWeekdayVolume,
  getGetStatsWeekdayVolumeQueryKey,
  useGetStatsRemakes,
  getGetStatsRemakesQueryKey,
  useGetStatsSalesForecast,
  getGetStatsSalesForecastQueryKey,
  useGetInvoiceDiscountsReport,
  type StatsCaseCategory,
} from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { DateField } from "@/components/DateField";
import { getJson } from "@/lib/read-api";
import {
  useMe,
  canEditAnyLab,
  editableLabMemberships,
  adminLabMemberships,
  ownerLabMemberships,
} from "@/lib/auth-me";
import {
  formatCalendarDate,
  formatMoney,
  toNumber,
} from "@/lib/format";
import { usHolidayNameMap, formatExcludedDate } from "@/lib/us-holidays";
import type { StatsSummaryResultDataExcludedDays } from "@workspace/api-client-react";

const REVENUE_COLOR_RED = "#ef4444";
const REVENUE_COLOR_YELLOW = "#eab308";
const REVENUE_COLOR_GREEN = "#22c55e";

const DEFAULT_REVENUE_THRESHOLDS: Record<string, [number, number]> = {
  day: [3_000, 4_200],
  week: [15_000, 21_000],
  month: [85_000, 95_000],
  year: [85_000, 95_000],
};

function revenueBarColor(
  value: number,
  gb: string,
  thresholds?: Record<string, [number, number]>,
): string {
  const src = thresholds ?? DEFAULT_REVENUE_THRESHOLDS;
  const [lo, hi] = src[gb] ?? src.month ?? [85_000, 95_000];
  if (value > hi) return REVENUE_COLOR_GREEN;
  if (value >= lo) return REVENUE_COLOR_YELLOW;
  return REVENUE_COLOR_RED;
}

function fmtThresholdK(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v}`;
}

function buildRevenueLegend(
  gb: string,
  thresholds: Record<string, [number, number]>,
): ReadonlyArray<{ color: string; label: string }> {
  const [lo, hi] = thresholds[gb] ?? thresholds.month ?? [85_000, 95_000];
  return [
    { color: REVENUE_COLOR_RED, label: `< ${fmtThresholdK(lo)}` },
    { color: REVENUE_COLOR_YELLOW, label: `${fmtThresholdK(lo)}–${fmtThresholdK(hi)}` },
    { color: REVENUE_COLOR_GREEN, label: `> ${fmtThresholdK(hi)}` },
  ];
}

const REMAKE_REASON_OPTIONS: Array<{ key: string; label: string }> = [
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
];

// ── Date-range presets ──────────────────────────────────────────────────────
// Each preset also picks the revenue-series bucket size so the chart stays
// readable (daily bars for a month, monthly bars for a year).
type PresetKey = "month" | "30d" | "quarter" | "year" | "12mo";
type GroupBy = "day" | "week" | "month" | "year";

const PRESETS: Array<{ key: PresetKey; label: string; groupBy: GroupBy }> = [
  { key: "month", label: "This month", groupBy: "day" },
  { key: "30d", label: "30 days", groupBy: "day" },
  { key: "quarter", label: "Quarter", groupBy: "week" },
  { key: "year", label: "This year", groupBy: "month" },
  { key: "12mo", label: "12 months", groupBy: "month" },
];

// The "Custom" chip lives alongside the presets; it swaps the preset range for
// two user-chosen calendar dates (via the shared DateField picker).
type RangeKey = PresetKey | "custom";

function rangeForPreset(key: PresetKey): { from: string; to: string } {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  let start: Date;
  if (key === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (key === "30d") {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
  } else if (key === "quarter") {
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
    start = new Date(now.getFullYear(), qStartMonth, 1);
  } else if (key === "year") {
    start = new Date(now.getFullYear(), 0, 1);
  } else {
    // 12mo — trailing twelve months (start of the month 11 months back).
    start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  }
  start.setHours(0, 0, 0, 0);
  return { from: start.toISOString(), to: end.toISOString() };
}

// Convert a date-only "YYYY-MM-DD" string into a local start-of-day (or
// end-of-day) ISO timestamp — mirrors the preset boundaries so the server sees
// the same inclusive window it does for a preset.
function ymdToIso(value: string, endOfDay: boolean): string | null {
  const [y, m, d] = value.split("-").map((n) => Number(n));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return null;
  if (endOfDay) dt.setHours(23, 59, 59, 999);
  else dt.setHours(0, 0, 0, 0);
  return dt.toISOString();
}

function todayYmd(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(
    n.getDate(),
  ).padStart(2, "0")}`;
}

function monthStartYmd(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-01`;
}

// Auto-derive the revenue-chart bucket size from how long the custom window is,
// so a few days show daily bars and a multi-year window shows monthly bars.
function groupByForRange(fromIso: string, toIso: string): GroupBy {
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return "month";
  const days = Math.abs(toMs - fromMs) / 86_400_000;
  if (days <= 62) return "day";
  if (days <= 190) return "week";
  return "month";
}

// Given a revenue bucket's `periodStart` (a UTC-midnight ISO stamp encoding
// the local start of the bucket) and the group size, return the local
// created-date window [from, to] for that single bar so tapping it drills the
// Cases list into just that day/week/month/year.
function bucketWindow(
  periodStart: string | null | undefined,
  groupBy: GroupBy,
): { createdFrom: string; createdTo: string } | null {
  if (!periodStart) return null;
  const d = new Date(periodStart);
  if (Number.isNaN(d.getTime())) return null;
  // periodStart was built from Date.UTC(localY, localM, localD), so read it
  // back in UTC and rebuild as a local Date to get the intended calendar day.
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const from = new Date(y, m, day);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  if (groupBy === "day") {
    // to stays on the same day
  } else if (groupBy === "week") {
    to.setDate(to.getDate() + 6);
  } else if (groupBy === "month") {
    to.setMonth(to.getMonth() + 1, 0);
  } else {
    to.setFullYear(to.getFullYear() + 1, 0, 0);
  }
  to.setHours(23, 59, 59, 999);
  return { createdFrom: from.toISOString(), createdTo: to.toISOString() };
}

const CATEGORY_OPTIONS: Array<{ key: StatsCaseCategory; label: string }> = [
  { key: "implants", label: "Implants" },
  { key: "zirconia", label: "Zirconia" },
  { key: "crown_bridge", label: "Crown & Bridge" },
  { key: "removable", label: "Removable" },
  { key: "other", label: "Other" },
  { key: "uncategorized", label: "Uncategorized" },
];

const CASE_CATEGORY_COLORS: Record<string, string> = {
  implants: "hsl(262 60% 55%)",
  zirconia: "hsl(199 80% 45%)",
  crown_bridge: "hsl(150 55% 42%)",
  removable: "hsl(32 90% 52%)",
  other: "hsl(220 10% 55%)",
  uncategorized: "hsl(220 10% 75%)",
};

const CASE_TYPE_BAR_COLORS: Record<string, string> = {
  Restorative: "hsl(150 55% 42%)",
  Removable: "hsl(32 90% 52%)",
  Implant: "hsl(199 80% 45%)",
  Other: "hsl(220 10% 55%)",
  Appliance: "hsl(262 60% 55%)",
};

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function formatRemakeRate(totalRemakes: number, totalCases: number): string {
  if (totalCases === 0) return "—";
  const rate = (totalRemakes / totalCases) * 100;
  if (rate > 0 && rate < 0.1) return "< 0.1%";
  return `${rate.toFixed(1)}%`;
}

export default function StatsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const meQuery = useMe();
  const me = meQuery.data;

  // Labs the user holds a billing-or-better role on — mirrors the server's
  // BILLING_ROLES gate exactly, so the screen never loads data the server
  // would refuse.
  const billingLabs = useMemo(() => {
    const seen = new Set<string>();
    return editableLabMemberships(me)
      .filter((m) => {
        if (seen.has(m.organizationId)) return false;
        seen.add(m.organizationId);
        return true;
      })
      .map((m) => ({
        id: m.organizationId,
        name:
          (typeof m.organization?.name === "string" && m.organization.name) ||
          "Lab",
      }));
  }, [me]);
  const canView = canEditAnyLab(me);

  const [orgIdOverride, setOrgIdOverride] = useState<string | null>(null);
  const orgId =
    orgIdOverride && billingLabs.some((l) => l.id === orgIdOverride)
      ? orgIdOverride
      : (billingLabs[0]?.id ?? null);

  // Fetch org settings to read per-lab revenue target thresholds.
  const orgSettingsQuery = useQuery<{ revenueTargetLow?: number | null; revenueTargetHigh?: number | null }>({
    queryKey: ["org-settings", orgId ?? ""],
    queryFn: async () => {
      const data = await getJson<{ data: { revenueTargetLow?: number | null; revenueTargetHigh?: number | null } }>(
        `/api/organizations/${orgId!}`,
      );
      return data.data ?? data;
    },
    staleTime: 60_000,
    enabled: !!orgId && canView,
  });
  // Monthly thresholds from org, with fallback to defaults.
  const orgMonthlyLow = orgSettingsQuery.data?.revenueTargetLow ?? 85_000;
  const orgMonthlyHigh = orgSettingsQuery.data?.revenueTargetHigh ?? 95_000;
  // Derive per-groupby thresholds by scaling from the monthly target.
  const resolvedThresholds: Record<string, [number, number]> = useMemo(() => ({
    day: [Math.round(orgMonthlyLow / 28), Math.round(orgMonthlyHigh / 28)],
    week: [Math.round(orgMonthlyLow / 4.33), Math.round(orgMonthlyHigh / 4.33)],
    month: [orgMonthlyLow, orgMonthlyHigh],
    year: [orgMonthlyLow, orgMonthlyHigh],
  }), [orgMonthlyLow, orgMonthlyHigh]);

  // Remakes are owner/admin-only (server enforces ADMIN_ROLES on
  // /api/stats/remakes) — gate on the SELECTED org so a billing-only role on
  // the current lab never sees the section even if the user admins another.
  const isAdminForOrg = useMemo(
    () => adminLabMemberships(me).some((m) => m.organizationId === orgId),
    [me, orgId],
  );

  // Forecast is owner-only (server enforces OWNER_ROLES on
  // GET /stats/sales-forecast) — gate on the SELECTED org.
  const isOwnerForOrg = useMemo(
    () => ownerLabMemberships(me).some((m) => m.organizationId === orgId),
    [me, orgId],
  );

  // Admin or owner on the selected org — Day/Week toggle is gated on this.
  const isAdminOrOwnerForOrg = isAdminForOrg || isOwnerForOrg;

  const [rangeKey, setRangeKey] = useState<RangeKey>("month");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");
  const [category, setCategory] = useState<StatsCaseCategory | "">("");

  // Seed the custom dates from the current preset window the first time the
  // user opens Custom, so there's always a valid range to start from.
  function selectRange(key: RangeKey) {
    if (key === "custom" && (!customFrom || !customTo)) {
      setCustomFrom(monthStartYmd());
      setCustomTo(todayYmd());
    }
    setRangeKey(key);
  }

  // Recompute only when inputs change — a fresh `new Date()` each render would
  // churn the query key on every render. Custom dates are date-only strings, so
  // a stray inverted range is auto-swapped before it hits the queries.
  const range = useMemo(() => {
    if (rangeKey === "custom") {
      const lo = customFrom && customTo && customFrom > customTo ? customTo : customFrom;
      const hi = customFrom && customTo && customFrom > customTo ? customFrom : customTo;
      const from = ymdToIso(lo, false);
      const to = ymdToIso(hi, true);
      if (from && to) return { from, to };
      return rangeForPreset("month");
    }
    return rangeForPreset(rangeKey);
  }, [rangeKey, customFrom, customTo]);

  const autoGroupBy = useMemo<GroupBy>(() => {
    if (rangeKey === "custom") return groupByForRange(range.from, range.to);
    return PRESETS.find((p) => p.key === rangeKey)?.groupBy ?? "month";
  }, [rangeKey, range.from, range.to]);

  // Admin/owner can override the auto groupBy with a Day/Week toggle when the
  // range is short enough to show meaningful sub-month bars (≤62 days).
  const [chartGroupByOverride, setChartGroupByOverride] = useState<"day" | "week" | null>(null);

  // Reset override whenever the auto groupBy changes so stale overrides don't
  // survive switching to a long range (e.g. "Year" → only monthly makes sense).
  const prevAutoGroupBy = React.useRef(autoGroupBy);
  if (prevAutoGroupBy.current !== autoGroupBy) {
    prevAutoGroupBy.current = autoGroupBy;
    if (chartGroupByOverride !== null) setChartGroupByOverride(null);
  }

  const showRevenueToggle =
    isAdminOrOwnerForOrg && (autoGroupBy === "day" || autoGroupBy === "week");

  const groupBy: GroupBy =
    showRevenueToggle && chartGroupByOverride !== null
      ? chartGroupByOverride
      : autoGroupBy;

  const timeZone = useMemo(() => localTimeZone(), []);

  const baseParams = {
    organizationId: orgId ?? "",
    dateFrom: range.from,
    dateTo: range.to,
    timeZone,
    ...(category ? { category } : {}),
  };
  const enabled = canView && !!orgId;

  const summaryQuery = useGetStatsSummary(baseParams, {
    query: { queryKey: getGetStatsSummaryQueryKey(baseParams), enabled },
  });
  const categoriesQuery = useGetStatsCaseCategories(baseParams, {
    query: { queryKey: getGetStatsCaseCategoriesQueryKey(baseParams), enabled },
  });
  const revenueParams = { ...baseParams, groupBy };
  const revenueQuery = useGetStatsRevenueSeries(revenueParams, {
    query: { queryKey: getGetStatsRevenueSeriesQueryKey(revenueParams), enabled },
  });
  const discountParams = {
    organizationId: orgId ?? "",
    dateFrom: range.from,
    dateTo: range.to,
    timeZone,
    groupBy: groupBy === "year" ? "month" as const : groupBy,
  };
  const discountsQuery = useGetInvoiceDiscountsReport(discountParams, {
    query: {
      queryKey: ["invoices", "reports", "discounts", discountParams],
      enabled,
    },
  });
  const weekdayQuery = useGetStatsWeekdayVolume(baseParams, {
    query: { queryKey: getGetStatsWeekdayVolumeQueryKey(baseParams), enabled },
  });

  // Remake-specific filter state (separate from main category/material filters).
  const [remakeReasonKey, setRemakeReasonKey] = useState<string>("");
  const [remakeRecharged, setRemakeRecharged] = useState<"yes" | "no" | "">("");
  const [remakeReturnedToLab, setRemakeReturnedToLab] = useState<"yes" | "no" | "">("");
  const [remakeCat, setRemakeCat] = useState<"crown_bridge" | "removable" | "implant" | "">("");
  const [remakeGroupBy, setRemakeGroupBy] = useState<"week" | "month">("week");

  // Remakes: date-range + optional filters, owner/admin-only (server enforces).
  const remakesParams = {
    organizationId: orgId ?? "",
    dateFrom: range.from,
    dateTo: range.to,
    timeZone,
    groupBy: remakeGroupBy,
    ...(remakeReasonKey ? { reasonKey: remakeReasonKey } : {}),
    ...(remakeRecharged ? { recharged: remakeRecharged } : {}),
    ...(remakeReturnedToLab ? { returnedToLab: remakeReturnedToLab } : {}),
    ...(remakeCat ? { remakeCategory: remakeCat } : {}),
  };
  const remakesQuery = useGetStatsRemakes(remakesParams, {
    query: {
      queryKey: getGetStatsRemakesQueryKey(remakesParams),
      enabled: isAdminForOrg && !!orgId,
    },
  });

  // Sales forecast: owner-only (server enforces OWNER_ROLES on
  // GET /stats/sales-forecast). No date-range param — always current period.
  const forecastParams = { organizationId: orgId ?? "", timeZone };
  const forecastQuery = useGetStatsSalesForecast(forecastParams, {
    query: {
      queryKey: getGetStatsSalesForecastQueryKey(forecastParams),
      enabled: isOwnerForOrg && !!orgId,
    },
  });
  const forecastMonth = forecastQuery.data?.data?.month;
  const forecastYear = forecastQuery.data?.data?.year;

  const summary = summaryQuery.data?.data;
  const categories = categoriesQuery.data?.data;
  const revenue = revenueQuery.data?.data;
  const discounts = discountsQuery.data?.data;
  const weekday = weekdayQuery.data?.data;
  const remakes = remakesQuery.data?.data;

  const refreshing =
    summaryQuery.isFetching ||
    categoriesQuery.isFetching ||
    revenueQuery.isFetching ||
    discountsQuery.isFetching ||
    weekdayQuery.isFetching ||
    remakesQuery.isFetching ||
    forecastQuery.isFetching;

  function refetchAll() {
    void summaryQuery.refetch();
    void categoriesQuery.refetch();
    void revenueQuery.refetch();
    void discountsQuery.refetch();
    void weekdayQuery.refetch();
    if (isAdminForOrg) void remakesQuery.refetch();
    if (isOwnerForOrg) void forecastQuery.refetch();
  }

  // Navigate to the Cases list pre-filtered to a category and/or created-date
  // window, turning a stat bar into a drill-down. `createdFrom`/`createdTo`
  // default to the currently selected range so the list matches the chart.
  function drillIntoCases(opts: {
    category?: StatsCaseCategory;
    createdFrom?: string;
    createdTo?: string;
  }) {
    router.push({
      pathname: "/(tabs)",
      params: {
        ...(opts.category ? { category: opts.category } : {}),
        createdFrom: opts.createdFrom ?? range.from,
        createdTo: opts.createdTo ?? range.to,
      },
    } as never);
  }

  const blocked = !meQuery.isLoading && !canView;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          style={styles.backBtn}
          onPress={() => router.back()}
          hitSlop={8}
          testID="stats-back"
        >
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            Stats
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            Case volume and sales trends
          </Text>
        </View>
      </View>

      {meQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : blocked ? (
        <View style={styles.center} testID="stats-blocked">
          <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Not available</Text>
          <Text style={styles.emptyBody}>
            Stats are available to lab owners, admins, and billing members.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refetchAll}
              tintColor={colors.tint}
            />
          }
        >
          {billingLabs.length > 1 ? (
            <ChipRow
              styles={styles}
              options={billingLabs.map((l) => ({ key: l.id, label: l.name }))}
              selected={orgId ?? ""}
              onSelect={(k) => setOrgIdOverride(k)}
              testIDPrefix="stats-org"
            />
          ) : null}

          <View style={styles.filtersCard}>
            <Text style={styles.filtersTitle}>Analytics filters</Text>
            <View style={styles.filterGroup}>
              <Text style={styles.filterLabel}>Date range</Text>
              <ChipRow
                styles={styles}
                options={[
                  ...PRESETS.map((p) => ({ key: p.key as string, label: p.label })),
                  { key: "custom", label: "Custom" },
                ]}
                selected={rangeKey}
                onSelect={(k) => selectRange(k as RangeKey)}
                testIDPrefix="stats-range"
              />
            </View>

            {rangeKey === "custom" ? (
              <View style={styles.customRange} testID="stats-custom-range">
                <View style={styles.customField}>
                  <Text style={styles.customLabel}>Start</Text>
                  <DateField
                    value={customFrom}
                    onChange={setCustomFrom}
                    title="Start date"
                    placeholder="Start date"
                    testID="stats-custom-from"
                  />
                </View>
                <View style={styles.customField}>
                  <Text style={styles.customLabel}>End</Text>
                  <DateField
                    value={customTo}
                    onChange={setCustomTo}
                    title="End date"
                    placeholder="End date"
                    testID="stats-custom-to"
                  />
                </View>
              </View>
            ) : null}

            <View style={styles.filterGroup}>
              <Text style={styles.filterLabel}>Case category</Text>
              <ChipRow
                styles={styles}
                options={[
                  { key: "", label: "All categories" },
                  ...CATEGORY_OPTIONS.map((c) => ({ key: c.key as string, label: c.label })),
                ]}
                selected={category}
                onSelect={(k) => setCategory(k as StatsCaseCategory | "")}
                testIDPrefix="stats-category"
              />
            </View>
          </View>

          {/* ── Summary metrics ─────────────────────────────────────── */}
          <Text style={styles.sectionTitle}>Overview</Text>
          <View style={styles.metricGrid} testID="stats-summary">
            <MetricTile
              styles={styles}
              colors={colors}
              icon="layers-outline"
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
            <MetricTile
              styles={styles}
              colors={colors}
              icon="cash-outline"
              label="Total sales"
              value={summary ? formatMoney(summary.totalRevenue) : "—"}
              sub={summary ? `${summary.invoiceCount} invoices` : undefined}
              changePct={summary?.previousPeriod?.revenueChangePct ?? null}
              loading={summaryQuery.isLoading}
            />
            <MetricTile
              styles={styles}
              colors={colors}
              icon="pricetag-outline"
              label="Discounts given"
              value={
                discounts
                  ? formatMoney(discounts.totals.amount)
                  : discountsQuery.isError
                    ? "Unavailable"
                    : "—"
              }
              sub={
                discounts
                  ? discounts.totals.count === 0
                    ? "No discounts in this range"
                    : `${discounts.totals.count} invoices with discounts`
                  : undefined
              }
              loading={discountsQuery.isLoading}
            />
            <MetricTile
              styles={styles}
              colors={colors}
              icon="trending-up-outline"
              label="Avg daily sales"
              value={summary ? formatMoney(summary.averageDailyRevenue ?? "0") : "—"}
              sub={
                summary?.salesCutoffDate
                  ? `thru ${summary.salesCutoffDate}`
                  : undefined
              }
              loading={summaryQuery.isLoading}
              infoText={buildExcludedDaysText(summary?.excludedDays)}
              infoTestID="stats-avg-daily-info"
              infoEntries={buildExcludedDaysEntries(summary?.excludedDays ?? null)}
              onManagePress={isAdminForOrg ? () => router.push("/manage/closed-days" as never) : undefined}
            />
            <MetricTile
              styles={styles}
              colors={colors}
              icon="pulse-outline"
              label="Avg case value"
              value={summary ? formatMoney(summary.averageCaseValue) : "—"}
              loading={summaryQuery.isLoading}
            />
            {isAdminForOrg && (
              <MetricTile
                styles={styles}
                colors={colors}
                icon="time-outline"
                label="Avg turnaround"
                value={
                  summary?.avgTurnaroundDays != null
                    ? `${summary.avgTurnaroundDays.toFixed(1)} days`
                    : "—"
                }
                sub={
                  summary?.eligibleTurnaroundCaseCount != null
                    ? `${summary.eligibleTurnaroundCaseCount} eligible cases`
                    : undefined
                }
                loading={summaryQuery.isLoading}
              />
            )}
            <MetricTile
              styles={styles}
              colors={colors}
              icon="bar-chart-outline"
              label="Top case type"
              value={summary?.topCategoryLabel ?? "—"}
              sub={
                summary?.topCategoryCount
                  ? `${summary.topCategoryCount} cases`
                  : undefined
              }
              loading={summaryQuery.isLoading}
            />
            <MetricTile
              styles={styles}
              colors={colors}
              icon="calendar-outline"
              label="Busiest weekday"
              value={summary?.busiestWeekdayLabel ?? "—"}
              loading={summaryQuery.isLoading}
            />
            <MetricTile
              styles={styles}
              colors={colors}
              icon="trending-up-outline"
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
            {isOwnerForOrg && (
              <MetricTile
                styles={styles}
                colors={colors}
                icon="trending-up-outline"
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
                onPress={() => router.push("/manage/sales-forecast" as never)}
              />
            )}
            {isOwnerForOrg && (
              <MetricTile
                styles={styles}
                colors={colors}
                icon="trending-up-outline"
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
          </View>
          {summaryQuery.isError ? (
            <Text style={styles.inlineError} testID="stats-summary-error">
              Could not load summary metrics. Pull to refresh and try again.
            </Text>
          ) : null}

          {/* ── Sales over time ─────────────────────────────────────── */}
          <ChartCard
            styles={styles}
            title={
              groupBy === "day"
                ? "Daily revenue"
                : groupBy === "week"
                  ? "Weekly revenue"
                  : "Sales over time"
            }
            subtitle={
              showRevenueToggle ? (
                <View style={styles.revenueToggleRow}>
                  {(["day", "week"] as const).map((g) => {
                    const active = groupBy === g;
                    return (
                      <Pressable
                        key={g}
                        onPress={() =>
                          setChartGroupByOverride(
                            chartGroupByOverride === g ? null : g,
                          )
                        }
                        style={[
                          styles.revenueToggleBtn,
                          active && {
                            backgroundColor: colors.tint,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.revenueToggleBtnText,
                            active && { color: "#fff" },
                          ]}
                        >
                          {g === "day" ? "Day" : "Week"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                "Invoiced revenue by period"
              )
            }
            loading={revenueQuery.isLoading}
            error={revenueQuery.isError}
            empty={!revenue || revenue.series.length === 0}
            emptyTestID="stats-revenue-empty"
          >
            {revenue && revenue.series.length > 0 ? (
              <>
                <VerticalBars
                  colors={colors}
                  bars={revenue.series.map((s) => {
                    const val = toNumber(s.revenue);
                    return {
                      key: s.period,
                      value: val,
                      color: revenueBarColor(val, groupBy, resolvedThresholds),
                      onPress: () => {
                        const win = bucketWindow(s.periodStart, groupBy);
                        if (win) drillIntoCases(win);
                      },
                    };
                  })}
                  firstLabel={revenue.series[0]?.period ?? ""}
                  lastLabel={revenue.series[revenue.series.length - 1]?.period ?? ""}
                  styles={styles}
                />
                {/* Threshold legend */}
                <View style={styles.revenueThresholdLegend}>
                  {buildRevenueLegend(groupBy, resolvedThresholds).map((item) => (
                    <View key={item.label} style={styles.revenueThresholdItem}>
                      <View
                        style={[
                          styles.revenueThresholdDot,
                          { backgroundColor: item.color },
                        ]}
                      />
                      <Text style={styles.revenueThresholdLabel}>{item.label}</Text>
                    </View>
                  ))}
                </View>
                <Text style={styles.chartFootnote}>
                  {formatMoney(revenue.totals.revenue)} total ·{" "}
                  {revenue.totals.invoiceCount} invoices · avg{" "}
                  {formatMoney(revenue.totals.averageInvoice)}
                </Text>
              </>
            ) : null}
          </ChartCard>

          {/* ── Cases by category ───────────────────────────────────── */}
          <ChartCard
            styles={styles}
            title="Cases by category"
            subtitle="Canonical + legacy cases"
            loading={categoriesQuery.isLoading}
            error={categoriesQuery.isError}
            empty={!categories || categories.totalCases === 0}
            emptyTestID="stats-categories-empty"
          >
            {categories && categories.totalCases > 0 ? (
              <HorizontalBars
                styles={styles}
                colors={colors}
                rows={categories.categories
                  .filter((c) => c.count > 0)
                  .map((c) => ({
                    label: c.label,
                    value: c.count,
                    onPress: () => drillIntoCases({ category: c.category }),
                  }))}
              />
            ) : null}
          </ChartCard>

          {/* ── Material breakdown ──────────────────────────────────── */}
          <ChartCard
            styles={styles}
            title="Material breakdown"
            subtitle="Units by normalized material"
            loading={categoriesQuery.isLoading}
            error={categoriesQuery.isError}
            empty={!categories || categories.materials.length === 0}
            emptyTestID="stats-materials-empty"
          >
            {categories && categories.materials.length > 0 ? (
              <HorizontalBars
                styles={styles}
                colors={colors}
                rows={categories.materials
                  .slice(0, 8)
                  .map((m) => ({ label: m.material, value: m.units }))}
              />
            ) : null}
          </ChartCard>

          {/* ── Case type breakdown ─────────────────────────────────── */}
          <ChartCard
            styles={styles}
            title="Case type breakdown"
            subtitle="Cases by type (canonical only)"
            loading={categoriesQuery.isLoading}
            error={categoriesQuery.isError}
            empty={!categories || !categories.caseTypes || categories.caseTypes.length === 0}
            emptyTestID="stats-casetypes-empty"
          >
            {categories && categories.caseTypes && categories.caseTypes.length > 0 ? (
              <HorizontalBars
                styles={styles}
                colors={colors}
                rows={categories.caseTypes.map((t) => ({
                  label: t.label,
                  value: t.count,
                  color: CASE_TYPE_BAR_COLORS[t.label],
                }))}
              />
            ) : null}
          </ChartCard>

          {/* ── Weekday volume ──────────────────────────────────────── */}
          <ChartCard
            styles={styles}
            title="Case volume by weekday"
            subtitle="Cases received per weekday"
            loading={weekdayQuery.isLoading}
            error={weekdayQuery.isError}
            empty={!weekday || weekday.totalCases === 0}
            emptyTestID="stats-weekday-empty"
          >
            {weekday && weekday.totalCases > 0 ? (
              <View style={styles.weekdayRow}>
                {weekday.weekdays.map((d) => {
                  const max = Math.max(...weekday.weekdays.map((w) => w.total), 1);
                  const values = CATEGORY_OPTIONS.map((option) => ({
                    key: option.key,
                    value: d.byCategory?.[option.key] ?? 0,
                    color: CASE_CATEGORY_COLORS[option.key],
                  })).filter((segment) => segment.value > 0);
                  const categorizedTotal = values.reduce((sum, segment) => sum + segment.value, 0);
                  const segments =
                    categorizedTotal === 0 && d.total > 0
                      ? [{ key: "all", value: d.total, color: colors.tint }]
                      : values;
                  const unclassified = Math.max(0, d.total - categorizedTotal);
                  if (unclassified > 0 && categorizedTotal > 0) {
                    segments.push({
                      key: "unclassified",
                      value: unclassified,
                      color: CASE_CATEGORY_COLORS.uncategorized,
                    });
                  }
                  return (
                    <View key={d.weekday} style={styles.weekdayCol} testID={`stats-weekday-bar-${d.weekday}`}>
                      <Text style={styles.weekdayCount}>{d.total || ""}</Text>
                      <View style={styles.weekdayBarTrack} accessibilityLabel={`${d.total} cases on ${d.label}`}>
                        <View style={styles.weekdayBarStack}>
                          {segments.map((segment) => (
                            <View
                              key={segment.key}
                              style={[
                                styles.weekdayBarSegment,
                                {
                                  height: `${Math.max(0, (segment.value / max) * 100)}%`,
                                  backgroundColor: segment.color,
                                },
                              ]}
                            />
                          ))}
                        </View>
                      </View>
                      <Text style={styles.weekdayLabel}>{d.label.slice(0, 3)}</Text>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </ChartCard>

          {/* ── Remakes (owner/admin only) ──────────────────────────────────────────── */}
          {isAdminForOrg && (
            <View testID="stats-remakes">
              <View style={styles.remakeSectionHeader}>
                <Ionicons name="refresh-outline" size={19} color={colors.tint} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.sectionTitle}>Remakes</Text>
                  <Text style={styles.chartSubtitle}>Remade cases received in this period</Text>
                </View>
              </View>
              {/* Remake filter chips */}
              <View style={styles.remakeTotalCard}>
                <Text style={styles.remakeTitle}>Filters</Text>
                <View style={styles.remakeFiltersGrid}>
                  <View style={styles.remakeFilterCell}>
                    <Text style={styles.filterLabel}>Trend by</Text>
                    <ChipRow styles={styles} options={[{ key: "week", label: "Week" }, { key: "month", label: "Month" }]} selected={remakeGroupBy} onSelect={(k) => setRemakeGroupBy(k as "week" | "month")} testIDPrefix="remake-groupby" />
                  </View>
                  <View style={styles.remakeFilterCell}>
                    <Text style={styles.filterLabel}>Category</Text>
                    <ChipRow styles={styles} options={[{ key: "", label: "All" }, { key: "crown_bridge", label: "Crown & Bridge" }, { key: "removable", label: "Removable" }, { key: "implant", label: "Implant" }]} selected={remakeCat} onSelect={(k) => setRemakeCat(k as "crown_bridge" | "removable" | "implant" | "")} testIDPrefix="remake-cat" />
                  </View>
                  <View style={styles.remakeFilterCell}>
                    <Text style={styles.filterLabel}>Recharged</Text>
                    <ChipRow styles={styles} options={[{ key: "", label: "All" }, { key: "yes", label: "Recharged" }, { key: "no", label: "Not recharged" }]} selected={remakeRecharged} onSelect={(k) => setRemakeRecharged(k as "yes" | "no" | "")} testIDPrefix="remake-recharged" />
                  </View>
                  <View style={styles.remakeFilterCell}>
                    <Text style={styles.filterLabel}>Returned to lab</Text>
                    <ChipRow styles={styles} options={[{ key: "", label: "All" }, { key: "yes", label: "Returned" }, { key: "no", label: "Not returned" }]} selected={remakeReturnedToLab} onSelect={(k) => setRemakeReturnedToLab(k as "yes" | "no" | "")} testIDPrefix="remake-returned" />
                  </View>
                  <View style={[styles.remakeFilterCell, styles.remakeReasonFilter]}>
                    <Text style={styles.filterLabel}>Reason</Text>
                    <ChipRow styles={styles} options={[{ key: "", label: "All" }, ...REMAKE_REASON_OPTIONS]} selected={remakeReasonKey} onSelect={setRemakeReasonKey} testIDPrefix="remake-reason" />
                  </View>
                </View>
              </View>

              {/* Summary totals */}
              <View style={styles.remakeMetricGrid} testID="stats-remakes-summary">
                {remakesQuery.isLoading ? (
                  <View style={styles.remakeMetricCard}><ActivityIndicator style={styles.remakeSpinner} /></View>
                ) : remakesQuery.isError ? (
                  <Text style={styles.chartStateText} testID="stats-remakes-error">Could not load remakes. Pull to refresh and try again.</Text>
                ) : !remakes || remakes.totalRemakes === 0 ? (
                  <Text style={[styles.chartStateText, styles.remakeEmpty]} testID="stats-remakes-empty">
                    No remakes in this period
                  </Text>
                ) : (
                  <>
                  <View style={styles.remakeMetricCard}>
                    <Text style={styles.remakeMetricLabel}>Total remakes</Text>
                    <Text style={styles.remakeTotal} testID="stats-remakes-total">
                      {remakes.totalRemakes}
                    </Text>
                    <Text
                      style={styles.remakeSubtitle}
                      testID="stats-remakes-rate"
                    >
                      {(summary?.totalCases ?? 0) === 0
                        ? "—"
                        : `${formatRemakeRate(remakes.totalRemakes, summary!.totalCases)} of ${summary!.totalCases} cases`}
                    </Text>
                  </View>
                  <View style={styles.remakeMetricCard}>
                    <Text style={styles.remakeMetricLabel}>Recharged</Text>
                    <Text style={[styles.remakeSplitValue, { color: colors.success }]}>{remakes.rechargedRemakes}</Text>
                    <Text style={styles.remakeSubtitle}>cases</Text>
                  </View>
                  <View style={styles.remakeMetricCard}>
                    <Text style={styles.remakeMetricLabel}>Not recharged</Text>
                    <Text style={[styles.remakeSplitValue, { color: colors.error }]}>{remakes.nonRechargedRemakes}</Text>
                    <Text style={styles.remakeSubtitle}>cases</Text>
                  </View>
                  </>
                )}
              </View>

              {/* Reasons breakdown */}
              <View style={styles.remakeReasonsCard}>
                <Text style={styles.remakeTitle}>Remake reasons</Text>
                <Text style={styles.remakeSubtitle}>Grouped by reason, most frequent first</Text>
                {remakesQuery.isLoading ? (
                  <ActivityIndicator style={styles.remakeSpinner} />
                ) : remakesQuery.isError ? (
                  <Text style={styles.chartStateText}>Could not load remake reasons.</Text>
                ) : !remakes || remakes.remakeReasons.length === 0 ? (
                  <Text style={styles.chartStateText}>No remakes in this period</Text>
                ) : (
                  <View testID="stats-remakes-reasons">
                    {remakes.remakeReasons.map((r) => {
                      const max = Math.max(...remakes.remakeReasons.map((item) => item.count), 1);
                      return (
                      <View key={r.reason} style={styles.reasonRow}>
                        <Text style={styles.reasonLabel} numberOfLines={2}>
                          {r.reason}
                        </Text>
                        <View style={styles.reasonBarTrack}>
                          <View style={[styles.reasonBarFill, { width: `${Math.max(4, (r.count / max) * 100)}%`, backgroundColor: colors.tint }]} />
                        </View>
                        <Text style={styles.reasonCount}>{r.count}</Text>
                      </View>
                    );})}
                  </View>
                )}
              </View>

              {/* Trend bars */}
              {remakes && remakes.timeSeries.length > 0 && (
                <View style={styles.remakeReasonsCard}>
                  <Text style={styles.remakeTitle}>
                    Remake trend (per {remakeGroupBy})
                  </Text>
                  {(() => {
                    const max = Math.max(...remakes.timeSeries.map((p) => p.count), 1);
                    return (
                      <View testID="stats-remakes-trend">
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.trendColumnRow}>
                          {remakes.timeSeries.map((p) => (
                            <View key={p.period} style={styles.trendColumn}>
                              <Text style={styles.trendCount}>{p.count}</Text>
                              <View style={styles.trendTrack}>
                                <View style={[styles.trendFill, { height: `${Math.max(p.count > 0 ? 5 : 0, (p.count / max) * 100)}%`, backgroundColor: colors.tint }]} />
                              </View>
                              <Text style={styles.trendLabel} numberOfLines={1}>{p.period}</Text>
                            </View>
                          ))}
                        </ScrollView>
                      </View>
                    );
                  })()}
                </View>
              )}

              {/* Doctor breakdown */}
              {remakes && remakes.byDoctor && remakes.byDoctor.length > 0 && (
                <View style={styles.remakeReasonsCard}>
                  <Text style={styles.remakeTitle}>By doctor</Text>
                  <View testID="stats-remakes-by-doctor">
                    {remakes.byDoctor.slice(0, 10).map((d) => {
                      const max = remakes.byDoctor![0]?.count ?? 1;
                      return (
                        <View key={d.doctorName} style={styles.reasonRow}>
                          <Text style={styles.reasonLabel} numberOfLines={1}>
                            {d.doctorName}
                          </Text>
                          <View style={styles.reasonBarTrack}>
                            <View style={[styles.reasonBarFill, { width: `${(d.count / max) * 100}%`, backgroundColor: colors.tint }]} />
                          </View>
                          <Text style={styles.reasonCount}>{d.count}</Text>
                        </View>
                      );
                    })}
                  </View>
                </View>
              )}

              {/* By type breakdown */}
              {remakes && remakes.byType && remakes.byType.length > 0 && (
                <View style={styles.remakeReasonsCard}>
                  <Text style={styles.remakeTitle}>By type</Text>
                  <View testID="stats-remakes-by-type">
                    {(() => {
                      const TYPE_COLORS: Record<string, string> = {
                        Restorative: "hsl(150 55% 42%)",
                        Removable: "hsl(32 90% 52%)",
                        Implant: "hsl(262 60% 55%)",
                        Other: "hsl(220 10% 55%)",
                      };
                      const max = remakes.byType![0]?.count ?? 1;
                      return remakes.byType!.map((t) => (
                        <View key={t.typeName} style={styles.reasonRow}>
                          <Text style={styles.reasonLabel} numberOfLines={1}>
                            {t.typeName}
                          </Text>
                          <View style={styles.reasonBarTrack}>
                            <View style={[styles.reasonBarFill, { width: `${(t.count / max) * 100}%`, backgroundColor: TYPE_COLORS[t.typeName] ?? "hsl(220 10% 55%)" }]} />
                          </View>
                          <Text style={styles.reasonCount}>{t.count}</Text>
                        </View>
                      ));
                    })()}
                  </View>
                </View>
              )}

              {/* Records list */}
              {remakes && remakes.records.length > 0 && (
                <View style={styles.remakeReasonsCard}>
                  <Text style={styles.remakeTitle}>Remake records</Text>
                  <Text style={styles.remakeSubtitle}>Newest first</Text>
                  <View testID="stats-remakes-records">
                    {remakes.records.map((rec) => (
                      <Pressable
                        key={rec.id}
                        style={styles.remakeRecordRow}
                        testID={`stats-remake-record-${rec.id}`}
                        onPress={() => router.push({ pathname: "/cases/[id]", params: { id: rec.id } } as never)}
                      >
                        <View style={{ flex: 1 }}>
                          {rec.doctorName ? (
                            <Text style={[styles.remakeRecordCase, { fontSize: 13 }]} numberOfLines={1}>
                              {rec.doctorName}
                            </Text>
                          ) : null}
                          <Text style={styles.remakeRecordCase}>
                            #{rec.caseNumber}
                            {rec.originalCaseNumber ? (
                              <Text style={styles.remakeRecordMeta}> → #{rec.originalCaseNumber}</Text>
                            ) : null}
                          </Text>
                          <Text style={styles.remakeRecordMeta} numberOfLines={1}>
                            {rec.reason}
                            {rec.category ? ` · ${rec.category.replace("_", " & ")}` : ""}
                          </Text>
                          <Text style={styles.remakeRecordMeta}>
                            {formatCalendarDate(rec.receivedAt)}
                            {" · "}{rec.source}
                          </Text>
                        </View>
                        <View style={{ alignItems: "flex-end", gap: 4 }}>
                          {rec.recharged && (
                            <Text style={[styles.remakeRecordBadge, { backgroundColor: "#d1fae5", color: "#065f46" }]}>
                              Recharged
                            </Text>
                          )}
                          {rec.returnedToLab && (
                            <Text style={[styles.remakeRecordBadge, { backgroundColor: "#dbeafe", color: "#1e40af" }]}>
                              Returned
                            </Text>
                          )}
                        </View>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ── UI pieces ───────────────────────────────────────────────────────────────

type Styles = ReturnType<typeof makeStyles>;

function ChipRow({
  styles,
  options,
  selected,
  onSelect,
  testIDPrefix,
}: {
  styles: Styles;
  options: Array<{ key: string; label: string }>;
  selected: string;
  onSelect: (key: string) => void;
  testIDPrefix: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRow}
    >
      {options.map((o) => {
        const active = o.key === selected;
        return (
          <Pressable
            key={o.key || "all"}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => onSelect(o.key)}
            testID={`${testIDPrefix}-${o.key || "all"}`}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function MetricTile({
  styles,
  colors,
  icon,
  label,
  value,
  sub,
  changePct,
  loading,
  onPress,
  infoText,
  infoTestID,
  infoEntries,
  onManagePress,
}: {
  styles: Styles;
  colors: ThemeColors;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  value: string;
  sub?: string;
  changePct?: number | null;
  loading?: boolean;
  onPress?: () => void;
  infoText?: string;
  infoTestID?: string;
  infoEntries?: Array<{ label: string; name?: string }>;
  onManagePress?: () => void;
}) {
  const [infoExpanded, setInfoExpanded] = useState(false);
  const toggleInfo = useCallback(() => setInfoExpanded((v) => !v), []);
  const hasInfo = !!infoText;
  return (
    <Card style={styles.metricTile} onPress={onPress}>
      <View style={styles.metricHeader}>
        <Ionicons name={icon} size={14} color={colors.textSecondary} />
        <Text style={styles.metricLabel} numberOfLines={1}>
          {label}
        </Text>
        {hasInfo ? (
          <Pressable
            onPress={toggleInfo}
            hitSlop={8}
            testID={infoTestID}
            style={{ marginLeft: "auto" }}
          >
            <Ionicons
              name={infoExpanded ? "information-circle" : "information-circle-outline"}
              size={14}
              color={colors.tint}
            />
          </Pressable>
        ) : onPress ? (
          <Ionicons
            name="chevron-forward"
            size={12}
            color={colors.textTertiary}
            style={{ marginLeft: "auto" }}
          />
        ) : null}
      </View>
      <Text style={styles.metricValue} numberOfLines={1}>
        {loading ? "…" : value}
      </Text>
      <View style={styles.metricSubRow}>
        {typeof changePct === "number" ? (
          <Text
            style={[
              styles.metricChange,
              { color: changePct >= 0 ? "#059669" : "#DC2626" },
            ]}
          >
            {changePct >= 0 ? "▲" : "▼"} {changePct >= 0 ? "+" : ""}
            {changePct}%
          </Text>
        ) : null}
        {sub ? (
          <Text style={styles.metricSub} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {hasInfo && infoExpanded ? (
        <View style={styles.metricInfoPanel}>
          <Text style={styles.metricInfoNote}>{infoText}</Text>
          {infoEntries && infoEntries.length > 0 ? (
            <View style={styles.metricInfoDateList}>
              {infoEntries.map((entry) => (
                <View key={entry.label} style={styles.metricInfoDateRow}>
                  <Text style={styles.metricInfoDateLabel}>{entry.label}</Text>
                  {entry.name ? (
                    <Text style={styles.metricInfoDateNote} numberOfLines={1}>
                      · {entry.name}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
          {onManagePress ? (
            <Pressable
              onPress={onManagePress}
              style={styles.manageClosedDaysBtn}
              testID="stats-manage-closed-days"
            >
              <Ionicons name="calendar-outline" size={12} color={colors.tint} />
              <Text style={[styles.manageClosedDaysBtnText, { color: colors.tint }]}>
                Manage closed days
              </Text>
              <Ionicons name="chevron-forward" size={12} color={colors.tint} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function buildExcludedDaysText(
  excludedDays:
    | { holidayCount: number; customClosedCount: number }
    | undefined
    | null,
): string | undefined {
  if (!excludedDays) return undefined;
  const { holidayCount, customClosedCount } = excludedDays;
  const total = holidayCount + customClosedCount;
  if (total === 0) return undefined;
  const parts: string[] = [];
  if (holidayCount > 0)
    parts.push(`${holidayCount} US federal holiday${holidayCount !== 1 ? "s" : ""}`);
  if (customClosedCount > 0)
    parts.push(
      `${customClosedCount} custom closed day${customClosedCount !== 1 ? "s" : ""}`,
    );
  return `Denominator excludes ${parts.join(" + ")} from the business-day count.`;
}

function buildExcludedDaysEntries(
  excludedDays: StatsSummaryResultDataExcludedDays | undefined | null,
): Array<{ label: string; name?: string }> | undefined {
  if (!excludedDays || excludedDays.dates.length === 0) return undefined;
  const years = [
    ...new Set(excludedDays.dates.map((d) => parseInt(d.date.slice(0, 4), 10))),
  ];
  const nameMap = usHolidayNameMap(years);
  return [...excludedDays.dates]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ date, reason }) => ({
      label: formatExcludedDate(date),
      name: reason === "holiday" ? (nameMap.get(date) ?? "Holiday") : undefined,
    }));
}

function ChartCard({
  styles,
  title,
  subtitle,
  loading,
  error,
  empty,
  emptyTestID,
  children,
}: {
  styles: Styles;
  title: string;
  subtitle?: string | React.ReactNode;
  loading?: boolean;
  error?: boolean;
  empty?: boolean;
  emptyTestID?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card style={styles.chartCard}>
      <Text style={styles.chartTitle}>{title}</Text>
      {subtitle != null
        ? typeof subtitle === "string"
          ? <Text style={styles.chartSubtitle}>{subtitle}</Text>
          : subtitle
        : null}
      <View style={styles.chartBody}>
        {loading ? (
          <Text style={styles.chartStateText}>Loading…</Text>
        ) : error ? (
          <Text style={styles.chartStateText}>
            Couldn’t load this chart. Pull to refresh.
          </Text>
        ) : empty ? (
          <Text style={styles.chartStateText} testID={emptyTestID}>
            No data for this period.
          </Text>
        ) : (
          children
        )}
      </View>
    </Card>
  );
}

function VerticalBars({
  styles,
  colors,
  bars,
  firstLabel,
  lastLabel,
}: {
  styles: Styles;
  colors: ThemeColors;
  bars: Array<{ key: string; value: number; color?: string; onPress?: () => void }>;
  firstLabel: string;
  lastLabel: string;
}) {
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <View>
      <View style={styles.vbarRow}>
        {bars.map((b) => {
          const pct = Math.round((b.value / max) * 100);
          return (
            <Pressable
              key={b.key}
              style={styles.vbarTrack}
              onPress={b.onPress}
              disabled={!b.onPress}
              hitSlop={4}
              testID={`stats-revenue-bar-${b.key}`}
            >
              <View
                style={[
                  styles.vbarFill,
                  {
                    height: `${Math.max(b.value > 0 ? 3 : 0, pct)}%`,
                    backgroundColor: b.color ?? colors.tint,
                  },
                ]}
              />
            </Pressable>
          );
        })}
      </View>
      <View style={styles.vbarLabels}>
        <Text style={styles.vbarLabel}>{firstLabel}</Text>
        <Text style={styles.vbarLabel}>{lastLabel}</Text>
      </View>
    </View>
  );
}

function HorizontalBars({
  styles,
  colors,
  rows,
}: {
  styles: Styles;
  colors: ThemeColors;
  rows: Array<{ label: string; value: number; color?: string; onPress?: () => void }>;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <View style={styles.hbarList}>
      {rows.map((r) => {
        const pct = Math.max(4, Math.round((r.value / max) * 100));
        return (
          <Pressable
            key={r.label}
            style={styles.hbarRow}
            onPress={r.onPress}
            disabled={!r.onPress}
            testID={`stats-category-bar-${r.label}`}
          >
            <Text style={styles.hbarLabel} numberOfLines={1}>
              {r.label}
            </Text>
            <View style={styles.hbarTrack}>
              <View
                style={[
                  styles.hbarFill,
                  { width: `${pct}%`, backgroundColor: r.color ?? colors.tint },
                ]}
              />
            </View>
            <Text style={styles.hbarValue}>{r.value}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
      gap: Spacing.xs,
    },
    backBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    headerText: { flex: 1 },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.sm,
    },
    emptyTitle: { ...Typography.h3, color: c.text, textAlign: "center" },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    content: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.md },
    filtersCard: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
      gap: Spacing.sm,
    },
    filtersTitle: {
      ...Typography.bodySemibold,
      color: c.text,
      paddingHorizontal: Spacing.md,
    },
    filterGroup: { gap: 5 },
    filterLabel: {
      ...Typography.label,
      color: c.textSecondary,
      textTransform: "uppercase",
      paddingHorizontal: Spacing.md,
    },
    sectionTitle: { ...Typography.h3, color: c.text },
    inlineError: {
      ...Typography.caption,
      color: c.error,
      paddingHorizontal: Spacing.xs,
    },
    chipRow: { gap: Spacing.xs, paddingHorizontal: Spacing.md },
    chip: {
      paddingHorizontal: Spacing.md,
      paddingVertical: 7,
      borderRadius: Radius.full,
      backgroundColor: c.surfaceAlt,
    },
    chipActive: { backgroundColor: c.tint },
    chipText: { ...Typography.captionMedium, color: c.textSecondary },
    chipTextActive: { color: c.textInverse },
    customRange: { flexDirection: "row", gap: Spacing.sm },
    customField: { flex: 1, gap: 4 },
    customLabel: {
      ...Typography.label,
      color: c.textSecondary,
      textTransform: "uppercase",
    },
    metricGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: Spacing.sm,
    },
    metricTile: {
      flexBasis: "47%",
      flexGrow: 1,
      gap: 4,
    },
    metricHeader: { flexDirection: "row", alignItems: "center", gap: 5 },
    metricLabel: {
      ...Typography.label,
      color: c.textSecondary,
      textTransform: "uppercase",
      flexShrink: 1,
    },
    metricValue: { ...Typography.h2, color: c.text },
    metricSubRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      minHeight: 16,
    },
    metricChange: { ...Typography.captionSemibold },
    metricSub: { ...Typography.caption, color: c.textSecondary, flexShrink: 1 },
    metricInfoPanel: {
      marginTop: Spacing.xs,
      gap: 4,
    },
    metricInfoNote: {
      ...Typography.caption,
      color: c.textSecondary,
      fontStyle: "italic",
    },
    metricInfoDateList: {
      marginTop: 4,
      gap: 3,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingTop: 6,
    },
    metricInfoDateRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: 4,
    },
    metricInfoDateLabel: {
      ...Typography.caption,
      color: c.text,
      minWidth: 46,
    },
    metricInfoDateNote: {
      ...Typography.caption,
      color: c.textSecondary,
      flexShrink: 1,
    },
    manageClosedDaysBtn: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
      marginTop: Spacing.xs,
      paddingTop: Spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    manageClosedDaysBtnText: {
      ...Typography.caption,
      fontWeight: "600" as const,
      flex: 1,
    },
    chartCard: { gap: 2 },
    chartTitle: { ...Typography.bodySemibold, color: c.text },
    chartSubtitle: { ...Typography.caption, color: c.textSecondary },
    revenueToggleRow: {
      flexDirection: "row" as const,
      gap: 4,
      marginTop: 2,
    },
    revenueToggleBtn: {
      paddingHorizontal: 10,
      paddingVertical: 3,
      borderRadius: 99,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    revenueToggleBtnText: {
      ...Typography.caption,
      color: c.textSecondary,
      fontWeight: "600" as const,
    },
    chartBody: { marginTop: Spacing.sm, minHeight: 60, justifyContent: "center" },
    chartStateText: {
      ...Typography.caption,
      color: c.textTertiary,
      textAlign: "center",
      paddingVertical: Spacing.lg,
    },
    chartFootnote: {
      ...Typography.caption,
      color: c.textSecondary,
      marginTop: Spacing.sm,
      textAlign: "center",
    },
    vbarRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 2,
      height: 140,
    },
    vbarTrack: { flex: 1, height: "100%", justifyContent: "flex-end" },
    vbarFill: { width: "100%", borderRadius: 2 },
    vbarLabels: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginTop: 4,
    },
    vbarLabel: { ...Typography.tiny, color: c.textTertiary },
    revenueThresholdLegend: {
      flexDirection: "row" as const,
      justifyContent: "center" as const,
      gap: Spacing.md,
      marginTop: Spacing.sm,
    },
    revenueThresholdItem: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 5,
    },
    revenueThresholdDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    revenueThresholdLabel: {
      ...Typography.tiny,
      color: c.textSecondary,
    },
    hbarList: { gap: Spacing.sm },
    hbarRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    hbarLabel: { ...Typography.caption, color: c.text, width: 110 },
    hbarTrack: {
      flex: 1,
      height: 16,
      borderRadius: 4,
      backgroundColor: c.surfaceAlt,
      overflow: "hidden",
    },
    hbarFill: { height: "100%", borderRadius: 4 },
    hbarValue: {
      ...Typography.captionSemibold,
      color: c.text,
      width: 40,
      textAlign: "right",
    },
    weekdayRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: Spacing.xs,
      height: 150,
    },
    weekdayCol: { flex: 1, alignItems: "center", height: "100%", justifyContent: "flex-end" },
    weekdayCount: { ...Typography.tiny, color: c.textSecondary, marginBottom: 2 },
    weekdayBarTrack: {
      width: "70%",
      flex: 1,
      justifyContent: "flex-end",
    },
    weekdayBarStack: {
      flex: 1,
      flexDirection: "column-reverse" as const,
      justifyContent: "flex-start",
      overflow: "hidden" as const,
      borderTopLeftRadius: 3,
      borderTopRightRadius: 3,
    },
    weekdayBarSegment: {
      width: "100%",
    },
    weekdayLabel: { ...Typography.tiny, color: c.textTertiary, marginTop: 4 },
    // Remake cards
    remakeTotalCard: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.md,
      padding: Spacing.md,
      marginTop: Spacing.md,
      gap: 4,
    },
    remakeReasonsCard: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.md,
      padding: Spacing.md,
      marginTop: Spacing.sm,
      gap: 4,
    },
    remakeSectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      marginTop: Spacing.md,
      marginBottom: Spacing.xs,
    },
    remakeFiltersGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      rowGap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    remakeFilterCell: { width: "48%", gap: 4 },
    remakeReasonFilter: { width: "100%" },
    remakeMetricGrid: {
      flexDirection: "row",
      gap: Spacing.xs,
      marginTop: Spacing.sm,
    },
    remakeMetricCard: {
      flex: 1,
      minWidth: 0,
      minHeight: 94,
      justifyContent: "center",
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.md,
      padding: Spacing.sm,
      gap: 2,
    },
    remakeMetricLabel: {
      ...Typography.tiny,
      color: c.textSecondary,
      textTransform: "uppercase",
      minHeight: 26,
    },
    remakeEmpty: {
      flex: 1,
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.md,
      minHeight: 94,
    },
    remakeTitle: { ...Typography.bodySemibold, color: c.text },
    remakeSubtitle: { ...Typography.caption, color: c.textSecondary },
    remakeTotal: {
      ...Typography.h2,
      color: c.text,
    },
    remakeSpinner: { marginVertical: Spacing.lg },
    remakeSplitRow: {
      flexDirection: "row",
      justifyContent: "center",
      gap: Spacing.md,
      marginTop: Spacing.md,
    },
    remakeSplitItem: { alignItems: "center", gap: 2 },
    remakeSplitValue: { ...Typography.h3, color: c.text },
    remakeSplitLabel: { ...Typography.caption, color: c.textSecondary },
    reasonRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingVertical: 7,
    },
    reasonLabel: { ...Typography.caption, color: c.text, flexShrink: 1, flex: 1.2 },
    reasonBarTrack: {
      flex: 1,
      minWidth: 30,
      height: 10,
      backgroundColor: c.surfaceAlt,
      borderRadius: 99,
      overflow: "hidden",
    },
    reasonBarFill: { height: "100%", borderRadius: 99 },
    reasonCount: {
      ...Typography.captionSemibold,
      color: c.textSecondary,
      minWidth: 24,
      textAlign: "right",
    },
    trendColumnRow: {
      alignItems: "flex-end",
      gap: Spacing.sm,
      paddingVertical: Spacing.xs,
      paddingHorizontal: 2,
    },
    trendColumn: {
      width: 48,
      height: 112,
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 4,
    },
    trendCount: { ...Typography.tiny, color: c.textSecondary },
    trendTrack: {
      width: 24,
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: c.surfaceAlt,
      borderTopLeftRadius: 4,
      borderTopRightRadius: 4,
      overflow: "hidden",
    },
    trendFill: {
      width: "100%",
      borderTopLeftRadius: 4,
      borderTopRightRadius: 4,
    },
    trendLabel: { ...Typography.tiny, color: c.textTertiary, width: 48, textAlign: "center" },
    remakeRecordRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: 8,
    },
    remakeRecordCase: {
      ...Typography.bodySemibold,
      color: c.tint,
      marginBottom: 2,
    },
    remakeRecordMeta: {
      ...Typography.caption,
      color: c.textSecondary,
    },
    remakeRecordBadge: {
      ...Typography.caption,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      overflow: "hidden",
    },
  });
}
