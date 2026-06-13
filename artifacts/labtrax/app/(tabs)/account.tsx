import React, { useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Alert,
  Switch,
  Image,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/lib/auth-context";
import { useMe } from "@/lib/auth-me";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { SettingsSection, SettingsRow } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";
import { isBackupOverdue } from "../settings/backup";

function push(path: string) {
  router.push(path as never);
}

export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const { colors, isDark, setMode } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { currentUser, userType, logout, profilePicUri } = useAuth();
  const me = useMe();

  const user = me.data?.user as any;
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  const displayName = fullName || currentUser || "Account";
  const displayRole = user?.role || userType || "user";
  const avatarLetter = displayName.charAt(0).toUpperCase() || "A";

  const isAdmin = (user?.role === "admin") || (userType === "master_admin");

  const backupOverdueQuery = useQuery({
    queryKey: ["admin", "backup-overdue-status"],
    queryFn: async () => {
      const res = await resilientFetch("/api/admin/backup/overdue-status");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json() as Promise<{ lastSuccessfulBackupAt: string | null; staleAfterDays: number }>;
    },
    staleTime: 5 * 60_000,
    enabled: isAdmin,
  });
  const backupOverdue =
    isAdmin && backupOverdueQuery.isSuccess && isBackupOverdue(backupOverdueQuery.data ?? { lastSuccessfulBackupAt: null, staleAfterDays: 7 });

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

      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile HUD */}
        <Pressable
          style={[styles.profileCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => push("/settings/profile")}
        >
          {profilePicUri ? (
            <Image source={{ uri: profilePicUri }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, { backgroundColor: colors.tint + "20" }]}>
              <Text style={[styles.avatarText, { color: colors.tint }]}>{avatarLetter}</Text>
            </View>
          )}
          <View style={styles.profileInfo}>
            <Text style={[styles.profileName, { color: colors.text }]} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={[styles.profileRole, { color: colors.textSecondary }]} numberOfLines={1}>
              {user?.email ? `${user.email} · ` : ""}
              <Text style={{ textTransform: "capitalize" }}>{displayRole}</Text>
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        </Pressable>

        {/* Personal section */}
        <SettingsSection title="Personal">
          <SettingsRow
            icon="person-outline"
            iconColor="#3B82F6"
            iconBg="#3B82F620"
            title="Profile"
            subtitle="Name, email, phone, work status"
            onPress={() => push("/settings/profile")}
          />
          <SettingsRow
            icon="key-outline"
            iconColor="#8B5CF6"
            iconBg="#8B5CF620"
            title="Password"
            subtitle="Change your sign-in password"
            onPress={() => push("/settings/password")}
          />
          <SettingsRow
            icon="shield-checkmark-outline"
            iconColor="#10B981"
            iconBg="#10B98120"
            title="Two-factor authentication"
            subtitle="Secure your account with an authenticator app"
            onPress={() => push("/settings/two-factor")}
          />
          <SettingsRow
            icon="phone-portrait-outline"
            iconColor="#64748B"
            iconBg="#64748B20"
            title="Active sessions"
            subtitle="Devices currently signed in to your account"
            onPress={() => push("/settings/sessions")}
          />
        </SettingsSection>

        {/* Lab & Orgs section */}
        <SettingsSection title="Lab & Organizations">
          <SettingsRow
            icon="business-outline"
            iconColor="#0EA5E9"
            iconBg="#0EA5E920"
            title="Organizations"
            subtitle="Labs and practices you belong to"
            onPress={() => push("/settings/organizations")}
          />
          <SettingsRow
            icon="notifications-outline"
            iconColor="#F59E0B"
            iconBg="#F59E0B20"
            title="Notifications"
            subtitle="Choose what you're notified about"
            onPress={() => push("/settings/notifications")}
          />
        </SettingsSection>

        {/* Appearance */}
        <SettingsSection title="Appearance">
          <View style={styles.themeRow}>
            <View style={[styles.themeIcon, { backgroundColor: "#64748B20" }]}>
              <Ionicons name={isDark ? "moon-outline" : "sunny-outline"} size={19} color="#64748B" />
            </View>
            <View style={styles.themeInfo}>
              <Text style={[styles.themeLabel, { color: colors.text }]}>Dark mode</Text>
              <Text style={[styles.themeSub, { color: colors.textSecondary }]}>
                {isDark ? "Currently dark" : "Currently light"}
              </Text>
            </View>
            <Switch
              value={isDark}
              onValueChange={(v) => setMode(v ? "dark" : "light")}
              trackColor={{ false: colors.border, true: colors.tint }}
              thumbColor="#fff"
            />
          </View>
        </SettingsSection>

        {/* Apps */}
        <SettingsSection title="Apps">
          <SettingsRow
            icon="desktop-outline"
            iconColor="#6366F1"
            iconBg="#6366F120"
            title="Desktop App"
            subtitle="Download LabTrax for Windows or macOS"
            onPress={() => push("/settings/desktop")}
          />
        </SettingsSection>

        {/* Administration — admin only */}
        {isAdmin && (
          <SettingsSection title="Administration">
            <SettingsRow
              icon="people-outline"
              iconColor="#3B82F6"
              iconBg="#3B82F620"
              title="Users"
              subtitle="All platform accounts and roles"
              onPress={() => push("/settings/users")}
            />
            <SettingsRow
              icon="cloud-upload-outline"
              iconColor="#0EA5E9"
              iconBg="#0EA5E920"
              title="Backup"
              subtitle={backupOverdue ? "⚠ Backup overdue — tap to review" : "Schedule and run encrypted data backups"}
              badge={backupOverdue}
              badgeColor="#F59E0B"
              onPress={() => push("/settings/backup")}
            />
            <SettingsRow
              icon="document-text-outline"
              iconColor="#8B5CF6"
              iconBg="#8B5CF620"
              title="Templates"
              subtitle="Invoice, statement, and letter layouts"
              onPress={() => push("/settings/templates")}
            />
            <SettingsRow
              icon="phone-portrait-outline"
              iconColor="#10B981"
              iconBg="#10B98120"
              title="Mobile App"
              subtitle="EAS builds and app version management"
              onPress={() => push("/settings/mobile-app")}
            />
            <SettingsRow
              icon="card-outline"
              iconColor="#F59E0B"
              iconBg="#F59E0B20"
              title="Subscriptions"
              subtitle="Organization billing and subscription status"
              onPress={() => push("/settings/subscriptions")}
            />
            <SettingsRow
              icon="shield-outline"
              iconColor="#EF4444"
              iconBg="#EF444420"
              title="Platform Admin"
              subtitle="Elevated platform-level access"
              onPress={() => push("/settings/platform-admin")}
            />
            <SettingsRow
              icon="sparkles-outline"
              iconColor="#A855F7"
              iconBg="#A855F720"
              title="iTero Auto-Import"
              subtitle="Desktop-only feature — tap to learn more"
              onPress={() => push("/settings/itero")}
              rightElement={
                <Ionicons name="lock-closed-outline" size={14} color={colors.textTertiary} style={{ marginRight: 2 }} />
              }
            />
          </SettingsSection>
        )}

        {/* About */}
        <SettingsSection title="About">
          <SettingsRow
            icon="document-outline"
            iconColor="#64748B"
            iconBg="#64748B20"
            title="Privacy Policy"
            onPress={() => push("/privacy-policy")}
          />
          <SettingsRow
            icon="reader-outline"
            iconColor="#64748B"
            iconBg="#64748B20"
            title="Terms of Service"
            onPress={() => push("/terms-of-service")}
          />
        </SettingsSection>

        {/* Log out */}
        <Pressable
          style={[styles.logoutBtn, { borderColor: colors.error }]}
          onPress={confirmLogout}
          testID="logout-button"
        >
          <Ionicons name="log-out-outline" size={20} color={colors.error} />
          <Text style={[styles.logoutText, { color: colors.error }]}>Log out</Text>
        </Pressable>

        <View style={styles.footerSpace} />
      </ScrollView>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
    },
    title: { ...Typography.h1, color: c.text },
    body: {
      padding: Spacing.lg,
      gap: Spacing.lg,
      paddingBottom: Spacing.xxxl,
    },

    profileCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      padding: Spacing.lg,
      borderRadius: Radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
    },
    avatar: {
      width: 52,
      height: 52,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: { ...Typography.h2 },
    profileInfo: { flex: 1 },
    profileName: { ...Typography.h3 },
    profileRole: { ...Typography.caption, marginTop: 2 },

    themeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
    },
    themeIcon: {
      width: 34,
      height: 34,
      borderRadius: Radius.sm,
      alignItems: "center",
      justifyContent: "center",
    },
    themeInfo: { flex: 1, gap: 2 },
    themeLabel: { ...Typography.bodyMedium },
    themeSub: { ...Typography.caption },

    logoutBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
    },
    logoutText: { ...Typography.bodySemibold },
    footerSpace: { height: Spacing.lg },
  });
}
