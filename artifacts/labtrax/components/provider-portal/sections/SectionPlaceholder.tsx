// Shared scaffold for provider-portal sections that are not built yet.
//
// Each of the five sections owns its own module so the follow-on per-section
// tasks can replace the body without touching the shell or each other. Until
// then they render this, which says plainly that the section is coming rather
// than looking like a broken screen.
import React, { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";

export interface SectionPlaceholderProps {
  title: string;
  description: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  testID: string;
  children?: React.ReactNode;
}

export function SectionPlaceholder({
  title,
  description,
  icon,
  testID,
  children,
}: SectionPlaceholderProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      testID={testID}
    >
      <View style={styles.card}>
        <Ionicons name={icon} size={26} color={colors.tint} />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
      {children}
    </ScrollView>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    scroll: { flex: 1 },
    content: { padding: Spacing.lg, gap: Spacing.lg },
    card: {
      alignItems: "center",
      gap: Spacing.sm,
      padding: Spacing.xxl,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    title: { ...Typography.h3, color: colors.text, textAlign: "center" },
    description: {
      ...Typography.caption,
      color: colors.textSecondary,
      textAlign: "center",
    },
  });
}
