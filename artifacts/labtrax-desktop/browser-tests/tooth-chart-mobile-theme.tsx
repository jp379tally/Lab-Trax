import React from "react";

const colors = {
  tint: "#2563EB",
  text: "#111827",
  textSecondary: "#475569",
  textTertiary: "#64748B",
  errorText: "#B91C1C",
  success: "#059669",
  successStrong: "#047857",
  warningStrong: "#B45309",
};

export function useTheme() {
  return { colors };
}

export type ThemeColors = typeof colors;
