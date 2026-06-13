import React from "react";
import { Stack } from "expo-router";
import { useTheme } from "@/lib/theme-context";

export default function SettingsLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.backgroundSolid },
        animation: "slide_from_right",
      }}
    />
  );
}
