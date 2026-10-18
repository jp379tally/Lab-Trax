// Provider portal → Stats.
//
// Mirrors the desktop ProviderStats: three summary figures (total remakes, the
// remake share of all cases, total cases) plus a remake-reason breakdown whose
// bars are relative to the largest reason. Backed by GET /provider/stats, the
// same endpoint desktop reads — it is outside the OpenAPI contract, so the
// request goes through providerRequest rather than a generated hook.
import React, { useMemo } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { providerRequest } from "@/lib/provider-api";

export interface ProviderStatsData {
  totalCases: number;
  remakeCount: number;
  remakePct: number;
  reasonCounts: Array<{ reason: string; count: number }>;
}

// "provider-stats" is a practice-scoped query prefix, so a practice switch
// drops this cache entry instead of painting the previous practice's figures.
export const PROVIDER_STATS_QUERY_KEY = ["provider-stats"] as const;

export function ProviderStatsSection() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const statsQuery = useQuery({
    queryKey: PROVIDER_STATS_QUERY_KEY,
    queryFn: () => providerRequest<ProviderStatsData>("/api/provider/stats"),
    staleTime: 60_000,
  });

  const header = (
    <View style={styles.header}>
      <Text style={styles.title}>Remake Stats</Text>
    </View>
  );

  if (statsQuery.isError) {
    const message =
      statsQuery.error instanceof Error && statsQuery.error.message
        ? statsQuery.error.message
        : "Failed to load stats.";
    return (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        testID="provider-portal-section-stats"
      >
        {header}
        <View style={styles.errorBox} accessibilityRole="alert" testID="provider-stats-error">
          <Text style={styles.errorText}>{message}</Text>
        </View>
      </ScrollView>
    );
  }

  const stats = statsQuery.data;
  if (!stats) {
    return (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        testID="provider-portal-section-stats"
      >
        {header}
        <View style={styles.loadingRow} testID="provider-stats-loading">
          <ActivityIndicator color={colors.tint} />
          <Text style={styles.mutedText}>Loading stats…</Text>
        </View>
      </ScrollView>
    );
  }

  const { totalCases, remakeCount, remakePct, reasonCounts } = stats;
  const maxCount = reasonCounts.length > 0 ? reasonCounts[0]!.count : 1;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      testID="provider-portal-section-stats"
    >
      <View style={styles.header}>
        <Text style={styles.title}>Remake Stats</Text>
        <Text style={styles.subtitle}>Computed from your complete case history</Text>
      </View>

      {/* Summary */}
      <View style={styles.summaryCard}>
        <View style={styles.summaryCell}>
          <Text style={styles.summaryValue} testID="provider-stats-remake-count">
            {remakeCount}
          </Text>
          <Text style={styles.summaryLabel}>Total remakes</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryCell}>
          <Text style={styles.summaryValue} testID="provider-stats-remake-pct">
            {remakePct}%
          </Text>
          <Text style={styles.summaryLabel}>of all cases</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryCell}>
          <Text style={styles.summaryValue} testID="provider-stats-total-cases">
            {totalCases}
          </Text>
          <Text style={styles.summaryLabel}>Total cases</Text>
        </View>
      </View>

      {/* Remake reasons */}
      {remakeCount === 0 ? (
        <View style={styles.noRemakes} testID="provider-stats-no-remakes">
          <Text style={styles.noRemakesIcon}>✅</Text>
          <Text style={styles.noRemakesTitle}>No remakes on record</Text>
          <Text style={styles.mutedText}>
            When a case is remade, the reason and count will appear here.
          </Text>
        </View>
      ) : (
        <View testID="provider-stats-reasons">
          <Text style={styles.reasonsTitle}>Remake reasons</Text>
          <View style={styles.reasonsCard}>
            {reasonCounts.map(({ reason, count }, idx) => {
              const pct = Math.round((count / maxCount) * 100);
              return (
                <View
                  key={reason}
                  style={[styles.reasonRow, idx > 0 && styles.reasonRowDivided]}
                  testID={`provider-stats-reason-${idx}`}
                >
                  <Text style={styles.reasonName} numberOfLines={1}>
                    {reason}
                  </Text>
                  <View style={styles.reasonBarTrack}>
                    <View
                      style={[styles.reasonBarFill, { width: `${pct}%` }]}
                      accessibilityLabel={`${reason}: ${count} of ${maxCount}`}
                      testID={`provider-stats-reason-bar-${idx}`}
                    />
                  </View>
                  <Text style={styles.reasonCount} testID={`provider-stats-reason-count-${idx}`}>
                    {count}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    scroll: { flex: 1, backgroundColor: c.backgroundSolid },
    content: { padding: Spacing.lg, gap: Spacing.lg },
    header: { gap: 2 },
    title: { ...Typography.h3, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary },
    loadingRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    mutedText: { ...Typography.caption, color: c.textSecondary },
    errorBox: {
      borderRadius: Radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.error,
      backgroundColor: c.errorSurface,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
    },
    errorText: { ...Typography.body, color: c.errorText },
    summaryCard: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-around",
      gap: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surface,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.lg,
    },
    summaryCell: { alignItems: "center", gap: 2 },
    summaryValue: { ...Typography.display, color: c.text },
    summaryLabel: { ...Typography.caption, color: c.textSecondary },
    summaryDivider: { width: StyleSheet.hairlineWidth, height: 40, backgroundColor: c.border },
    noRemakes: {
      alignItems: "center",
      gap: Spacing.xs,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      paddingHorizontal: Spacing.xxl,
      paddingVertical: Spacing.huge,
    },
    noRemakesIcon: { fontSize: 24 },
    noRemakesTitle: { ...Typography.bodyMedium, color: c.textSecondary },
    reasonsTitle: { ...Typography.bodyMedium, color: c.text, marginBottom: Spacing.sm },
    reasonsCard: {
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surface,
      overflow: "hidden",
    },
    reasonRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
    },
    reasonRowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    reasonName: { ...Typography.body, color: c.text, width: 110, flexShrink: 0 },
    reasonBarTrack: {
      flex: 1,
      height: 8,
      borderRadius: Radius.full,
      backgroundColor: c.surfaceAlt,
      overflow: "hidden",
    },
    reasonBarFill: { height: "100%", borderRadius: Radius.full, backgroundColor: c.tint },
    reasonCount: { ...Typography.bodyMedium, color: c.text, minWidth: 24, textAlign: "right" },
  });
}
