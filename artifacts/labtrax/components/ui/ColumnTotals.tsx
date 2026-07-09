import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { formatMoney } from "@/lib/format";

/**
 * Safely sums a list of possibly-null/undefined/string amounts.
 * Null/undefined and non-numeric strings count as 0; negatives are included.
 * Mirrors the desktop implementation in
 * artifacts/labtrax-desktop/src/components/ColumnTotal.tsx.
 */
export function sumAmounts(
  values: Array<string | number | null | undefined>,
): number {
  let total = 0;
  for (const v of values) {
    const n = typeof v === "string" ? Number(v) : (v ?? 0);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

export interface ColumnTotalItem {
  label: string;
  values: Array<string | number | null | undefined>;
  testID?: string;
}

/**
 * ColumnTotals — a compact summary bar showing the total of each amount
 * column for the currently displayed rows (mobile equivalent of the desktop
 * ColumnTotal column-header sums). Shows a placeholder while the underlying
 * data is loading so a stale or partial sum is never displayed.
 */
export function ColumnTotals({
  items,
  loading = false,
}: {
  items: ColumnTotalItem[];
  loading?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.bar} testID="column-totals">
      {items.map((item) => (
        <View key={item.label} style={styles.item}>
          <Text style={styles.label} numberOfLines={1}>
            {item.label}
          </Text>
          <Text style={styles.value} numberOfLines={1} testID={item.testID}>
            {loading ? "—" : formatMoney(sumAmounts(item.values))}
          </Text>
        </View>
      ))}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.md,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm + 2,
      marginBottom: Spacing.sm,
      borderRadius: Radius.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    item: { flexShrink: 1, gap: 1 },
    label: {
      ...Typography.caption,
      color: c.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.4,
      fontSize: 10,
    },
    value: { ...Typography.bodySemibold, color: c.text, fontVariant: ["tabular-nums"] },
  });
}
