import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { router } from "expo-router";
import { useInvoices, type CanonicalInvoice } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { ListScreen } from "@/components/ui/ListScreen";
import { useMe, primaryLabOrgId, primaryProviderOrgId } from "@/lib/auth-me";
import { titleCase, toNumber, formatMoney, formatDate } from "@/lib/format";

function invoiceVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("paid")) return "paid";
  if (s.includes("overdue") || s.includes("past")) return "overdue";
  if (s.includes("void") || s.includes("cancel")) return "void";
  if (s.includes("draft")) return "draft";
  return "unpaid";
}

export default function InvoicesScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const me = useMe().data;
  const labOrgId = primaryLabOrgId(me);
  const providerOrgId = primaryProviderOrgId(me);
  const params = labOrgId
    ? { labOrganizationId: labOrgId }
    : providerOrgId
    ? { practiceId: providerOrgId }
    : undefined;
  const query = useInvoices(params);
  const count = query.data?.length ?? 0;

  return (
    <ListScreen<CanonicalInvoice>
      title="Invoices"
      subtitle={query.isLoading ? "Loading…" : `${count} invoice${count === 1 ? "" : "s"}`}
      query={query}
      keyExtractor={(i) => i.id}
      emptyIcon="document-text-outline"
      emptyTitle="No invoices"
      emptyBody="Invoices will appear here once they're created."
      errorTitle="Couldn't load invoices"
      renderItem={(i) => (
        <Card
          style={styles.row}
          onPress={() => router.push(`/invoice-editor/${i.id}` as never)}
          testID={`invoice-${i.id}`}
        >
          <View style={styles.main}>
            <Text style={styles.name} numberOfLines={1}>
              {i.invoiceNumber || "Invoice"}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              Issued {formatDate(i.issuedAt)} · Due {formatDate(i.dueAt)}
            </Text>
          </View>
          <View style={styles.right}>
            <Text style={styles.amount}>{formatMoney(i.balanceDue ?? i.total)}</Text>
            <View style={styles.badges}>
              <StatusBadge label={titleCase(i.status ?? "—")} variant={invoiceVariant(i.status)} size="sm" />
              {i.frozen && (
                <View style={[styles.frozenBadge, { backgroundColor: colors.warningLight }]}>
                  <Text style={[styles.frozenText, { color: colors.warning }]}>CASE DELETED</Text>
                </View>
              )}
            </View>
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
    badges: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, flexWrap: "wrap", justifyContent: "flex-end" },
    frozenBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 99,
    },
    frozenText: {
      fontSize: 10,
      fontFamily: "Inter_600SemiBold",
      letterSpacing: 0.4,
    },
  });
}
