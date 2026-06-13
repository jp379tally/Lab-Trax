import React, { useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  Linking,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";
import { getPlatformAdminSessionHeaders } from "@/lib/platform-admin-session";

type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "grace"
  | "locked"
  | "canceled"
  | "legacy_free";

interface SubscriptionItem {
  id: string;
  subjectType: string;
  subjectId: string;
  subjectName: string;
  subjectOrgType: string | null;
  subjectEmail: string | null;
  provider: string;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  createdAt: string;
}

interface SubscriptionsResponse {
  ok?: boolean;
  items?: SubscriptionItem[];
  total?: number;
}

const STATUS_META: Record<SubscriptionStatus, { label: string; color: string; bg: string; icon: string }> = {
  trialing:    { label: "Trial",        color: "#3B82F6", bg: "#3B82F620", icon: "time-outline" },
  active:      { label: "Active",       color: "#10B981", bg: "#10B98120", icon: "checkmark-circle-outline" },
  past_due:    { label: "Past due",     color: "#F59E0B", bg: "#F59E0B20", icon: "warning-outline" },
  grace:       { label: "Grace period", color: "#F97316", bg: "#F9731620", icon: "alert-circle-outline" },
  locked:      { label: "Locked",       color: "#EF4444", bg: "#EF444420", icon: "lock-closed-outline" },
  canceled:    { label: "Canceled",     color: "#6B7280", bg: "#6B728020", icon: "close-circle-outline" },
  legacy_free: { label: "Legacy free",  color: "#8B5CF6", bg: "#8B5CF620", icon: "gift-outline" },
};

function formatDate(s: string | null | undefined) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch { return s; }
}

function subjectTypeLabel(t: string): string {
  if (t === "lab_org") return "Lab";
  if (t === "provider_org") return "Provider";
  if (t === "user") return "User";
  return t;
}

function SubscriptionCard({
  item,
  styles,
  colors,
}: {
  item: SubscriptionItem;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  const meta = STATUS_META[item.status] ?? STATUS_META.active;
  const hasStripe = !!item.stripeCustomerId;

  const portalMutation = useMutation({
    mutationFn: async () => {
      const adminHeaders = await getPlatformAdminSessionHeaders();
      const res = await resilientFetch(`/api/admin/subscriptions/${item.id}/portal`, {
        method: "POST",
        headers: adminHeaders,
      });
      const body = await res.json().catch(() => ({})) as any;
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      return body as { ok: boolean; url: string };
    },
    onSuccess: async (data) => {
      if (data.url) {
        const supported = await Linking.canOpenURL(data.url);
        if (supported) {
          await Linking.openURL(data.url);
        } else {
          Alert.alert("Portal URL", data.url);
        }
      }
    },
    onError: (err: Error) => Alert.alert("Could not open Stripe portal", err.message),
  });

  const isAtRisk =
    item.status === "trialing" ||
    item.status === "past_due" ||
    item.status === "grace";

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: isAtRisk ? meta.color + "40" : colors.border,
        },
      ]}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.iconWrap, { backgroundColor: colors.tint + "1A" }]}>
          <Ionicons name="business-outline" size={18} color={colors.tint} />
        </View>
        <View style={styles.cardInfo}>
          <Text style={[styles.subjectName, { color: colors.text }]} numberOfLines={1}>
            {item.subjectName}
          </Text>
          <View style={styles.badgeRow}>
            <View style={[styles.pill, { backgroundColor: colors.surfaceAlt }]}>
              <Text style={[styles.pillText, { color: colors.textSecondary }]}>
                {subjectTypeLabel(item.subjectType)}
              </Text>
            </View>
            <View style={[styles.pill, { backgroundColor: meta.bg }]}>
              <Ionicons name={meta.icon as any} size={11} color={meta.color} />
              <Text style={[styles.pillText, { color: meta.color }]}>{meta.label}</Text>
            </View>
            {item.cancelAtPeriodEnd && (
              <View style={[styles.pill, { backgroundColor: colors.warning + "20" }]}>
                <Text style={[styles.pillText, { color: colors.warning }]}>Cancels at end</Text>
              </View>
            )}
          </View>
          {item.subjectEmail && (
            <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>
              {item.subjectEmail}
            </Text>
          )}
        </View>
      </View>

      <View style={[styles.datesRow, { borderTopColor: colors.border }]}>
        <View style={styles.dateItem}>
          <Text style={[styles.dateLabel, { color: colors.textSecondary }]}>Provider</Text>
          <Text style={[styles.dateVal, { color: colors.text }]}>{item.provider || "—"}</Text>
        </View>
        {item.status === "trialing" && item.trialEndsAt && (
          <View style={styles.dateItem}>
            <Text style={[styles.dateLabel, { color: colors.textSecondary }]}>Trial ends</Text>
            <Text style={[styles.dateVal, { color: "#3B82F6" }]}>
              {formatDate(item.trialEndsAt)}
            </Text>
          </View>
        )}
        {item.status !== "trialing" && item.currentPeriodEnd && (
          <View style={styles.dateItem}>
            <Text style={[styles.dateLabel, { color: colors.textSecondary }]}>Period ends</Text>
            <Text style={[styles.dateVal, { color: colors.text }]}>
              {formatDate(item.currentPeriodEnd)}
            </Text>
          </View>
        )}
        {!item.currentPeriodEnd && item.status !== "trialing" && (
          <View style={styles.dateItem}>
            <Text style={[styles.dateLabel, { color: colors.textSecondary }]}>Created</Text>
            <Text style={[styles.dateVal, { color: colors.text }]}>{formatDate(item.createdAt)}</Text>
          </View>
        )}
      </View>

      {(item.status === "trialing" || item.status === "grace" || item.status === "past_due") && (
        <View
          style={[
            styles.trialBanner,
            { backgroundColor: meta.bg, borderTopColor: meta.color + "20" },
          ]}
        >
          <Ionicons name={meta.icon as any} size={13} color={meta.color} />
          <Text style={[styles.trialBannerText, { color: meta.color }]}>
            {item.status === "trialing" && item.trialEndsAt
              ? `Trial ends ${formatDate(item.trialEndsAt)} — add a payment method to continue.`
              : item.status === "grace"
              ? "In grace period — billing failed. Please update payment to avoid losing access."
              : "Payment past due — please update your billing information."}
          </Text>
        </View>
      )}

      {hasStripe && (
        <Pressable
          style={[styles.portalBtn, { borderTopColor: colors.border }]}
          onPress={() => portalMutation.mutate()}
          disabled={portalMutation.isPending}
        >
          {portalMutation.isPending ? (
            <ActivityIndicator size="small" color={colors.tint} />
          ) : (
            <>
              <Ionicons name="card-outline" size={15} color={colors.tint} />
              <Text style={[styles.portalBtnText, { color: colors.tint }]}>
                Manage billing in Stripe
              </Text>
              <Ionicons name="open-outline" size={13} color={colors.tint} />
            </>
          )}
        </Pressable>
      )}
    </View>
  );
}

