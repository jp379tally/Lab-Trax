// Mobile companion of the desktop Receive Payments screen.
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { apiRequest, resilientFetch } from "@/lib/query-client";
import {
  type OpenInvoice,
  type ReceivePaymentsInput,
  ReceivePaymentsInputPaymentMethod,
} from "@workspace/api-client-react";

type Provider = { id: string; name: string };
type BankAccount = { id: string; name: string; isArchived: boolean; last4?: string | null };

function fmtMoney(v: string | number) {
  const n = Number(v) || 0;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function ReceivePaymentsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [labId, setLabId] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenInvoice[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [totalReceived, setTotalReceived] = useState("");
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState<ReceivePaymentsInputPaymentMethod>(
    ReceivePaymentsInputPaymentMethod.check
  );
  const [memo, setMemo] = useState("");
  const [paymentDate, setPaymentDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [applications, setApplications] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Bootstrap: pull membership lab + invoices to derive provider list, plus accounts.
  useEffect(() => {
    (async () => {
      try {
        const memRes = await resilientFetch("/api/auth/me");
        const me = await memRes.json().catch(() => ({}));
        const memberships: Array<{
          organizationId?: string;
          labId?: string;
          role: string;
          status: string;
          organization?: { id?: string; userType?: string } | null;
        }> = me?.memberships || me?.user?.memberships || [];
        const billing = memberships.find((m) => {
          const orgId = m.organizationId || m.labId;
          if (!orgId || m.status !== "active") return false;
          if (!["owner", "admin", "billing"].includes(m.role)) return false;
          // Restrict to lab-side memberships when org type is known.
          const orgType = m.organization?.userType;
          if (orgType && orgType !== "lab") return false;
          return true;
        });
        const billingOrgId = billing?.organizationId || billing?.labId || null;
        if (!billing || !billingOrgId) {
          setLoading(false);
          return;
        }
        setLabId(billingOrgId);

        const [invRes, acctRes] = await Promise.all([
          resilientFetch("/api/invoices"),
          resilientFetch(`/api/finance/accounts?organizationId=${billingOrgId}`),
        ]);
        const invsBody = await invRes.json().catch(() => ({}));
        const invs: any[] = Array.isArray(invsBody)
          ? invsBody
          : Array.isArray(invsBody?.data)
            ? invsBody.data
            : [];
        const provMap = new Map<string, string>();
        for (const inv of invs) {
          if (inv.labOrganizationId !== billingOrgId) continue;
          if (inv.status === "paid" || inv.status === "void") continue;
          if (Number(inv.balanceDue ?? 0) <= 0) continue;
          if (inv.providerOrganizationId && !provMap.has(inv.providerOrganizationId)) {
            provMap.set(
              inv.providerOrganizationId,
              inv.providerOrganization?.name || "Practice"
            );
          }
        }
        const provList = Array.from(provMap.entries())
          .map(([id, name]) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setProviders(provList);
        if (provList.length) setProviderId(provList[0].id);

        const acctsBody = await acctRes.json().catch(() => ({}));
        const accts: BankAccount[] = Array.isArray(acctsBody)
          ? acctsBody
          : Array.isArray(acctsBody?.data)
            ? acctsBody.data
            : [];
        const usable = (accts || []).filter((a: any) => !a.isArchived);
        setAccounts(usable);
        if (usable.length) setAccountId(usable[0].id);
      } catch (e: any) {
        Alert.alert("Could not load", e?.message || "Failed.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Reload open invoices whenever provider changes.
  useEffect(() => {
    if (!providerId || !labId) return;
    setApplications({});
    setTotalReceived("");
    (async () => {
      try {
        const res = await resilientFetch(
          `/api/invoices/open?providerOrganizationId=${providerId}&labOrganizationId=${labId}`
        );
        const body = await res.json().catch(() => ({}));
        const rows: OpenInvoice[] = Array.isArray(body)
          ? body
          : Array.isArray(body?.data)
            ? body.data
            : [];
        setOpen(rows || []);
      } catch (e: any) {
        Alert.alert("Could not load invoices", e?.message || "");
      }
    })();
  }, [providerId, labId]);

  function autoApply(total: number) {
    const next: Record<string, string> = {};
    let remaining = total;
    for (const inv of open) {
      if (remaining <= 0) break;
      const bal = Number(inv.balanceDue);
      const take = Math.min(bal, remaining);
      next[inv.id] = take.toFixed(2);
      remaining = +(remaining - take).toFixed(2);
    }
    setApplications(next);
  }

  function onTotalChange(v: string) {
    setTotalReceived(v);
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) autoApply(n);
  }

  const appliedSum = useMemo(
    () =>
      Object.values(applications).reduce(
        (s, v) => s + (Number(v) || 0),
        0
      ),
    [applications]
  );

  async function submit() {
    if (!labId || !providerId) return;
    const apps = Object.entries(applications)
      .map(([invoiceId, amount]) => ({ invoiceId, amount: Number(amount) || 0 }))
      .filter((a) => a.amount > 0);
    if (!apps.length) {
      Alert.alert("No payments", "Apply an amount to at least one invoice.");
      return;
    }
    const totalReceivedNum = Number(totalReceived) || 0;
    if (totalReceivedNum > 0 && appliedSum - totalReceivedNum > 0.005) {
      Alert.alert(
        "Applied total too high",
        `Applied (${fmtMoney(appliedSum)}) is greater than the payment received (${fmtMoney(totalReceivedNum)}).`
      );
      return;
    }
    if (!accountId) {
      Alert.alert(
        "Pick a deposit account",
        "Choose a bank account to deposit this payment into."
      );
      return;
    }
    setSaving(true);
    try {
      const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(paymentDate)
        ? new Date(paymentDate).toISOString()
        : new Date().toISOString();
      const body: ReceivePaymentsInput = {
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        paymentDate: isoDate,
        paymentMethod: method,
        referenceNumber: reference.trim() || null,
        memo: memo.trim() || null,
        depositBankAccountId: accountId,
        applications: apps,
      };
      const res = await apiRequest("POST", "/api/invoices/receive-payments", body);
      const out = await res.json().catch(() => ({} as any));
      const total: string =
        out?.data?.totalApplied ?? out?.totalApplied ?? String(appliedSum);
      Alert.alert(
        "Payment recorded",
        `Applied ${fmtMoney(total)} across ${apps.length} invoice${apps.length === 1 ? "" : "s"}.`,
        [{ text: "OK", onPress: () => router.back() }]
      );
    } catch (e: any) {
      Alert.alert("Could not save", e?.message || "Failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen
        options={{
          title: "Receive Payments",
          headerBackTitle: "Back",
        }}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : !labId ? (
          <Text style={styles.muted}>
            Receive Payments is only available to billing-role lab accounts.
          </Text>
        ) : !providers.length ? (
          <Text style={styles.muted}>No practices have open invoices right now.</Text>
        ) : (
          <>
            <Text style={styles.label}>Practice</Text>
            <View style={styles.pillRow}>
              {providers.map((p) => (
                <Pressable
                  key={p.id}
                  onPress={() => setProviderId(p.id)}
                  style={[
                    styles.pill,
                    providerId === p.id && styles.pillActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.pillText,
                      providerId === p.id && styles.pillTextActive,
                    ]}
                  >
                    {p.name}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.row2}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Total received</Text>
                <TextInput
                  value={totalReceived}
                  onChangeText={onTotalChange}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  style={styles.input}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Reference #</Text>
                <TextInput
                  value={reference}
                  onChangeText={setReference}
                  placeholder={method === "check" ? "Check #" : "Optional"}
                  style={styles.input}
                />
              </View>
            </View>

            <Text style={styles.label}>Payment date</Text>
            <TextInput
              value={paymentDate}
              onChangeText={setPaymentDate}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />

            <Text style={styles.label}>Method</Text>
            <View style={styles.pillRow}>
              {(["check", "card", "ach", "cash", "other"] as const).map((m) => (
                <Pressable
                  key={m}
                  onPress={() => setMethod(m)}
                  style={[styles.pillSm, method === m && styles.pillActive]}
                >
                  <Text
                    style={[
                      styles.pillText,
                      method === m && styles.pillTextActive,
                    ]}
                  >
                    {m.toUpperCase()}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.label}>Deposit to (required)</Text>
            {accounts.length > 0 ? (
              <View style={styles.pillRow}>
                {accounts.map((a) => (
                  <Pressable
                    key={a.id}
                    onPress={() => setAccountId(a.id)}
                    style={[
                      styles.pillSm,
                      accountId === a.id && styles.pillActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        accountId === a.id && styles.pillTextActive,
                      ]}
                    >
                      {a.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Text style={[styles.label, { color: colors.errorText }]}>
                No active bank accounts. Add one in the desktop app first.
              </Text>
            )}

            <Text style={styles.label}>Memo</Text>
            <TextInput
              value={memo}
              onChangeText={setMemo}
              placeholder="Optional"
              style={styles.input}
            />

            <View style={styles.summary}>
              <SumRow label="Open invoices" value={String(open.length)} />
              <SumRow
                label="Open balance"
                value={fmtMoney(
                  open.reduce((s, i) => s + Number(i.balanceDue), 0)
                )}
              />
              <SumRow label="Applied" value={fmtMoney(appliedSum)} bold />
              <SumRow
                label="Unapplied"
                value={fmtMoney(
                  Math.max(0, (Number(totalReceived) || 0) - appliedSum)
                )}
              />
            </View>

            <Text style={[styles.label, { marginTop: 12 }]}>Outstanding invoices</Text>
            {open.length === 0 ? (
              <Text style={styles.muted}>No open invoices for this practice.</Text>
            ) : (
              open.map((inv) => {
                const bal = Number(inv.balanceDue);
                const selected = Number(applications[inv.id] || 0) > 0;
                return (
                  <View key={inv.id} style={styles.invoiceCard}>
                    <Pressable
                      onPress={() =>
                        setApplications((prev) => ({
                          ...prev,
                          [inv.id]: selected ? "" : bal.toFixed(2),
                        }))
                      }
                      style={[
                        styles.checkbox,
                        selected && styles.checkboxOn,
                      ]}
                      accessibilityLabel={`Select ${inv.invoiceNumber}`}
                    >
                      {selected ? (
                        <Ionicons name="checkmark" size={14} color={colors.textInverse} />
                      ) : null}
                    </Pressable>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.invoiceNum}>{inv.invoiceNumber}</Text>
                      <Text style={styles.invoiceMeta}>
                        Bal {fmtMoney(inv.balanceDue)}
                        {inv.ageDays != null ? ` · ${inv.ageDays}d old` : ""}
                      </Text>
                    </View>
                    <TextInput
                      value={applications[inv.id] || ""}
                      onChangeText={(v) =>
                        setApplications((prev) => ({ ...prev, [inv.id]: v }))
                      }
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                      style={styles.amtInput}
                    />
                  </View>
                );
              })
            )}

            <Pressable
              disabled={saving || appliedSum <= 0 || !accountId}
              onPress={submit}
              style={({ pressed }) => [
                styles.saveBtn,
                (saving || appliedSum <= 0 || !accountId) && { opacity: 0.5 },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Ionicons name="checkmark-circle" size={18} color={colors.textInverse} />
              <Text style={styles.saveBtnText}>
                {saving ? "Saving…" : `Record ${fmtMoney(appliedSum)}`}
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function SumRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.sumRow}>
      <Text style={styles.sumLabel}>{label}</Text>
      <Text style={[styles.sumValue, bold && { fontWeight: "700" }]}>{value}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { padding: 16, paddingBottom: 80 },
  muted: { color: colors.textSecondary, marginVertical: 24, textAlign: "center" },
  label: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    marginTop: 16,
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  input: {
    height: 44,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: 15,
    color: colors.text,
  },
  row2: { flexDirection: "row", gap: 10 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
  },
  pillSm: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
  },
  pillActive: { backgroundColor: colors.tint },
  pillText: { fontSize: 13, color: colors.text },
  pillTextActive: { color: colors.textInverse, fontWeight: "600" },
  summary: {
    marginTop: 16,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  sumLabel: { color: colors.textSecondary, fontSize: 13 },
  sumValue: { fontVariant: ["tabular-nums"], fontSize: 13, color: colors.text },
  invoiceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 8,
  },
  invoiceNum: { fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }), fontSize: 13, fontWeight: "600", color: colors.text },
  invoiceMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  checkboxOn: {
    backgroundColor: colors.tint,
    borderColor: colors.tint,
  },
  amtInput: {
    width: 96,
    height: 38,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
    backgroundColor: colors.surface,
    color: colors.text,
  },
  saveBtn: {
    marginTop: 24,
    height: 50,
    borderRadius: 12,
    backgroundColor: colors.tint,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  saveBtnText: { color: colors.textInverse, fontWeight: "700", fontSize: 15 },
});
