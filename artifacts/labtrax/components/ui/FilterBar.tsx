import React from "react";
import { ScrollView, Pressable, Text, StyleSheet, View } from "react-native";
import { useTheme } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

interface FilterChip<T extends string> {
  id: T;
  label: string;
  count?: number;
}

interface FilterBarProps<T extends string> {
  filters: FilterChip<T>[];
  activeId: T;
  onSelect: (id: T) => void;
  style?: object;
}

export function FilterBar<T extends string>({
  filters,
  activeId,
  onSelect,
  style,
}: FilterBarProps<T>) {
  const { colors, isDark } = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.container, style]}
      style={styles.scroll}
    >
      {filters.map((f) => {
        const active = f.id === activeId;
        return (
          <Pressable
            key={f.id}
            onPress={() => onSelect(f.id)}
            style={[
              styles.chip,
              {
                backgroundColor: active
                  ? colors.tint
                  : isDark
                  ? colors.surfaceSecondary
                  : colors.surfaceAlt,
                borderColor: active ? colors.tint : colors.border,
              },
            ]}
          >
            <Text
              style={[
                styles.label,
                { color: active ? colors.textInverse : colors.textSecondary },
              ]}
            >
              {f.label}
              {f.count !== undefined ? (
                <Text style={[styles.count, { color: active ? "rgba(255,255,255,0.75)" : colors.textTertiary }]}>
                  {" "}{f.count}
                </Text>
              ) : null}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 0,
  },
  container: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
    flexDirection: "row",
  },
  chip: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  count: {
    ...Typography.caption,
  },
});
