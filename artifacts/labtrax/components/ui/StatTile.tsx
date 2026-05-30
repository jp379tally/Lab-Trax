import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

interface StatTileProps {
  label: string;
  value: string | number;
  icon?: keyof typeof Ionicons.glyphMap;
  accent?: string;
  active?: boolean;
  onPress?: () => void;
  testID?: string;
  style?: object;
}

/**
 * StatTile — a compact metric card (count + label) used for the dashboard
 * summary row and other "key number" surfaces. Centrally controlled so every
 * stat looks identical.
 */
export function StatTile({
  label,
  value,
  icon,
  accent,
  active = false,
  onPress,
  testID,
  style,
}: StatTileProps) {
  const { colors, isDark, shadows } = useTheme();
  const accentColor = accent ?? colors.tint;

  const content = (
    <View
      style={[
        styles.tile,
        {
          backgroundColor: colors.surface,
          borderColor: active ? accentColor : colors.border,
          borderWidth: active ? 1.5 : StyleSheet.hairlineWidth,
        },
        shadows.sm,
        style,
      ]}
    >
      {icon ? (
        <View
          style={[
            styles.iconWrap,
            { backgroundColor: isDark ? accentColor + "26" : accentColor + "18" },
          ]}
        >
          <Ionicons name={icon} size={18} color={accentColor} />
        </View>
      ) : null}
      <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.label, { color: colors.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        testID={testID}
        style={({ pressed }) => [styles.pressable, pressed && { opacity: 0.85 }]}
      >
        {content}
      </Pressable>
    );
  }

  return content;
}

const styles = StyleSheet.create({
  pressable: {
    flex: 1,
  },
  tile: {
    flex: 1,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    gap: Spacing.xs,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.xs,
  },
  value: {
    ...Typography.h1,
  },
  label: {
    ...Typography.caption,
  },
});
