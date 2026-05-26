import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { AppHeader } from "@/components/ui/AppHeader";
import { FilterBar } from "@/components/ui/FilterBar";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { resilientFetch } from "@/lib/query-client";

interface BankAccount {
  id: string;
  name: string;
  isArchived: boolean;
  last4?: string | null;
  currentBalance?: string | number | null;
}

interface LedgerEntry {
  id: string;
  date: string;
  description: string;
  amount: string | number;
  type: "debit" | "credit" | string;
  runningBalance?: string | number | null;
  referenceNumber?: string | null;
  memo?: string | null;
}

function fmtMoney(v?: string | number | null, sign = false) {
  const n = Number(v) || 0;
  const abs = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  if (sign && n > 0) return `+${abs}`;
  return abs;
}

function fmtDate(d: string) {
  try {
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return d;
  }
}

export default function BankRegisterScreen() {
  const { colors, isDark } = useTheme();
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [labId, setLabId] = useState<string | null>(null);

  async function loadAccounts() {
    try {
      const meRes = await resilientFetch("/api/auth/me");
      const me = await meRes.json().catch(() => ({}));
      const memberships: any[] = me?.memberships || me?.user?.memberships || [];
      const billing = memberships.find((m: any) => {
        if (m.status !== "active") return false;
        if (!["owner", "admin", "billing"].includes(m.role)) return false;
        const orgType = m.organization?.userType;
        if (orgType && orgType !== "lab") return false;
        return true;
      });
      const orgId = billing?.organizationId || billing?.labId || null;
      setLabId(orgId);
      if (!orgId) {
        setLoading(false);
        return;
      }
      const res = await resilientFetch(`/api/finance/accounts?organizationId=${orgId}`);
      const body = await res.json().catch(() => ({}));
      const accts: BankAccount[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
      const active = accts.filter((a) => !a.isArchived);
      setAccounts(active);
      if (active.length) setSelectedAccountId(active[0].id);
    } catch {
      // swallow
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function loadEntries(accountId: string) {
    if (!labId) return;
    setLoadingEntries(true);
    try {
      const res = await resilientFetch(
        `/api/finance/entries?organizationId=${labId}&accountId=${accountId}&limit=100`
      );
      const body = await res.json().catch(() => ({}));
      const rows: LedgerEntry[] = Array.isArray(body)
        ? body
        : Array.isArray(body?.data)
        ? body.data
        : Array.isArray(body?.entries)
        ? body.entries
        : [];
      setEntries(rows);
    } catch {
      setEntries([]);
    } finally {
      setLoadingEntries(false);
    }
  }

  useEffect(() => { void loadAccounts(); }, []);
  useEffect(() => {
    if (selectedAccountId && labId) void loadEntries(selectedAccountId);
  }, [selectedAccountId, labId]);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  const FILTERS = accounts.map((a) => ({
    id: a.id,
    label: a.name + (a.last4 ? ` ···${a.last4}` : ""),
  }));

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSolid }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <AppHeader title="Bank Register" />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : !labId ? (
        <View style={styles.center}>
          <Ionicons name="wallet-outline" size={48} color={colors.textTertiary} />
          <Text style={[styles.empty, { color: colors.textSecondary }]}>
            Bank register is only available to billing-role lab accounts.
          </Text>
        </View>
      ) : accounts.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="wallet-outline" size={48} color={colors.textTertiary} />
          <Text style={[styles.empty, { color: colors.textSecondary }]}>
            No bank accounts found. Add accounts in Settings.
          </Text>
        </View>
      ) : (
        <>
          {accounts.length > 1 && (
            <FilterBar
              filters={FILTERS}
              activeId={selectedAccountId!}
              onSelect={(id) => setSelectedAccountId(id)}
            />
          )}

          {selectedAccount && (
            <View style={[styles.accountCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View>
                <Text style={[styles.accountName, { color: colors.text }]}>{selectedAccount.name}</Text>
                {selectedAccount.last4 && (
                  <Text style={[styles.accountSub, { color: colors.textSecondary }]}>···{selectedAccount.last4}</Text>
                )}
              </View>
              {selectedAccount.currentBalance != null && (
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={[styles.balLabel, { color: colors.textSecondary }]}>Balance</Text>
                  <Text style={[styles.balValue, { color: colors.text }]}>
                    {fmtMoney(selectedAccount.currentBalance)}
                  </Text>
                </View>
              )}
            </View>
          )}

          {loadingEntries ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.tint} />
            </View>
          ) : (
            <FlatList
              data={entries}
              keyExtractor={(item) => item.id}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => {
                    setRefreshing(true);
                    loadAccounts();
                  }}
                  tintColor={colors.tint}
                />
              }
              contentContainerStyle={{ paddingBottom: 40 }}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <View style={styles.center}>
                  <Ionicons name="bar-chart-outline" size={48} color={colors.textTertiary} />
                  <Text style={[styles.empty, { color: colors.textSecondary }]}>No transactions yet</Text>
                </View>
              }
              renderItem={({ item: entry }) => {
                const amount = Number(entry.amount) || 0;
                const isCredit = entry.type === "credit" || amount > 0;
                const amtColor = isCredit ? colors.success : colors.error;

                return (
                  <View style={[styles.row, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.desc, { color: colors.text }]} numberOfLines={1}>
                        {entry.description || "Transaction"}
                      </Text>
                      {entry.memo ? (
                        <Text style={[styles.memo, { color: colors.textTertiary }]} numberOfLines={1}>
                          {entry.memo}
                        </Text>
                      ) : null}
                      <Text style={[styles.date, { color: colors.textSecondary }]}>{fmtDate(entry.date)}</Text>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 2 }}>
                      <Text style={[styles.amount, { color: amtColor }]}>
                        {isCredit ? "+" : "-"}{fmtMoney(Math.abs(amount))}
                      </Text>
                      {entry.runningBalance != null && (
                        <Text style={[styles.running, { color: colors.textTertiary }]}>
                          {fmtMoney(entry.runningBalance)}
                        </Text>
                      )}
                    </View>
                  </View>
                );
              }}
            />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 12 },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" },
  accountCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 16,
    marginVertical: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  accountName: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  accountSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  balLabel: { fontSize: 10, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.5 },
  balValue: { fontSize: 16, fontFamily: "Inter_700Bold", marginTop: 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  desc: { fontSize: 14, fontFamily: "Inter_500Medium" },
  memo: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  date: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 3 },
  amount: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  running: { fontSize: 11, fontFamily: "Inter_400Regular" },
});
