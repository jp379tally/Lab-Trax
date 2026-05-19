import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router as expoRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { getAccessToken, getApiUrl } from "@/lib/query-client";
import { useApp } from "@/lib/app-context";

interface ProviderOrg {
  id: string;
  name: string;
  displayName?: string | null;
  phone?: string | null;
  billingEmail?: string | null;
  city?: string | null;
  state?: string | null;
  deletedAt?: string | null;
}

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  providerOrganizationId: string;
  status: string;
  total?: string | number | null;
  balanceDue?: string | number | null;
  issuedAt?: string | null;
  dueAt?: string | null;
}

function fmtMoney(v?: string | number | null) {
  const n = Number(v) || 0;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function apiFetch<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`/api${path}`, getApiUrl()).toString();
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export default function CustomersScreen() {
  const insets = useSafeAreaInsets();
  const { invoices: appInvoices, setPendingInvoiceEditId } = useApp();
  const [orgs, setOrgs] = useState<ProviderOrg[]>([]);
  const [apiInvoices, setApiInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [orgsData, invData] = await Promise.all([
          apiFetch<(ProviderOrg & { type?: string })[]>("/organizations"),
          apiFetch<InvoiceRow[]>("/invoices"),
        ]);
        if (!cancelled) {
          setOrgs(
            orgsData.filter(
              (o) =>
                o.deletedAt == null &&
                (o.type === "provider" || o.type === "practice")
            )
          );
          setApiInvoices(invData);
        }
      } catch {
        // swallow
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function openInvoice(apiInvoiceId: string) {
    const local = appInvoices.find((i) => i.serverId === apiInvoiceId || i.id === apiInvoiceId);
    if (local) {
      setPendingInvoiceEditId(local.id);
      expoRouter.push("/(tabs)" as any);
    }
  }

  const openBalanceByOrg = useMemo(() => {
    const map = new Map<string, number>();
    for (const inv of apiInvoices) {
      const isOpen = inv.status === "open" || inv.status === "partially_paid";
      if (!isOpen) continue;
      const bal = Number(inv.balanceDue ?? inv.total ?? 0);
      map.set(inv.providerOrganizationId, (map.get(inv.providerOrganizationId) ?? 0) + bal);
    }
    return map;
  }, [apiInvoices]);

  const invoiceCountByOrg = useMemo(() => {
    const map = new Map<string, number>();
    for (const inv of apiInvoices) {
      map.set(inv.providerOrganizationId, (map.get(inv.providerOrganizationId) ?? 0) + 1);
    }
    return map;
  }, [apiInvoices]);

  const filteredOrgs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orgs
      .filter((o) => {
        if (!q) return true;
        return (
          o.name.toLowerCase().includes(q) ||
          (o.displayName || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) =>
        (a.displayName || a.name).localeCompare(b.displayName || b.name)
      );
  }, [orgs, search]);

  const selectedOrg = orgs.find((o) => o.id === selectedId) ?? null;

  const orgInvoices = useMemo(() => {
    if (!selectedId) return [];
    return apiInvoices
      .filter((inv) => inv.providerOrganizationId === selectedId)
      .sort((a, b) =>
        (b.issuedAt || "").localeCompare(a.issuedAt || "")
      );
  }, [apiInvoices, selectedId]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color={Colors.light.tint} />
      </View>
    );
  }

  if (selectedOrg) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <Pressable
            onPress={() => setSelectedId(null)}
            style={styles.backBtn}
            hitSlop={8}
          >
            <Ionicons name="chevron-back" size={22} color={Colors.light.tint} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {selectedOrg.displayName || selectedOrg.name}
            </Text>
            <Text style={styles.headerSub}>
              {invoiceCountByOrg.get(selectedOrg.id) ?? 0} invoice
              {(invoiceCountByOrg.get(selectedOrg.id) ?? 0) !== 1 ? "s" : ""}
            </Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.balanceLabel}>Open balance</Text>
            <Text
              style={[
                styles.balanceValue,
                (openBalanceByOrg.get(selectedOrg.id) ?? 0) > 0 && { color: "#D97706" },
              ]}
            >
              {fmtMoney(openBalanceByOrg.get(selectedOrg.id) ?? 0)}
            </Text>
          </View>
        </View>

        {/* Practice info strip */}
        <View style={styles.infoStrip}>
          {selectedOrg.phone ? (
            <View style={styles.infoItem}>
              <Ionicons name="call-outline" size={13} color={Colors.light.textSecondary} />
              <Text style={styles.infoText}>{selectedOrg.phone}</Text>
            </View>
          ) : null}
          {selectedOrg.billingEmail ? (
            <View style={styles.infoItem}>
              <Ionicons name="mail-outline" size={13} color={Colors.light.textSecondary} />
              <Text style={styles.infoText} numberOfLines={1}>
                {selectedOrg.billingEmail}
              </Text>
            </View>
          ) : null}
          {(selectedOrg.city || selectedOrg.state) ? (
            <View style={styles.infoItem}>
              <Ionicons name="location-outline" size={13} color={Colors.light.textSecondary} />
              <Text style={styles.infoText}>
                {[selectedOrg.city, selectedOrg.state].filter(Boolean).join(", ")}
              </Text>
            </View>
          ) : null}
        </View>

        <FlatList
          data={orgInvoices}
          keyExtractor={(inv) => inv.id}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No invoices found.</Text>
            </View>
          }
          renderItem={({ item: inv }) => {
            const isOpen = inv.status === "open" || inv.status === "partially_paid";
            const balance = Number(inv.balanceDue ?? inv.total ?? 0);
            return (
              <Pressable
                style={({ pressed }) => [styles.invoiceRow, pressed && { opacity: 0.7 }]}
                onPress={() => openInvoice(inv.id)}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.invNum}>{inv.invoiceNumber}</Text>
                  <Text style={styles.invDate}>Issued {fmtDate(inv.issuedAt)}</Text>
                  {inv.dueAt && (
                    <Text style={styles.invDate}>Due {fmtDate(inv.dueAt)}</Text>
                  )}
                </View>
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <View
                    style={[
                      styles.statusBadge,
                      inv.status === "paid" && { backgroundColor: "#DCFCE7" },
                      (inv.status === "open" || inv.status === "partially_paid") && { backgroundColor: "#FEF9C3" },
                      inv.status === "void" && { backgroundColor: "#F1F5F9" },
                      inv.status === "draft" && { backgroundColor: "#F1F5F9" },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusText,
                        inv.status === "paid" && { color: "#16A34A" },
                        (inv.status === "open" || inv.status === "partially_paid") && { color: "#D97706" },
                        (inv.status === "void" || inv.status === "draft") && { color: "#64748B" },
                      ]}
                    >
                      {inv.status.replace(/_/g, " ")}
                    </Text>
                  </View>
                  <Text style={styles.invTotal}>{fmtMoney(inv.total)}</Text>
                  {isOpen && balance > 0 && (
                    <Text style={[styles.invBalance, { color: "#D97706" }]}>
                      bal {fmtMoney(balance)}
                    </Text>
                  )}
                </View>
                <Ionicons name="chevron-forward" size={16} color={Colors.light.textSecondary} style={{ marginLeft: 8 }} />
              </Pressable>
            );
          }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable
          onPress={() => expoRouter.back()}
          style={styles.backBtn}
          hitSlop={8}
        >
          <Ionicons name="chevron-back" size={22} color={Colors.light.tint} />
        </Pressable>
        <Text style={styles.headerTitle}>Customers</Text>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons
          name="search-outline"
          size={16}
          color={Colors.light.textSecondary}
          style={{ position: "absolute", left: 12, top: "50%", marginTop: -8 }}
        />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search practices…"
          placeholderTextColor={Colors.light.textSecondary}
          style={styles.searchInput}
        />
      </View>

      <FlatList
        data={filteredOrgs}
        keyExtractor={(o) => o.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No practices found.</Text>
          </View>
        }
        renderItem={({ item: org }) => {
          const balance = openBalanceByOrg.get(org.id) ?? 0;
          const count = invoiceCountByOrg.get(org.id) ?? 0;
          return (
            <Pressable
              style={({ pressed }) => [styles.orgRow, pressed && { opacity: 0.7 }]}
              onPress={() => setSelectedId(org.id)}
            >
              <View style={styles.orgIcon}>
                <Ionicons name="business-outline" size={18} color={Colors.light.tint} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.orgName} numberOfLines={1}>
                  {org.displayName || org.name}
                </Text>
                <Text style={styles.orgSub}>
                  {count} invoice{count !== 1 ? "s" : ""}
                  {(org.city || org.state)
                    ? ` · ${[org.city, org.state].filter(Boolean).join(", ")}`
                    : ""}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end", marginRight: 4 }}>
                {balance > 0 && (
                  <Text style={styles.orgBalance}>{fmtMoney(balance)}</Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={16} color={Colors.light.textSecondary} />
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.backgroundSolid,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Colors.light.backgroundSolid,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.border,
    gap: 10,
  },
  backBtn: {
    padding: 2,
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
    flex: 1,
  },
  headerSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
  },
  balanceLabel: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  balanceValue: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  infoStrip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.border,
    backgroundColor: Colors.light.surface || Colors.light.backgroundSolid,
    gap: 4,
  },
  infoItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  infoText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
  },
  searchWrap: {
    position: "relative",
    marginHorizontal: 16,
    marginVertical: 10,
  },
  searchInput: {
    height: 40,
    paddingLeft: 38,
    paddingRight: 12,
    backgroundColor: Colors.light.surface || "#F1F5F9",
    borderRadius: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
  },
  orgRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.border,
    gap: 12,
  },
  orgIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: Colors.light.tintLight || "#EFF6FF",
    alignItems: "center",
    justifyContent: "center",
  },
  orgName: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  orgSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 1,
  },
  orgBalance: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#D97706",
  },
  invoiceRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.border,
    gap: 8,
  },
  invNum: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  invDate: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 1,
  },
  invTotal: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  invBalance: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 99,
    backgroundColor: "#F1F5F9",
  },
  statusText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    textTransform: "capitalize",
  },
  empty: {
    padding: 40,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
    color: Colors.light.textSecondary,
    fontFamily: "Inter_400Regular",
  },
});
