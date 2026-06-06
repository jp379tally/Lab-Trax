import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { EmptyState } from "@/components/ui/EmptyState";
import { AppHeader } from "@/components/ui/AppHeader";
import { FilterBar } from "@/components/ui/FilterBar";
import { resilientFetch } from "@/lib/query-client";

interface BankAccount {
  id: string;
  name: string;
  isArchived?: boolean;
  last4?: string | null;
  bookBalance?: string | number | null;
  clearedBalance?: string | number | null;
}

interface Transaction {
  id: string;
  txnDate: string;
  payee?: string | null;
  memo?: string | null;
  type?: string | null;
  debitAmount?: string | number | null;
  creditAmount?: string | number | null;
  netAmount?: string | number | null;
  status?: string | null;
  cleared?: boolean;
  reconciled?: boolean;
  checkNumber?: string | null;
  categoryId?: string | null;
  linkedInvoices?: Array<{ invoiceNumber?: string }>;
}

function fmtMoney(v?: string | number | null, showSign = false) {
  const n = Number(v) || 0;
  const abs = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  if (showSign && n > 0) return `+${abs}`;
  return abs;
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return d;
  }
}

type TxnFilter = "all" | "posted" | "uncleared" | "unreconciled";

function AIInsightBanner({ orgId }: { orgId: string }) {
  const { colors } = useTheme();
  const [insight, setInsight] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    setLoading(true);
    resilientFetch("/api/ai-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: `Briefly summarize any financial anomalies or notable patterns in the bank register for organization ${orgId}. Be concise (1-2 sentences max). If nothing notable, say so briefly.` }],
      }),
    })
      .then((r) => r.json().catch(() => ({})))
      .then((body) => {
        const txt = body?.reply ?? body?.message ?? body?.content;
        if (txt && typeof txt === "string" && txt.length > 10) setInsight(txt);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [orgId]);

  if (dismissed || (!loading && !insight)) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", backgroundColor: colors.tint + "12", borderWidth: 1, borderColor: colors.tint + "30", borderRadius: 12, marginHorizontal: 16, marginVertical: 8, padding: 12, gap: 8 }}>
      <Ionicons name="sparkles" size={16} color={colors.tint} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: colors.tint, marginBottom: 2 }}>AI Insight</Text>
        {loading ? <ActivityIndicator size="small" color={colors.tint} /> : <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: colors.text, lineHeight: 18 }}>{insight}</Text>}
      </View>
      <Pressable onPress={() => setDismissed(true)} hitSlop={8}><Ionicons name="close" size={16} color={colors.textTertiary} /></Pressable>
    </View>
  );
}

