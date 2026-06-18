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
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell } from "@/components/settings/SettingsRow";
import { resilientFetch, loadTokens, getAccessToken } from "@/lib/query-client";

type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "grace"
  | "locked"
  | "canceled"
  | "legacy_free";

interface SubscriptionEntitlement {
  status: SubscriptionStatus;
  accessLevel: "full" | "read_only" | "locked";
  trialDaysRemaining: number | null;
  graceDaysRemaining: number | null;
  currentPeriodEnd: string | null;
  hasPaymentMethod: boolean;
  planType: "lab" | "provider" | null;
  billingInterval: "month" | "year" | null;
  cancelAtPeriodEnd: boolean;
  hasStripeSubscription: boolean;
}

interface StripeInvoice {
  id: string;
  number: string | null;
  status: string | null;
  amountPaid: number;
  amountDue: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  hostedInvoiceUrl: string | null;
}

interface SubscriptionEvent {
  id: string;
  eventType: string;
  statusBefore: string | null;
  statusAfter: string | null;
  provider: string | null;
  createdAt: string;
}

const STATUS_META: Record<
  SubscriptionStatus,
  { label: string; color: string; bg: string; icon: string; description: string }
> = {
  trialing: {
    label: "Free Trial",
    color: "#3B82F6",
    bg: "#3B82F620",
    icon: "time-outline",
    description: "Add a payment method to keep access after your trial ends.",
  },
  active: {
    label: "Active",
    color: "#10B981",
    bg: "#10B98120",
    icon: "checkmark-circle-outline",
    description: "Your subscription is active and in good standing.",
  },
  past_due: {
    label: "Past due",
    color: "#F59E0B",
    bg: "#F59E0B20",
    icon: "warning-outline",
    description: "Your last payment failed. Please update your payment method.",
  },
  grace: {
    label: "Grace period",
    color: "#F97316",
    bg: "#F9731620",
    icon: "alert-circle-outline",
    description: "Read-only access. Add a payment method to restore full access.",
  },
  locked: {
    label: "Locked",
    color: "#EF4444",
    bg: "#EF444420",
    icon: "lock-closed-outline",
    description: "Your account is locked. Subscribe to restore access.",
  },
  canceled: {
    label: "Canceled",
    color: "#6B7280",
    bg: "#6B728020",
    icon: "close-circle-outline",
    description: "Your subscription has been canceled. Subscribe again to restore access.",
  },
  legacy_free: {
    label: "Legacy free",
    color: "#8B5CF6",
    bg: "#8B5CF620",
    icon: "gift-outline",
    description: "You have legacy free access.",
  },
};

const EVENT_LABELS: Record<string, string> = {
  trial_started: "Trial started",
  status_changed_to_active: "Subscription activated",
  status_changed_to_past_due: "Payment failed",
  status_changed_to_grace: "Entered grace period",
  status_changed_to_locked: "Account locked",
  status_changed_to_canceled: "Subscription canceled",
  checkout_completed: "Checkout completed",
  invoice_payment_succeeded: "Payment succeeded",
  invoice_payment_failed: "Payment failed",
  plan_switched: "Plan changed",
  cancel_scheduled: "Cancellation scheduled",
  cancel_reversed: "Cancellation reversed",
  trial_reminder_sent: "Reminder sent",
  rc_initial_purchase: "Purchase completed",
  rc_renewal: "Subscription renewed",
  rc_product_change: "Plan changed",
  rc_cancellation: "Subscription canceled",
};

function formatDate(s: string | null | undefined) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return s ?? "—";
  }
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  } catch {
    return `$${(amount / 100).toFixed(2)}`;
  }
}

