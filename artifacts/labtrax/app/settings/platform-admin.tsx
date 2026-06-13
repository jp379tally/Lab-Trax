import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell, SettingsSection } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";
import { storePlatformAdminSession, clearPlatformAdminSession } from "@/lib/platform-admin-session";

interface StatusResponse {
  ok?: boolean;
  secretConfigured: boolean;
  pinConfigured: boolean;
  sessionActive: boolean;
  sessionExpiresAt: string | null;
}

function formatExpiry(iso: string | null | undefined) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      month: "short",
      day: "numeric",
    });
  } catch { return iso ?? ""; }
}

export default function PlatformAdminScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const [credential, setCredential] = useState("");
  const [showCred, setShowCred] = useState(false);

  const statusQuery = useQuery<StatusResponse>({
    queryKey: ["admin", "platform-admin", "status"],
    queryFn: async () => {
      const res = await resilientFetch("/api/admin/platform-admin/status");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json() as Promise<StatusResponse>;
    },
    staleTime: 30_000,
  });

  const status = statusQuery.data;

  const unlockMutation = useMutation({
    mutationFn: async (cred: string) => {
      const res = await resilientFetch("/api/admin/platform-admin/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: cred }),
      });
      const body = await res.json().catch(() => ({})) as any;
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      return body as { ok: boolean; expiresAt: string; sessionToken: string };
    },
    onSuccess: async (data) => {
      setCredential("");
      if (data.sessionToken) {
        await storePlatformAdminSession(data.sessionToken);
      }
      qc.setQueryData<StatusResponse>(["admin", "platform-admin", "status"], (old) =>
        old ? { ...old, sessionActive: true, sessionExpiresAt: data.expiresAt } : old
      );
    },
    onError: (err: Error) => Alert.alert("Unlock failed", err.message),
  });

  const lockMutation = useMutation({
    mutationFn: async () => {
      const res = await resilientFetch("/api/admin/platform-admin/lock", { method: "POST" });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json();
    },
    onSuccess: async () => {
      await clearPlatformAdminSession();
      qc.setQueryData<StatusResponse>(["admin", "platform-admin", "status"], (old) =>
        old ? { ...old, sessionActive: false, sessionExpiresAt: null } : old
      );
    },
    onError: (err: Error) => Alert.alert("Lock failed", err.message),
  });

  const pending = unlockMutation.isPending || lockMutation.isPending;

  return (
    <ScreenShell
      title="Platform Admin"
      subtitle="Elevated platform-level access"
      onBack={() => router.back()}
      insetTop={insets.top}
    >
      <ScrollView contentContainerStyle={styles.body}>
        {statusQuery.isLoading && <ActivityIndicator color={colors.tint} />}
        {statusQuery.error && (
          <Text style={[styles.errorText, { color: colors.error }]}>
            Could not check platform admin status.
          </Text>
        )}

        {status && (
          <>
            <View
              style={[
                styles.statusCard,
                {
                  backgroundColor: status.sessionActive ? colors.tint + "10" : colors.surface,
                  borderColor: status.sessionActive ? colors.tint + "40" : colors.border,
                },
              ]}
            >
              <View
                style={[
                  styles.statusIcon,
                  { backgroundColor: status.sessionActive ? colors.tint + "20" : colors.surfaceAlt },
                ]}
              >
                <Ionicons
                  name={status.sessionActive ? "shield-checkmark-outline" : "shield-outline"}
                  size={24}
                  color={status.sessionActive ? colors.tint : colors.textSecondary}
                />
              </View>
              <View style={styles.statusText}>
                <Text style={[styles.statusTitle, { color: colors.text }]}>
                  {status.sessionActive ? "Session active" : "Not authenticated"}
                </Text>
                <Text style={[styles.statusSub, { color: colors.textSecondary }]}>
                  {status.sessionActive && status.sessionExpiresAt
                    ? `Expires ${formatExpiry(status.sessionExpiresAt)}`
                    : status.pinConfigured
                    ? "Enter your admin PIN or secret to unlock elevated access."
                    : "PLATFORM_ADMIN_SECRET is not configured on this server."}
                </Text>
              </View>
            </View>

            {!status.sessionActive && status.pinConfigured && (
              <SettingsSection title="Unlock session">
                <View style={styles.inputRow}>
                  <TextInput
                    style={[
                      styles.credInput,
                      {
                        color: colors.text,
                        backgroundColor: colors.surfaceAlt,
                        borderColor: colors.border,
                      },
                    ]}
                    value={credential}
                    onChangeText={setCredential}
                    placeholder={status.secretConfigured ? "PIN or secret" : "Admin PIN"}
                    placeholderTextColor={colors.textSecondary}
                    secureTextEntry={!showCred}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Pressable
                    style={[styles.eyeBtn, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
                    onPress={() => setShowCred((v) => !v)}
                  >
                    <Ionicons
                      name={showCred ? "eye-off-outline" : "eye-outline"}
                      size={18}
                      color={colors.textSecondary}
                    />
                  </Pressable>
                </View>
                <Pressable
                  style={[
                    styles.unlockBtn,
                    {
                      backgroundColor: credential.length > 0 ? colors.tint : colors.surfaceAlt,
                      borderColor: credential.length > 0 ? colors.tint : colors.border,
                    },
                  ]}
                  onPress={() => {
                    if (credential.length === 0) return;
                    unlockMutation.mutate(credential);
                  }}
                  disabled={pending || credential.length === 0}
                >
                  {unlockMutation.isPending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="lock-open-outline" size={16} color={credential.length > 0 ? "#fff" : colors.textSecondary} />
                      <Text style={[styles.unlockBtnText, { color: credential.length > 0 ? "#fff" : colors.textSecondary }]}>
                        Unlock
                      </Text>
                    </>
                  )}
                </Pressable>
              </SettingsSection>
            )}

            {status.sessionActive && (
              <SettingsSection title="Session">
                <Pressable
                  style={[styles.lockBtn, { borderColor: colors.error + "50" }]}
                  onPress={() =>
                    Alert.alert("End admin session", "This will revoke your elevated access.", [
                      { text: "Cancel", style: "cancel" },
                      { text: "Lock", style: "destructive", onPress: () => lockMutation.mutate() },
                    ])
                  }
                  disabled={pending}
                >
                  {lockMutation.isPending ? (
                    <ActivityIndicator size="small" color={colors.error} />
                  ) : (
                    <>
                      <Ionicons name="lock-closed-outline" size={16} color={colors.error} />
                      <Text style={[styles.lockBtnText, { color: colors.error }]}>
                        End session
                      </Text>
                    </>
                  )}
                </Pressable>
              </SettingsSection>
            )}

            <SettingsSection title="About platform admin">
              {[
                {
                  icon: "server-outline" as const,
                  title: "Server-side enforcement",
                  desc: "All /api/admin/* endpoints validate the credential on every request. This session record is stored server-side.",
                },
                {
                  icon: "lock-closed-outline" as const,
                  title: "PLATFORM_ADMIN_SECRET",
                  desc: "Long secret set as an environment variable. Grants access without a signed-in user (for CI/automation).",
                },
                {
                  icon: "keypad-outline" as const,
                  title: "PLATFORM_ADMIN_PIN",
                  desc: "Short numeric PIN alternative. Requires the user also has the admin role — PIN alone cannot authenticate.",
                },
              ].map((item, idx) => (
                <View
                  key={item.icon}
                  style={[
                    styles.howRow,
                    idx > 0 && styles.howRowBorder,
                    idx > 0 && { borderTopColor: colors.border },
                  ]}
                >
                  <View style={[styles.howIcon, { backgroundColor: colors.surfaceAlt }]}>
                    <Ionicons name={item.icon} size={16} color={colors.textSecondary} />
                  </View>
                  <View style={styles.howText}>
                    <Text style={[styles.howTitle, { color: colors.text }]}>{item.title}</Text>
                    <Text style={[styles.howDesc, { color: colors.textSecondary }]}>{item.desc}</Text>
                  </View>
                </View>
              ))}
            </SettingsSection>

            <View
              style={[
                styles.warningCard,
                { backgroundColor: colors.warning + "10", borderColor: colors.warning + "30" },
              ]}
            >
              <Ionicons name="warning-outline" size={16} color={colors.warning} />
              <Text style={[styles.warningText, { color: colors.warning }]}>
                Platform admin grants elevated privileges across all organizations. Only use when
                necessary and never share the secret.
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl },
    errorText: { ...Typography.body, textAlign: "center" },
    statusCard: {
      flexDirection: "row",
      gap: Spacing.md,
      borderRadius: Radius.lg,
      borderWidth: 1,
      padding: Spacing.lg,
    },
    statusIcon: {
      width: 44,
      height: 44,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    statusText: { flex: 1, gap: 5 },
    statusTitle: { ...Typography.h3 },
    statusSub: { ...Typography.caption },
    inputRow: { flexDirection: "row", gap: Spacing.sm, padding: Spacing.lg, paddingBottom: 0 },
    credInput: {
      flex: 1,
      ...Typography.body,
      borderWidth: 1,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    eyeBtn: {
      width: 42,
      height: 42,
      borderWidth: 1,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    unlockBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      margin: Spacing.lg,
      marginTop: Spacing.md,
      borderWidth: 1,
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
    },
    unlockBtnText: { ...Typography.bodyMedium },
    lockBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      margin: Spacing.lg,
      borderWidth: 1,
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
    },
    lockBtnText: { ...Typography.bodyMedium },
    howRow: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.md, padding: Spacing.lg },
    howRowBorder: { borderTopWidth: StyleSheet.hairlineWidth },
    howIcon: {
      width: 32,
      height: 32,
      borderRadius: Radius.sm,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    howText: { flex: 1, gap: 3 },
    howTitle: { ...Typography.bodyMedium },
    howDesc: { ...Typography.caption },
    warningCard: {
      flexDirection: "row",
      gap: Spacing.md,
      alignItems: "flex-start",
      borderRadius: Radius.md,
      borderWidth: 1,
      padding: Spacing.lg,
    },
    warningText: { ...Typography.caption, flex: 1 },
  });
}
