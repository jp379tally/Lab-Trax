// Blocking practice picker.
//
// Shown when the portal has no active practice and one must be chosen — either
// because the account is linked to several and none is stored yet, or because
// the server answered 409 PROVIDER_ORGANIZATION_REQUIRED. An account linked to
// exactly one practice never reaches this screen.
import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { useProviderPractice } from "@/lib/provider-practice";

export function ProviderPracticePicker() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { practices, selectPractice, switchError } = useProviderPractice();

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      testID="provider-practice-picker"
    >
      <Text style={styles.title}>Select a practice</Text>
      <Text style={styles.subtitle}>
        {practices.length > 1
          ? "Your account is linked to more than one practice. Choose the one you want to work in."
          : "Confirm the practice you want to work in to continue."}
      </Text>
      {switchError ? (
        <Text style={styles.error} testID="provider-practice-picker-error">
          {switchError}
        </Text>
      ) : null}
      {practices.map((row) => (
        <Pressable
          key={row.id}
          onPress={() => selectPractice(row.id)}
          style={styles.row}
          accessibilityRole="button"
          testID={`provider-practice-choice-${row.id}`}
        >
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {row.name}
            </Text>
            {row.accountNumber ? (
              <Text style={styles.rowMeta} numberOfLines={1}>
                {row.accountNumber}
              </Text>
            ) : null}
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    scroll: { flex: 1, backgroundColor: colors.backgroundSolid },
    content: { padding: Spacing.lg, gap: Spacing.sm },
    title: { ...Typography.h2, color: colors.text },
    subtitle: {
      ...Typography.caption,
      color: colors.textSecondary,
      marginBottom: Spacing.sm,
    },
    error: {
      ...Typography.caption,
      color: colors.errorText,
      backgroundColor: colors.errorSurface,
      borderRadius: Radius.sm,
      padding: Spacing.md,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      padding: Spacing.lg,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    rowMain: { flex: 1, gap: 2 },
    rowTitle: { ...Typography.bodyMedium, color: colors.text },
    rowMeta: { ...Typography.caption, color: colors.textSecondary },
  });
}