function planLabel(
  planType: string | null,
  interval: string | null
): string {
  const type =
    planType === "lab" ? "Lab" : planType === "provider" ? "Provider" : null;
  const cycle =
    interval === "month" ? "Monthly" : interval === "year" ? "Annual" : null;
  if (type && cycle) return `${type} — ${cycle}`;
  if (type) return type;
  if (cycle) return cycle;
  return "LabTrax";
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  await loadTokens();
  const token = getAccessToken();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

export default function SubscriptionsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const subQuery = useQuery({
    queryKey: ["billing", "subscription"],
    queryFn: async () => {
      const headers = await getAuthHeaders();
      const res = await resilientFetch("/api/billing/subscription", { headers });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = (await res.json()) as { ok: boolean; entitlement: SubscriptionEntitlement };
      return body.entitlement;
    },
    staleTime: 30_000,
  });

  const invoicesQuery = useQuery({
    queryKey: ["billing", "invoices"],
    queryFn: async () => {
      const headers = await getAuthHeaders();
      const res = await resilientFetch("/api/billing/invoices", { headers });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = (await res.json()) as { ok: boolean; invoices: StripeInvoice[] };
      return body.invoices ?? [];
    },
    staleTime: 60_000,
  });

  const historyQuery = useQuery({
    queryKey: ["billing", "history"],
    queryFn: async () => {
      const headers = await getAuthHeaders();
      const res = await resilientFetch("/api/billing/history", { headers });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = (await res.json()) as { ok: boolean; events: SubscriptionEvent[] };
      return body.events ?? [];
    },
    staleTime: 60_000,
  });

  const portalMutation = useMutation({
    mutationFn: async () => {
      const headers = await getAuthHeaders();
      const res = await resilientFetch("/api/billing/portal-session", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      return body as { ok: boolean; url: string };
    },
    onSuccess: async (data) => {
      if (data.url) {
        const supported = await Linking.canOpenURL(data.url);
        if (supported) {
          await Linking.openURL(data.url);
        } else {
          Alert.alert("Billing Portal", data.url);
        }
      }
    },
    onError: (err: Error) =>
      Alert.alert("Could not open billing portal", err.message),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const headers = await getAuthHeaders();
      const res = await resilientFetch("/api/billing/cancel", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ immediately: false }),
      });
      const body = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      return body;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing", "subscription"] });
      qc.invalidateQueries({ queryKey: ["billing", "history"] });
    },
    onError: (err: Error) =>
      Alert.alert("Could not cancel subscription", err.message),
  });

  const reactivateMutation = useMutation({
    mutationFn: async () => {
      const headers = await getAuthHeaders();
      const res = await resilientFetch("/api/billing/reactivate", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      return body;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing", "subscription"] });
      qc.invalidateQueries({ queryKey: ["billing", "history"] });
    },
    onError: (err: Error) =>
      Alert.alert("Could not reactivate subscription", err.message),
  });

  const entitlement = subQuery.data;
  const meta = entitlement ? (STATUS_META[entitlement.status] ?? STATUS_META.active) : null;

  const needsPayment =
    entitlement?.status === "trialing" ||
    entitlement?.status === "grace" ||
    entitlement?.status === "locked" ||
    entitlement?.status === "past_due" ||
    entitlement?.status === "canceled";

  const canManage =
    entitlement?.status === "active" || entitlement?.status === "past_due";

  function handleCancelPress() {
    const periodEnd = entitlement?.currentPeriodEnd
      ? ` Your access continues until ${formatDate(entitlement.currentPeriodEnd)}.`
      : "";
    Alert.alert(
      "Cancel subscription?",
      `Your subscription will be canceled at the end of the current billing period.${periodEnd}`,
      [
        { text: "Keep subscription", style: "cancel" },
        {
          text: "Cancel at period end",
          style: "destructive",
          onPress: () => cancelMutation.mutate(),
        },
      ]
    );
  }

  function handlePortalPress() {
    if (entitlement?.hasStripeSubscription) {
      portalMutation.mutate();
    } else {
      Alert.alert(
        "Manage subscription",
        "Visit the web app or desktop app to manage your subscription and payment method.",
        [{ text: "OK" }]
      );
    }
  }

  return (
    <ScreenShell
      title="Subscription & Billing"
      subtitle="Manage your LabTrax plan"
      onBack={() => router.back()}
      insetTop={insets.top}
    >
      <ScrollView contentContainerStyle={styles.body}>
        {subQuery.isLoading && (
          <ActivityIndicator color={colors.tint} style={{ marginVertical: Spacing.xl }} />
        )}
        {subQuery.error && (
          <Text style={[styles.errorText, { color: colors.error }]}>
            Could not load subscription info.
          </Text>
        )}

        {entitlement && meta && (
          <>
            {/* Status card */}
            <View
              style={[
                styles.statusCard,
                {
                  backgroundColor: meta.bg,
                  borderColor: meta.color + "40",
                },
              ]}
            >
              <View style={styles.statusRow}>
                <View style={[styles.iconWrap, { backgroundColor: meta.color + "20" }]}>
                  <Ionicons name={meta.icon as any} size={20} color={meta.color} />
                </View>
                <View style={styles.statusInfo}>
                  <View style={styles.badgeRow}>
                    <Text style={[styles.statusLabel, { color: meta.color }]}>
                      {meta.label}
                    </Text>
                    {entitlement.status === "trialing" &&
                      entitlement.trialDaysRemaining !== null && (
                        <View style={[styles.pill, { backgroundColor: meta.color + "20" }]}>
                          <Text style={[styles.pillText, { color: meta.color }]}>
                            {entitlement.trialDaysRemaining} day
                            {entitlement.trialDaysRemaining !== 1 ? "s" : ""} left
                          </Text>
                        </View>
                      )}
                    {entitlement.cancelAtPeriodEnd && (
                      <View style={[styles.pill, { backgroundColor: colors.warning + "20" }]}>
                        <Text style={[styles.pillText, { color: colors.warning }]}>
                          Cancels at period end
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.statusDesc, { color: colors.textSecondary }]}>
                    {meta.description}
                  </Text>
                </View>
              </View>
            </View>

            {/* Plan details */}
            <View style={[styles.section, { borderColor: colors.border }]}>
              <View style={[styles.sectionHeader, { borderBottomColor: colors.border }]}>
                <Ionicons name="card-outline" size={14} color={colors.textSecondary} />
                <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                  Plan Details
                </Text>
              </View>
              <DetailRow
                label="Plan"
                value={
                  entitlement.planType || entitlement.billingInterval
                    ? planLabel(entitlement.planType, entitlement.billingInterval)
                    : "—"
                }
                styles={styles}
                colors={colors}
              />
              <DetailRow
                label="Billing cycle"
                value={
                  entitlement.billingInterval === "month"
                    ? "Monthly"
                    : entitlement.billingInterval === "year"
                    ? "Annual"
                    : "—"
                }
                styles={styles}
                colors={colors}
              />
              <DetailRow
                label="Payment method"
                value={entitlement.hasPaymentMethod ? "On file" : "None"}
                valueColor={
                  entitlement.hasPaymentMethod ? colors.success : colors.textSecondary
                }
                styles={styles}
                colors={colors}
              />
              {entitlement.status === "trialing" &&
                entitlement.trialDaysRemaining !== null && (
                  <DetailRow
                    label="Trial ends"
                    value={
                      entitlement.trialDaysRemaining > 0
                        ? `In ${entitlement.trialDaysRemaining} day${entitlement.trialDaysRemaining !== 1 ? "s" : ""}`
                        : "Today"
                    }
                    valueColor={meta.color}
                    styles={styles}
                    colors={colors}
                    last
                  />
                )}
              {entitlement.currentPeriodEnd && (
                <DetailRow
                  label={
                    entitlement.status === "active" && !entitlement.cancelAtPeriodEnd
                      ? "Next renewal"
                      : "Access until"
                  }
                  value={formatDate(entitlement.currentPeriodEnd)}
                  styles={styles}
                  colors={colors}
                  last
                />
              )}
            </View>

            {/* Action buttons */}
            <View style={styles.actions}>
              {needsPayment && (
                <Pressable
                  style={[styles.primaryBtn, { backgroundColor: colors.tint }]}
                  onPress={handlePortalPress}
                  disabled={portalMutation.isPending}
                >
                  {portalMutation.isPending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Ionicons name="card-outline" size={16} color="#fff" />
                  )}
                  <Text style={styles.primaryBtnText}>
                    {entitlement.status === "locked" || entitlement.status === "canceled"
                      ? "Reactivate Subscription"
                      : "Add Payment Method"}
                  </Text>
                  <Ionicons name="open-outline" size={13} color="rgba(255,255,255,0.7)" />
                </Pressable>
              )}

              {canManage && (
                <>
                  <Pressable
                    style={[
                      styles.secondaryBtn,
                      {
                        backgroundColor: colors.surface,
                        borderColor: colors.border,
                      },
                    ]}
                    onPress={handlePortalPress}
                    disabled={portalMutation.isPending}
                  >
                    {portalMutation.isPending ? (
                      <ActivityIndicator size="small" color={colors.tint} />
                    ) : (
                      <Ionicons name="card-outline" size={16} color={colors.tint} />
                    )}
                    <Text style={[styles.secondaryBtnText, { color: colors.tint }]}>
                      Manage Billing
                    </Text>
                    <Ionicons name="open-outline" size={13} color={colors.tint} />
                  </Pressable>

                  {entitlement.cancelAtPeriodEnd ? (
                    <Pressable
                      style={[
                        styles.secondaryBtn,
                        {
                          backgroundColor: colors.surface,
                          borderColor: colors.success + "50",
                        },
                      ]}
                      onPress={() => reactivateMutation.mutate()}
                      disabled={reactivateMutation.isPending}
                    >
                      {reactivateMutation.isPending ? (
                        <ActivityIndicator size="small" color={colors.success} />
                      ) : (
                        <Ionicons
                          name="checkmark-circle-outline"
                          size={16}
                          color={colors.success}
                        />
                      )}
                      <Text
                        style={[styles.secondaryBtnText, { color: colors.success }]}
                      >
                        Undo Cancellation
                      </Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      style={[
                        styles.secondaryBtn,
                        {
                          backgroundColor: colors.surface,
                          borderColor: colors.border,
                        },
                      ]}
                      onPress={handleCancelPress}
                      disabled={cancelMutation.isPending}
                    >
                      {cancelMutation.isPending ? (
                        <ActivityIndicator size="small" color={colors.error} />
                      ) : (
                        <Ionicons
                          name="close-circle-outline"
                          size={16}
                          color={colors.error}
                        />
                      )}
                      <Text style={[styles.secondaryBtnText, { color: colors.error }]}>
                        Cancel Plan
                      </Text>
                    </Pressable>
                  )}
                </>
              )}

              <Text style={[styles.mobileNote, { color: colors.textSecondary }]}>
                Plan changes are handled through the web or desktop app. Mobile billing
                is managed through your device's subscription settings.
              </Text>
            </View>

            {/* Invoices */}
            {!invoicesQuery.isLoading && (invoicesQuery.data?.length ?? 0) > 0 && (
              <View style={[styles.section, { borderColor: colors.border }]}>
                <View style={[styles.sectionHeader, { borderBottomColor: colors.border }]}>
                  <Ionicons name="receipt-outline" size={14} color={colors.textSecondary} />
                  <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                    Recent Invoices
                  </Text>
                </View>
                {invoicesQuery.data!.map((inv, idx) => (
                  <Pressable
                    key={inv.id}
                    style={[
                      styles.invoiceRow,
                      {
                        borderBottomColor: colors.border,
                        borderBottomWidth:
                          idx < invoicesQuery.data!.length - 1
                            ? StyleSheet.hairlineWidth
                            : 0,
                      },
                    ]}
                    onPress={() => {
                      if (inv.hostedInvoiceUrl) {
                        Linking.openURL(inv.hostedInvoiceUrl).catch(() => {});
                      }
                    }}
                    disabled={!inv.hostedInvoiceUrl}
                  >
                    <View style={styles.invoiceInfo}>
                      <Text style={[styles.invoiceNum, { color: colors.text }]}>
                        {inv.number ?? inv.id.slice(-8)}
                      </Text>
                      <Text style={[styles.invoiceDate, { color: colors.textSecondary }]}>
                        {formatDate(inv.createdAt)}
                      </Text>
                    </View>
                    <View style={styles.invoiceRight}>
                      <Text style={[styles.invoiceAmount, { color: colors.text }]}>
                        {formatCurrency(inv.amountPaid, inv.currency)}
                      </Text>
                      <View
                        style={[
                          styles.invoiceStatus,
                          {
                            backgroundColor:
                              inv.status === "paid"
                                ? colors.success + "20"
                                : colors.warning + "20",
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.invoiceStatusText,
                            {
                              color:
                                inv.status === "paid"
                                  ? colors.success
                                  : colors.warning,
                            },
                          ]}
                        >
                          {inv.status}
                        </Text>
                      </View>
                      {inv.hostedInvoiceUrl && (
                        <Ionicons
                          name="open-outline"
                          size={12}
                          color={colors.textSecondary}
                        />
                      )}
                    </View>
                  </Pressable>
                ))}
              </View>
            )}

            {/* History */}
            {!historyQuery.isLoading && (historyQuery.data?.length ?? 0) > 0 && (
              <View style={[styles.section, { borderColor: colors.border }]}>
                <View style={[styles.sectionHeader, { borderBottomColor: colors.border }]}>
                  <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
                  <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                    Subscription History
                  </Text>
                </View>
                {historyQuery.data!.slice(0, 10).map((ev, idx) => (
                  <View
                    key={ev.id}
                    style={[
                      styles.historyRow,
                      {
                        borderBottomColor: colors.border,
                        borderBottomWidth:
                          idx < Math.min(historyQuery.data!.length, 10) - 1
                            ? StyleSheet.hairlineWidth
                            : 0,
                      },
                    ]}
                  >
                    <View
                      style={[styles.historyDot, { backgroundColor: colors.border }]}
                    />
                    <View style={styles.historyInfo}>
                      <Text style={[styles.historyEvent, { color: colors.text }]}>
                        {EVENT_LABELS[ev.eventType] ?? ev.eventType}
                      </Text>
                      {(ev.statusBefore || ev.statusAfter) && (
                        <Text
                          style={[styles.historyMeta, { color: colors.textSecondary }]}
                        >
                          {ev.statusBefore}
                          {ev.statusBefore && ev.statusAfter ? " → " : ""}
                          {ev.statusAfter}
                        </Text>
                      )}
                    </View>
                    <Text style={[styles.historyDate, { color: colors.textSecondary }]}>
                      {formatDate(ev.createdAt)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </ScreenShell>
  );
}

function DetailRow({
  label,
  value,
  valueColor,
  styles,
  colors,
  last,
}: {
  label: string;
  value: string;
  valueColor?: string;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
  last?: boolean;
}) {
  return (
    <View
      style={[
        styles.detailRow,
        {
          borderBottomColor: colors.border,
          borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        },
      ]}
    >
      <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text
        style={[styles.detailValue, { color: valueColor ?? colors.text }]}
      >
        {value}
      </Text>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl },
    errorText: { ...Typography.body, textAlign: "center" },

    statusCard: { borderRadius: Radius.lg, borderWidth: 1, padding: Spacing.lg },
    statusRow: { flexDirection: "row", gap: Spacing.md },
    iconWrap: {
      width: 40,
      height: 40,
      borderRadius: Radius.sm,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    statusInfo: { flex: 1, gap: 5 },
    statusLabel: { ...Typography.bodyMedium },
    statusDesc: { ...Typography.caption },
    badgeRow: { flexDirection: "row", gap: Spacing.xs, flexWrap: "wrap", alignItems: "center" },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      borderRadius: Radius.full,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    pillText: { ...Typography.tiny },

    section: {
      borderRadius: Radius.lg,
      borderWidth: 1,
      overflow: "hidden",
      backgroundColor: c.surface,
    },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    sectionTitle: { ...Typography.caption, textTransform: "uppercase", letterSpacing: 0.5 },

    detailRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm + 2,
    },
    detailLabel: { ...Typography.body },
    detailValue: { ...Typography.bodyMedium },

    actions: { gap: Spacing.sm },
    primaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.lg,
    },
    primaryBtnText: { ...Typography.bodyMedium, color: "#fff", flex: 1, textAlign: "center" },
    secondaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: 1,
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.lg,
    },
    secondaryBtnText: { ...Typography.bodyMedium, flex: 1, textAlign: "center" },

    mobileNote: {
      ...Typography.caption,
      textAlign: "center",
      marginTop: Spacing.xs,
      lineHeight: 16,
    },

    invoiceRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm + 2,
    },
    invoiceInfo: { gap: 2 },
    invoiceNum: { ...Typography.bodyMedium, fontFamily: "monospace" },
    invoiceDate: { ...Typography.caption },
    invoiceRight: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    invoiceAmount: { ...Typography.bodyMedium },
    invoiceStatus: {
      borderRadius: Radius.full,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    invoiceStatusText: { ...Typography.tiny },

    historyRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm + 2,
      gap: Spacing.sm,
    },
    historyDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      marginTop: 5,
      flexShrink: 0,
    },
    historyInfo: { flex: 1, gap: 2 },
    historyEvent: { ...Typography.body },
    historyMeta: { ...Typography.caption },
    historyDate: { ...Typography.caption, flexShrink: 0 },
  });
}
