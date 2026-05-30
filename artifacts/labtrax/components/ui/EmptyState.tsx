import React, { useMemo } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons, Feather } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

interface EmptyStateProps {
  /** Ionicons or Feather glyph name. */
  icon?: keyof typeof Ionicons.glyphMap;
  featherIcon?: keyof typeof Feather.glyphMap;
  title: string;
  description?: string;
  action?: { label: string; onPress: () => void };
  style?: object;
}

/**
 * EmptyState — a deliberate, centered placeholder for empty lists and
 * sections. Replaces the ad-hoc icon+text blocks scattered across screens.
 */
export function EmptyState({
  icon,
  featherIcon,
  title,
  description,
  action,
  style,
}: EmptyStateProps) {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View style={[styles.container, style]}>
      <View
        style={[
          styles.iconWrap,
          { backgroundColor: isDark ? colors.surfaceSecondary : colors.surfaceAlt },
        ]}
      >
        {featherIcon ? (
          <Feather name={featherIcon} size={28} color={colors.textTertiary} />
        ) : (
          <Ionicons
            name={icon ?? "file-tray-outline"}
            size={28}
            color={colors.textTertiary}
          />
        )}
      </View>
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      {description ? (
        <Text style={[styles.description, { color: colors.textSecondary }]}>
          {description}
        </Text>
      ) : null}
      {action ? (
        <Pressable
          onPress={action.onPress}
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: colors.tint },
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={styles.actionText}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: Spacing.huge,
      paddingHorizontal: Spacing.xl,
    },
    iconWrap: {
      width: 64,
      height: 64,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: Spacing.lg,
    },
    title: {
      ...Typography.h3,
      textAlign: "center",
    },
    description: {
      ...Typography.body,
      textAlign: "center",
      marginTop: Spacing.xs,
      maxWidth: 280,
    },
    action: {
      marginTop: Spacing.xl,
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
    },
    actionText: {
      ...Typography.bodySemibold,
      color: colors.textInverse,
    },
  });
