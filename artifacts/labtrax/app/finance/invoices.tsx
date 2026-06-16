import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { router } from "expo-router";
import { useInvoices, type CanonicalInvoice } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { ListScreen, type ListScreenQuery } from "@/components/ui/ListScreen";
import { useMe, primaryLabOrgId, primaryProviderOrgId } from "@/lib/auth-me";
import { titleCase, toNumber, formatMoney, formatDate } from "@/lib/format";

type StatusFilter = "all" | "frozen";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "frozen", label: "Frozen" },
];

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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const me = useMe().data;
  const labOrgId = primaryLabOrgId(me);
  const providerOrgId = primaryProviderOrgId(me);
  const params = labOrgId
    ? { labOrganizationId: labOrgId }
    : providerOrgId
    ? { practiceId: providerOrgId }
    : undefined;
  const query = useInvoices(params);

  const filteredQuery = useMemo((): ListScreenQuery<CanonicalInvoice> => {
    if (statusFilter === "frozen") {
      return { ...query, data: query.data?.filter((i) => i.frozen) };
    }
    return query;
  }, [query, statusFilter]);

  const count = filteredQuery.data?.length ?? 0;

  const filterHeader = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.filterRow}
    >
      {STATUS_FILTERS.map((f) => {
        const active = f.key === statusFilter;
        return (
          <Pressable
            key={f.key}
            onPress={() => setStatusFilter(f.key)}
            style={[styles.filterChip, active && styles.filterChipActive]}
            testID={`filter-${f.key}`}
          >
            <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
              {f.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  return (
    <ListScreen<CanonicalInvoice>
      title="Invoices"
      subtitle={query.isLoading ? "Loading…" : `${count} invoice${count === 1 ? "" : "s"}`}
      query={filteredQuery}
      keyExtractor={(i) => i.id}
      emptyIcon="document-text-outline"
      emptyTitle="No invoices"
      emptyBody={
        statusFilter === "frozen"
          ? "No frozen invoices found."
          : "Invoices will appear here once they're created."
      }
      errorTitle="Couldn't load invoices"
      ListHeader={filterHeader}
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
              {i.frozen ? (
                <View
                  style={[styles.frozenBadge, { backgroundColor: colors.warningLight }]}
                  accessibilityLabel="Frozen"
                  accessibilityHint="Invoice is frozen — the linked case was deleted"
                >
                  <Text style={[styles.frozenText, { color: colors.warning }]}>FROZEN</Text>
                </View>
              ) : null}
            </View>
          </View>
        </Card>
      )}
    />
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    filterRow: {
      paddingHorizontal: Spacing.lg,
      paddingBottom: Spacing.md,
      gap: Spacing.sm,
    },
    filterChip: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.xs + 2,
      borderRadius: Radius.full,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    filterChipActive: {
      backgroundColor: c.tintLight,
      borderColor: c.tint,
    },
    filterChipText: { ...Typography.captionSemibold, color: c.textSecondary },
    filterChipTextActive: { color: c.tint },
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
