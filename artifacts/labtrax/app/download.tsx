import React from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { AppHeader } from "@/components/ui/AppHeader";

export default function DownloadScreen() {
  const { colors } = useTheme();

  const installers = [
    {
      key: "windows-portable",
      label: "Windows (Portable)",
      subtitle: "LabTrax-Windows-Portable.zip — no install required",
      icon: "logo-windows" as const,
      path: "/downloads/LabTrax-Windows-Portable.zip",
    },
    {
      key: "windows-setup",
      label: "Windows Installer",
      subtitle: "LabTrax-Setup.exe — one-click install",
      icon: "logo-windows" as const,
      path: "/downloads/LabTrax-Setup.exe",
    },
    {
      key: "macos",
      label: "macOS",
      subtitle: "LabTrax.dmg — drag to Applications",
      icon: "logo-apple" as const,
      path: "/downloads/LabTrax.dmg",
    },
  ];

  function openDownload(path: string) {
    const base = (process.env.EXPO_PUBLIC_DOMAIN as string | undefined)
      ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
      : "";
    Linking.openURL(`${base}${path}`).catch(() => {});
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSolid }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <AppHeader title="Download Desktop App" showSearch={false} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={[styles.infoBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Ionicons name="desktop-outline" size={32} color={colors.tint} />
          <Text style={[styles.infoTitle, { color: colors.text }]}>LabTrax Desktop</Text>
          <Text style={[styles.infoSub, { color: colors.textSecondary }]}>
            The desktop app gives you a native experience on Windows and macOS
            with offline support, file-system access, and auto-updates.
          </Text>
        </View>

        <Text style={[styles.sectionLabel, { color: colors.textTertiary }]}>CHOOSE YOUR PLATFORM</Text>

        {installers.map((item) => (
          <Pressable
            key={item.key}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: pressed ? colors.surfaceSecondary : colors.surface,
                borderColor: colors.border,
              },
            ]}
            onPress={() => openDownload(item.path)}
          >
            <View style={[styles.iconWrap, { backgroundColor: colors.tint + "18" }]}>
              <Ionicons name={item.icon} size={22} color={colors.tint} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: colors.text }]}>{item.label}</Text>
              <Text style={[styles.rowSub, { color: colors.textSecondary }]}>{item.subtitle}</Text>
            </View>
            <Ionicons name="download-outline" size={20} color={colors.tint} />
          </Pressable>
        ))}

        <Text style={[styles.note, { color: colors.textTertiary }]}>
          Contact your lab administrator if downloads are unavailable.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, gap: 12, paddingBottom: 60 },
  infoBox: {
    alignItems: "center",
    padding: 24,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
    marginBottom: 8,
  },
  infoTitle: { fontSize: 18, fontFamily: "Inter_700Bold" },
  infoSub: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 19 },
  sectionLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  rowSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  note: { fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 8 },
});
