import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme } from "@/lib/theme-context";

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

const VARIANT_MAP: Record<BadgeVariant, { color: string; bg: string }> = {
  intake:   { color: "#2563EB", bg: "#DBEAFE" },
  progress: { color: "#7C3AED", bg: "#EDE9FE" },
  ship:     { color: "#0891B2", bg: "#CFFAFE" },
  complete: { color: "#10B981", bg: "#D1FAE5" },
  rush:     { color: "#EF4444", bg: "#FEE2E2" },
  remake:   { color: "#F59E0B", bg: "#FEF3C7" },
  paid:     { color: "#10B981", bg: "#D1FAE5" },
  unpaid:   { color: "#F59E0B", bg: "#FEF3C7" },
  overdue:  { color: "#EF4444", bg: "#FEE2E2" },
  draft:    { color: "#64748B", bg: "#F1F5F9" },
  void:     { color: "#64748B", bg: "#F1F5F9" },
  open:     { color: "#D97706", bg: "#FEF3C7" },
  trialing: { color: "#7C3AED", bg: "#EDE9FE" },
  active:   { color: "#10B981", bg: "#D1FAE5" },
  grace:    { color: "#EA580C", bg: "#FFF7ED" },
  locked:   { color: "#EF4444", bg: "#FEE2E2" },
  custom:   { color: "#145DA0", bg: "#D9E9F7" },
};

export function StatusBadge({ label, color, bg, variant, size = "md" }: StatusBadgeProps) {
  const { isDark } = useTheme();
  const resolved = variant ? VARIANT_MAP[variant] : null;
  const badgeColor = color ?? resolved?.color ?? "#64748B";
  const badgeBg   = bg    ?? resolved?.bg    ?? "#F1F5F9";

  const darkBg = isDark ? badgeColor + "25" : badgeBg;
  const darkColor = isDark ? badgeColor : badgeColor;

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
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeSm: {
    paddingHorizontal: 6,
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
