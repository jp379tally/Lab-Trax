import React, { useMemo } from "react";
import { View, Text, StyleSheet, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { formatMoney } from "@/lib/format";

export type RegisterSummary = {
  openBalance?: number | null;
  openCount?: number | null;
  overdueBalance?: number | null;
  overdueCount?: number | null;
  paidThisMonth?: number | null;
  paidCount?: number | null;
  totalInvoices?: number | null;
} | null | undefined;

function money(v: number | null | undefined, loading: boolean) {
  return loading || v == null ? "—" : formatMoney(v);
}
function count(v: number | null | undefined, loading: boolean) {
  if (loading || v == null) return "—";
  return `${v} invoice${v === 1 ? "" : "s"}`;
}

/** Web-only. Values come from the server summary, never from loaded rows. */
export function InvoiceSummaryCards({ summary, loading }: { summary: RegisterSummary; loading: boolean }) {
  const { colors, isDark } = useTheme() as ReturnType<typeof useTheme> & { isDark?: boolean };
  const { width } = useWindowDimensions();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const basis = width >= 1100 ? "23%" : "45%";
  // Tinted surfaces: pale in light theme, deep translucent in dark theme.
  const tint = (hex: string, light: string) => (isDark ? hex + "26" : light);
  const cards = [
    { key: "open", label: "OPEN BALANCE", value: summary?.openBalance, n: summary?.openCount, accent: "#2563EB", bg: tint("#2563EB", "#EFF6FF"), icon: "document-text" as const, red: false },
    { key: "overdue", label: "OVERDUE", value: summary?.overdueBalance, n: summary?.overdueCount, accent: "#DC2626", bg: tint("#DC2626", "#FEF2F2"), icon: "alarm" as const, red: true },
    { key: "paid", label: "PAID THIS MONTH", value: summary?.paidThisMonth, n: summary?.paidCount, accent: "#16A34A", bg: tint("#16A34A", "#F0FDF4"), icon: "checkmark-circle" as const, red: false },
  ];
  const total = loading || summary?.totalInvoices == null ? "—" : summary.totalInvoices.toLocaleString("en-US");
  const Card = ({ id, label, accent, bg, icon, value, sub, red }: { id: string; label: string; accent: string; bg: string; icon: keyof typeof Ionicons.glyphMap; value: string; sub: string; red?: boolean }) => (
    <View style={[s.card, { backgroundColor: bg, borderColor: accent + "40", flexBasis: basis }]} testID={id}>
      <View style={[s.iconBlock, { backgroundColor: accent }]}><Ionicons name={icon} size={18} color="#fff" /></View>
      <View style={s.body}>
        <Text style={[s.label, { color: accent }]} numberOfLines={1}>{label}</Text>
        <Text style={[s.value, { color: red ? colors.error : colors.text }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
        <Text style={s.sub} numberOfLines={1}>{sub}</Text>
      </View>
      <View style={[s.bar, { backgroundColor: accent }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden />
    </View>
  );
  return (
    <View style={s.wrap} testID="invoice-summary-cards">
      {cards.map((c) => <Card key={c.key} id={`invoice-summary-${c.key}`} label={c.label} accent={c.accent} bg={c.bg} icon={c.icon} red={c.red}
        value={money(c.value, loading)} sub={count(c.n, loading)} />)}
      <Card id="invoice-summary-total" label="TOTAL INVOICES" accent="#7C3AED" bg={tint("#7C3AED", "#F5F3FF")} icon="documents" value={total} sub="All time" />
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    wrap: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
    card: { flexGrow: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: Spacing.sm, padding: Spacing.sm + 2, borderRadius: Radius.lg, borderWidth: 1, overflow: "hidden" },
    iconBlock: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center" },
    body: { flex: 1, minWidth: 0, gap: 1 },
    label: { ...Typography.caption, fontSize: 10, letterSpacing: 0.5 },
    value: { ...Typography.bodySemibold, fontSize: 16 },
    sub: { ...Typography.caption, fontSize: 11, color: c.textSecondary },
    bar: { position: "absolute", right: 0, top: 0, bottom: 0, width: 4, opacity: 0.7 },
  });
}
