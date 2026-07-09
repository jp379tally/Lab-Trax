import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useInvoices, type CanonicalInvoice } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { ListScreen, type ListScreenQuery } from "@/components/ui/ListScreen";
import { ColumnTotals } from "@/components/ui/ColumnTotals";
import { FormSheet } from "@/components/ui/FormSheet";
import { TextField } from "@/components/ui/TextField";
import { useMe, primaryLabOrgId, primaryProviderOrgId } from "@/lib/auth-me";
import { titleCase, toNumber, formatMoney, formatDate } from "@/lib/format";
import {
  STATUS_FILTERS,
  DATE_FILTERS,
  dateFilterLabel,
  parseDateInput,
  filterAndSortInvoices,
  customerNameOf,
  type InvoiceStatusFilter,
  type InvoiceDateFilter,
  type InvoiceSort,
} from "@/lib/invoice-filters";

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
  const [statusFilter, setStatusFilter] = useState<InvoiceStatusFilter>("all");
  const [dateFilter, setDateFilter] = useState<InvoiceDateFilter>("all");
  const [customStartText, setCustomStartText] = useState("");
  const [customEndText, setCustomEndText] = useState("");
  const [sort, setSort] = useState<InvoiceSort>("newest");

  // Pending state inside the date sheet — applied on "Apply".
  const [dateSheetOpen, setDateSheetOpen] = useState(false);
  const [pendingDate, setPendingDate] = useState<InvoiceDateFilter>("all");
  const [pendingStartText, setPendingStartText] = useState("");
  const [pendingEndText, setPendingEndText] = useState("");

  const me = useMe().data;
  const labOrgId = primaryLabOrgId(me);
  const providerOrgId = primaryProviderOrgId(me);
  const params = labOrgId
    ? { labOrganizationId: labOrgId }
    : providerOrgId
    ? { practiceId: providerOrgId }
    : undefined;
  const query = useInvoices(params);

  const customStart = useMemo(() => parseDateInput(customStartText), [customStartText]);
  const customEnd = useMemo(() => parseDateInput(customEndText), [customEndText]);

  const filteredQuery = useMemo((): ListScreenQuery<CanonicalInvoice> => {
    const data = query.data
      ? filterAndSortInvoices(query.data, {
          status: statusFilter,
          date: dateFilter,
          customStart,
          customEnd,
          sort,
        })
      : undefined;
    return { ...query, data };
  }, [query, statusFilter, dateFilter, customStart, customEnd, sort]);

  const count = filteredQuery.data?.length ?? 0;
  const filtersActive = statusFilter !== "all" || dateFilter !== "all";

  const pendingStart = parseDateInput(pendingStartText);
  const pendingEnd = parseDateInput(pendingEndText);
  const pendingCustomInvalid =
    pendingDate === "custom" &&
    (!pendingStart || !pendingEnd || pendingEnd.getTime() < pendingStart.getTime());

  const openDateSheet = () => {
    setPendingDate(dateFilter);
    setPendingStartText(customStartText);
    setPendingEndText(customEndText);
    setDateSheetOpen(true);
  };

  const applyDateSheet = () => {
    setDateFilter(pendingDate);
    setCustomStartText(pendingStartText);
    setCustomEndText(pendingEndText);
    setDateSheetOpen(false);
  };

  const dateChipLabel =
    dateFilter === "all"
      ? "All dates"
      : dateFilter === "custom" && customStart && customEnd
      ? `${formatDate(customStart.toISOString())} – ${formatDate(customEnd.toISOString())}`
      : dateFilterLabel(dateFilter);

  const displayedInvoices = filteredQuery.data ?? [];

  const filterHeader = (
    <View>
      <ColumnTotals
        loading={query.isLoading || query.isFetching}
        items={[
          {
            label: "Total",
            values: displayedInvoices.map((i) => i.total),
            testID: "column-total-total",
          },
          {
            label: "Balance",
            values: displayedInvoices.map((i) => i.balanceDue ?? i.total),
            testID: "column-total-balance",
          },
        ]}
      />
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
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
      >
        <Pressable
          onPress={openDateSheet}
          style={[styles.filterChip, styles.iconChip, dateFilter !== "all" && styles.filterChipActive]}
          testID="filter-date"
          accessibilityLabel={`Filter by date: ${dateChipLabel}`}
        >
          <Ionicons
            name="calendar-outline"
            size={13}
            color={dateFilter !== "all" ? colors.tint : colors.textSecondary}
          />
          <Text
            style={[styles.filterChipText, dateFilter !== "all" && styles.filterChipTextActive]}
          >
            {dateChipLabel}
          </Text>
          <Ionicons
            name="chevron-down"
            size={12}
            color={dateFilter !== "all" ? colors.tint : colors.textSecondary}
          />
        </Pressable>
        <Pressable
          onPress={() => setSort((s) => (s === "newest" ? "customer" : "newest"))}
          style={[styles.filterChip, styles.iconChip, sort === "customer" && styles.filterChipActive]}
          testID="sort-toggle"
          accessibilityLabel={`Sort by ${sort === "customer" ? "customer" : "newest"}. Tap to change.`}
        >
          <Ionicons
            name="swap-vertical"
            size={13}
            color={sort === "customer" ? colors.tint : colors.textSecondary}
          />
          <Text style={[styles.filterChipText, sort === "customer" && styles.filterChipTextActive]}>
            {sort === "customer" ? "Sort: Customer" : "Sort: Newest"}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );

  return (
    <>
      <ListScreen<CanonicalInvoice>
        title="Invoices"
        subtitle={query.isLoading ? "Loading…" : `${count} invoice${count === 1 ? "" : "s"}`}
        query={filteredQuery}
        keyExtractor={(i) => i.id}
        emptyIcon="document-text-outline"
        emptyTitle="No invoices"
        emptyBody={
          filtersActive
            ? "No invoices match your filters."
            : "Invoices will appear here once they're created."
        }
        errorTitle="Couldn't load invoices"
        pinnedHeader={filterHeader}
        renderItem={(i) => {
          const customer = customerNameOf(i);
          return (
            <Card
              style={styles.row}
              onPress={() => router.push(`/invoice-editor/${i.id}` as never)}
              testID={`invoice-${i.id}`}
            >
              <View style={styles.main}>
                <Text style={styles.name} numberOfLines={1}>
                  {i.invoiceNumber || "Invoice"}
                </Text>
                {customer ? (
                  <Text style={styles.customer} numberOfLines={1}>
                    {customer}
                  </Text>
                ) : null}
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
          );
        }}
      />
      <FormSheet
        visible={dateSheetOpen}
        title="Filter by date"
        onClose={() => setDateSheetOpen(false)}
        onSubmit={applyDateSheet}
        submitLabel="Apply"
        submitDisabled={pendingCustomInvalid}
      >
        <View style={styles.dateOptions}>
          {DATE_FILTERS.map((f) => {
            const selected = f.key === pendingDate;
            return (
              <Pressable
                key={f.key}
                onPress={() => setPendingDate(f.key)}
                style={styles.dateOptionRow}
                testID={`date-option-${f.key}`}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
              >
                <Ionicons
                  name={selected ? "radio-button-on" : "radio-button-off"}
                  size={20}
                  color={selected ? colors.tint : colors.textTertiary}
                />
                <Text style={[styles.dateOptionText, selected && styles.dateOptionTextActive]}>
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {pendingDate === "custom" ? (
          <View style={styles.customFields}>
            <TextField
              label="From"
              placeholder="MM/DD/YYYY"
              value={pendingStartText}
              onChangeText={setPendingStartText}
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
              autoCorrect={false}
              error={pendingStartText.trim().length > 0 && !pendingStart}
              testID="custom-date-start"
            />
            <TextField
              label="To"
              placeholder="MM/DD/YYYY"
              value={pendingEndText}
              onChangeText={setPendingEndText}
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
              autoCorrect={false}
              error={
                (pendingEndText.trim().length > 0 && !pendingEnd) ||
                Boolean(pendingStart && pendingEnd && pendingEnd.getTime() < pendingStart.getTime())
              }
              hint={
                pendingStart && pendingEnd && pendingEnd.getTime() < pendingStart.getTime()
                  ? "End date must be on or after the start date."
                  : "Dates are inclusive."
              }
              testID="custom-date-end"
            />
          </View>
        ) : null}
      </FormSheet>
    </>
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
    iconChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
    },
    filterChipActive: {
      backgroundColor: c.tintLight,
      borderColor: c.tint,
    },
    filterChipText: { ...Typography.captionSemibold, color: c.textSecondary },
    filterChipTextActive: { color: c.tint },
    dateOptions: { gap: 2 },
    dateOptionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingVertical: Spacing.sm + 2,
    },
    dateOptionText: { ...Typography.body, color: c.text },
    dateOptionTextActive: { ...Typography.bodySemibold, color: c.tint },
    customFields: { marginTop: Spacing.md, gap: Spacing.md },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodySemibold, color: c.text },
    customer: { ...Typography.caption, color: c.textSecondary },
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
