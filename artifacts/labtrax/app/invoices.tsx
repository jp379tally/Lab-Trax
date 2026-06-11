import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { EmptyState } from "@/components/ui/EmptyState";
import { AppHeader } from "@/components/ui/AppHeader";
import { FilterBar } from "@/components/ui/FilterBar";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useListInvoices } from "@workspace/api-client-react";

type InvoiceStatus = "all" | "open" | "paid" | "overdue" | "draft" | "void";

interface ApiInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  total?: string | number | null;
  balanceDue?: string | number | null;
  issuedAt?: string | null;
  dueAt?: string | null;
  caseId?: string | null;
  providerOrganization?: { name?: string | null; displayName?: string | null } | null;
  providerOrganizationId?: string | null;
}

function fmtMoney(v?: string | number | null) {
  const n = Number(v) || 0;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function invoiceVariant(status: string): "paid" | "overdue" | "open" | "draft" | "void" | "custom" {
  if (status === "paid") return "paid";
  if (status === "open" || status === "partially_paid") return "open";
  if (status === "overdue") return "overdue";
  if (status === "draft") return "draft";
  if (status === "void") return "void";
  return "custom";
}

function isOverdue(inv: ApiInvoice): boolean {
  if (inv.status !== "open" && inv.status !== "partially_paid") return false;
  if (!inv.dueAt) return false;
  return new Date(inv.dueAt).getTime() < Date.now();
}

function AIInsightBanner({ invoices }: { invoices: ApiInvoice[] }) {
  const { colors } = useTheme();
  const [insight, setInsight] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!invoices.length) return;
    const overdue = invoices.filter((i) => isOverdue(i));
    const overdueTotal = overdue.reduce((s, i) => s + (Number(i.balanceDue) || 0), 0);
    if (overdue.length === 0) return;

    const practiceGroups: Record<string, number> = {};
    for (const inv of overdue) {
      const name = inv.providerOrganization?.displayName ?? inv.providerOrganization?.name ?? "Unknown";
      practiceGroups[name] = (practiceGroups[name] || 0) + (Number(inv.balanceDue) || 0);
    }
    const top = Object.entries(practiceGroups).sort((a, b) => b[1] - a[1])[0];
    const msg = top
      ? `${overdue.length} overdue invoice${overdue.length !== 1 ? "s" : ""} totaling ${overdueTotal.toLocaleString("en-US", { style: "currency", currency: "USD" })}. Largest balance: ${top[0]} (${top[1].toLocaleString("en-US", { style: "currency", currency: "USD" })}).`
      : `${overdue.length} overdue invoice${overdue.length !== 1 ? "s" : ""} totaling ${overdueTotal.toLocaleString("en-US", { style: "currency", currency: "USD" })}.`;
    setInsight(msg);
  }, [invoices]);

  if (dismissed || !insight) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", backgroundColor: "#EF444415", borderWidth: 1, borderColor: "#EF444430", borderRadius: 10, marginHorizontal: 16, marginVertical: 8, padding: 12, gap: 8 }}>
      <Ionicons name="warning-outline" size={16} color="#EF4444" style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#EF4444", marginBottom: 2 }}>AI Financial Insight</Text>
        <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "#374151", lineHeight: 18 }}>{insight}</Text>
      </View>
      <Pressable onPress={() => setDismissed(true)} hitSlop={8}><Ionicons name="close" size={16} color="#9CA3AF" /></Pressable>
    </View>
  );
}

function ErrorRetryBanner({ onRetry }: { onRetry: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#F59E0B15", borderWidth: 1, borderColor: "#F59E0B40", borderRadius: 10, marginHorizontal: 16, marginVertical: 8, padding: 12, gap: 10 }}>
      <Ionicons name="cloud-offline-outline" size={18} color="#B45309" />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#B45309" }}>Can't reach the server</Text>
        <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textSecondary, marginTop: 2 }}>Showing your last saved invoices. Check your connection and retry.</Text>
      </View>
      <Pressable onPress={onRetry} hitSlop={8} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: "#B45309" }}>
        <Ionicons name="refresh" size={13} color="#FFFFFF" />
        <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#FFFFFF" }}>Retry</Text>
      </Pressable>
    </View>
  );
}

