import React from "react";
import { View, Pressable, StyleSheet, ViewStyle, StyleProp } from "react-native";
import { useTheme } from "@/lib/theme-context";

interface CardProps {
  children: React.ReactNode;
  /** Padding preset. `none` lets the caller control insets (e.g. list cards). */
  padding?: "none" | "sm" | "md" | "lg";
  /** Elevation preset from the theme shadow scale. */
  elevation?: "none" | "sm" | "md" | "lg";
  /** Show the hairline border (default true). */
  bordered?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Card — the canonical surface container. One radius, one border, one
 * elevation language for every "card" across the app.
 */
export function Card({
  children,
  padding = "md",
  elevation = "sm",
  bordered = true,
  onPress,
  onLongPress,
  delayLongPress,
  testID,
  style,
}: CardProps) {
  const { colors, radius, spacing, shadows } = useTheme();

  const paddingValue =
    padding === "none"
      ? 0
      : padding === "sm"
      ? spacing.md
      : padding === "lg"
      ? spacing.xl
      : spacing.lg;

  const cardStyle: StyleProp<ViewStyle> = [
    {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      padding: paddingValue,
      borderWidth: bordered ? StyleSheet.hairlineWidth : 0,
      borderColor: colors.border,
    },
    shadows[elevation],
    style,
  ];

  if (onPress || onLongPress) {
    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={delayLongPress}
        testID={testID}
        style={({ pressed }) => [cardStyle, pressed && { opacity: 0.85 }]}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View style={cardStyle} testID={testID}>
      {children}
    </View>
  );
}
