// Provider portal → Settings.
//
// Reached from the header gear, matching desktop: the desktop gear opens a
// sixth (non-sidebar) view holding notification preferences and doctor
// preferences. Mobile already has both as full screens, so this section is the
// entry point into them rather than a second copy of the forms.
import React, { useMemo } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { router } from "expo-router";
import { useTheme } from "@/lib/theme-context";
import { Spacing } from "@/constants/tokens";
import { SettingsRow, SettingsSection } from "@/components/settings/SettingsRow";

export function ProviderSettingsSection() {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        scroll: { flex: 1, backgroundColor: colors.backgroundSolid },
        content: { padding: Spacing.lg },
      }),
    [colors],
  );

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      testID="provider-portal-section-settings"
    >
      <SettingsSection
        title="Settings"
        footer="Matches the settings your lab portal opens on the web."
      >
        <SettingsRow
          icon="notifications-outline"
          title="Notification preferences"
          subtitle="Choose which alerts reach you by email, text, and in-app"
          testID="provider-portal-settings-notifications"
          onPress={() => router.push("/settings/notifications" as any)}
        />
        <SettingsRow
          icon="medkit-outline"
          title="Doctor preferences"
          subtitle="Your standing instructions for every case you send"
          testID="provider-portal-settings-doctor-preferences"
          onPress={() => router.push("/settings/doctor-preferences" as any)}
        />
      </SettingsSection>
    </ScrollView>
  );
}
