import { TextStyle, ViewStyle } from "react-native";

// ─────────────────────────────────────────────────────────────────────────────
// Design tokens — the single source of truth for spacing, corner radii,
// elevation, and typography across the LabTrax mobile app. Consume these via
// the `useTheme()` hook (which re-exports them alongside theme colors) so every
// screen stays visually consistent.
// ─────────────────────────────────────────────────────────────────────────────

// 4-point spacing scale.
export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
} as const;

// Corner-radius scale.
export const Radius = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  full: 999,
} as const;

// Typography scale built on the already-loaded Inter family.
export const Typography = {
  display: { fontSize: 28, fontFamily: "Inter_700Bold", lineHeight: 34 },
  h1: { fontSize: 22, fontFamily: "Inter_700Bold", lineHeight: 28 },
  h2: { fontSize: 18, fontFamily: "Inter_700Bold", lineHeight: 24 },
  h3: { fontSize: 16, fontFamily: "Inter_600SemiBold", lineHeight: 22 },
  bodyLg: { fontSize: 15, fontFamily: "Inter_400Regular", lineHeight: 22 },
  bodyLgMedium: { fontSize: 15, fontFamily: "Inter_500Medium", lineHeight: 22 },
  body: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  bodyMedium: { fontSize: 14, fontFamily: "Inter_500Medium", lineHeight: 20 },
  bodySemibold: { fontSize: 14, fontFamily: "Inter_600SemiBold", lineHeight: 20 },
  caption: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 16 },
  captionMedium: { fontSize: 12, fontFamily: "Inter_500Medium", lineHeight: 16 },
  captionSemibold: { fontSize: 12, fontFamily: "Inter_600SemiBold", lineHeight: 16 },
  label: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.8 },
  tiny: { fontSize: 10, fontFamily: "Inter_500Medium", lineHeight: 14 },
} as const satisfies Record<string, TextStyle>;

export type ShadowPreset = {
  none: ViewStyle;
  sm: ViewStyle;
  md: ViewStyle;
  lg: ViewStyle;
};

// Elevation presets. Shadows read heavier in dark mode so cards keep their
// separation against the dark canvas.
export function makeShadows(isDark: boolean): ShadowPreset {
  return {
    none: {},
    sm: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: isDark ? 0.35 : 0.06,
      shadowRadius: 3,
      elevation: 2,
    },
    md: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: isDark ? 0.45 : 0.08,
      shadowRadius: 12,
      elevation: 4,
    },
    lg: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: isDark ? 0.55 : 0.12,
      shadowRadius: 24,
      elevation: 10,
    },
  };
}

export type SpacingScale = typeof Spacing;
export type RadiusScale = typeof Radius;
export type TypographyScale = typeof Typography;
