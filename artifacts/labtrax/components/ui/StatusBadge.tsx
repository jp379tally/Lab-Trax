import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius } from "@/constants/tokens";

export type BadgeVariant =
  | "intake"
  | "progress"
  | "ship"
  | "complete"
  | "rush"
  | "remake"
  | "paid"
  | "unpaid"
  | "overdue"
  | "draft"
  | "void"
  | "open"
  | "trialing"
  | "active"
  | "grace"
  | "locked"
  | "custom";

interface StatusBadgeProps {
  label: string;
  color?: string;
  bg?: string;
  variant?: BadgeVariant;
  size?: "sm" | "md";
}

function makeVariantMap(c: ThemeColors): Record<BadgeVariant, { color: string; bg: string }> {
  return {
    intake:   { color: c.info,         bg: c.infoLight },
    progress: { color: c.violet,       bg: c.violetLight },
    ship:     { color: c.cyan,         bg: c.cyanLight },
    complete: { color: c.success,      bg: c.successLight },
    rush:     { color: c.error,        bg: c.errorLight },
    remake:   { color: c.warning,      bg: c.warningLight },
    paid:     { color: c.success,      bg: c.successLight },
    unpaid:   { color: c.warning,      bg: c.warningLight },
    overdue:  { color: c.error,        bg: c.errorLight },
    draft:    { color: c.textSecondary, bg: c.surfaceAlt },
    void:     { color: c.textSecondary, bg: c.surfaceAlt },
    open:     { color: c.warningStrong, bg: c.warningLight },
    trialing: { color: c.violet,       bg: c.violetLight },
    active:   { color: c.success,      bg: c.successLight },
    grace:    { color: c.orange,       bg: c.orangeLight },
    locked:   { color: c.error,        bg: c.errorLight },
    custom:   { color: c.tint,         bg: c.tintLight },
  };
}

export function StatusBadge({ label, color, bg, variant, size = "md" }: StatusBadgeProps) {
  const { colors, isDark } = useTheme();
  const variantMap = useMemo(() => makeVariantMap(colors), [colors]);
  const resolved = variant ? variantMap[variant] : null;
  const badgeColor = color ?? resolved?.color ?? colors.textSecondary;
  const badgeBg   = bg    ?? resolved?.bg    ?? colors.surfaceAlt;

  const darkBg = isDark ? badgeColor + "25" : badgeBg;
  const darkColor = badgeColor;

  return (
    <View style={[
      styles.badge,
      size === "sm" && styles.badgeSm,
      { backgroundColor: darkBg },
    ]}>
      <Text style={[
        styles.label,
        size === "sm" && styles.labelSm,
        { color: darkColor },
      ]}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radius.xs,
  },
  badgeSm: {
    paddingHorizontal: Spacing.xs + 2,
    paddingVertical: 2,
  },
  label: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.4,
  },
  labelSm: {
    fontSize: 10,
  },
});
