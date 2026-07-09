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
  type StatsCaseCategory,
} from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { useMe, canEditAnyLab, editableLabMemberships } from "@/lib/auth-me";
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

  const [preset, setPreset] = useState<PresetKey>("month");
  const [category, setCategory] = useState<StatsCaseCategory | "">("");

  // Recompute only when the preset changes — a fresh `new Date()` each render
  // would churn the query key on every render.
  const range = useMemo(() => rangeForPreset(preset), [preset]);
  const groupBy = PRESETS.find((p) => p.key === preset)?.groupBy ?? "month";
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

  const summary = summaryQuery.data?.data;
  const categories = categoriesQuery.data?.data;
  const revenue = revenueQuery.data?.data;
  const weekday = weekdayQuery.data?.data;

  const refreshing =
    summaryQuery.isFetching ||
    categoriesQuery.isFetching ||
    revenueQuery.isFetching ||
    weekdayQuery.isFetching;

  function refetchAll() {
    void summaryQuery.refetch();
    void categoriesQuery.refetch();
    void revenueQuery.refetch();
    void weekdayQuery.refetch();
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
            options={PRESETS.map((p) => ({ key: p.key, label: p.label }))}
            selected={preset}
            onSelect={(k) => setPreset(k as PresetKey)}
            testIDPrefix="stats-range"
          />

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
                  .map((c) => ({ label: c.label, value: c.count }))}
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
  bars: Array<{ key: string; value: number }>;
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
            <View key={b.key} style={styles.vbarTrack}>
              <View
                style={[
                  styles.vbarFill,
                  {
                    height: `${Math.max(b.value > 0 ? 3 : 0, pct)}%`,
                    backgroundColor: colors.tint,
                  },
                ]}
              />
            </View>
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
  rows: Array<{ label: string; value: number }>;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <View style={styles.hbarList}>
      {rows.map((r) => {
        const pct = Math.max(4, Math.round((r.value / max) * 100));
        return (
          <View key={r.label} style={styles.hbarRow}>
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
          </View>
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
  });
}
