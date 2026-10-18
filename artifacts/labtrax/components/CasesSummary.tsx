import React, { useMemo } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { CasesOverview } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

type Props = {
  data: CasesOverview | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
};

const DASH = "\u2014";
const fmt = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : DASH;

/** Two compact rows keep all workbench totals visible on phone-sized screens. */
export function CasesSummary({ data, isLoading, isError, onRetry }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const unavailable = isLoading || isError;
  const tiles = [
    { id: "total", label: "Total Cases", value: data?.totalCases, accent: colors.tint },
    { id: "processing", label: "Processing", value: data?.processingCases, accent: colors.violet },
    { id: "in-transit", label: "In Transit", value: data?.inTransitCases, accent: colors.info },
    { id: "completed", label: "Completed", value: data?.completedCases, accent: colors.success },
    { id: "overdue", label: "Overdue", value: data?.overdueCases, accent: colors.error },
  ];
  return (
    <View style={styles.wrap} testID="cases-summary">
      <View style={styles.grid}>
        {tiles.map((tile) => (
          <View
            key={tile.id}
            style={[styles.tile, { borderTopColor: tile.accent }]}
            testID={`cases-summary-${tile.id}`}
            accessibilityLabel={`${tile.label}: ${unavailable ? "unavailable" : fmt(tile.value)}`}
          >
            <Text style={styles.value} testID={`cases-summary-${tile.id}-value`}>
              {unavailable ? DASH : fmt(tile.value)}
            </Text>
            <Text style={styles.label} numberOfLines={1}>{tile.label}</Text>
          </View>
        ))}
      </View>
      {isError ? (
        <View style={styles.errorRow} testID="cases-summary-error">
          <Text style={styles.errorText}>Case totals unavailable.</Text>
          <Pressable onPress={onRetry} hitSlop={8} testID="cases-summary-retry">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    wrap: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
    grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: Spacing.xs },
    tile: {
      width: "31.5%",
      minHeight: 50,
      justifyContent: "center",
      backgroundColor: c.surface,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      borderTopWidth: 2,
      paddingVertical: 4,
      paddingHorizontal: Spacing.sm,
    },
    value: { ...Typography.bodySemibold, color: c.text, fontVariant: ["tabular-nums"] },
    label: { ...Typography.caption, color: c.textSecondary },
    errorRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md, marginTop: Spacing.xs },
    errorText: { ...Typography.caption, color: c.error },
    retryText: { ...Typography.caption, color: c.tint, fontWeight: "600" },
  });
}
