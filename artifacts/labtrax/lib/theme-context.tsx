import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Colors from "@/constants/colors";
import {
  Spacing,
  Radius,
  Typography,
  makeShadows,
  type SpacingScale,
  type RadiusScale,
  type TypographyScale,
  type ShadowPreset,
} from "@/constants/tokens";

type ThemeMode = "light" | "dark";
export type ThemeColors = typeof Colors.light;

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  colors: ThemeColors;
  isDark: boolean;
  spacing: SpacingScale;
  radius: RadiusScale;
  typography: TypographyScale;
  shadows: ShadowPreset;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_KEY = "@drivesync_theme";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("light");

  useEffect(() => {
    AsyncStorage.getItem(THEME_KEY).then((saved) => {
      if (saved === "dark" || saved === "light") setModeState(saved);
    });
  }, []);

  function setMode(m: ThemeMode) {
    setModeState(m);
    AsyncStorage.setItem(THEME_KEY, m);
  }

  const value = useMemo(() => {
    const isDark = mode === "dark";
    return {
      mode,
      setMode,
      colors: isDark ? Colors.dark : Colors.light,
      isDark,
      spacing: Spacing,
      radius: Radius,
      typography: Typography,
      shadows: makeShadows(isDark),
    };
  }, [mode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
