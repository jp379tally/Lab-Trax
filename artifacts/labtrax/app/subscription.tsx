import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Platform,
  StyleSheet,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { resilientFetch } from "@/lib/query-client";
import {
  isRevenueCatAvailable,
  useRevenueCat,
  purchasePackage,
  restorePurchases,
} from "@/lib/revenuecat";
import type { PurchasesPackage } from "react-native-purchases";

interface Entitlement {
  status:
    | "trialing"
    | "active"
    | "past_due"
    | "grace"
    | "locked"
    | "canceled"
    | "legacy_free";
  accessLevel: "full" | "read_only" | "locked";
  trialDaysRemaining: number | null;
  graceDaysRemaining: number | null;
  currentPeriodEnd: string | null;
  hasPaymentMethod: boolean;
  subjectType: string;
  subjectId: string;
  subscriptionId: string | null;
}

interface Plan {
  id: string;
  currency: string;
  unitAmount: number | null;
  interval: string | null;
  productName: string | null;
}

type StatusMeta = {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  bg: string;
  desc: string;
};

const makeStatusMeta = (colors: ThemeColors): Record<string, StatusMeta> => ({
  trialing: {
    title: "Free Trial",
    icon: "time-outline",
    color: colors.info,
    bg: colors.infoSurface,
    desc: "You're on a free trial. Add a payment method to keep access when it ends.",
  },
  active: {
    title: "Active",
    icon: "checkmark-circle",
    color: colors.successStrong,
    bg: colors.successSurface,
    desc: "Your subscription is active and in good standing.",
  },
  past_due: {
    title: "Payment Issue",
    icon: "alert-circle",
    color: colors.warningStrong,
    bg: colors.warningSurface,
    desc: "Your last payment failed. Update your payment method to avoid losing access.",
  },
  grace: {
    title: "Grace Period",
    icon: "shield-outline",
    color: colors.orange,
    bg: colors.orangeLight,
    desc: "Your trial ended. You have read-only access. Subscribe to restore full access.",
  },
  locked: {
    title: "Locked",
    icon: "lock-closed",
    color: colors.errorStrong,
    bg: colors.errorSurface,
    desc: "Your account is locked. Subscribe to restore access to your data.",
  },
  canceled: {
    title: "Canceled",
    icon: "refresh-circle-outline",
    color: colors.textSecondary,
    bg: colors.canvas,
    desc: "Your subscription was canceled. Subscribe again to restore access.",
  },
  legacy_free: {
    title: "Legacy Access",
    icon: "flash",
    color: colors.violet,
    bg: colors.violetLight,
    desc: "You have legacy free access — billing doesn't apply to your account.",
  },
});

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function fmtPrice(unitAmount: number | null, currency: string, interval: string | null): string {
  if (unitAmount == null) return "—";
  const price = (unitAmount / 100).toFixed(2);
  const curr = currency.toUpperCase();
  const per = interval === "month" ? "/mo" : interval === "year" ? "/yr" : "";
  return `$${price} ${curr}${per}`;
}

function fmtRcPrice(pkg: PurchasesPackage): string {
  const price = pkg.product.priceString;
  const period = pkg.packageType === "MONTHLY"
    ? "/mo"
    : pkg.packageType === "ANNUAL"
      ? "/yr"
      : "";
  return `${price}${period}`;
}

const useNativeIAP = Platform.OS === "ios" || Platform.OS === "android";

