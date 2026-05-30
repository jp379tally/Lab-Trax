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
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getAccessToken, getApiUrl, resilientFetch } from "@/lib/query-client";

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
  providerOrganization?: { name?: string | null } | null;
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

export default function InvoicesScreen() {
  const { colors, isDark } = useTheme();
  const [invoices, setInvoices] = useState<ApiInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<InvoiceStatus>("all");

  async function load() {
    try {
      const res = await resilientFetch("/api/invoices");
      const body = await res.json().catch(() => ({}));
      const rows: ApiInvoice[] = Array.isArray(body)
        ? body
        : Array.isArray(body?.data)
        ? body.data
        : [];
      setInvoices(rows);
    } catch {
      // swallow
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void load(); }, []);

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
        (inv.providerOrganization?.name || "").toLowerCase().includes(q)
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
              onRefresh={() => { setRefreshing(true); void load(); }}
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
            const practiceName = inv.providerOrganization?.name || "—";
            return (
              <Pressable
                style={({ pressed }) => [
                  styles.row,
                  { borderBottomColor: colors.border, backgroundColor: pressed ? (isDark ? colors.surfaceSecondary : colors.canvas) : colors.surface },
                ]}
                onPress={() => {
                  if (inv.caseId) {
                    router.push(`/case/${inv.caseId}` as any);
                  }
                }}
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
  empty: { fontSize: 15, fontFamily: "Inter_400Regular", textAlign: "center" },
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
