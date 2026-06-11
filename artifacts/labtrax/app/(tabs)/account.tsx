import React, { useMemo } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/lib/auth-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";

function roleLabel(userType: string | null): string {
  switch (userType) {
    case "provider":
      return "Provider";
    case "lab":
      return "Lab";
    case "master_admin":
      return "Administrator";
    default:
      return "Member";
  }
}

export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const { colors, isDark, setMode } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { currentUser, userType, logout } = useAuth();

  function confirmLogout() {
    Alert.alert("Log out", "Are you sure you want to log out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => logout() },
    ]);
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Account</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Card>
          <View style={styles.profileRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {(currentUser ?? "?").charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={styles.profileInfo}>
              <Text style={styles.username} numberOfLines={1}>
                {currentUser ?? "Signed in"}
              </Text>
              <Text style={styles.role}>{roleLabel(userType)}</Text>
            </View>
          </View>
        </Card>

        <Card>
          <Text style={styles.cardHeading}>Appearance</Text>
          <View style={styles.segment}>
            <Pressable
              style={[styles.segmentBtn, !isDark && styles.segmentBtnOn]}
              onPress={() => setMode("light")}
              testID="theme-light"
            >
              <Ionicons name="sunny-outline" size={16} color={!isDark ? colors.textInverse : colors.textSecondary} />
              <Text style={[styles.segmentLabel, !isDark && styles.segmentLabelOn]}>Light</Text>
            </Pressable>
            <Pressable
              style={[styles.segmentBtn, isDark && styles.segmentBtnOn]}
              onPress={() => setMode("dark")}
              testID="theme-dark"
            >
              <Ionicons name="moon-outline" size={16} color={isDark ? colors.textInverse : colors.textSecondary} />
              <Text style={[styles.segmentLabel, isDark && styles.segmentLabelOn]}>Dark</Text>
            </Pressable>
          </View>
        </Card>

        <Pressable style={styles.logoutBtn} onPress={confirmLogout} testID="logout-button">
          <Ionicons name="log-out-outline" size={20} color={colors.error} />
          <Text style={styles.logoutText}>Log out</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: Spacing.xs },
    title: { ...Typography.h1, color: c.text },
    body: { padding: Spacing.lg, gap: Spacing.md },
    profileRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    avatar: {
      width: 52,
      height: 52,
      borderRadius: Radius.full,
      backgroundColor: c.tintLight,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: { ...Typography.h2, color: c.tint },
    profileInfo: { flex: 1 },
    username: { ...Typography.h3, color: c.text },
    role: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    cardHeading: { ...Typography.h3, color: c.text, marginBottom: Spacing.md },
    segment: {
      flexDirection: "row",
      backgroundColor: c.surfaceAlt,
      borderRadius: Radius.md,
      padding: 4,
      gap: 4,
    },
    segmentBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.sm,
    },
    segmentBtnOn: { backgroundColor: c.tint },
    segmentLabel: { ...Typography.bodyMedium, color: c.textSecondary },
    segmentLabelOn: { color: c.textInverse },
    logoutBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.error,
      marginTop: Spacing.sm,
    },
    logoutText: { ...Typography.bodySemibold, color: c.error },
  });
}
