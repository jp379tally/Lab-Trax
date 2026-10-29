import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { CanonicalInvoice } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { titleCase, formatMoney, formatDate } from "@/lib/format";
import { customerNameOf } from "@/lib/invoice-filters";
import { doctorOf, isHistoricalInvoiceHeld, isInvoiceOverdue, paymentActionState, patientOf, registerRestoration } from "@/lib/invoice-web-fields";

export function invoiceBadgeVariant(status?: string | null): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s === "paid") return "paid";
  if (s === "draft" || s === "recovery_draft") return "draft";
  if (s === "open" || s === "partially_paid") return "open";
  if (s.includes("overdue") || s.includes("past")) return "overdue";
  if (s.includes("void") || s.includes("cancel")) return "void";
  return "unpaid";
}

export type InvoiceRowProps = {
  invoice: CanonicalInvoice;
  selected: boolean;
  /** Dense column layout (wide web) vs touch record (narrow web). */
  wide?: boolean;
  /** Lab-editor permission for this invoice's lab. */
  canWrite?: boolean;
  onPress: () => void;
  onEdit?: (inv: CanonicalInvoice) => void;
  onRecordPayment?: (inv: CanonicalInvoice) => void;
};

const COL = { num: 1.1, who: 2, rest: 1.4, due: 1, status: 1, total: 1, bal: 1 } as const;

export function InvoiceRegisterColumns({ total, balance, loading = false }: { total?: number; balance?: number; loading?: boolean }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const h = (label: string, flex: number, right?: boolean) => (
    <Text key={label} style={[s.headCell, { flex }, right && { textAlign: "right" }]} numberOfLines={1}>{label}</Text>
  );
  const amount = (label: string, flex: number, value?: number) => (
    <View key={label} style={{ flex, minWidth: 0, alignItems: "flex-end" }}>
      <Text style={s.headCell}>{label}</Text>
      <Text style={s.sub} numberOfLines={1} testID={`invoice-column-${label.toLowerCase()}`}>{loading || value == null ? "—" : formatMoney(value)}</Text>
    </View>
  );
  return (
    <View style={s.headRow} testID="invoice-register-columns" accessibilityRole="header">
      {h("INVOICE #", COL.num)}{h("PRACTICE / PATIENT", COL.who)}{h("RESTORATION", COL.rest)}{h("DUE DATE", COL.due)}
      {h("STATUS", COL.status)}{amount("TOTAL", COL.total, total)}{amount("BALANCE", COL.bal, balance)}
      <Text style={[s.headCell, { width: 128, textAlign: "right" }]}>ACTIONS</Text>
    </View>
  );
}

