import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, Alert, ActivityIndicator } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { ListScreen } from "@/components/ui/ListScreen";
import { getJson } from "@/lib/read-api";
import { useMe, primaryAdminLabOrgId, canAdminAnyLab } from "@/lib/auth-me";
import { titleCase, toNumber, formatMoney } from "@/lib/format";

interface BilledRow {
  restorationType?: string | null;
  material?: string | null;
  unitsBilled?: number | null;
  caseCount?: number | null;
  totalRevenue?: string | number | null;
  avgPrice?: string | number | null;
}

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(rows: BilledRow[]): string {
  const header = ["Restoration", "Material", "Units billed", "Cases", "Total revenue", "Avg price"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.restorationType ?? "",
        r.material ?? "",
        r.unitsBilled ?? 0,
        r.caseCount ?? 0,
        toNumber(r.totalRevenue).toFixed(2),
        toNumber(r.avgPrice).toFixed(2),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

export default function ReportsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const me = useMe().data;
  // The billed report (/api/pricing/billed) is admin-only on the server
  // (resolveLabId → owner/admin), so gate the screen on admin to match.
  const labOrgId = primaryAdminLabOrgId(me);
  const canEdit = canAdminAnyLab(me);
  const [exporting, setExporting] = useState(false);

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

  async function handleExport() {
    if (rows.length === 0 || exporting) return;
    setExporting(true);
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert("Sharing unavailable", "Exporting isn’t supported on this device.");
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const uri = `${FileSystem.cacheDirectory ?? ""}billed-report-${stamp}.csv`;
      await FileSystem.writeAsStringAsync(uri, buildCsv(rows));
      await Sharing.shareAsync(uri, {
        mimeType: "text/csv",
        dialogTitle: "Export billed report",
        UTI: "public.comma-separated-values-text",
      });
    } catch {
      Alert.alert("Couldn’t export", "Please try again.");
    } finally {
      setExporting(false);
    }
  }

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

  const exportBtn =
    canEdit && labOrgId && rows.length > 0 ? (
      <Pressable style={styles.exportBtn} onPress={handleExport} disabled={exporting} testID="reports-export">
        {exporting ? (
          <ActivityIndicator size="small" color={colors.tint} />
        ) : (
          <Ionicons name="share-outline" size={22} color={colors.tint} />
        )}
      </Pressable>
    ) : null;

  return (
    <ListScreen<BilledRow>
      title="Reports"
      subtitle="Billed revenue by restoration"
      query={query}
      keyExtractor={(r) => `${r.restorationType ?? "?"}:${r.material ?? "?"}`}
      ListHeader={header}
      headerRight={exportBtn}
      emptyIcon="bar-chart-outline"
      emptyTitle="No billed data"
      emptyBody="Billed revenue will appear here once invoices are created."
      errorTitle="Couldn’t load report"
      blocked={
        !canEdit
          ? {
              icon: "lock-closed-outline",
              title: "Not available",
              body: "Reports are available to lab owners and admins.",
            }
          : null
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
    exportBtn: {
      width: 40,
      height: 40,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.tint + "1A",
    },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodySemibold, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
    right: { alignItems: "flex-end", gap: 2 },
    amount: { ...Typography.bodySemibold, color: c.text },
    avg: { ...Typography.caption, color: c.textTertiary },
  });
}
