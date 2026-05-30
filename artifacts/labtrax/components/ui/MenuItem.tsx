import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons, Feather } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

interface MenuItemProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description?: string;
  iconColor?: string;
  iconBg?: string;
  trailing?: React.ReactNode;
  showChevron?: boolean;
  onPress?: () => void;
  testID?: string;
  /** Render label/icon in the destructive (error) color. */
  destructive?: boolean;
}

/**
 * MenuItem — the canonical "icon + label + chevron" row used in drawers,
 * settings lists, and action menus. One consistent tap target everywhere.
 */
export function MenuItem({
  icon,
  label,
  description,
  iconColor,
  iconBg,
  trailing,
  showChevron = true,
  onPress,
  testID,
  destructive = false,
}: MenuItemProps) {
  const { colors, isDark } = useTheme();

  const resolvedIconColor = destructive
    ? colors.error
    : iconColor ?? colors.tint;
  const resolvedIconBg =
    iconBg ?? (isDark ? colors.surfaceSecondary : colors.surfaceAlt);

  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.row,
        pressed && { opacity: 0.7 },
      ]}
    >
      <View style={[styles.icon, { backgroundColor: resolvedIconBg }]}>
        <Ionicons name={icon} size={20} color={resolvedIconColor} />
      </View>
      <View style={styles.content}>
        <Text
          style={[
            styles.label,
            { color: destructive ? colors.error : colors.text },
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {description ? (
          <Text
            style={[styles.description, { color: colors.textSecondary }]}
            numberOfLines={1}
          >
            {description}
          </Text>
        ) : null}
      </View>
      {trailing}
      {showChevron && (
        <Feather name="chevron-right" size={18} color={colors.textTertiary} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    gap: Spacing.md,
    minHeight: 56,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  label: {
    ...Typography.h3,
    fontSize: 15,
  },
  description: {
    ...Typography.caption,
    marginTop: 2,
  },
});
