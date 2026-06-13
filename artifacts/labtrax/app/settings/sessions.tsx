import React, { useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
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
import { ScreenShell } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";

interface Session {
  id: string;
  deviceName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt?: string | null;
  expiresAt?: string | null;
  current?: boolean;
  isSuspicious?: boolean;
}

function formatDate(s: string | null | undefined) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch { return s; }
}

export default function SessionsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const query = useQuery<Session[]>({
    queryKey: ["auth", "sessions"],
    queryFn: async () => {
      const res = await resilientFetch("/api/auth/sessions");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      const data = body?.sessions ?? body?.data ?? body;
      return Array.isArray(data) ? data : [];
    },
    staleTime: 30_000,
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await resilientFetch(`/api/auth/sessions/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "sessions"] }),
    onError: (err: Error) => Alert.alert("Could not revoke session", err.message),
  });

  function confirmRevoke(session: Session) {
    Alert.alert(
      "Revoke session",
      `Sign out this device: ${session.deviceName || session.ipAddress || "unknown"}?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Revoke", style: "destructive", onPress: () => revokeMutation.mutate(session.id) },
      ]
    );
  }

  const suspiciousSessions = (query.data ?? []).filter((s) => s.isSuspicious && !s.current);

  return (
    <ScreenShell
      title="Active Sessions"
      subtitle="Devices signed in to your account"
      onBack={() => router.back()}
      insetTop={insets.top}
    >
      <ScrollView contentContainerStyle={styles.body}>
        {query.isLoading && <ActivityIndicator color={colors.tint} />}
        {query.error && (
          <Text style={[styles.errorText, { color: colors.error }]}>Could not load sessions.</Text>
        )}
        {!query.isLoading && (query.data?.length ?? 0) === 0 && (
          <Text style={[styles.empty, { color: colors.textSecondary }]}>No active sessions found.</Text>
        )}

        {suspiciousSessions.length > 0 && (
          <View
            style={[
              styles.alertBanner,
              { backgroundColor: "#EF444415", borderColor: "#EF444430" },
            ]}
          >
            <Ionicons name="warning-outline" size={16} color="#EF4444" />
            <Text style={[styles.alertText, { color: "#EF4444" }]}>
              {suspiciousSessions.length === 1
                ? "1 session was signed in from an unfamiliar IP address. Review and revoke if this wasn't you."
                : `${suspiciousSessions.length} sessions were signed in from unfamiliar IP addresses. Review and revoke if these weren't you.`}
            </Text>
          </View>
        )}

        {(query.data ?? []).map((session) => (
          <View
            key={session.id}
            style={[
              styles.card,
              {
                backgroundColor: session.isSuspicious && !session.current
                  ? "#EF444408"
                  : colors.surface,
                borderColor: session.isSuspicious && !session.current
                  ? "#EF444430"
                  : colors.border,
              },
            ]}
          >
            <View style={styles.cardHeader}>
              <View
                style={[
                  styles.iconWrap,
                  {
                    backgroundColor: session.isSuspicious && !session.current
                      ? "#EF444420"
                      : colors.tint + "1A",
                  },
                ]}
              >
                <Ionicons
                  name={
                    session.isSuspicious && !session.current
                      ? "warning-outline"
                      : "phone-portrait-outline"
                  }
                  size={18}
                  color={
                    session.isSuspicious && !session.current ? "#EF4444" : colors.tint
                  }
                />
              </View>
              <View style={styles.cardInfo}>
                <View style={styles.titleRow}>
                  <Text style={[styles.deviceText, { color: colors.text }]} numberOfLines={1}>
                    {session.deviceName || session.userAgent?.split(" ")[0] || "Unknown device"}
                  </Text>
                  {session.current && (
                    <View style={[styles.badge, { backgroundColor: colors.tint + "20" }]}>
                      <Text style={[styles.badgeText, { color: colors.tint }]}>This device</Text>
                    </View>
                  )}
                  {session.isSuspicious && !session.current && (
                    <View style={[styles.badge, { backgroundColor: "#EF444420" }]}>
                      <Ionicons name="warning-outline" size={10} color="#EF4444" />
                      <Text style={[styles.badgeText, { color: "#EF4444" }]}>Suspicious</Text>
                    </View>
                  )}
                </View>
                {session.ipAddress && (
                  <Text style={[styles.meta, { color: colors.textSecondary }]}>
                    IP: {session.ipAddress}
                    {session.isSuspicious && !session.current ? " · new location" : ""}
                  </Text>
                )}
                <Text style={[styles.meta, { color: colors.textSecondary }]}>
                  Signed in: {formatDate(session.createdAt)}
                  {session.expiresAt ? ` · expires ${formatDate(session.expiresAt)}` : ""}
                </Text>
              </View>
            </View>

            {!session.current && (
              <Pressable
                style={[
                  styles.revokeBtn,
                  {
                    borderColor: session.isSuspicious ? "#EF4444" : colors.error + "60",
                    backgroundColor: session.isSuspicious ? "#EF444410" : "transparent",
                  },
                ]}
                onPress={() => confirmRevoke(session)}
                disabled={revokeMutation.isPending}
              >
                <Text
                  style={[
                    styles.revokeBtnText,
                    { color: session.isSuspicious ? "#EF4444" : colors.error },
                  ]}
                >
                  {session.isSuspicious ? "Revoke (suspicious)" : "Revoke"}
                </Text>
              </Pressable>
            )}
          </View>
        ))}
      </ScrollView>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl },
    errorText: { ...Typography.body, textAlign: "center" },
    empty: { ...Typography.body, textAlign: "center", marginTop: Spacing.xxl },
    alertBanner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      padding: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: 1,
    },
    alertText: { ...Typography.caption, flex: 1 },
    card: {
      borderRadius: Radius.lg,
      borderWidth: 1,
      overflow: "hidden",
      padding: Spacing.lg,
      gap: Spacing.md,
    },
    cardHeader: { flexDirection: "row", gap: Spacing.md },
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: Radius.sm,
      alignItems: "center",
      justifyContent: "center",
    },
    cardInfo: { flex: 1, gap: 3 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, flexWrap: "wrap" },
    deviceText: { ...Typography.bodyMedium, flex: 1 },
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      borderRadius: Radius.full,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    badgeText: { ...Typography.tiny },
    meta: { ...Typography.caption },
    revokeBtn: {
      alignSelf: "flex-start",
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
    },
    revokeBtnText: { ...Typography.captionMedium },
  });
}
