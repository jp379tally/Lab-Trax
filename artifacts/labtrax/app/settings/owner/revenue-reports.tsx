import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  useWindowDimensions,
} from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";
import { useMe, primaryOwnerLabOrgId } from "@/lib/auth-me";

type GroupBy = "month" | "practice" | "restoration_type";
type Period = "month" | "quarter" | "year";

interface RevenueItem {
  label: string;
  revenue: string;
  invoiceCount?: number;
  count?: number;
}

interface RevenueReport {
  groupBy: GroupBy;
  items: RevenueItem[];
  totalRevenue: string;
}

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "month", label: "This Month" },
  { value: "quarter", label: "This Quarter" },
  { value: "year", label: "This Year" },
];

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "month", label: "By Month" },
  { value: "practice", label: "By Practice" },
  { value: "restoration_type", label: "By Type" },
];

function fmt(amount: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(parseFloat(amount));
  } catch {
    return `$${amount}`;
  }
}

export default function OwnerRevenueReportsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const me = useMe();
  const orgId = primaryOwnerLabOrgId(me.data);

  const [period, setPeriod] = useState<Period>("month");
  const [groupBy, setGroupBy] = useState<GroupBy>("month");

  const query = useQuery<RevenueReport>({
    queryKey: ["owner", "revenue-report", orgId, period, groupBy],
    queryFn: async () => {
      const res = await resilientFetch(
        `/api/owner/revenue-report?organizationId=${orgId}&period=${period}&groupBy=${groupBy}`
      );
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      return body.data ?? body;
    },
    enabled: !!orgId,
  });

  if (!orgId) {
    return (
      <ScreenShell title="Revenue Reports" onBack={() => router.back()}>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={32} color={colors.textTertiary} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            Owner access required.
          </Text>
        </View>
      </ScreenShell>
    );
  }

  const report = query.data;

  return (
    <ScreenShell title="Revenue Reports" onBack={() => router.back()}>
      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        {/* Period selector */}
        <View style={styles.filterRow}>
          {PERIOD_OPTIONS.map((o) => (
            <Pressable
              key={o.value}
              style={[
                styles.chip,
                { borderColor: colors.border, backgroundColor: colors.surface },
                period === o.value && { backgroundColor: colors.tint, borderColor: colors.tint },
              ]}
              onPress={() => setPeriod(o.value)}
            >
              <Text
                style={[
                  styles.chipText,
                  { color: period === o.value ? "#fff" : colors.textSecondary },
                ]}
              >
                {o.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* GroupBy selector */}
        <View style={styles.filterRow}>
          {GROUP_OPTIONS.map((o) => (
            <Pressable
              key={o.value}
              style={[
                styles.chip,
                { borderColor: colors.border, backgroundColor: colors.surface },
                groupBy === o.value && { backgroundColor: colors.tint, borderColor: colors.tint },
              ]}
              onPress={() => setGroupBy(o.value)}
            >
              <Text
                style={[
                  styles.chipText,
                  { color: groupBy === o.value ? "#fff" : colors.textSecondary },
                ]}
              >
                {o.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {query.isLoading && (
          <ActivityIndicator color={colors.tint} style={styles.loader} />
        )}

        {query.isError && (
          <View style={[styles.errorBanner, { backgroundColor: colors.error + "15", borderColor: colors.error }]}>
            <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
            <Text style={[styles.errorText, { color: colors.error }]}>
              {(query.error as Error)?.message ?? "Failed to load report."}
            </Text>
          </View>
        )}

        {report && (
          <>
            {/* Total card */}
            <View style={[styles.totalCard, { backgroundColor: colors.tint + "10", borderColor: colors.tint + "30" }]}>
              <Ionicons name="bar-chart-outline" size={22} color={colors.tint} />
              <View>
                <Text style={[styles.totalLabel, { color: colors.textSecondary }]}>Total Revenue</Text>
                <Text style={[styles.totalAmount, { color: colors.text }]}>
                  {fmt(report.totalRevenue)}
                </Text>
              </View>
            </View>

            {/* Bar chart — all groupings */}
            {report.items.length > 0 && (
              <SimpleBarChart items={report.items} colors={colors} groupBy={groupBy} />
            )}

            {/* Table */}
            <View style={[styles.tableCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={[styles.tableHeader, { borderBottomColor: colors.border }]}>
                <Text style={[styles.tableHeaderCell, { color: colors.textSecondary, flex: 2 }]}>
                  {groupBy === "month" ? "Month" : groupBy === "practice" ? "Practice" : "Type"}
                </Text>
                <Text style={[styles.tableHeaderCell, styles.textRight, { color: colors.textSecondary }]}>
                  Revenue
                </Text>
                <Text style={[styles.tableHeaderCell, styles.textRight, { color: colors.textSecondary }]}>
                  Count
                </Text>
              </View>
              {report.items.map((item, i) => (
                <View
                  key={i}
                  style={[
                    styles.tableRow,
                    i < report.items.length - 1 && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: colors.border,
                    },
                  ]}
                >
                  <Text style={[styles.tableCell, { color: colors.text, flex: 2 }]} numberOfLines={1}>
                    {item.label}
                  </Text>
                  <Text style={[styles.tableCell, styles.textRight, { color: colors.text }]}>
                    {fmt(item.revenue)}
                  </Text>
                  <Text style={[styles.tableCell, styles.textRight, { color: colors.textSecondary }]}>
                    {item.invoiceCount ?? item.count ?? "—"}
                  </Text>
                </View>
              ))}
              {report.items.length === 0 && (
                <View style={styles.emptyRow}>
                  <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                    No revenue data for this period.
                  </Text>
                </View>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </ScreenShell>
  );
}

function SimpleBarChart({
  items,
  colors,
  groupBy,
}: {
  items: RevenueItem[];
  colors: ThemeColors;
  groupBy: GroupBy;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const chartHeight = 160;
  const labelHeight = 28;
  const maxVal = Math.max(...items.map((i) => parseFloat(i.revenue) || 0), 1);

  const chartTitle =
    groupBy === "month"
      ? "Monthly Revenue"
      : groupBy === "practice"
      ? "Revenue by Practice"
      : "Revenue by Restoration Type";

  // For month grouping, use 3-char abbreviations (e.g. "Jan").
  // For practice/restoration_type, truncate longer names to fit.
  const maxLabelChars = groupBy === "month" ? 3 : 8;

  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        padding: 12,
        paddingBottom: 4,
      }}
    >
      <Text
        style={{
          fontSize: 11,
          fontWeight: "700",
          color: colors.textSecondary,
          marginBottom: 8,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {chartTitle}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "flex-end", height: chartHeight }}>
        {items.map((item, i) => {
          const val = parseFloat(item.revenue) || 0;
          const barHeight = Math.max((val / maxVal) * (chartHeight - labelHeight), 4);
          const shortLabel =
            item.label.length > maxLabelChars
              ? item.label.slice(0, maxLabelChars - 1) + "…"
              : item.label;
          return (
            <View
              key={i}
              style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", height: chartHeight }}
            >
              <Text
                style={{
                  fontSize: 9,
                  color: colors.textSecondary,
                  marginBottom: 2,
                }}
                numberOfLines={1}
              >
                {val >= 1000 ? `$${(val / 1000).toFixed(0)}k` : val > 0 ? `$${val}` : ""}
              </Text>
              <View
                style={{
                  width: "60%",
                  height: barHeight,
                  backgroundColor: colors.tint,
                  borderRadius: 3,
                  opacity: 0.9,
                }}
              />
              <Text
                style={{
                  fontSize: 9,
                  color: colors.textSecondary,
                  marginTop: 4,
                  width: (screenWidth - 40) / items.length,
                  textAlign: "center",
                }}
                numberOfLines={1}
              >
                {shortLabel}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingTop: 80,
      gap: Spacing.md,
    },
    emptyText: { ...Typography.body, textAlign: "center" },
    loader: { marginTop: Spacing.xl },
    filterRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    chip: {
      paddingHorizontal: Spacing.md,
      paddingVertical: 6,
      borderRadius: Radius.full,
      borderWidth: StyleSheet.hairlineWidth,
    },
    chipText: { ...Typography.caption, fontWeight: "600" },
    errorBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      padding: Spacing.sm,
    },
    errorText: { ...Typography.caption, flex: 1 },
    totalCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      borderRadius: Radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      padding: Spacing.lg,
    },
    totalLabel: { ...Typography.caption },
    totalAmount: { ...Typography.h2, marginTop: 2 },
    tableCard: {
      borderRadius: Radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
    },
    tableHeader: {
      flexDirection: "row",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    tableHeaderCell: { ...Typography.caption, fontWeight: "700" },
    tableRow: {
      flexDirection: "row",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm + 2,
    },
    tableCell: { ...Typography.caption, flex: 1 },
    textRight: { textAlign: "right" },
    emptyRow: { padding: Spacing.xl, alignItems: "center" },
  });
}
