import React, { useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  useCases,
  useInvoices,
  type CanonicalCase,
  type CanonicalInvoice,
} from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { useMe, primaryLabOrgId, primaryProviderOrgId } from "@/lib/auth-me";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function patientName(c: CanonicalCase): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function isClosedCase(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return (
    s.includes("complete") ||
    s.includes("delivered") ||
    s.includes("done") ||
    s.includes("cancel") ||
    s.includes("void")
  );
}

function caseStatusVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("remake")) return "remake";
  if (s.includes("complete") || s.includes("delivered") || s.includes("done")) return "complete";
  if (s.includes("ship") || s.includes("ready") || s.includes("delivery")) return "ship";
  if (s.includes("hold") || s.includes("cancel") || s.includes("void")) return "draft";
  if (s.includes("intake") || s.includes("new") || s.includes("received") || s.includes("pending")) return "intake";
  return "progress";
}

function isOpenInvoice(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return !(s.includes("paid") || s.includes("void") || s.includes("cancel"));
}

function toNumber(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(v: number): string {
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = d.getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const meQuery = useMe();
  const me = meQuery.data;
  const labOrgId = primaryLabOrgId(me);
  const providerOrgId = primaryProviderOrgId(me);
  const invoiceParams = labOrgId
    ? { labOrganizationId: labOrgId }
    : providerOrgId
    ? { practiceId: providerOrgId }
    : undefined;

  const casesQuery = useCases();
  const invoicesQuery = useInvoices(invoiceParams);
  const cases = casesQuery.data ?? [];
  const invoices = invoicesQuery.data ?? [];

  const openCases = useMemo(() => cases.filter((c) => !isClosedCase(c.status)), [cases]);
  const dueSoon = useMemo(() => {
    return cases
      .filter((c) => {
        if (isClosedCase(c.status)) return false;
        const d = daysUntil(c.dueDate);
        return d != null && d <= 7;
      })
      .sort((a, b) => {
        const da = daysUntil(a.dueDate) ?? 9999;
        const dbv = daysUntil(b.dueDate) ?? 9999;
        return da - dbv;
      });
  }, [cases]);

  const openInvoices = useMemo(() => invoices.filter((i) => isOpenInvoice(i.status)), [invoices]);
  const outstanding = useMemo(
    () => openInvoices.reduce((sum, i) => sum + toNumber(i.balanceDue ?? i.total), 0),
    [openInvoices],
  );

  const loading = casesQuery.isLoading || invoicesQuery.isLoading;
  const refreshing = casesQuery.isFetching || invoicesQuery.isFetching;

  function refetchAll() {
    casesQuery.refetch();
    invoicesQuery.refetch();
  }

  const metrics: { label: string; value: string; icon: IconName; color: string }[] = [
    { label: "Open cases", value: String(openCases.length), icon: "file-tray-full-outline", color: colors.tint },
    { label: "Due soon", value: String(dueSoon.length), icon: "alarm-outline", color: colors.warningStrong },
    { label: "Open invoices", value: String(openInvoices.length), icon: "document-text-outline", color: colors.violet },
    { label: "Outstanding", value: formatMoney(outstanding), icon: "cash-outline", color: colors.success },
  ];

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Dashboard</Text>
        <Text style={styles.subtitle}>Your lab at a glance</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} tintColor={colors.tint} />}
        >
          <View style={styles.metricGrid}>
            {metrics.map((m) => (
              <Card key={m.label} style={styles.metricCard}>
                <View style={[styles.metricIcon, { backgroundColor: m.color + "1A" }]}>
                  <Ionicons name={m.icon} size={18} color={m.color} />
                </View>
                <Text style={styles.metricValue} numberOfLines={1}>
                  {m.value}
                </Text>
                <Text style={styles.metricLabel}>{m.label}</Text>
              </Card>
            ))}
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Due soon</Text>
            <Pressable onPress={() => router.push("/(tabs)" as never)} hitSlop={8}>
              <Text style={styles.sectionLink}>All cases</Text>
            </Pressable>
          </View>

          {dueSoon.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Ionicons name="checkmark-circle-outline" size={28} color={colors.success} />
              <Text style={styles.emptyText}>Nothing due in the next 7 days.</Text>
            </Card>
          ) : (
            <View style={styles.list}>
              {dueSoon.slice(0, 6).map((c) => {
                const d = daysUntil(c.dueDate);
                const overdue = d != null && d < 0;
                return (
                  <Card key={c.id} style={styles.row} onPress={() => router.push(`/case/${c.id}` as never)}>
                    <View style={styles.rowMain}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {patientName(c)}
                      </Text>
                      <Text style={styles.rowMeta} numberOfLines={1}>
                        {c.caseNumber ? `#${c.caseNumber}` : "No case #"}
                        {c.doctorName ? `  ·  ${c.doctorName}` : ""}
                      </Text>
                      <Text style={[styles.rowDue, overdue && { color: colors.error }]}>
                        Due {formatDate(c.dueDate)}
                        {d != null ? `  ·  ${overdue ? `${Math.abs(d)}d overdue` : d === 0 ? "today" : `in ${d}d`}` : ""}
                      </Text>
                    </View>
                    <StatusBadge label={titleCase(c.status ?? "—")} variant={caseStatusVariant(c.status)} size="sm" />
                  </Card>
                );
              })}
            </View>
          )}

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent invoices</Text>
            <Pressable onPress={() => router.push("/finance/invoices" as never)} hitSlop={8}>
              <Text style={styles.sectionLink}>View all</Text>
            </Pressable>
          </View>

          {openInvoices.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Ionicons name="receipt-outline" size={28} color={colors.textTertiary} />
              <Text style={styles.emptyText}>No open invoices.</Text>
            </Card>
          ) : (
            <View style={styles.list}>
              {openInvoices.slice(0, 4).map((i) => (
                <Card key={i.id} style={styles.row} onPress={() => router.push(`/invoice-editor/${i.id}` as never)}>
                  <View style={styles.rowMain}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {i.invoiceNumber || "Invoice"}
                    </Text>
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      Due {formatDate(i.dueAt)}
                    </Text>
                  </View>
                  <View style={styles.rowRight}>
                    <Text style={styles.rowAmount}>{formatMoney(toNumber(i.balanceDue ?? i.total))}</Text>
                    <StatusBadge label={titleCase(i.status ?? "—")} variant={invoiceVariant(i.status)} size="sm" />
                  </View>
                </Card>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function invoiceVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("paid")) return "paid";
  if (s.includes("overdue") || s.includes("past")) return "overdue";
  if (s.includes("void") || s.includes("cancel")) return "void";
  if (s.includes("draft")) return "draft";
  return "unpaid";
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
    },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl, minHeight: 280 },
    content: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.md },
    metricGrid: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    metricCard: { width: "47.8%", flexGrow: 1, gap: Spacing.xs },
    metricIcon: {
      width: 32,
      height: 32,
      borderRadius: Radius.sm,
      alignItems: "center",
      justifyContent: "center",
    },
    metricValue: { ...Typography.h1, color: c.text, marginTop: Spacing.xs },
    metricLabel: { ...Typography.caption, color: c.textSecondary },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: Spacing.sm,
    },
    sectionTitle: { ...Typography.h2, color: c.text },
    sectionLink: { ...Typography.captionSemibold, color: c.tint },
    list: { gap: Spacing.sm },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    rowMain: { flex: 1, gap: 2 },
    rowName: { ...Typography.bodySemibold, color: c.text },
    rowMeta: { ...Typography.caption, color: c.textSecondary },
    rowDue: { ...Typography.caption, color: c.textTertiary, marginTop: 2 },
    rowRight: { alignItems: "flex-end", gap: Spacing.xs },
    rowAmount: { ...Typography.bodySemibold, color: c.text },
    emptyCard: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    emptyText: { ...Typography.body, color: c.textSecondary, flex: 1 },
  });
}
