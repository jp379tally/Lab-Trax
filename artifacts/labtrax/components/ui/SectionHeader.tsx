import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useTheme } from "@/lib/theme-context";

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
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 8,
  },
  title: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
  },
  action: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});
