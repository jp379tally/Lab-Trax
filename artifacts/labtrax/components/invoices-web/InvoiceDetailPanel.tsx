import React, { useEffect, useMemo, useRef } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCase, useInvoice, type CanonicalInvoice } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { useMe, canEditOrg } from "@/lib/auth-me";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { titleCase, formatMoney, formatDate } from "@/lib/format";
import { customerNameOf, formatInvoiceIssueDate } from "@/lib/invoice-filters";
import { doctorOf, isHistoricalInvoiceHeld, metaOf, paymentActionState, patientOf, restorationOf, toothOf, type LinkedCaseLike } from "@/lib/invoice-web-fields";

function sumPayments(inv: CanonicalInvoice): number {
  return (inv.payments ?? []).reduce((t, p) => {
    const n = Number(p.amount);
    return Number.isFinite(n) ? t + n : t;
  }, 0);
}

export type InvoiceDetailViewProps = {
  invoice: CanonicalInvoice | null;
  linkedCase?: LinkedCaseLike;
  loading: boolean;
  error: boolean;
  canWrite: boolean;
  onRetry: () => void;
  onClose: () => void;
  onEdit: (invoice: CanonicalInvoice) => void;
  onRecordPayment: (invoice: CanonicalInvoice) => void;
};

/** Presentational, read-only detail. Write actions render only when canWrite. */
export function InvoiceDetailView(p: InvoiceDetailViewProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const closeRef = useRef<{ focus?: () => void } | null>(null);
  const inv = p.invoice;

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus?.();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const onCloseRef = useRef(p.onClose);
  onCloseRef.current = p.onClose;
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  let body: React.ReactNode;
  if (p.loading && !inv) {
    body = <View style={s.center} testID="invoice-detail-loading" accessibilityLiveRegion="polite"><ActivityIndicator color={colors.tint} /></View>;
  } else if (p.error && !inv) {
    body = <View style={s.center} testID="invoice-detail-error" accessibilityRole="alert">
      <Text style={s.muted}>Couldn't load this invoice.</Text>
      <Pressable onPress={p.onRetry} style={s.btn} accessibilityRole="button" testID="invoice-detail-retry"><Text style={s.btnText}>Retry</Text></Pressable>
    </View>;
  } else if (!inv) {
    body = <View style={s.center} testID="invoice-detail-missing"><Text style={s.muted}>This invoice is no longer available.</Text></View>;
  } else {
    const c = p.linkedCase;
    const meta = metaOf(inv);
    const dash = (v: string) => v || "—";
    const rows: Array<[string, string]> = [
      ["Practice", dash(customerNameOf(inv))],
      ["Patient", dash(patientOf(inv, c))],
      ["Restoration", dash(restorationOf(inv, c))],
      ["Tooth #", dash(toothOf(inv, c))],
      ["Doctor", dash(doctorOf(inv, c))],
      ["Issued", formatInvoiceIssueDate(inv.issuedAt ?? inv.createdAt)],
      ["Due", formatDate(inv.dueAt)],
      ["Total", formatMoney(inv.total)],
      ["Payments", formatMoney(sumPayments(inv))],
    ];
    const writable = p.canWrite && !p.error;
    const historicalHold = isHistoricalInvoiceHeld(inv);
    const webDraft = historicalHold || (Platform.OS === "web" && inv.status === "draft");
    const frozen = Boolean(inv.frozen);
    const pay = paymentActionState(inv, writable && !webDraft);
    const notes = inv.notes || (typeof meta.caseNotes === "string" ? meta.caseNotes : "");
    body = <>
      <ScrollView contentContainerStyle={s.scroll} testID="invoice-detail-body">
        {p.error ? <Text style={s.warn} testID="invoice-detail-stale">Showing last loaded details; refresh failed.</Text> : null}
        <Text style={s.status}>{titleCase(inv.status ?? "—")}{frozen ? " · Frozen" : ""}</Text>
        {webDraft ? <Text style={s.warn}>
          {historicalHold
            ? "Historical reconstructed invoice remains held and is not collectible."
            : "Draft invoices are read-only here; use their original creation or review workflow."}
        </Text> : null}
        {rows.map(([k, v]) => <View key={k} style={s.kv}><Text style={s.k}>{k}</Text><Text style={s.v} numberOfLines={2}>{v}</Text></View>)}
        <View style={[s.kv, s.balanceRow]}><Text style={s.bk}>Balance Due</Text><Text style={s.bv} testID="invoice-detail-balance">{formatMoney(inv.balanceDue ?? inv.total)}</Text></View>
        <View style={s.kv}><Text style={s.k}>Notes</Text><Text style={s.v}>{notes || "—"}</Text></View>
      </ScrollView>
      {writable ? <View style={s.actions}>
        {!frozen && !webDraft ? <Pressable onPress={() => p.onEdit(inv)} style={s.btn} accessibilityRole="button" testID="invoice-detail-edit">
          <Text style={s.btnText}>Edit Invoice</Text>
        </Pressable> : null}
        {pay.visible ? <Pressable onPress={() => p.onRecordPayment(inv)} disabled={!pay.enabled} accessibilityRole="button"
          accessibilityState={{ disabled: !pay.enabled }} style={[s.btn, s.primary, !pay.enabled && s.disabled]} testID="invoice-detail-payment">
          <Text style={[s.btnText, { color: colors.background }]}>Record Payment</Text>
        </Pressable> : null}
      </View> : null}
    </>;
  }

  return (
    <View style={s.panel} testID="invoice-detail-panel" accessibilityLabel="Invoice detail">
      <View style={s.head}>
        <Text style={s.title} numberOfLines={1} accessibilityRole="header">{inv?.invoiceNumber ? `Invoice ${inv.invoiceNumber}` : "Invoice"}</Text>
        <Pressable ref={closeRef as never} onPress={p.onClose} hitSlop={10} style={s.close} accessibilityRole="button" accessibilityLabel="Close invoice detail" testID="invoice-detail-close">
          <Ionicons name="close" size={22} color={colors.text} />
        </Pressable>
      </View>
      {body}
    </View>
  );
}