export default function SubscriptionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const STATUS_META = useMemo(() => makeStatusMeta(colors), [colors]);
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rcAvailable = isRevenueCatAvailable();
  const { offering, loading: rcLoading, refresh: rcRefresh } = useRevenueCat();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [subResp, plansResp] = await Promise.all([
        resilientFetch("/api/billing/subscription"),
        useNativeIAP && rcAvailable
          ? Promise.resolve(null)
          : resilientFetch("/api/billing/plans"),
      ]);
      const subJson = await subResp.json().catch(() => ({}));
      setEntitlement(subJson?.entitlement ?? null);
      if (plansResp) {
        const plansJson = await plansResp.json().catch(() => ({}));
        setPlans(plansJson?.plans ?? []);
      }
    } catch {
      setError("Failed to load subscription info.");
    } finally {
      setLoading(false);
    }
  }, [rcAvailable]);

  useEffect(() => {
    load();
    if (rcAvailable) {
      rcRefresh();
    }
  }, [load, rcAvailable, rcRefresh]);

  const meta = entitlement ? (STATUS_META[entitlement.status] ?? STATUS_META.legacy_free) : null;

  const needsPayment =
    entitlement?.status === "trialing" ||
    entitlement?.status === "grace" ||
    entitlement?.status === "locked" ||
    entitlement?.status === "past_due" ||
    entitlement?.status === "canceled";

  async function handleNativePurchase(pkg: PurchasesPackage) {
    setActionLoading(true);
    try {
      const result = await purchasePackage(pkg);
      if (result.cancelled) {
        return;
      }
      if (result.success) {
        await load();
        Alert.alert("Success", "Your subscription is now active!");
      } else {
        Alert.alert("Purchase Failed", result.error ?? "Something went wrong. Please try again.");
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function handleNativeRestore() {
    setActionLoading(true);
    try {
      const result = await restorePurchases();
      if (result.success) {
        await load();
        Alert.alert("Restored", "Your purchases have been restored.");
      } else {
        Alert.alert("Restore Failed", result.error ?? "No purchases found to restore.");
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function handleNativeManage() {
    const { Linking } = await import("react-native");
    if (Platform.OS === "ios") {
      await Linking.openURL("https://apps.apple.com/account/subscriptions");
    } else {
      await Linking.openURL("https://play.google.com/store/account/subscriptions");
    }
  }

  async function handleSubscribe(priceId?: string) {
    setActionLoading(true);
    try {
      const body = priceId ? JSON.stringify({ priceId }) : "{}";
      const resp = await resilientFetch("/api/billing/checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const json = await resp.json().catch(() => ({}));
      if (json?.url) {
        if (Platform.OS === "web") {
          window.open(json.url, "_blank");
        } else {
          const { Linking } = await import("react-native");
          await Linking.openURL(json.url);
        }
      } else {
        Alert.alert("Error", json?.message ?? "Failed to start checkout");
      }
    } catch (err: any) {
      Alert.alert("Error", err?.message ?? "Failed to start checkout");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleManage() {
    setActionLoading(true);
    try {
      const resp = await resilientFetch("/api/billing/portal-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await resp.json().catch(() => ({}));
      if (json?.url) {
        if (Platform.OS === "web") {
          window.open(json.url, "_blank");
        } else {
          const { Linking } = await import("react-native");
          await Linking.openURL(json.url);
        }
      } else {
        Alert.alert("Error", json?.message ?? "Failed to open billing portal");
      }
    } catch (err: any) {
      Alert.alert("Error", err?.message ?? "Failed to open billing portal");
    } finally {
      setActionLoading(false);
    }
  }

  const rcPackages = offering?.availablePackages ?? [];

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 12,
            backgroundColor: colors.backgroundSolid,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          Subscription
        </Text>
        <Pressable
          onPress={load}
          style={({ pressed }) => [styles.refreshBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons name="refresh" size={20} color={colors.textSecondary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: 20,
          paddingBottom: insets.bottom + 40,
        }}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.tint} />
          </View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={20} color={colors.errorStrong} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : entitlement && meta ? (
          <View style={{ gap: 20 }}>
            {/* Status card */}
            <View
              style={[
                styles.statusCard,
                { backgroundColor: meta.bg, borderColor: meta.color + "33" },
              ]}
            >
              <View
                style={[
                  styles.statusIconWrap,
                  { backgroundColor: meta.color + "20" },
                ]}
              >
                <Ionicons name={meta.icon} size={24} color={meta.color} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Text style={[styles.statusTitle, { color: meta.color }]}>
                    {meta.title}
                  </Text>
                  {entitlement.status === "trialing" &&
                    entitlement.trialDaysRemaining !== null && (
                      <View
                        style={[
                          styles.badge,
                          { backgroundColor: colors.infoLight },
                        ]}
                      >
                        <Text style={[styles.badgeText, { color: colors.infoStrong }]}>
                          {entitlement.trialDaysRemaining}d left
                        </Text>
                      </View>
                    )}
                  {entitlement.status === "grace" &&
                    entitlement.graceDaysRemaining !== null && (
                      <View
                        style={[
                          styles.badge,
                          { backgroundColor: colors.orangeLight },
                        ]}
                      >
                        <Text style={[styles.badgeText, { color: colors.orange }]}>
                          {entitlement.graceDaysRemaining}d read-only
                        </Text>
                      </View>
                    )}
                </View>
                <Text style={[styles.statusDesc, { color: colors.textSecondary }]}>
                  {meta.desc}
                </Text>
              </View>
            </View>

            {/* CTA — native IAP (iOS / Android) */}
            {needsPayment && useNativeIAP && rcAvailable && (
              <View style={{ gap: 12 }}>
                {rcLoading ? (
                  <ActivityIndicator size="small" color={colors.tint} />
                ) : rcPackages.length > 0 ? (
                  <>
                    <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
                      CHOOSE A PLAN
                    </Text>
                    {rcPackages.map((pkg) => (
                      <Pressable
                        key={pkg.identifier}
                        style={({ pressed }) => [
                          styles.planCard,
                          {
                            backgroundColor: colors.backgroundSolid,
                            borderColor: colors.border,
                          },
                          pressed && { opacity: 0.75 },
                        ]}
                        onPress={() => handleNativePurchase(pkg)}
                        disabled={actionLoading}
                      >
                        <Text style={[styles.planName, { color: colors.text }]}>
                          {pkg.product.title || pkg.product.identifier}
                        </Text>
                        <Text style={[styles.planPrice, { color: colors.tint }]}>
                          {fmtRcPrice(pkg)}
                        </Text>
                        {actionLoading ? (
                          <ActivityIndicator size="small" color={colors.tint} />
                        ) : (
                          <Ionicons
                            name="arrow-forward-circle"
                            size={22}
                            color={colors.tint}
                          />
                        )}
                      </Pressable>
                    ))}

                    <Pressable
                      style={({ pressed }) => [
                        styles.restoreBtn,
                        pressed && { opacity: 0.7 },
                      ]}
                      onPress={handleNativeRestore}
                      disabled={actionLoading}
                    >
                      <Text style={[styles.restoreBtnText, { color: colors.textSecondary }]}>
                        Restore Purchases
                      </Text>
                    </Pressable>
                  </>
                ) : (
                  <View style={styles.errorBox}>
                    <Ionicons name="information-circle-outline" size={20} color={colors.textSecondary} />
                    <Text style={[styles.errorText, { color: colors.textSecondary }]}>
                      No plans available. Please try again later.
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* CTA — Stripe / web */}
            {needsPayment && !useNativeIAP && (
              <View style={{ gap: 12 }}>
                {plans.length > 0 ? (
                  <>
                    <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
                      CHOOSE A PLAN
                    </Text>
                    {plans.map((plan) => (
                      <Pressable
                        key={plan.id}
                        style={({ pressed }) => [
                          styles.planCard,
                          {
                            backgroundColor: colors.backgroundSolid,
                            borderColor: colors.border,
                          },
                          pressed && { opacity: 0.75 },
                        ]}
                        onPress={() => handleSubscribe(plan.id)}
                        disabled={actionLoading}
                      >
                        <Text style={[styles.planName, { color: colors.text }]}>
                          {plan.productName ?? "LabTrax Pro"}
                        </Text>
                        <Text style={[styles.planPrice, { color: colors.tint }]}>
                          {fmtPrice(plan.unitAmount, plan.currency, plan.interval)}
                        </Text>
                        {actionLoading ? (
                          <ActivityIndicator size="small" color={colors.tint} />
                        ) : (
                          <Ionicons
                            name="arrow-forward-circle"
                            size={22}
                            color={colors.tint}
                          />
                        )}
                      </Pressable>
                    ))}
                  </>
                ) : (
                  <Pressable
                    style={({ pressed }) => [
                      styles.primaryBtn,
                      { backgroundColor: colors.tint },
                      pressed && { opacity: 0.8 },
                    ]}
                    onPress={() => handleSubscribe()}
                    disabled={actionLoading}
                  >
                    {actionLoading ? (
                      <ActivityIndicator size="small" color={colors.textInverse} />
                    ) : (
                      <Ionicons name="arrow-forward-circle" size={20} color={colors.textInverse} />
                    )}
                    <Text style={styles.primaryBtnText}>
                      {entitlement.status === "locked" || entitlement.status === "canceled"
                        ? "Reactivate Subscription"
                        : "Start Subscription"}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}

            {/* Manage subscription */}
            {(entitlement.status === "active" || entitlement.status === "past_due") && (
              <Pressable
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  {
                    borderColor: colors.border,
                    backgroundColor: colors.backgroundSolid,
                  },
                  pressed && { opacity: 0.7 },
                ]}
                onPress={useNativeIAP && rcAvailable ? handleNativeManage : handleManage}
                disabled={actionLoading}
              >
                {actionLoading ? (
                  <ActivityIndicator size="small" color={colors.tint} />
                ) : (
                  <Ionicons name="card-outline" size={18} color={colors.tint} />
                )}
                <Text style={[styles.secondaryBtnText, { color: colors.tint }]}>
                  Manage Subscription
                </Text>
              </Pressable>
            )}

            {/* Restore on manage view as well (iOS requirement) */}
            {useNativeIAP && rcAvailable && !needsPayment && (
              <Pressable
                style={({ pressed }) => [
                  styles.restoreBtn,
                  pressed && { opacity: 0.7 },
                ]}
                onPress={handleNativeRestore}
                disabled={actionLoading}
              >
                <Text style={[styles.restoreBtnText, { color: colors.textSecondary }]}>
                  Restore Purchases
                </Text>
              </Pressable>
            )}

            {/* Details */}
            <View
              style={[
                styles.detailsCard,
                {
                  backgroundColor: colors.backgroundSolid,
                  borderColor: colors.border,
                },
              ]}
            >
              <DetailRow
                label="Status"
                value={meta.title}
                colors={colors}
                isDark={isDark}
              />
              <DetailRow
                label="Payment method"
                value={entitlement.hasPaymentMethod ? "On file" : "None"}
                highlight={entitlement.hasPaymentMethod}
                colors={colors}
                isDark={isDark}
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
                    colors={colors}
                    isDark={isDark}
                    last
                  />
                )}
              {entitlement.currentPeriodEnd && (
                <DetailRow
                  label={entitlement.status === "active" ? "Next renewal" : "Period end"}
                  value={fmtDate(entitlement.currentPeriodEnd)}
                  colors={colors}
                  isDark={isDark}
                  last
                />
              )}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function DetailRow({
  label,
  value,
  highlight,
  last,
  colors,
  isDark,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  last?: boolean;
  colors: any;
  isDark: boolean;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View
      style={[
        styles.detailRow,
        !last && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
      ]}
    >
      <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>
        {label}
      </Text>
      <Text
        style={[
          styles.detailValue,
          { color: highlight ? colors.successStrong : colors.text },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  backBtn: { padding: 4 },
  refreshBtn: { padding: 4, marginLeft: "auto" },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    flex: 1,
    textAlign: "center",
  },
  center: { alignItems: "center", marginTop: 60 },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    backgroundColor: colors.errorSurface,
    borderRadius: 12,
  },
  errorText: { color: colors.errorText, fontFamily: "Inter_500Medium", fontSize: 14, flex: 1 },
  statusCard: {
    flexDirection: "row",
    gap: 14,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  statusIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  statusTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  statusDesc: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    marginTop: 4,
    lineHeight: 18,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 20,
  },
  badgeText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
  },
  sectionLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.8,
  },
  planCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
  },
  planName: {
    fontFamily: "Inter_500Medium",
    fontSize: 15,
    flex: 1,
  },
  planPrice: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
  },
  primaryBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
    color: colors.textInverse,
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  secondaryBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  restoreBtn: {
    alignItems: "center",
    paddingVertical: 10,
  },
  restoreBtnText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  detailsCard: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 12,
  },
  detailLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  detailValue: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    textAlign: "right",
    flex: 1,
  },
});
