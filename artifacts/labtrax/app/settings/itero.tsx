import React, { useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell, SettingsSection, SettingsRow } from "@/components/settings/SettingsRow";

export default function IteroScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <ScreenShell title="iTero Auto-Import" subtitle="Desktop-only feature" onBack={() => router.back()} insetTop={insets.top}>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={[styles.headerCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.iconWrap, { backgroundColor: "#8B5CF620" }]}>
            <Ionicons name="sparkles" size={24} color="#8B5CF6" />
          </View>
          <View style={styles.headerInfo}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>iTero Auto-Import</Text>
            <View style={[styles.desktopBadge, { backgroundColor: colors.tint + "20" }]}>
              <Ionicons name="desktop-outline" size={12} color={colors.tint} />
              <Text style={[styles.desktopBadgeText, { color: colors.tint }]}>Desktop only</Text>
            </View>
          </View>
        </View>

        <View style={[styles.infoCard, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
          <Ionicons name="information-circle" size={18} color={colors.tint} style={styles.infoIcon} />
          <Text style={[styles.infoText, { color: colors.textSecondary }]}>
            The iTero auto-import feature uses the LabTrax Desktop app to log into the iTero Lab Review portal and automatically create cases from scanned prescriptions.{"\n\n"}
            This requires a persistent desktop session with a dedicated Electron browser window that can poll the iTero portal. Mobile devices cannot run this background polling process.{"\n\n"}
            To configure iTero credentials and enable auto-import, open{" "}
            <Text style={{ color: colors.text, fontFamily: "Inter_600SemiBold" }}>
              LabTrax Desktop → Settings → iTero auto-import
            </Text>.
          </Text>
        </View>

        <SettingsSection title="How it works">
          {[
            { icon: "key-outline", title: "Store credentials", desc: "Admin saves shared iTero credentials securely in the Desktop app using native encrypted storage." },
            { icon: "time-outline", title: "Automatic polling", desc: "Desktop polls the iTero Lab Review queue every 5–240 minutes and downloads new prescriptions." },
            { icon: "document-text-outline", title: "Case creation", desc: "Each new prescription is processed by AI and automatically creates an active case in LabTrax." },
            { icon: "checkmark-circle-outline", title: "Review in mobile", desc: "Cases imported from iTero appear with a review banner on both mobile and desktop." },
          ].map((item, idx) => (
            <SettingsRow
              key={item.icon}
              icon={item.icon as any}
              iconColor="#8B5CF6"
              iconBg="#8B5CF620"
              title={item.title}
              subtitle={item.desc}
              showChevron={false}
            />
          ))}
        </SettingsSection>
      </ScrollView>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl },
    headerCard: {
      flexDirection: "row",
      gap: Spacing.md,
      alignItems: "center",
      borderRadius: Radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      padding: Spacing.lg,
    },
    iconWrap: {
      width: 52,
      height: 52,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    headerInfo: { flex: 1, gap: Spacing.sm },
    headerTitle: { ...Typography.h3 },
    desktopBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      alignSelf: "flex-start",
      borderRadius: Radius.full,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    desktopBadgeText: { ...Typography.tiny },
    infoCard: {
      flexDirection: "row",
      gap: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      padding: Spacing.lg,
    },
    infoIcon: { flexShrink: 0, marginTop: 2 },
    infoText: { ...Typography.body, flex: 1 },
  });
}