/** Fetches authoritative invoice + linked case; refetches when the register regains focus (after edit/payment). */
export function InvoiceDetailPanel({ invoiceId, refreshToken = 0, onClose, onEdit, onRecordPayment, onFresh }: {
  invoiceId: string;
  /** Bumped by the register on manual/pull refresh. */
  refreshToken?: number;
  onClose: () => void;
  onEdit: (invoice: CanonicalInvoice) => void;
  onRecordPayment: (invoice: CanonicalInvoice) => void;
  onFresh?: () => void;
}) {
  const me = useMe().data;
  const q = useInvoice(invoiceId);
  const inv = q.data ?? null;
  const caseQuery = useCase(inv?.caseId ?? null);
  const refetchRef = useRef(q.refetch);
  refetchRef.current = q.refetch;
  const freshRef = useRef(onFresh);
  freshRef.current = onFresh;
  const first = useRef(true);
  useFocusEffect(React.useCallback(() => {
    if (first.current) { first.current = false; return; }
    void refetchRef.current();
    freshRef.current?.();
  }, []));
  const lastToken = useRef(refreshToken);
  useEffect(() => {
    if (lastToken.current === refreshToken) return;
    lastToken.current = refreshToken;
    void refetchRef.current();
  }, [refreshToken]);
  // Never offer writes against stale data: a failed refresh (including 404) disables them.
  const canWrite = !q.isError && Boolean(inv) && canEditOrg(me, (inv as { labOrganizationId?: string | null } | null)?.labOrganizationId);
  return <InvoiceDetailView
    invoice={inv}
    linkedCase={(caseQuery.data ?? null) as LinkedCaseLike}
    loading={q.isLoading}
    error={q.isError}
    canWrite={canWrite}
    onRetry={() => void q.refetch()}
    onClose={onClose}
    onEdit={onEdit}
    onRecordPayment={onRecordPayment}
  />;
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    panel: { flex: 1, backgroundColor: c.background },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: Spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    title: { ...Typography.bodySemibold, color: c.text, flex: 1 },
    close: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
    scroll: { padding: Spacing.lg, gap: Spacing.sm },
    status: { ...Typography.captionSemibold, color: c.tint },
    warn: { ...Typography.caption, color: c.warning },
    kv: { flexDirection: "row", justifyContent: "space-between", gap: Spacing.md, paddingVertical: 4 },
    k: { ...Typography.caption, color: c.textSecondary },
    v: { ...Typography.caption, color: c.text, flexShrink: 1, textAlign: "right" },
    balanceRow: { backgroundColor: c.tintLight, borderRadius: Radius.md, paddingHorizontal: Spacing.sm, paddingVertical: Spacing.sm },
    bk: { ...Typography.bodySemibold, color: c.text },
    bv: { ...Typography.bodySemibold, color: c.text },
    actions: { flexDirection: "row", gap: Spacing.sm, padding: Spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    btn: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: Radius.md, borderWidth: 1, borderColor: c.tint },
    primary: { backgroundColor: c.tint },
    btnText: { ...Typography.captionSemibold, color: c.tint },
    disabled: { opacity: 0.4 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: Spacing.md, padding: Spacing.lg },
    muted: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
  });
}
