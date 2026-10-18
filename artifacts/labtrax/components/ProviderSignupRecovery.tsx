import React, { useEffect, useState } from "react";
import { AppState, Modal, Platform, Pressable, ScrollView, Text, View, Linking } from "react-native";
import Constants from "expo-constants";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProviderSignupTier } from "@workspace/api-client-react";
import ProviderPlanChoices from "./ProviderPlanChoices";
import { resilientFetch, getApiUrl } from "@/lib/query-client";
import { useAuth } from "@/lib/auth-context";
import AsyncStorage from "@react-native-async-storage/async-storage";

type Entitlement = { status: string; providerPlan?: ProviderSignupTier; reuseSubscriptionCard?: boolean };
export default function ProviderSignupRecovery() {
  const insets = useSafeAreaInsets();
  const { currentUserId } = useAuth();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<ProviderSignupTier | null>(null);
  const [reuseCard, setReuseCard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nativeApproved = Constants.expoConfig?.extra?.providerSubscriptionCheckoutApproved === true;
  const canLaunchPaid = Platform.OS === "web" || nativeApproved;
  const query = useQuery({
    queryKey: ["provider-signup-state", currentUserId],
    queryFn: async () => {
      const response = await resilientFetch("/api/billing/subscription");
      if (!response.ok) throw new Error("Could not verify signup. Check your connection and refresh.");
      return (await response.json()).entitlement as Entitlement;
    },
    refetchInterval: 10_000,
  });
  useEffect(() => {
    if (!query.data || selected) return;
    setSelected(query.data.providerPlan ?? null);
    setReuseCard(query.data.reuseSubscriptionCard === true);
  }, [query.data, selected]);
  useEffect(() => {
    if (!query.data || query.data.status === "onboarding_pending") return;
    void qc.invalidateQueries({ queryKey: ["billing", "subscription"] });
    if (currentUserId) void AsyncStorage.removeItem(`@labtrax_subscription_signup:${currentUserId}`);
  }, [query.data?.status, qc, currentUserId]);
  useEffect(() => {
    const refresh = async () => {
      await query.refetch();
      await qc.invalidateQueries({ queryKey: ["billing", "subscription"] });
    };
    const listener = AppState.addEventListener("change", (state) => { if (state === "active") void refresh(); });
    if (Platform.OS === "web") window.addEventListener("focus", refresh);
    return () => { listener.remove(); if (Platform.OS === "web") window.removeEventListener("focus", refresh); };
  }, [qc, query.refetch]);
  async function resume() {
    if (!selected || busy || !currentUserId) return;
    setBusy(true); setError(null);
    try {
      if (selected !== "free" && !canLaunchPaid) throw new Error("Paid subscription purchases are not approved for this app distribution. You may explicitly choose Free; your paid signup remains incomplete.");
      const choice = await resilientFetch("/api/billing/provider-plan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerPlan: selected, reuseSubscriptionCard: reuseCard }),
      });
      if (!choice.ok) throw new Error((await choice.json()).message || "Could not save the selected plan.");
      if (selected !== "free") {
        // Only actor+surface are stored locally. Processor identity and all
        // authoritative outcomes stay in the authenticated server attempt.
        await AsyncStorage.setItem(`@labtrax_subscription_signup:${currentUserId}`, JSON.stringify({ origin: "signup" }));
        const returnUrl = (checkout: string) => {
          const url = new URL("api/billing/mobile-return", getApiUrl());
          url.searchParams.set("checkout", checkout);
          if (Platform.OS === "web") url.searchParams.set("platform", "web");
          return url.href;
        };
        const response = await resilientFetch("/api/billing/checkout-session", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ purchaseChannel: Platform.OS === "web" ? "web" : "native", successUrl: returnUrl("success"), cancelUrl: returnUrl("cancel") }),
        });
        const body = await response.json();
        if (!response.ok || !body.url) throw new Error(body.message || body.error || "Could not start checkout. Retry without registering again.");
        if (Platform.OS === "web") window.location.assign(body.url);
        else await Linking.openURL(body.url);
        setError("Card collection is not yet confirmed. Finish secure checkout, then refresh. If cancelled, retry or explicitly choose Free.");
      }
      await query.refetch();
      await qc.invalidateQueries({ queryKey: ["billing", "subscription"] });
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <Modal visible transparent={false} onRequestClose={() => {}} testID="provider-signup-recovery">
    <View style={{ flex: 1, backgroundColor: "#F8FAFC", paddingTop: Math.max(insets.top, Platform.OS === "web" ? 67 : 0) }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: Math.max(insets.bottom, 34) }}>
        <Text style={{ color: "#0F172A", fontSize: 22, fontWeight: "700" }}>Finish provider signup</Text>
        <Text style={{ color: "#334155" }}>Your account is saved. The paid plan remains incomplete until Stripe verifies your card. Retry or explicitly choose permanent Free.</Text>
        <ProviderPlanChoices selected={selected} onSelect={setSelected} reuseCard={reuseCard} onReuseChange={setReuseCard} disabled={busy} />
        {!canLaunchPaid && <Text style={{ color: "#334155" }}>Paid subscription checkout is unavailable in this app distribution pending store-policy approval. Free does not require a card.</Text>}
        {(error || query.error) && <Text accessibilityRole="alert" style={{ color: "#B91C1C" }}>{error || query.error?.message}</Text>}
        <Pressable testID="provider-signup-resume" accessibilityRole="button" accessibilityState={{ disabled: busy || !selected }} disabled={busy || !selected}
          onPress={() => void resume()} style={{ minHeight: 48, padding: 14, borderRadius: 10, backgroundColor: "#145DA0", opacity: busy || !selected ? 0.5 : 1 }}>
          <Text style={{ color: "#FFF", fontWeight: "600", textAlign: "center" }}>{busy ? "Checking…" : selected === "free" ? "Confirm permanent Free plan" : "Continue to secure card collection"}</Text>
        </Pressable>
        <Pressable testID="provider-signup-refresh" accessibilityRole="button" onPress={() => { void query.refetch(); void qc.invalidateQueries({ queryKey: ["billing", "subscription"] }); }} style={{ minHeight: 44, padding: 12 }}>
          <Text style={{ color: "#145DA0", textAlign: "center" }}>Refresh verified signup state</Text>
        </Pressable>
      </ScrollView>
    </View>
  </Modal>;
}
