import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { ListScreen } from "@/components/ui/ListScreen";
import { getJson } from "@/lib/read-api";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import { formatMoney } from "@/lib/format";

interface BankAccount {
  id: string;
  name: string;
  institution?: string | null;
  last4?: string | null;
  isArchived?: boolean | null;
  bookBalance?: string | number | null;
  clearedBalance?: string | number | null;
  unreconciledBalance?: string | number | null;
}

export default function AccountsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const labOrgId = primaryLabOrgId(useMe().data);

  const query = useQuery<BankAccount[]>({
    queryKey: ["bank-accounts", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: () => getJson<BankAccount[]>(`/api/finance/accounts?organizationId=${encodeURIComponent(labOrgId!)}`),
  });

  const count = query.data?.length ?? 0;

  return (
    <ListScreen<BankAccount>
      title="Accounts"
      subtitle={query.isLoading ? "Loading…" : `${count} account${count === 1 ? "" : "s"}`}
      query={query}
      keyExtractor={(a) => a.id}
      emptyIcon="wallet-outline"
      emptyTitle="No accounts"
      emptyBody="Bank and cash accounts will appear here."
      errorTitle="Couldn’t load accounts"
      blocked={
        labOrgId
          ? null
          : {
              icon: "wallet-outline",
              title: "No lab selected",
              body: "Accounts are scoped to a lab. This view is available to lab members.",
            }
      }
      renderItem={(a) => (
        <Card style={styles.card}>
          <View style={styles.headerRow}>
            <View style={styles.main}>
              <Text style={styles.name} numberOfLines={1}>
                {a.name}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {a.institution || "Account"}
                {a.last4 ? ` ····${a.last4}` : ""}
              </Text>
            </View>
            <Text style={styles.balance}>{formatMoney(a.bookBalance)}</Text>
          </View>
          <View style={styles.subRow}>
            <Text style={styles.subLabel}>
              Cleared <Text style={styles.subValue}>{formatMoney(a.clearedBalance)}</Text>
            </Text>
            <Text style={styles.subLabel}>
              Unreconciled <Text style={styles.subValue}>{formatMoney(a.unreconciledBalance)}</Text>
            </Text>
          </View>
        </Card>
      )}
    />
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    card: { gap: Spacing.sm },
    headerRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodyLgMedium, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
    balance: { ...Typography.h3, color: c.text },
    subRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingTop: Spacing.sm,
    },
    subLabel: { ...Typography.caption, color: c.textTertiary },
    subValue: { ...Typography.captionSemibold, color: c.textSecondary },
  });
}
