import React, { useMemo } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography } from "@/constants/tokens";
import { ScreenShell, SettingsSection, SettingsRow } from "@/components/settings/SettingsRow";

export default function TemplatesScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <ScreenShell title="Templates" subtitle="Document layout editors" onBack={() => router.back()} insetTop={insets.top}>
      <ScrollView contentContainerStyle={styles.body}>
        <SettingsSection
          title="Layouts"
          footer="Each layout controls how documents are formatted when generated for practices."
        >
          <SettingsRow
            icon="document-text-outline"
            iconColor="#3B82F6"
            iconBg="#3B82F620"
            title="Invoice Layout"
            subtitle="Header, footer, and column configuration for invoice PDFs"
            onPress={() => router.push("/settings/invoice-layout" as never)}
          />
          <SettingsRow
            icon="receipt-outline"
            iconColor="#8B5CF6"
            iconBg="#8B5CF620"
            title="Statement Layout"
            subtitle="Monthly billing statement PDF layout and branding"
            onPress={() => router.push("/settings/statement-layout" as never)}
          />
          <SettingsRow
            icon="mail-outline"
            iconColor="#0EA5E9"
            iconBg="#0EA5E920"
            title="Correspondence Layout"
            subtitle="Letter and general correspondence template settings"
            onPress={() => router.push("/settings/correspondence-layout" as never)}
          />
        </SettingsSection>
      </ScrollView>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl },
  });
}