export default function SubscriptionsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const query = useQuery<SubscriptionItem[]>({
    queryKey: ["admin", "subscriptions"],
    queryFn: async () => {
      const adminHeaders = await getPlatformAdminSessionHeaders();
      const res = await resilientFetch("/api/admin/subscriptions", { headers: adminHeaders });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = (await res.json()) as SubscriptionsResponse;
      return Array.isArray(body?.items) ? body.items : [];
    },
    staleTime: 60_000,
  });

  const items = query.data ?? [];

  return (
    <ScreenShell
      title="Subscriptions"
      subtitle="Organization subscription status"
      onBack={() => router.back()}
      insetTop={insets.top}
    >
      <ScrollView contentContainerStyle={styles.body}>
        {query.isLoading && <ActivityIndicator color={colors.tint} />}
        {query.error && (
          <Text style={[styles.errorText, { color: colors.error }]}>
            Could not load subscriptions.
          </Text>
        )}

        {!query.isLoading && items.length === 0 && !query.error && (
          <Text style={[styles.empty, { color: colors.textSecondary }]}>
            No subscription data available.
          </Text>
        )}

        {items.map((item) => (
          <SubscriptionCard key={item.id} item={item} styles={styles} colors={colors} />
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
    card: { borderRadius: Radius.lg, borderWidth: 1, overflow: "hidden" },
    cardHeader: { flexDirection: "row", gap: Spacing.md, padding: Spacing.lg },
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: Radius.sm,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    cardInfo: { flex: 1, gap: 5 },
    subjectName: { ...Typography.bodyMedium },
    badgeRow: { flexDirection: "row", gap: Spacing.xs, flexWrap: "wrap", alignItems: "center" },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderRadius: Radius.full,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    pillText: { ...Typography.tiny },
    meta: { ...Typography.caption },
    datesRow: {
      flexDirection: "row",
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      gap: Spacing.xl,
    },
    dateItem: { gap: 2 },
    dateLabel: { ...Typography.caption },
    dateVal: { ...Typography.bodyMedium },
    trialBanner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    trialBannerText: { ...Typography.caption, flex: 1 },
    portalBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    portalBtnText: { ...Typography.bodyMedium, flex: 1, textAlign: "center" },
  });
}
