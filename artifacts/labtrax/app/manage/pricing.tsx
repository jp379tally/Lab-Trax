import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { ListScreen } from "@/components/ui/ListScreen";
import { getJson } from "@/lib/read-api";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";

interface PricingTier {
  id: string;
  name: string;
  prices?: Record<string, string | number | null> | null;
}

function pricedCount(prices: PricingTier["prices"]): number {
  if (!prices) return 0;
  return Object.values(prices).filter((v) => v != null && String(v).trim() !== "").length;
}

export default function PricingScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const labOrgId = primaryLabOrgId(useMe().data);

  const query = useQuery<PricingTier[]>({
    queryKey: ["pricing-tiers", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: async () => {
      const data = await getJson<{ tiers: PricingTier[] }>(
        `/api/pricing/tiers?labOrganizationId=${encodeURIComponent(labOrgId!)}`,
      );
      return data.tiers ?? [];
    },
  });

  const count = query.data?.length ?? 0;

  return (
    <ListScreen<PricingTier>
      title="Pricing"
      subtitle={query.isLoading ? "Loading…" : `${count} tier${count === 1 ? "" : "s"}`}
      query={query}
      keyExtractor={(t) => t.id}
      emptyIcon="pricetags-outline"
      emptyTitle="No pricing tiers"
      emptyBody="Pricing tiers will appear here."
      errorTitle="Couldn’t load pricing"
      blocked={
        labOrgId
          ? null
          : {
              icon: "pricetags-outline",
              title: "No lab selected",
              body: "Pricing is scoped to a lab. This view is available to lab members.",
            }
      }
      renderItem={(t) => (
        <Card style={styles.row}>
          <View style={[styles.icon, { backgroundColor: colors.tint + "1A" }]}>
            <Text style={[styles.iconText, { color: colors.tint }]}>{(t.name || "?").charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.main}>
            <Text style={styles.name} numberOfLines={1}>
              {t.name}
            </Text>
            <Text style={styles.meta}>
              {pricedCount(t.prices)} priced item{pricedCount(t.prices) === 1 ? "" : "s"}
            </Text>
          </View>
        </Card>
      )}
    />
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
    iconText: { ...Typography.bodySemibold },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodyLgMedium, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
  });
}
