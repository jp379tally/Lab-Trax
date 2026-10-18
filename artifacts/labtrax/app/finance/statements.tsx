import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useFocusEffect } from "expo-router";
import { useStatementAccountSummaries, type MobileStatementAccountSummary } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { ListScreen } from "@/components/ui/ListScreen";
import { ColumnTotals } from "@/components/ui/ColumnTotals";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import { formatMoney, formatDate } from "@/lib/format";

export default function StatementsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const labOrgId = primaryLabOrgId(useMe().data);

  const query = useStatementAccountSummaries(labOrgId);
  const refreshRef = useRef(query.refresh);
  useEffect(() => {
    refreshRef.current = query.refresh;
  }, [query.refresh]);
  useFocusEffect(useCallback(() => {
    void refreshRef.current();
  }, []));

  const count = query.total;

  return (
    <ListScreen<MobileStatementAccountSummary>
      title="Statements"
      subtitle={query.isLoading ? "Loading…" : `${count} practice${count === 1 ? "" : "s"}`}
      query={query}
      hasMore={query.hasNextPage}
      isLoadingMore={query.isFetchingNextPage}
      onLoadMore={query.fetchNextPage}
      onRefresh={query.refresh}
      keyExtractor={(r) => r.practiceId}
      emptyIcon="mail-outline"
      emptyTitle="No statement accounts"
      emptyBody="Practices with invoice or statement activity will appear here."
      errorTitle="Couldn’t load statements"
      ListHeader={
        <ColumnTotals
          loading={query.isLoading || query.isFetching}
          items={[
            {
              label: "Open Balance",
              values: (query.data ?? []).map((r) => r.totalOpenBalance),
              testID: "column-total-total",
            },
          ]}
        />
      }
      blocked={
        labOrgId
          ? null
          : {
              icon: "mail-outline",
              title: "No lab selected",
              body: "Statements are scoped to a lab. This view is available to lab members.",
            }
      }
      renderItem={(r) => (
        <Card style={styles.row}>
          <View style={styles.main}>
            <Text style={styles.name} numberOfLines={1}>
              {r.practiceName}
            </Text>
            <Text style={styles.email} numberOfLines={1}>
              {r.billingEmail || "No email on file."}
            </Text>
            <View style={styles.metrics}>
              <Metric label="Open Invoices" value={String(r.openInvoiceCount)} styles={styles} />
              <Metric label="Open Invoices Total" value={formatMoney(r.openInvoiceTotal)} styles={styles} testID={`statement-open-total-${r.practiceId}`} />
              <Metric label="Total Open Balance" value={formatMoney(r.totalOpenBalance)} styles={styles} testID={`statement-balance-${r.practiceId}`} />
              <Metric label="Overdue" value={formatMoney(r.overdueBalance)} styles={styles} overdue={r.overdueBalance > 0} testID={`statement-overdue-${r.practiceId}`} />
            </View>
            <Text style={styles.sectionLabel}>Unpaid Statements</Text>
            {r.unpaidStatements.length ? r.unpaidStatements.slice(0, 3).map((statement) => (
              <View key={statement.id} style={styles.statementLine}>
                <Text style={styles.meta}>{formatDate(statement.date)}</Text>
                <Text style={styles.amount}>{formatMoney(statement.remainingBalance)}</Text>
              </View>
            )) : <Text style={styles.meta}>None</Text>}
            {r.unpaidStatements.length > 3 ? (
              <Text style={styles.meta}>{r.unpaidStatements.length - 3} more unpaid statement{r.unpaidStatements.length === 4 ? "" : "s"}</Text>
            ) : null}
          </View>
        </Card>
      )}
    />
  );
}

function Metric({ label, value, styles, overdue = false, testID }: {
  label: string;
  value: string;
  styles: ReturnType<typeof makeStyles>;
  overdue?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text testID={testID} style={overdue ? styles.overdueAmount : styles.amount}>{value}</Text>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    row: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.md },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodySemibold, color: c.text },
    email: { ...Typography.caption, color: c.textSecondary, marginBottom: Spacing.sm },
    meta: { ...Typography.caption, color: c.textSecondary },
    amount: { ...Typography.bodySemibold, color: c.text },
    overdueAmount: { ...Typography.bodySemibold, color: c.error },
    metrics: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm, marginBottom: Spacing.sm },
    metric: { width: "47%", gap: 2 },
    metricLabel: { ...Typography.caption, color: c.textSecondary },
    sectionLabel: { ...Typography.caption, color: c.textSecondary, marginTop: Spacing.xs },
    statementLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 24 },
  });
}
