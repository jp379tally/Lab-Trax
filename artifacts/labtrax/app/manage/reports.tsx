import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { ListScreen } from "@/components/ui/ListScreen";
import { getJson } from "@/lib/read-api";
import { useMe, primaryLabOrgId, canEditAnyLab } from "@/lib/auth-me";
import { titleCase, toNumber, formatMoney } from "@/lib/format";

interface BilledRow {
  restorationType?: string | null;
  material?: string | null;
  unitsBilled?: number | null;
  caseCount?: number | null;
  totalRevenue?: string | number | null;
  avgPrice?: string | number | null;
}

export default function ReportsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const me = useMe().data;
  const labOrgId = primaryLabOrgId(me);
  const canEdit = canEditAnyLab(me);

  const query = useQuery<BilledRow[]>({
    queryKey: ["billed-report", labOrgId ?? ""],
    enabled: !!labOrgId && canEdit,
    staleTime: 30_000,
    queryFn: async () => {
      const data = await getJson<{ rows: BilledRow[] }>(
        `/api/pricing/billed?labOrganizationId=${encodeURIComponent(labOrgId!)}`,
      );
      return data.rows ?? [];
    },
  });

  const rows = query.data ?? [];
  const totalRevenue = useMemo(() => rows.reduce((sum, r) => sum + toNumber(r.totalRevenue), 0), [rows]);
  const totalUnits = useMemo(() => rows.reduce((sum, r) => sum + (r.unitsBilled ?? 0), 0), [rows]);

  const header =
    rows.length > 0 ? (
      <Card style={styles.summary}>
        <View style={styles.summaryCol}>
          <Text style={styles.summaryValue}>{formatMoney(totalRevenue)}</Text>
          <Text style={styles.summaryLabel}>Total billed</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryCol}>
          <Text style={styles.summaryValue}>{totalUnits}</Text>
          <Text style={styles.summaryLabel}>Units</Text>
        </View>
      </Card>
    ) : null;

  return (
    <ListScreen<BilledRow>
      title="Reports"
      subtitle="Billed revenue by restoration"
      query={query}
      keyExtractor={(r) => `${r.restorationType ?? "?"}:${r.material ?? "?"}`}
      ListHeader={header}
      emptyIcon="bar-chart-outline"
      emptyTitle="No billed data"
      emptyBody="Billed revenue will appear here once invoices are created."
      errorTitle="Couldn’t load report"
      blocked={
        !canEdit
          ? {
              icon: "lock-closed-outline",
              title: "Not available",
              body: "Reports are available to lab owners, admins, and billing users.",
            }
          : labOrgId
          ? null
          : {
              icon: "bar-chart-outline",
              title: "No lab selected",
              body: "Reports are scoped to a lab. This view is available to lab members.",
            }
      }
      renderItem={(r) => (
        <Card style={styles.row}>
          <View style={styles.main}>
            <Text style={styles.name} numberOfLines={1}>
              {titleCase(r.restorationType ?? "—")}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {r.material ? `${titleCase(r.material)} · ` : ""}
              {r.unitsBilled ?? 0} units · {r.caseCount ?? 0} case{(r.caseCount ?? 0) === 1 ? "" : "s"}
            </Text>
          </View>
          <View style={styles.right}>
            <Text style={styles.amount}>{formatMoney(r.totalRevenue)}</Text>
            <Text style={styles.avg}>avg {formatMoney(r.avgPrice)}</Text>
          </View>
        </Card>
      )}
    />
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    summary: { flexDirection: "row", alignItems: "center" },
    summaryCol: { flex: 1, alignItems: "center", gap: 2 },
    summaryDivider: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", backgroundColor: c.border },
    summaryValue: { ...Typography.h2, color: c.text },
    summaryLabel: { ...Typography.caption, color: c.textSecondary },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodySemibold, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
    right: { alignItems: "flex-end", gap: 2 },
    amount: { ...Typography.bodySemibold, color: c.text },
    avg: { ...Typography.caption, color: c.textTertiary },
  });
}
