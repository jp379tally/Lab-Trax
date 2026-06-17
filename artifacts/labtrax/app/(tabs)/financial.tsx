import React, { useMemo } from "react";
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { getJson } from "@/lib/read-api";
import { useMe, primaryLabOrgId, canEditAnyLab } from "@/lib/auth-me";
import { formatMoney } from "@/lib/format";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

interface HubItem {
  title: string;
  subtitle: string;
  icon: IconName;
  route: string;
}

interface UndepositedSummary {
  count: number;
  total: number;
}

const ITEMS: HubItem[] = [
  {
    title: "Invoices",
    subtitle: "Billing, balances, and line items",
    icon: "document-text-outline",
    route: "/finance/invoices",
  },
  {
    title: "Customer Center",
    subtitle: "Doctors and practices you bill",
    icon: "people-outline",
    route: "/finance/customers",
  },
  {
    title: "Statements",
    subtitle: "Monthly statement send runs",
    icon: "mail-outline",
    route: "/finance/statements",
  },
  {
    title: "Bank Register",
    subtitle: "Transactions and running balances",
    icon: "swap-horizontal-outline",
    route: "/finance/bank-register",
  },
];

export default function FinancialHubScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const me = useMe();
  const labOrgId = primaryLabOrgId(me.data);
  const hasBillingAccess = canEditAnyLab(me.data);

  const undepositedQuery = useQuery<UndepositedSummary>({
    queryKey: ["undeposited-funds-summary", labOrgId ?? ""],
    enabled: hasBillingAccess && !!labOrgId,
    staleTime: 60_000,
    queryFn: async () =>
      getJson<UndepositedSummary>(
        `/api/finance/undeposited-funds?organizationId=${encodeURIComponent(labOrgId!)}&summary=1`,
      ),
  });

  const pending = undepositedQuery.data;
  const showBadge = hasBillingAccess && !!pending && pending.count > 0;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Financial</Text>
        <Text style={styles.subtitle}>Billing and bookkeeping</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {showBadge && (
          <TouchableOpacity
            testID="undeposited-funds-banner"
            activeOpacity={0.8}
            onPress={() => router.push("/finance/bank-register" as never)}
            style={[styles.alertRow, { backgroundColor: colors.warningSurface, borderColor: colors.warning }]}
          >
            <View style={[styles.alertIcon, { backgroundColor: colors.warningLight }]}>
              <Ionicons name="wallet-outline" size={18} color={colors.warning} />
            </View>
            <View style={styles.alertMain}>
              <Text style={[styles.alertTitle, { color: colors.warning }]}>
                Undeposited Funds
              </Text>
              <Text style={[styles.alertSub, { color: colors.textSecondary }]}>
                {pending.count} payment{pending.count !== 1 ? "s" : ""} · {formatMoney(pending.total)} waiting to deposit
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.warning} />
          </TouchableOpacity>
        )}
        {ITEMS.map((item) => (
          <Card key={item.route} style={styles.row} onPress={() => router.push(item.route as never)} testID={`hub-${item.route}`}>
            <View style={[styles.rowIcon, { backgroundColor: colors.tint + "1A" }]}>
              <Ionicons name={item.icon} size={20} color={colors.tint} />
            </View>
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle}>{item.title}</Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {item.subtitle}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: Spacing.xs },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    content: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.sm },
    alertRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: 1,
      padding: Spacing.md,
    },
    alertIcon: {
      width: 36,
      height: 36,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    alertMain: { flex: 1, gap: 2 },
    alertTitle: { ...Typography.bodyMedium, fontWeight: "600" },
    alertSub: { ...Typography.caption },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    rowIcon: {
      width: 40,
      height: 40,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    rowMain: { flex: 1, gap: 2 },
    rowTitle: { ...Typography.bodyLgMedium, color: c.text },
    rowSubtitle: { ...Typography.caption, color: c.textSecondary },
  });
}