export default function InvoicesScreen() {
  const { colors, isDark } = useTheme();
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<InvoiceStatus>("all");

  const {
    data: invoiceResult,
    isLoading: loading,
    isFetching,
    isError,
    refetch,
  } = useListInvoices();
  const invoices = useMemo<ApiInvoice[]>(
    () => (invoiceResult?.data ?? []) as unknown as ApiInvoice[],
    [invoiceResult],
  );
  const refreshing = isFetching && !loading;

  const enriched = useMemo(() =>
    invoices.map((inv) => ({
      ...inv,
      effectiveStatus: isOverdue(inv) ? "overdue" : inv.status,
    })),
    [invoices]
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: enriched.length };
    enriched.forEach((inv) => {
      c[inv.effectiveStatus] = (c[inv.effectiveStatus] || 0) + 1;
    });
    return c;
  }, [enriched]);

  const filtered = useMemo(() => {
    let rows = enriched;
    if (filterStatus !== "all") {
      rows = rows.filter((inv) => inv.effectiveStatus === filterStatus);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((inv) =>
        (inv.invoiceNumber || "").toLowerCase().includes(q) ||
        (inv.providerOrganization?.name || "").toLowerCase().includes(q) ||
        (inv.providerOrganization?.displayName || "").toLowerCase().includes(q)
      );
    }
    return rows.sort((a, b) => (b.issuedAt || "").localeCompare(a.issuedAt || ""));
  }, [enriched, filterStatus, search]);

  const FILTERS: { id: InvoiceStatus; label: string }[] = [
    { id: "all",     label: "All"     },
    { id: "open",    label: "Open"    },
    { id: "overdue", label: "Overdue" },
    { id: "paid",    label: "Paid"    },
    { id: "draft",   label: "Draft"   },
    { id: "void",    label: "Void"    },
  ];

  function navigateToInvoice(inv: ApiInvoice) {
    router.push(`/invoice/${inv.id}` as any);
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSolid }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <AppHeader title="Invoices" showSearch={false} />

      <FilterBar
        filters={FILTERS.map((f) => ({ ...f, count: counts[f.id] || 0 }))}
        activeId={filterStatus}
        onSelect={setFilterStatus}
      />

      <View style={[styles.searchRow, { borderBottomColor: colors.border }]}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search invoices…"
          placeholderTextColor={colors.textTertiary}
          value={search}
          onChangeText={setSearch}
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")} hitSlop={8}>
            <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
          </Pressable>
        )}
      </View>

      {isError && <ErrorRetryBanner onRetry={() => { void refetch(); }} />}

      {!loading && <AIInsightBanner invoices={enriched} />}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { void refetch(); }}
              tintColor={colors.tint}
            />
          }
          contentContainerStyle={{ paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <EmptyState
              icon="receipt-outline"
              title="No invoices found"
              description="Invoices you create or receive will appear here."
            />
          }
          renderItem={({ item: inv }) => {
            const balance = Number(inv.balanceDue ?? 0);
            const isOpen = inv.effectiveStatus === "open" || inv.effectiveStatus === "overdue";
            const practiceName = inv.providerOrganization?.displayName ?? inv.providerOrganization?.name ?? "—";
            return (
              <Pressable
                style={({ pressed }) => [
                  styles.row,
                  { borderBottomColor: colors.border, backgroundColor: pressed ? (isDark ? colors.surfaceSecondary : colors.canvas) : colors.surface },
                ]}
                onPress={() => navigateToInvoice(inv)}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.invNum, { color: colors.text }]}>{inv.invoiceNumber}</Text>
                  <Text style={[styles.practice, { color: colors.textSecondary }]} numberOfLines={1}>{practiceName}</Text>
                  <Text style={[styles.dates, { color: colors.textTertiary }]}>
                    Issued {fmtDate(inv.issuedAt)}
                    {inv.dueAt ? `  ·  Due ${fmtDate(inv.dueAt)}` : ""}
                  </Text>
                </View>
                <View style={styles.right}>
                  <StatusBadge
                    label={inv.effectiveStatus.replace(/_/g, " ")}
                    variant={invoiceVariant(inv.effectiveStatus)}
                    size="sm"
                  />
                  <Text style={[styles.amount, { color: colors.text }]}>{fmtMoney(inv.total)}</Text>
                  {isOpen && balance > 0 && (
                    <Text style={[styles.balance, { color: colors.warningStrong }]}>bal {fmtMoney(balance)}</Text>
                  )}
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} style={{ marginLeft: 8 }} />
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 12 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    height: 36,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  invNum: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  practice: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  dates: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 3 },
  right: { alignItems: "flex-end", gap: 4 },
  amount: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  balance: { fontSize: 12, fontFamily: "Inter_500Medium" },
});