function EntryModal({
  visible,
  onClose,
  onSave,
  orgId,
  accountId,
  categories,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: () => void;
  orgId: string;
  accountId: string;
  categories: Array<{ id: string; name: string; kind: string }>;
}) {
  const { colors } = useTheme();
  const [type, setType] = useState<"debit" | "credit">("debit");
  const [payee, setPayee] = useState("");
  const [memo, setMemo] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function reset() { setType("debit"); setPayee(""); setMemo(""); setAmount(""); setDate(new Date().toISOString().split("T")[0]); setCategoryId(null); }

  async function save() {
    const amt = Number(amount);
    if (!amt || isNaN(amt) || amt <= 0) { Alert.alert("Invalid amount", "Please enter a valid amount."); return; }
    setSaving(true);
    try {
      await resilientFetch("/api/finance/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankAccountId: accountId,
          txnDate: date,
          type: type === "credit" ? "deposit" : "payment",
          payee: payee.trim() || "Manual Entry",
          memo: memo.trim() || null,
          payment: type === "debit" ? amt : 0,
          deposit: type === "credit" ? amt : 0,
          status: "posted",
          categoryId: categoryId || null,
        }),
      });
      reset();
      onSave();
      onClose();
    } catch {
      Alert.alert("Error", "Failed to save transaction. Please try again.");
    } finally { setSaving(false); }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <Text style={{ fontSize: 17, fontFamily: "Inter_700Bold", color: colors.text }}>New Entry</Text>
            <Pressable onPress={onClose} hitSlop={8}><Ionicons name="close" size={22} color={colors.textSecondary} /></Pressable>
          </View>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
            {(["debit", "credit"] as const).map((t) => (
              <Pressable key={t} onPress={() => setType(t)} style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: "center", backgroundColor: type === t ? (t === "credit" ? colors.success : colors.error) : colors.canvas, borderWidth: 1, borderColor: type === t ? "transparent" : colors.border }}>
                <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: type === t ? "#fff" : colors.textSecondary }}>{t === "credit" ? "Credit (+)" : "Debit (−)"}</Text>
              </Pressable>
            ))}
          </View>
          {[
            { label: "Date", value: date, onChange: setDate, placeholder: "YYYY-MM-DD" },
            { label: "Payee", value: payee, onChange: setPayee, placeholder: "Payee or description" },
            { label: "Amount ($)", value: amount, onChange: setAmount, placeholder: "0.00", keyboard: "decimal-pad" },
            { label: "Memo", value: memo, onChange: setMemo, placeholder: "Optional memo" },
          ].map((f) => (
            <View key={f.label} style={{ marginBottom: 12 }}>
              <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginBottom: 4 }}>{f.label}</Text>
              <TextInput value={f.value} onChangeText={f.onChange} placeholder={f.placeholder} placeholderTextColor={colors.textTertiary} keyboardType={(f as any).keyboard ?? "default"} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, fontFamily: "Inter_400Regular", color: colors.text, backgroundColor: colors.canvas }} />
            </View>
          ))}
          <Pressable onPress={save} disabled={saving} style={{ backgroundColor: colors.tint, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 4 }}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 15 }}>Save Entry</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function BankRegisterScreen() {
  const { colors, isDark } = useTheme();
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingTxns, setLoadingTxns] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [labId, setLabId] = useState<string | null>(null);
  const [filter, setFilter] = useState<TxnFilter>("all");
  const [search, setSearch] = useState("");
  const [entryModalVisible, setEntryModalVisible] = useState(false);

  async function loadLabAndAccounts() {
    try {
      const meRes = await resilientFetch("/api/auth/me");
      const me = await meRes.json().catch(() => ({}));
      const memberships: any[] = me?.memberships ?? me?.user?.memberships ?? [];
      const billing = memberships.find(
        (m: any) => m.status === "active" && ["owner", "admin", "billing"].includes(m.role)
      );
      const orgId = billing?.labId ?? billing?.organizationId ?? null;
      setLabId(orgId);
      if (!orgId) { setLoading(false); return; }

      const [acctRes, catRes] = await Promise.all([
        resilientFetch(`/api/finance/accounts?organizationId=${orgId}`),
        resilientFetch(`/api/finance/categories?organizationId=${orgId}`),
      ]);
      const acctBody = await acctRes.json().catch(() => ({}));
      const catBody = await catRes.json().catch(() => ({}));
      const accts: BankAccount[] = (Array.isArray(acctBody) ? acctBody : acctBody?.data ?? []).filter((a: any) => !a.isArchived);
      setAccounts(accts);
      setCategories(Array.isArray(catBody) ? catBody : catBody?.data ?? []);
      if (accts.length && !selectedAccountId) setSelectedAccountId(accts[0].id);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }

  async function loadTransactions(accountId: string) {
    if (!labId) return;
    setLoadingTxns(true);
    try {
      const params = new URLSearchParams({ organizationId: labId, bankAccountId: accountId });
      if (filter !== "all") params.set("status", filter);
      const res = await resilientFetch(`/api/finance/transactions?${params}`);
      const body = await res.json().catch(() => ({}));
      const rows: Transaction[] = Array.isArray(body) ? body : body?.data ?? body?.transactions ?? [];
      setTransactions(rows.sort((a, b) => {
        const da = new Date(b.txnDate || 0).getTime();
        const db2 = new Date(a.txnDate || 0).getTime();
        return da - db2;
      }));
    } catch { setTransactions([]); } finally { setLoadingTxns(false); }
  }

  useEffect(() => { void loadLabAndAccounts(); }, []);
  useEffect(() => {
    if (selectedAccountId && labId) void loadTransactions(selectedAccountId);
  }, [selectedAccountId, labId, filter]);

  const filtered = useMemo(() => {
    if (!search.trim()) return transactions;
    const q = search.toLowerCase();
    return transactions.filter((t) =>
      (t.payee || "").toLowerCase().includes(q) ||
      (t.memo || "").toLowerCase().includes(q) ||
      (t.checkNumber || "").toLowerCase().includes(q)
    );
  }, [transactions, search]);

  async function voidTransaction(txn: Transaction) {
    Alert.alert("Void Transaction", `Void "${txn.payee || "this transaction"}"? This cannot be undone.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Void", style: "destructive", onPress: async () => {
        try {
          await resilientFetch(`/api/finance/transactions/${txn.id}/void`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
          if (selectedAccountId && labId) void loadTransactions(selectedAccountId);
        } catch { Alert.alert("Error", "Failed to void transaction."); }
      }},
    ]);
  }

  async function toggleCleared(txn: Transaction) {
    try {
      await resilientFetch(`/api/finance/transactions/${txn.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cleared: !txn.cleared, clearedAt: !txn.cleared ? new Date().toISOString() : null }),
      });
      setTransactions((prev) => prev.map((t) => t.id === txn.id ? { ...t, cleared: !txn.cleared } : t));
    } catch {}
  }

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const ACCOUNT_FILTERS = accounts.map((a) => ({ id: a.id, label: a.name + (a.last4 ? ` ···${a.last4}` : "") }));
  const TXN_FILTERS: { id: TxnFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "posted", label: "Posted" },
    { id: "uncleared", label: "Uncleared" },
    { id: "unreconciled", label: "Unreconciled" },
  ];

  function renderTxnRow({ item: t }: { item: Transaction }) {
    const net = Number(t.netAmount) || 0;
    const isVoid = t.status === "void";
    const netColor = isVoid ? colors.textTertiary : net >= 0 ? colors.success : colors.error;

    return (
      <Pressable
        onLongPress={() => !isVoid && voidTransaction(t)}
        style={[styles.row, { borderBottomColor: colors.border, backgroundColor: colors.surface, opacity: isVoid ? 0.55 : 1 }]}
      >
        <Pressable onPress={() => !isVoid && toggleCleared(t)} style={{ marginRight: 10 }}>
          <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: t.cleared ? colors.success : colors.border, backgroundColor: t.cleared ? colors.success + "20" : "transparent", alignItems: "center", justifyContent: "center" }}>
            {t.cleared && <Ionicons name="checkmark" size={12} color={colors.success} />}
          </View>
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.payee, { color: colors.text }]} numberOfLines={1}>{t.payee || "Transaction"}</Text>
          {t.memo ? <Text style={{ fontSize: 12, color: colors.textTertiary, marginTop: 1 }} numberOfLines={1}>{t.memo}</Text> : null}
          <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 2 }}>{fmtDate(t.txnDate)}{t.checkNumber ? `  ·  #${t.checkNumber}` : ""}</Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 3 }}>
          <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: netColor }}>
            {net >= 0 ? "+" : "−"}{fmtMoney(Math.abs(net))}
          </Text>
          {isVoid && <Text style={{ fontSize: 10, fontFamily: "Inter_600SemiBold", color: colors.error }}>VOID</Text>}
          {t.reconciled && <Ionicons name="shield-checkmark" size={12} color={colors.success} />}
        </View>
      </Pressable>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.backgroundSolid }}>
      <Stack.Screen options={{ headerShown: false }} />
      <AppHeader
        title="Bank Register"
        showSearch={false}
        rightActions={
          labId && selectedAccountId ? (
            <Pressable onPress={() => setEntryModalVisible(true)} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.tint, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="add" size={20} color="#fff" />
            </Pressable>
          ) : null
        }
      />

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.tint} /></View>
      ) : !labId ? (
        <EmptyState icon="wallet-outline" title="Access restricted" description="Bank register is available for billing-role lab accounts." />
      ) : accounts.length === 0 ? (
        <EmptyState icon="wallet-outline" title="No bank accounts" description="Add a bank account in Finance Settings." />
      ) : (
        <>
          {accounts.length > 1 && (
            <FilterBar filters={ACCOUNT_FILTERS} activeId={selectedAccountId!} onSelect={(id) => setSelectedAccountId(id)} />
          )}

          {selectedAccount && (
            <View style={[styles.accountCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View>
                <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.text }}>{selectedAccount.name}</Text>
                {selectedAccount.last4 && <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 1 }}>···{selectedAccount.last4}</Text>}
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_500Medium", color: colors.textTertiary, textTransform: "uppercase", letterSpacing: 0.5 }}>Book Balance</Text>
                <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: colors.text, marginTop: 2 }}>{fmtMoney(selectedAccount.bookBalance)}</Text>
                {selectedAccount.clearedBalance != null && (
                  <Text style={{ fontSize: 11, color: colors.textSecondary }}>Cleared {fmtMoney(selectedAccount.clearedBalance)}</Text>
                )}
              </View>
            </View>
          )}

          {labId && <AIInsightBanner orgId={labId} />}

          <FilterBar filters={TXN_FILTERS} activeId={filter} onSelect={(id) => setFilter(id as TxnFilter)} />

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
            <Ionicons name="search" size={15} color={colors.textTertiary} />
            <TextInput
              style={{ flex: 1, fontSize: 14, color: colors.text, fontFamily: "Inter_400Regular", height: 34 }}
              placeholder="Search transactions…"
              placeholderTextColor={colors.textTertiary}
              value={search}
              onChangeText={setSearch}
            />
            {search.length > 0 && <Pressable onPress={() => setSearch("")} hitSlop={8}><Ionicons name="close-circle" size={16} color={colors.textTertiary} /></Pressable>}
          </View>

          {loadingTxns ? (
            <View style={styles.center}><ActivityIndicator color={colors.tint} /></View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(t) => t.id}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void loadLabAndAccounts(); }} tintColor={colors.tint} />}
              contentContainerStyle={{ paddingBottom: 40 }}
              showsVerticalScrollIndicator={false}
              ListHeaderComponent={
                filtered.length > 0 ? (
                  <Text style={{ fontSize: 11, color: colors.textTertiary, paddingHorizontal: 16, paddingVertical: 8, fontFamily: "Inter_400Regular" }}>
                    Long-press a transaction to void it
                  </Text>
                ) : null
              }
              ListEmptyComponent={<EmptyState icon="bar-chart-outline" title="No transactions" description="Transactions for this account will appear here." />}
              renderItem={renderTxnRow}
            />
          )}

          {labId && selectedAccountId && (
            <EntryModal
              visible={entryModalVisible}
              onClose={() => setEntryModalVisible(false)}
              onSave={() => selectedAccountId && labId && loadTransactions(selectedAccountId)}
              orgId={labId}
              accountId={selectedAccountId}
              categories={categories}
            />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 12 },
  accountCard: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginHorizontal: 16, marginVertical: 10, padding: 14, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth },
  payee: { fontSize: 14, fontFamily: "Inter_500Medium" },
});
