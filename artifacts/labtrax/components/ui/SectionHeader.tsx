import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useTheme } from "@/lib/theme-context";
import { Spacing, Typography } from "@/constants/tokens";

interface SectionHeaderProps {
  title: string;
  action?: { label: string; onPress: () => void };
  style?: object;
}

export function SectionHeader({ title, action, style }: SectionHeaderProps) {
  const { colors } = useTheme();

  return (
    <View style={[styles.row, style]}>
      <Text style={[styles.title, { color: colors.textSecondary }]}>
        {title.toUpperCase()}
      </Text>
      {action && (
        <Pressable onPress={action.onPress} hitSlop={8}>
          <Text style={[styles.action, { color: colors.tint }]}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.sm,
  },
  title: {
    ...Typography.label,
  },
  action: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});
