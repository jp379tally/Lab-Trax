import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ListScreen } from "@/components/ui/ListScreen";
import { getJson } from "@/lib/read-api";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import { titleCase, toNumber, formatMoney, formatDate } from "@/lib/format";

interface BankTxn {
  id: string;
  txnDate?: string | null;
  type?: string | null;
  payee?: string | null;
  memo?: string | null;
  netAmount?: string | number | null;
  runningBalance?: string | number | null;
  status?: string | null;
}

export default function BankRegisterScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const labOrgId = primaryLabOrgId(useMe().data);

  const query = useQuery<BankTxn[]>({
    queryKey: ["bank-transactions", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: () =>
      getJson<BankTxn[]>(`/api/finance/transactions?organizationId=${encodeURIComponent(labOrgId!)}`),
  });

  const count = query.data?.length ?? 0;

  return (
    <ListScreen<BankTxn>
      title="Bank Register"
      subtitle={query.isLoading ? "Loading…" : `${count} transaction${count === 1 ? "" : "s"}`}
      query={query}
      keyExtractor={(t) => t.id}
      emptyIcon="swap-horizontal-outline"
      emptyTitle="No transactions"
      emptyBody="Bank transactions will appear here."
      errorTitle="Couldn’t load transactions"
      blocked={
        labOrgId
          ? null
          : {
              icon: "swap-horizontal-outline",
              title: "No lab selected",
              body: "The bank register is scoped to a lab. This view is available to lab members.",
            }
      }
      renderItem={(t) => {
        const amount = toNumber(t.netAmount);
        const voided = (t.status ?? "").toLowerCase().includes("void");
        return (
          <Card style={styles.row}>
            <View style={styles.main}>
              <Text style={styles.name} numberOfLines={1}>
                {t.payee || t.memo || titleCase(t.type ?? "Transaction")}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {formatDate(t.txnDate)}
                {t.runningBalance != null ? ` · Balance ${formatMoney(t.runningBalance)}` : ""}
              </Text>
            </View>
            <View style={styles.right}>
              <Text style={[styles.amount, { color: amount < 0 ? colors.error : colors.success }]}>
                {amount < 0 ? "-" : "+"}
                {formatMoney(Math.abs(amount))}
              </Text>
              {voided ? <StatusBadge label="Void" variant="void" size="sm" /> : null}
            </View>
          </Card>
        );
      }}
    />
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodySemibold, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
    right: { alignItems: "flex-end", gap: Spacing.xs },
    amount: { ...Typography.bodySemibold },
  });
}
