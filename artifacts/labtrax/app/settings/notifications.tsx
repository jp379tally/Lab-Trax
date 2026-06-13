import React, { useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Switch,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell, SettingsSection } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";

interface NotifPrefs {
  emailCaseAssigned: boolean;
  emailCaseStatusChanged: boolean;
  emailInvoiceDue: boolean;
  emailInvoicePaid: boolean;
  emailDailySummary: boolean;
  emailWeeklySummary: boolean;
  smsCaseAssigned: boolean;
  smsCaseStatusChanged: boolean;
  smsInvoiceDue: boolean;
  pushCaseAssigned: boolean;
  pushCaseStatusChanged: boolean;
  pushInvoiceDue: boolean;
  pushChatMessage: boolean;
}

interface PrefsResponse {
  success?: boolean;
  preferences?: Partial<NotifPrefs>;
}

const NOTIFICATION_GROUPS: Array<{
  title: string;
  items: Array<{ key: keyof NotifPrefs; label: string; description: string }>;
}> = [
  {
    title: "Email",
    items: [
      { key: "emailCaseAssigned",      label: "Case assigned",      description: "When a case is assigned to you" },
      { key: "emailCaseStatusChanged", label: "Status updates",     description: "When a case status changes" },
      { key: "emailInvoiceDue",        label: "Invoice due",        description: "When an invoice is approaching due date" },
      { key: "emailInvoicePaid",       label: "Invoice paid",       description: "When an invoice is marked as paid" },
      { key: "emailDailySummary",      label: "Daily summary",      description: "End-of-day digest of activity" },
      { key: "emailWeeklySummary",     label: "Weekly summary",     description: "Weekly round-up of cases and invoices" },
    ],
  },
  {
    title: "SMS",
    items: [
      { key: "smsCaseAssigned",      label: "Case assigned",  description: "Text when a case is assigned to you" },
      { key: "smsCaseStatusChanged", label: "Status updates", description: "Text when a case status changes" },
      { key: "smsInvoiceDue",        label: "Invoice due",    description: "Text when an invoice approaches due date" },
    ],
  },
  {
    title: "Push",
    items: [
      { key: "pushCaseAssigned",      label: "Case assigned",  description: "Push notification when a case is assigned" },
      { key: "pushCaseStatusChanged", label: "Status updates", description: "Push when a case status changes" },
      { key: "pushInvoiceDue",        label: "Invoice due",    description: "Push when an invoice approaches due date" },
      { key: "pushChatMessage",       label: "Chat messages",  description: "Push for new in-app messages" },
    ],
  },
];

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const query = useQuery<NotifPrefs>({
    queryKey: ["auth", "notification-preferences"],
    queryFn: async () => {
      const res = await resilientFetch("/api/auth/notification-preferences");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = (await res.json()) as PrefsResponse;
      return (body?.preferences ?? {}) as NotifPrefs;
    },
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: async (patch: Partial<NotifPrefs>) => {
      const res = await resilientFetch("/api/auth/notification-preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return (await res.json()) as PrefsResponse;
    },
    onSuccess: (data) => {
      if (data.preferences) {
        qc.setQueryData(["auth", "notification-preferences"], data.preferences);
      }
    },
  });

  const prefs = query.data;

  function toggle(key: keyof NotifPrefs) {
    if (!prefs) return;
    const updated = { [key]: !prefs[key] };
    qc.setQueryData<NotifPrefs>(["auth", "notification-preferences"], (old) =>
      old ? { ...old, ...updated } : old
    );
    mutation.mutate(updated);
  }

  return (
    <ScreenShell
      title="Notifications"
      subtitle="Choose what you're notified about"
      onBack={() => router.back()}
      insetTop={insets.top}
    >
      <ScrollView contentContainerStyle={styles.body}>
        {query.isLoading && <ActivityIndicator color={colors.tint} />}
        {query.error && (
          <Text style={[styles.errorText, { color: colors.error }]}>
            Could not load notification preferences.
          </Text>
        )}

        {mutation.error && (
          <View style={[styles.warnCard, { backgroundColor: colors.error + "10", borderColor: colors.error + "30" }]}>
            <Ionicons name="warning-outline" size={14} color={colors.error} />
            <Text style={[styles.warnText, { color: colors.error }]}>
              Failed to save — changes may not persist.
            </Text>
          </View>
        )}

        {prefs &&
          NOTIFICATION_GROUPS.map((group) => (
            <SettingsSection key={group.title} title={group.title}>
              {group.items.map((item, idx) => (
                <View
                  key={item.key as string}
                  style={[
                    styles.row,
                    idx > 0 && styles.rowBorder,
                    idx > 0 && { borderTopColor: colors.border },
                  ]}
                >
                  <View style={styles.rowInfo}>
                    <Text style={[styles.rowTitle, { color: colors.text }]}>{item.label}</Text>
                    <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>
                      {item.description}
                    </Text>
                  </View>
                  <Switch
                    value={prefs[item.key] ?? false}
                    onValueChange={() => toggle(item.key)}
                    trackColor={{ false: colors.border, true: colors.tint }}
                    thumbColor="#fff"
                    disabled={mutation.isPending}
                  />
                </View>
              ))}
            </SettingsSection>
          ))}
      </ScrollView>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl },
    errorText: { ...Typography.body, textAlign: "center" },
    warnCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      padding: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: 1,
    },
    warnText: { ...Typography.caption, flex: 1 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
    },
    rowBorder: { borderTopWidth: StyleSheet.hairlineWidth },
    rowInfo: { flex: 1, gap: 2 },
    rowTitle: { ...Typography.bodyMedium },
    rowDesc: { ...Typography.caption },
  });
}
