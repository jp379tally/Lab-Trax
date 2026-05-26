import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { AppHeader } from "@/components/ui/AppHeader";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { resilientFetch } from "@/lib/query-client";

interface PricingTier {
  id: string;
  name: string;
  items?: Array<{ description?: string | null; price?: string | number | null; unit?: string | null }>;
}

function fmtPrice(v?: string | number | null, unit?: string | null) {
  const n = Number(v);
  if (isNaN(n)) return "—";
  const formatted = n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  return unit ? `${formatted} / ${unit}` : formatted;
}

export default function PricingScreen() {
  const { colors, isDark } = useTheme();
  const [tiers, setTiers] = useState<PricingTier[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    resilientFetch("/api/pricing-tiers")
      .then((r) => r.json().catch(() => ({})))
      .then((body) => {
        const rows: PricingTier[] = Array.isArray(body)
          ? body
          : Array.isArray(body?.data)
          ? body.data
          : [];
        setTiers(rows);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSolid }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <AppHeader title="Pricing" showSearch={false} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : tiers.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="pricetag-outline" size={48} color={colors.textTertiary} />
          <Text style={[styles.empty, { color: colors.textSecondary }]}>No pricing tiers configured</Text>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
          {tiers.map((tier) => (
            <View key={tier.id} style={{ marginBottom: 4 }}>
              <SectionHeader title={tier.name} />
              <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                {(tier.items ?? []).map((item, idx) => (
                  <View
                    key={idx}
                    style={[
                      styles.lineItem,
                      { borderBottomColor: colors.border },
                      idx === (tier.items?.length ?? 0) - 1 && { borderBottomWidth: 0 },
                    ]}
                  >
                    <Text style={[styles.desc, { color: colors.text }]} numberOfLines={2}>
                      {item.description || "—"}
                    </Text>
                    <Text style={[styles.price, { color: colors.tint }]}>
                      {fmtPrice(item.price, item.unit)}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 12 },
  empty: { fontSize: 15, fontFamily: "Inter_400Regular", textAlign: "center" },
  card: {
    marginHorizontal: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  lineItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  desc: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular" },
  price: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
