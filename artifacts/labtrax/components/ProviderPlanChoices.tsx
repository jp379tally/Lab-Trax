import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import {
  PROVIDER_SIGNUP_CHOICES, PROVIDER_CARD_REUSE_WORDING,
  PROVIDER_CARD_REUSE_EXPLANATION, PROVIDER_TRIAL_DISCLOSURE,
  type ProviderSignupTier,
} from "@workspace/api-client-react";

export default function ProviderPlanChoices({ selected, onSelect, reuseCard, onReuseChange, disabled = false }: {
  selected: ProviderSignupTier | null; onSelect: (plan: ProviderSignupTier) => void;
  reuseCard: boolean; onReuseChange: (value: boolean) => void; disabled?: boolean;
}) {
  return <View style={styles.stack}>
    {PROVIDER_SIGNUP_CHOICES.map((plan) => <Pressable
      key={plan.id} accessibilityRole="radio" accessibilityLabel={`${plan.name} $${plan.monthlyPriceUsd}${plan.cardRequired ? " per month" : ""}`}
      accessibilityState={{ checked: selected === plan.id, disabled }}
      testID={`provider-plan-${plan.id}`} disabled={disabled}
      onPress={() => { if (!disabled) { onSelect(plan.id); if (plan.id === "free") onReuseChange(false); } }}
      style={[styles.card, selected === plan.id && styles.selected]}>
      <Text style={styles.title}>{plan.name}{selected === plan.id ? " — Selected" : ""}</Text>
      <Text style={styles.price}>${plan.monthlyPriceUsd}{plan.cardRequired ? "/month USD" : " — permanent"}</Text>
      <Text style={styles.copy}>{plan.description}</Text>
      <Text style={styles.copy}>{plan.cardRequired ? "Card required · First charge after a 30-day trial" : "No card required · No trial expiry"}</Text>
    </Pressable>)}
    {selected && selected !== "free" && <>
      <Text style={styles.copy}>{PROVIDER_TRIAL_DISCLOSURE}</Text>
      <Pressable testID="provider-card-reuse" accessibilityRole="checkbox" accessibilityLabel={PROVIDER_CARD_REUSE_WORDING}
        accessibilityState={{ checked: reuseCard, disabled }} disabled={disabled}
        onPress={() => { if (!disabled) onReuseChange(!reuseCard); }} style={styles.consent}>
        <Text style={styles.check}>{reuseCard ? "☑" : "☐"}</Text>
        <Text style={[styles.copy, { flex: 1 }]}>{PROVIDER_CARD_REUSE_WORDING}</Text>
      </Pressable>
      <Text style={styles.copy}>{PROVIDER_CARD_REUSE_EXPLANATION}</Text>
    </>}
  </View>;
}
const styles = StyleSheet.create({
  stack: { gap: 12 }, card: { padding: 16, borderWidth: 1, borderColor: "#CBD5E1", borderRadius: 12, backgroundColor: "#FFF", gap: 6 },
  selected: { borderColor: "#145DA0", borderWidth: 2, backgroundColor: "#EFF6FF" },
  title: { color: "#0F172A", fontSize: 16, fontWeight: "600" }, price: { color: "#0F172A", fontSize: 20, fontWeight: "700" },
  copy: { color: "#334155", fontSize: 13, lineHeight: 19 }, consent: { flexDirection: "row", gap: 10, paddingVertical: 10 },
  check: { color: "#145DA0", fontSize: 24 },
});