export function InvoiceRegisterRow({ invoice: i, selected, wide = false, canWrite = false, onPress, onEdit, onRecordPayment }: InvoiceRowProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [menu, setMenu] = useState(false);
  const practice = customerNameOf(i);
  const patient = patientOf(i) || doctorOf(i) || "—";
  const overdue = isInvoiceOverdue(i);
  const historicalHold = isHistoricalInvoiceHeld(i);
  const readonlyDraft = i.status === "draft" || historicalHold;
  const pay = paymentActionState(i, canWrite && !readonlyDraft);
  const canEdit = canWrite && !i.frozen && !readonlyDraft;
  const num = i.invoiceNumber || "Invoice";
  const copy = () => {
    try { void (globalThis as { navigator?: { clipboard?: { writeText: (t: string) => Promise<void> } } }).navigator?.clipboard?.writeText(num); } catch { /* clipboard unavailable */ }
    setMenu(false);
  };
  const flags = (
    <>
      {i.frozen ? <Text style={[s.flag, { color: colors.warning, backgroundColor: colors.warningLight }]}>FROZEN</Text> : null}
      {i.aiGenerated ? <Text style={[s.flag, { color: colors.tint, backgroundColor: colors.tintLight }]}>AI</Text> : null}
    </>
  );
  const due = <Text style={[s.cell, overdue && s.overdue]} numberOfLines={1} testID={`invoice-due-${i.id}`}>{formatDate(i.dueAt)}</Text>;
  const actions = (
    <View style={s.actions}>
      <Pressable onPress={onPress} style={s.iconBtn} accessibilityRole="button" accessibilityLabel={`View invoice ${num}`} testID={`invoice-view-${i.id}`}>
        <Ionicons name="eye-outline" size={18} color={colors.textSecondary} />
      </Pressable>
      {canEdit ? <Pressable onPress={() => onEdit?.(i)} style={s.iconBtn} accessibilityRole="button" accessibilityLabel={`Edit invoice ${num}`} testID={`invoice-edit-${i.id}`}>
        <Ionicons name="create-outline" size={18} color={colors.textSecondary} />
      </Pressable> : null}
      <Pressable onPress={() => setMenu((v) => !v)} style={s.iconBtn} accessibilityRole="button" accessibilityState={{ expanded: menu }}
        accessibilityLabel={`More actions for ${num}`} testID={`invoice-more-${i.id}`}>
        <Ionicons name="ellipsis-horizontal" size={18} color={colors.textSecondary} />
      </Pressable>
    </View>
  );
  const menuView = menu ? (
    <View style={s.menu} testID={`invoice-menu-${i.id}`}>
      <Pressable style={s.menuItem} onPress={() => { setMenu(false); onPress(); }} testID={`invoice-menu-details-${i.id}`}><Text style={s.menuText}>Open details</Text></Pressable>
      <Pressable style={s.menuItem} onPress={copy} testID={`invoice-menu-copy-${i.id}`}><Text style={s.menuText}>Copy invoice number</Text></Pressable>
      {readonlyDraft ? <Text style={[s.menuText, { paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs }]} testID={`invoice-menu-readonly-${i.id}`}>
        {historicalHold
          ? "Historical held invoice; not collectible or editable."
          : "Draft invoices are read-only here."}
      </Text> : null}
      {canEdit ? <Pressable style={s.menuItem} onPress={() => { setMenu(false); onEdit?.(i); }} testID={`invoice-menu-edit-${i.id}`}><Text style={s.menuText}>Edit invoice</Text></Pressable> : null}
      {pay.visible ? <Pressable style={[s.menuItem, !pay.enabled && { opacity: 0.4 }]} disabled={!pay.enabled} onPress={() => { setMenu(false); onRecordPayment?.(i); }}
        accessibilityState={{ disabled: !pay.enabled }} testID={`invoice-menu-payment-${i.id}`}><Text style={s.menuText}>Record payment</Text></Pressable> : null}
    </View>
  ) : null;

  if (wide) {
    return (
      <View style={[s.row, selected && s.selected]}>
        <View style={s.wideLine}>
          <Pressable onPress={onPress} style={s.wideMain} accessibilityRole="button" accessibilityState={{ selected }}
            accessibilityLabel={`Invoice ${i.invoiceNumber ?? ""}`} testID={`invoice-${i.id}`}>
            <View style={{ flex: COL.num, flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0 }}>
              <Text style={s.num} numberOfLines={1}>{num}</Text>{flags}
            </View>
            <View style={{ flex: COL.who, minWidth: 0 }}>
              <Text style={s.practice} numberOfLines={1}>{practice || "—"}</Text>
              <Text style={s.sub} numberOfLines={1}>{patient}</Text>
            </View>
            <Text style={[s.cell, { flex: COL.rest }]} numberOfLines={2}>{registerRestoration(i)}</Text>
            <View style={{ flex: COL.due }}>{due}</View>
            <View style={{ flex: COL.status, alignItems: "flex-start" }}><StatusBadge label={historicalHold ? "Historical hold (not collectible)" : titleCase(i.status ?? "—")} variant={historicalHold ? "draft" : invoiceBadgeVariant(i.status)} size="sm" /></View>
            <Text style={[s.money, { flex: COL.total }]} numberOfLines={1}>{formatMoney(i.total)}</Text>
            <Text style={[s.money, { flex: COL.bal }]} numberOfLines={1}>{formatMoney(i.balanceDue ?? i.total)}</Text>
          </Pressable>
          <View style={{ width: 128, alignItems: "flex-end" }}>{actions}</View>
        </View>
        {menuView}
      </View>
    );
  }
  return (
    <View style={[s.row, selected && s.selected]}>
      <Pressable onPress={onPress} style={s.card} accessibilityRole="button" accessibilityState={{ selected }}
        accessibilityLabel={`Invoice ${i.invoiceNumber ?? ""}`} testID={`invoice-${i.id}`}>
        <View style={s.cardTop}>
          <View style={s.numRow}><Text style={s.num} numberOfLines={1}>{num}</Text>{flags}</View>
        <StatusBadge label={historicalHold ? "Historical hold (not collectible)" : titleCase(i.status ?? "—")} variant={historicalHold ? "draft" : invoiceBadgeVariant(i.status)} size="sm" />
        </View>
        <Text style={s.practice} numberOfLines={1}>{practice || "—"}</Text>
        <Text style={s.sub} numberOfLines={1}>{patient}</Text>
        <Text style={s.sub} numberOfLines={1}>{registerRestoration(i)}</Text>
        <View style={s.cardBottom}>
          <Text style={s.sub}>Due </Text>{due}
          <View style={{ flex: 1 }} />
          <Text style={s.sub}>Total {formatMoney(i.total)}  </Text>
          <Text style={s.money}>Bal {formatMoney(i.balanceDue ?? i.total)}</Text>
        </View>
      </Pressable>
      <View style={s.cardActions}>{actions}</View>
      {menuView}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    headRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingVertical: Spacing.xs + 2, paddingHorizontal: Spacing.lg, backgroundColor: c.tintLight, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    headCell: { ...Typography.caption, fontSize: 10, letterSpacing: 0.5, color: c.tint, minWidth: 0 },
    row: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, backgroundColor: c.background },
    selected: { backgroundColor: c.tintLight },
    wideLine: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingHorizontal: Spacing.lg, minHeight: 56 },
    wideMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingVertical: Spacing.sm, minWidth: 0 },
    card: { gap: 2, paddingTop: Spacing.sm + 2, paddingHorizontal: Spacing.lg, paddingBottom: 2 },
    cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm },
    numRow: { flexDirection: "row", alignItems: "center", gap: 4, flex: 1, minWidth: 0 },
    cardBottom: { flexDirection: "row", alignItems: "center", marginTop: 2 },
    cardActions: { alignItems: "flex-end", paddingHorizontal: Spacing.md, paddingBottom: Spacing.xs },
    num: { ...Typography.captionSemibold, color: c.tint },
    practice: { ...Typography.bodySemibold, color: c.text },
    sub: { ...Typography.caption, color: c.textSecondary },
    cell: { ...Typography.caption, color: c.text },
    overdue: { color: c.error, fontWeight: "600" },
    money: { ...Typography.bodySemibold, color: c.text, fontVariant: ["tabular-nums"], textAlign: "right" },
    flag: { fontSize: 10, paddingHorizontal: 6, paddingVertical: 2, borderRadius: Radius.full, overflow: "hidden" },
    actions: { flexDirection: "row", gap: 2 },
    iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: Radius.md },
    menu: { alignSelf: "flex-end", marginRight: Spacing.lg, marginBottom: Spacing.sm, borderRadius: Radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, minWidth: 190 },
    menuItem: { minHeight: 44, justifyContent: "center", paddingHorizontal: Spacing.md },
    menuText: { ...Typography.caption, color: c.text },
  });
}
