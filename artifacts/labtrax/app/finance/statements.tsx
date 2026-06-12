import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { ListScreen } from "@/components/ui/ListScreen";
import { getJson } from "@/lib/read-api";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import { titleCase, toNumber, formatMoney, formatDate } from "@/lib/format";

interface StatementRun {
  id: string;
  practiceName?: string | null;
  periodMonth?: string | null;
  status?: string | null;
  invoiceCount?: number | null;
  totalAmount?: string | number | null;
  createdAt?: string | null;
}

function runVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("sent") || s.includes("complete") || s.includes("success")) return "paid";
  if (s.includes("fail") || s.includes("error")) return "overdue";
  if (s.includes("pending") || s.includes("queue") || s.includes("progress")) return "open";
  return "draft";
}

export default function StatementsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const labOrgId = primaryLabOrgId(useMe().data);

  const query = useQuery<StatementRun[]>({
    queryKey: ["statement-runs", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: () => getJson<StatementRun[]>(`/api/statements/${encodeURIComponent(labOrgId!)}/statement-runs`),
  });

  const count = query.data?.length ?? 0;

  return (
    <ListScreen<StatementRun>
      title="Statements"
      subtitle={query.isLoading ? "Loading…" : `${count} send${count === 1 ? "" : "s"}`}
      query={query}
      keyExtractor={(r) => r.id}
      emptyIcon="mail-outline"
      emptyTitle="No statement runs"
      emptyBody="Monthly statement sends will appear here."
      errorTitle="Couldn’t load statements"
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
              {r.practiceName || "Practice"}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {r.periodMonth ? `${r.periodMonth} · ` : ""}
              {r.invoiceCount ?? 0} invoice{(r.invoiceCount ?? 0) === 1 ? "" : "s"}
              {r.createdAt ? ` · ${formatDate(r.createdAt)}` : ""}
            </Text>
          </View>
          <View style={styles.right}>
            {r.totalAmount != null ? <Text style={styles.amount}>{formatMoney(toNumber(r.totalAmount))}</Text> : null}
            <StatusBadge label={titleCase(r.status ?? "—")} variant={runVariant(r.status)} size="sm" />
          </View>
        </Card>
      )}
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
    amount: { ...Typography.bodySemibold, color: c.text },
  });
}
