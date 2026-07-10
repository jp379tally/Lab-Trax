// Stats & Analytics — mobile parity for the desktop Stats dashboard.
//
// Read-only, billing-role gated (owner/admin/billing — the server enforces
// BILLING_ROLES on every /api/stats/* endpoint via requireAnyRole). Uses the
// generated hooks, which return the `{ ok, data }` envelope, so every read is
// `query.data?.data?.X`. Charts are lightweight View-based bars (no charting
// library on mobile).
import React, { useMemo, useState } from "react";
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
  type StatsCaseCategory,
} from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { DateField } from "@/components/DateField";
import {
  useMe,
  canEditAnyLab,
  editableLabMemberships,
  adminLabMemberships,
} from "@/lib/auth-me";
import { formatMoney, toNumber } from "@/lib/format";

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

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
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

  // Remakes are owner/admin-only (server enforces ADMIN_ROLES on
  // /api/stats/remakes) — gate on the SELECTED org so a billing-only role on
  // the current lab never sees the section even if the user admins another.
  const isAdminForOrg = useMemo(
    () => adminLabMemberships(me).some((m) => m.organizationId === orgId),
    [me, orgId],
  );

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

  const groupBy = useMemo<GroupBy>(() => {
    if (rangeKey === "custom") return groupByForRange(range.from, range.to);
    return PRESETS.find((p) => p.key === rangeKey)?.groupBy ?? "month";
  }, [rangeKey, range.from, range.to]);

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
  const weekdayQuery = useGetStatsWeekdayVolume(baseParams, {
    query: { queryKey: getGetStatsWeekdayVolumeQueryKey(baseParams), enabled },
  });

  // Remakes: date-range only, owner/admin-only (server enforces).
  const remakesParams = {
    organizationId: orgId ?? "",
    dateFrom: range.from,
    dateTo: range.to,
    timeZone,
  };
  const remakesQuery = useGetStatsRemakes(remakesParams, {
    query: {
      queryKey: getGetStatsRemakesQueryKey(remakesParams),
      enabled: isAdminForOrg && !!orgId,
    },
  });

  const summary = summaryQuery.data?.data;
  const categories = categoriesQuery.data?.data;
  const revenue = revenueQuery.data?.data;
  const weekday = weekdayQuery.data?.data;
  const remakes = remakesQuery.data?.data;

  const refreshing =
    summaryQuery.isFetching ||
    categoriesQuery.isFetching ||
    revenueQuery.isFetching ||
    weekdayQuery.isFetching ||
    remakesQuery.isFetching;

  function refetchAll() {
    void summaryQuery.refetch();
    void categoriesQuery.refetch();
    void revenueQuery.refetch();
    void weekdayQuery.refetch();
    if (isAdminForOrg) void remakesQuery.refetch();
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

          {/* ── Summary metrics ─────────────────────────────────────── */}
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
              icon="pulse-outline"
              label="Avg case value"
              value={summary ? formatMoney(summary.averageCaseValue) : "—"}
              loading={summaryQuery.isLoading}
            />
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
          </View>

          {/* ── Sales over time ─────────────────────────────────────── */}
          <ChartCard
            styles={styles}
            title="Sales over time"
            subtitle="Invoiced revenue by period"
            loading={revenueQuery.isLoading}
            error={revenueQuery.isError}
            empty={!revenue || revenue.series.length === 0}
            emptyTestID="stats-revenue-empty"
          >
            {revenue && revenue.series.length > 0 ? (
              <>
                <VerticalBars
                  colors={colors}
                  bars={revenue.series.map((s) => ({
                    key: s.period,
                    value: toNumber(s.revenue),
                    onPress: () => {
                      const win = bucketWindow(s.periodStart, groupBy);
                      if (win) drillIntoCases(win);
                    },
                  }))}
                  firstLabel={revenue.series[0]?.period ?? ""}
                  lastLabel={revenue.series[revenue.series.length - 1]?.period ?? ""}
                  styles={styles}
                />
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
                  const pct = Math.round((d.total / max) * 100);
                  return (
                    <View key={d.weekday} style={styles.weekdayCol}>
                      <Text style={styles.weekdayCount}>{d.total || ""}</Text>
                      <View style={styles.weekdayBarTrack}>
                        <View
                          style={[
                            styles.weekdayBarFill,
                            { height: `${Math.max(d.total > 0 ? 4 : 0, pct)}%` },
                          ]}
                        />
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
              <View style={styles.remakeTotalCard}>
                <Text style={styles.remakeTitle}>Remakes</Text>
                <Text style={styles.remakeSubtitle}>
                  Remade cases received in this period
                </Text>
                {remakesQuery.isLoading ? (
                  <ActivityIndicator style={styles.remakeSpinner} />
                ) : remakesQuery.isError ? (
                  <Text style={styles.chartStateText}>Could not load remakes.</Text>
                ) : !remakes || remakes.totalRemakes === 0 ? (
                  <Text style={styles.chartStateText} testID="stats-remakes-empty">
                    No remakes in this period
                  </Text>
                ) : (
                  <View>
                    <Text style={styles.remakeTotal} testID="stats-remakes-total">
                      {remakes.totalRemakes}
                    </Text>
                    <Text style={styles.remakeSubtitle}>Total remakes</Text>
                    <View style={styles.remakeSplitRow}>
                      <View style={styles.remakeSplitItem}>
                        <Text style={[styles.remakeSplitValue, { color: "#059669" }]}>
                          {remakes.rechargedRemakes}
                        </Text>
                        <Text style={styles.remakeSplitLabel}>Recharged</Text>
                      </View>
                      <View style={styles.remakeSplitItem}>
                        <Text style={[styles.remakeSplitValue, { color: "#DC2626" }]}>
                          {remakes.nonRechargedRemakes}
                        </Text>
                        <Text style={styles.remakeSplitLabel}>Not recharged</Text>
                      </View>
                    </View>
                  </View>
                )}
              </View>
              <View style={styles.remakeReasonsCard}>
                <Text style={styles.remakeTitle}>Remake reasons</Text>
                {remakesQuery.isLoading ? (
                  <ActivityIndicator style={styles.remakeSpinner} />
                ) : !remakes || remakes.remakeReasons.length === 0 ? (
                  <Text style={styles.chartStateText}>No remakes in this period</Text>
                ) : (
                  <View testID="stats-remakes-reasons">
                    {remakes.remakeReasons.map((r) => (
                      <View key={r.reason} style={styles.reasonRow}>
                        <Text style={styles.reasonLabel} numberOfLines={1}>
                          {r.reason}
                        </Text>
                        <Text style={styles.reasonCount}>{r.count}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
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
}: {
  styles: Styles;
  colors: ThemeColors;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  value: string;
  sub?: string;
  changePct?: number | null;
  loading?: boolean;
}) {
  return (
    <Card style={styles.metricTile}>
      <View style={styles.metricHeader}>
        <Ionicons name={icon} size={14} color={colors.textSecondary} />
        <Text style={styles.metricLabel} numberOfLines={1}>
          {label}
        </Text>
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
    </Card>
  );
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
  subtitle?: string;
  loading?: boolean;
  error?: boolean;
  empty?: boolean;
  emptyTestID?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card style={styles.chartCard}>
      <Text style={styles.chartTitle}>{title}</Text>
      {subtitle ? <Text style={styles.chartSubtitle}>{subtitle}</Text> : null}
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
  bars: Array<{ key: string; value: number; onPress?: () => void }>;
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
                    backgroundColor: colors.tint,
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
  rows: Array<{ label: string; value: number; onPress?: () => void }>;
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
                  { width: `${pct}%`, backgroundColor: colors.tint },
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
    chipRow: { gap: Spacing.xs, paddingRight: Spacing.lg },
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
    chartCard: { gap: 2 },
    chartTitle: { ...Typography.bodySemibold, color: c.text },
    chartSubtitle: { ...Typography.caption, color: c.textSecondary },
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
    weekdayBarFill: {
      width: "100%",
      borderRadius: 3,
      backgroundColor: c.tint,
    },
    weekdayLabel: { ...Typography.tiny, color: c.textTertiary, marginTop: 4 },
    // Remake cards
    remakeTotalCard: {
      backgroundColor: c.surface,
      borderRadius: Radius.md,
      padding: Spacing.md,
      marginTop: Spacing.md,
      gap: 4,
    },
    remakeReasonsCard: {
      backgroundColor: c.surface,
      borderRadius: Radius.md,
      padding: Spacing.md,
      marginTop: Spacing.sm,
      gap: 4,
    },
    remakeTitle: { ...Typography.bodySemibold, color: c.text },
    remakeSubtitle: { ...Typography.caption, color: c.textSecondary },
    remakeTotal: {
      ...Typography.h1,
      color: c.text,
      marginTop: Spacing.sm,
      textAlign: "center",
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
      justifyContent: "space-between",
      paddingVertical: 6,
    },
    reasonLabel: { ...Typography.body, color: c.text, flexShrink: 1, flex: 1 },
    reasonCount: {
      ...Typography.bodySemibold,
      color: c.textSecondary,
      minWidth: 24,
      textAlign: "right",
    },
  });
}
