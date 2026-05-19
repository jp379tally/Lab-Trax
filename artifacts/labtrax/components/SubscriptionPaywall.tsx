import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  Modal,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Platform,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/lib/theme-context";
import {
  isRevenueCatAvailable,
  useRevenueCat,
  purchasePackage,
  restorePurchases,
} from "@/lib/revenuecat";
import { resilientFetch } from "@/lib/query-client";
import type { PurchasesPackage } from "react-native-purchases";
import type { AccessLevel } from "@/lib/useEntitlement";

interface Props {
  accessLevel: AccessLevel;
  onSubscribed: () => void;
  onDismiss?: () => void;
}

const useNativeIAP = Platform.OS === "ios" || Platform.OS === "android";

function fmtRcPrice(pkg: PurchasesPackage): string {
  const price = pkg.product.priceString;
  const period =
    pkg.packageType === "MONTHLY"
      ? "/mo"
      : pkg.packageType === "ANNUAL"
        ? "/yr"
        : "";
  return `${price}${period}`;
}

export function SubscriptionPaywall({ accessLevel, onSubscribed, onDismiss }: Props) {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const rcAvailable = isRevenueCatAvailable();
  const { offering, loading: rcLoading, refresh: rcRefresh } = useRevenueCat();
  const [actionLoading, setActionLoading] = useState(false);
  const [webPlans, setWebPlans] = useState<{ id: string; productName: string | null; unitAmount: number | null; currency: string; interval: string | null }[]>([]);
  const [webPlansLoaded, setWebPlansLoaded] = useState(false);

  const isLocked = accessLevel === "locked";
  const dismissable = !isLocked;

  const rcPackages = offering?.availablePackages ?? [];

  useEffect(() => {
    if (rcAvailable) {
      rcRefresh();
    } else if (useNativeIAP) {
    } else {
      resilientFetch("/api/billing/plans")
        .then((r) => r.json())
        .then((j) => setWebPlans(j?.plans ?? []))
        .catch(() => {})
        .finally(() => setWebPlansLoaded(true));
    }
  }, [rcAvailable, rcRefresh]);

  async function handleNativePurchase(pkg: PurchasesPackage) {
    setActionLoading(true);
    try {
      const result = await purchasePackage(pkg);
      if (result.cancelled) return;
      if (result.success) {
        onSubscribed();
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
        onSubscribed();
      } else {
        Alert.alert("Restore Failed", result.error ?? "No purchases found to restore.");
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function handleWebSubscribe(priceId?: string) {
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
        const { Linking } = await import("react-native");
        await Linking.openURL(json.url);
      } else {
        Alert.alert("Error", json?.message ?? "Failed to start checkout");
      }
    } catch (err: any) {
      Alert.alert("Error", err?.message ?? "Failed to start checkout");
    } finally {
      setActionLoading(false);
    }
  }

  const headerBg = isLocked ? "#FEF2F2" : "#FFF7ED";
  const headerIconColor = isLocked ? "#DC2626" : "#EA580C";
  const headerIcon: keyof typeof Ionicons.glyphMap = isLocked ? "lock-closed" : "shield-outline";
  const headerTitle = isLocked ? "Account Locked" : "Grace Period";
  const headerDesc = isLocked
    ? "Your account is locked. Subscribe to restore full access to your data."
    : "Your trial has ended. Subscribe to keep full access, or continue in read-only mode.";

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={dismissable ? onDismiss : undefined}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={dismissable ? onDismiss : undefined}
        />

        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.backgroundSolid,
              paddingBottom: insets.bottom + 20,
            },
          ]}
        >
          <View style={styles.handle} />

          {!isLocked && dismissable && (
            <Pressable
              style={[styles.closeBtn, { top: 16 }]}
              onPress={onDismiss}
              hitSlop={12}
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          )}

          <View style={[styles.iconWrap, { backgroundColor: headerBg }]}>
            <Ionicons name={headerIcon} size={32} color={headerIconColor} />
          </View>

          <Text style={[styles.title, { color: colors.text }]}>{headerTitle}</Text>
          <Text style={[styles.desc, { color: colors.textSecondary }]}>{headerDesc}</Text>

          <View style={styles.divider} />

          {useNativeIAP && rcAvailable ? (
            rcLoading ? (
              <ActivityIndicator size="small" color={colors.tint} style={{ marginVertical: 16 }} />
            ) : rcPackages.length > 0 ? (
              <View style={styles.plansWrap}>
                {rcPackages.map((pkg) => (
                  <Pressable
                    key={pkg.identifier}
                    style={({ pressed }) => [
                      styles.planCard,
                      {
                        backgroundColor: isDark ? "#1C1C1E" : "#F8FAFC",
                        borderColor: isDark ? "#3A3A3C" : "#E2E8F0",
                      },
                      pressed && { opacity: 0.75 },
                    ]}
                    onPress={() => handleNativePurchase(pkg)}
                    disabled={actionLoading}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.planName, { color: colors.text }]}>
                        {pkg.product.title || pkg.product.identifier}
                      </Text>
                      {pkg.product.description ? (
                        <Text style={[styles.planSub, { color: colors.textSecondary }]}>
                          {pkg.product.description}
                        </Text>
                      ) : null}
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 4 }}>
                      <Text style={[styles.planPrice, { color: colors.tint }]}>
                        {fmtRcPrice(pkg)}
                      </Text>
                      {actionLoading ? (
                        <ActivityIndicator size="small" color={colors.tint} />
                      ) : (
                        <Ionicons name="arrow-forward-circle" size={22} color={colors.tint} />
                      )}
                    </View>
                  </Pressable>
                ))}

                <Pressable
                  style={({ pressed }) => [styles.restoreBtn, pressed && { opacity: 0.7 }]}
                  onPress={handleNativeRestore}
                  disabled={actionLoading}
                >
                  <Text style={[styles.restoreBtnText, { color: colors.textSecondary }]}>
                    Restore Purchases
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.noPlans}>
                <Ionicons name="information-circle-outline" size={20} color="#6B7280" />
                <Text style={[styles.noPlansText, { color: colors.textSecondary }]}>
                  No plans available. Please try again later.
                </Text>
              </View>
            )
          ) : useNativeIAP && !rcAvailable ? (
            <View style={styles.plansWrap}>
              <View style={[styles.noPlans, { marginBottom: 8 }]}>
                <Ionicons name="information-circle-outline" size={20} color="#6B7280" />
                <Text style={[styles.noPlansText, { color: colors.textSecondary }]}>
                  In-app billing is not configured yet. Contact support or visit our website to manage your subscription.
                </Text>
              </View>
              <Pressable
                style={({ pressed }) => [
                  styles.primaryBtn,
                  { backgroundColor: colors.tint },
                  pressed && { opacity: 0.8 },
                ]}
                onPress={async () => {
                  const { Linking } = await import("react-native");
                  await Linking.openURL("https://labtrax.app/subscribe");
                }}
              >
                <Ionicons name="open-outline" size={18} color="#FFF" />
                <Text style={styles.primaryBtnText}>Subscribe on Website</Text>
              </Pressable>
              {dismissable && (
                <Pressable
                  style={({ pressed }) => [styles.restoreBtn, pressed && { opacity: 0.7 }]}
                  onPress={onDismiss}
                >
                  <Text style={[styles.restoreBtnText, { color: colors.textSecondary }]}>
                    Continue in Read-Only Mode
                  </Text>
                </Pressable>
              )}
            </View>
          ) : !useNativeIAP ? (
            <View style={styles.plansWrap}>
              {!webPlansLoaded ? (
                <ActivityIndicator size="small" color={colors.tint} style={{ marginVertical: 16 }} />
              ) : webPlans.length > 0 ? (
                webPlans.map((plan) => (
                  <Pressable
                    key={plan.id}
                    style={({ pressed }) => [
                      styles.planCard,
                      {
                        backgroundColor: isDark ? "#1C1C1E" : "#F8FAFC",
                        borderColor: isDark ? "#3A3A3C" : "#E2E8F0",
                      },
                      pressed && { opacity: 0.75 },
                    ]}
                    onPress={() => handleWebSubscribe(plan.id)}
                    disabled={actionLoading}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.planName, { color: colors.text }]}>
                        {plan.productName ?? "LabTrax Pro"}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 4 }}>
                      <Text style={[styles.planPrice, { color: colors.tint }]}>
                        {plan.unitAmount != null
                          ? `$${(plan.unitAmount / 100).toFixed(2)} ${plan.currency.toUpperCase()}${plan.interval === "month" ? "/mo" : plan.interval === "year" ? "/yr" : ""}`
                          : "—"}
                      </Text>
                      {actionLoading ? (
                        <ActivityIndicator size="small" color={colors.tint} />
                      ) : (
                        <Ionicons name="arrow-forward-circle" size={22} color={colors.tint} />
                      )}
                    </View>
                  </Pressable>
                ))
              ) : (
                <Pressable
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    { backgroundColor: colors.tint },
                    pressed && { opacity: 0.8 },
                  ]}
                  onPress={() => handleWebSubscribe()}
                  disabled={actionLoading}
                >
                  {actionLoading ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <Ionicons name="arrow-forward-circle" size={20} color="#FFF" />
                  )}
                  <Text style={styles.primaryBtnText}>
                    {isLocked ? "Reactivate Subscription" : "Start Subscription"}
                  </Text>
                </Pressable>
              )}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    alignItems: "center",
    elevation: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#D1D5DB",
    marginBottom: 16,
  },
  closeBtn: {
    position: "absolute",
    right: 16,
    padding: 4,
  },
  iconWrap: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  title: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    marginBottom: 8,
  },
  desc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: 8,
    marginBottom: 4,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#E5E7EB",
    alignSelf: "stretch",
    marginVertical: 16,
  },
  plansWrap: {
    alignSelf: "stretch",
    gap: 10,
  },
  planCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  planName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  planSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  planPrice: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
  restoreBtn: {
    alignItems: "center",
    paddingVertical: 10,
  },
  restoreBtnText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  noPlans: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
  },
  noPlansText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    flex: 1,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    paddingVertical: 14,
    gap: 8,
  },
  primaryBtnText: {
    color: "#FFF",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
});
