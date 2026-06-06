import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { AppHeader } from "@/components/ui/AppHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { resilientFetch } from "@/lib/query-client";

function fmtMoney(v?: string | number | null) {
  const n = Number(v) || 0;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }); }
  catch { return d; }
}

function invoiceVariant(status: string): "paid" | "overdue" | "open" | "draft" | "void" | "custom" {
  if (status === "paid") return "paid";
  if (status === "open" || status === "partially_paid") return "open";
  if (status === "overdue") return "overdue";
  if (status === "draft") return "draft";
  if (status === "void") return "void";
  return "custom";
}

interface LineItem {
  id: string;
  description?: string | null;
  quantity?: number | null;
  unitPrice?: string | number | null;
  lineTotal?: string | number | null;
  toothNumbers?: string | null;
  material?: string | null;
}

interface Payment {
  id: string;
  amount: string | number;
  paidAt?: string | null;
  method?: string | null;
  notes?: string | null;
}

function RecordPaymentModal({
  visible,
  onClose,
  onSave,
  invoiceId,
  balanceDue,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: () => void;
  invoiceId: string;
  balanceDue: number;
}) {
  const { colors } = useTheme();
  const [amount, setAmount] = useState(String(balanceDue.toFixed(2)));
  const [method, setMethod] = useState("check");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const METHODS = ["check", "cash", "card", "ach", "other"];

  async function save() {
    const amt = Number(amount);
    if (!amt || isNaN(amt) || amt <= 0) { Alert.alert("Invalid amount"); return; }
    setSaving(true);
    try {
      await resilientFetch(`/api/invoices/${invoiceId}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amt.toFixed(2), paymentMethod: method, referenceNumber: referenceNumber.trim() || undefined }),
      });
      onSave();
      onClose();
    } catch {
      Alert.alert("Error", "Failed to record payment. Please try again.");
    } finally { setSaving(false); }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 40 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <Text style={{ fontSize: 17, fontFamily: "Inter_700Bold", color: colors.text }}>Record Payment</Text>
            <Pressable onPress={onClose} hitSlop={8}><Ionicons name="close" size={22} color={colors.textSecondary} /></Pressable>
          </View>
          <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginBottom: 6 }}>Amount ($)</Text>
          <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11, fontSize: 16, fontFamily: "Inter_600SemiBold", color: colors.text, backgroundColor: colors.canvas, marginBottom: 14 }} />
          <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginBottom: 8 }}>Payment Method</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }} contentContainerStyle={{ gap: 8 }}>
            {METHODS.map((m) => (
              <Pressable key={m} onPress={() => setMethod(m)} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: method === m ? colors.tint : colors.border, backgroundColor: method === m ? colors.tint + "15" : "transparent" }}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: method === m ? colors.tint : colors.textSecondary }}>{m.replace(/_/g, " ")}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginBottom: 6 }}>Reference / Check # (optional)</Text>
          <TextInput value={referenceNumber} onChangeText={setReferenceNumber} placeholder="Check number, reference, etc." placeholderTextColor={colors.textTertiary} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, fontFamily: "Inter_400Regular", color: colors.text, backgroundColor: colors.canvas, marginBottom: 16 }} />
          <Pressable onPress={save} disabled={saving} style={{ backgroundColor: colors.tint, borderRadius: 12, paddingVertical: 14, alignItems: "center" }}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 15 }}>Save Payment</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function EmailModal({ visible, onClose, practiceName }: { visible: boolean; onClose: () => void; invoiceId: string; practiceName: string }) {
  const { colors } = useTheme();

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 40 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <Text style={{ fontSize: 17, fontFamily: "Inter_700Bold", color: colors.text }}>Email Invoice</Text>
            <Pressable onPress={onClose} hitSlop={8}><Ionicons name="close" size={22} color={colors.textSecondary} /></Pressable>
          </View>
          <View style={{ alignItems: "center", paddingVertical: 20, gap: 12 }}>
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.tint + "15", alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="desktop-outline" size={28} color={colors.tint} />
            </View>
            <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.text, textAlign: "center" }}>Use the Desktop App to Email</Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: "center", lineHeight: 20 }}>
              Sending invoice emails requires generating a PDF attachment, which is only available in the LabTrax Desktop app.
            </Text>
            <Text style={{ fontSize: 13, color: colors.textTertiary, textAlign: "center" }}>To: {practiceName}</Text>
          </View>
          <Pressable onPress={onClose} style={{ backgroundColor: colors.tint, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 8 }}>
            <Text style={{ color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 15 }}>Got it</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

export default function InvoiceDetailScreen() {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [invoice, setInvoice] = useState<any>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [paymentModalVisible, setPaymentModalVisible] = useState(false);
  const [emailModalVisible, setEmailModalVisible] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await resilientFetch(`/api/invoices/${id}`);
      const body = await res.json().catch(() => ({}));
      const inv = body?.invoice ?? body?.data ?? body;
      setInvoice(inv);
      setLineItems(inv?.lineItems ?? inv?.items ?? []);
      setPayments(inv?.payments ?? []);
    } catch {} finally { setLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const effectiveStatus = useMemo(() => {
    if (!invoice) return "unknown";
    if ((invoice.status === "open" || invoice.status === "partially_paid") && invoice.dueAt && new Date(invoice.dueAt).getTime() < Date.now()) return "overdue";
    return invoice.status || "unknown";
  }, [invoice]);

  const balanceDue = Number(invoice?.balanceDue ?? 0);
  const isOpen = effectiveStatus === "open" || effectiveStatus === "overdue" || effectiveStatus === "partially_paid";
  const practiceName = invoice?.providerOrganization?.displayName ?? invoice?.providerOrganization?.name ?? "Practice";

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.backgroundSolid }}>
        <Stack.Screen options={{ headerShown: false }} />
        <AppHeader title="Invoice" showBack />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator size="large" color={colors.tint} /></View>
      </View>
    );
  }

  if (!invoice) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.backgroundSolid }}>
        <Stack.Screen options={{ headerShown: false }} />
        <AppHeader title="Invoice" showBack />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 40 }}>
          <Text style={{ fontSize: 15, color: colors.textSecondary, textAlign: "center" }}>Invoice not found.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.backgroundSolid }}>
      <Stack.Screen options={{ headerShown: false }} />
      <AppHeader
        title={`Invoice ${invoice.invoiceNumber || ""}`}
        showBack
        rightActions={
          <View style={{ flexDirection: "row", gap: 4 }}>
            <Pressable onPress={() => setEmailModalVisible(true)} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.canvas, alignItems: "center", justifyContent: "center" }} hitSlop={4}>
              <Ionicons name="mail-outline" size={18} color={colors.tint} />
            </Pressable>
          </View>
        }
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
        <Card style={{ margin: 16, padding: 0 }} padding="none">
          <View style={{ padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: colors.text }}>{invoice.invoiceNumber}</Text>
                <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 2 }}>{practiceName}</Text>
              </View>
              <StatusBadge label={effectiveStatus.replace(/_/g, " ")} variant={invoiceVariant(effectiveStatus)} />
            </View>
          </View>

          <View style={{ padding: 16, gap: 10 }}>
            {[
              { label: "Issued", value: fmtDate(invoice.issuedAt) },
              { label: "Due", value: fmtDate(invoice.dueAt) },
              { label: "Total", value: fmtMoney(invoice.total) },
              { label: "Paid", value: fmtMoney(Number(invoice.total || 0) - balanceDue) },
              { label: "Balance Due", value: fmtMoney(balanceDue) },
            ].map((row) => (
              <View key={row.label} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ fontSize: 13, color: colors.textSecondary, fontFamily: "Inter_400Regular" }}>{row.label}</Text>
                <Text style={{ fontSize: 13, color: row.label === "Balance Due" && balanceDue > 0 ? colors.error : colors.text, fontFamily: row.label === "Balance Due" ? "Inter_700Bold" : "Inter_500Medium" }}>{row.value}</Text>
              </View>
            ))}
          </View>
        </Card>

        {invoice.caseId && (
          <Pressable
            onPress={() => router.push(`/case/${invoice.caseId}` as any)}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginBottom: 8, padding: 12, backgroundColor: colors.surface, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}
          >
            <Ionicons name="file-tray-full-outline" size={16} color={colors.tint} />
            <Text style={{ fontSize: 13, color: colors.tint, fontFamily: "Inter_500Medium", flex: 1 }}>View associated case</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.tint} />
          </Pressable>
        )}

        <SectionHeader title={`Line Items (${lineItems.length})`} />
        <Card style={{ marginHorizontal: 16 }} padding="none">
          {lineItems.length === 0 ? (
            <View style={{ padding: 20, alignItems: "center" }}>
              <Text style={{ fontSize: 13, color: colors.textTertiary }}>No line items</Text>
            </View>
          ) : (
            lineItems.map((item, idx) => {
              const total = Number(item.lineTotal) || (Number(item.quantity || 1) * Number(item.unitPrice || 0));
              return (
                <View key={item.id || idx} style={{ padding: 14, borderBottomWidth: idx < lineItems.length - 1 ? StyleSheet.hairlineWidth : 0, borderBottomColor: colors.border }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: colors.text, marginBottom: 2 }} numberOfLines={2}>{item.description || "Item"}</Text>
                      {item.material && <Text style={{ fontSize: 12, color: colors.textTertiary }}>Material: {item.material}</Text>}
                      {item.toothNumbers && <Text style={{ fontSize: 12, color: colors.textTertiary }}>Tooth: {item.toothNumbers}</Text>}
                    </View>
                    <View style={{ alignItems: "flex-end", marginLeft: 12 }}>
                      <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: colors.tint }}>{fmtMoney(total)}</Text>
                      {Number(item.quantity) > 0 && (
                        <Text style={{ fontSize: 11, color: colors.textTertiary }}>{item.quantity} × {fmtMoney(item.unitPrice)}</Text>
                      )}
                    </View>
                  </View>
                </View>
              );
            })
          )}
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.canvas }}>
            <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: colors.text }}>Total</Text>
            <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: colors.text }}>{fmtMoney(invoice.total)}</Text>
          </View>
        </Card>

        {payments.length > 0 && (
          <>
            <SectionHeader title={`Payments (${payments.length})`} />
            <Card style={{ marginHorizontal: 16 }} padding="none">
              {payments.map((p, idx) => (
                <View key={p.id} style={{ flexDirection: "row", justifyContent: "space-between", padding: 14, borderBottomWidth: idx < payments.length - 1 ? StyleSheet.hairlineWidth : 0, borderBottomColor: colors.border }}>
                  <View>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: colors.text }}>{(p.method || "payment").replace(/_/g, " ")}</Text>
                    <Text style={{ fontSize: 11, color: colors.textTertiary }}>{fmtDate(p.paidAt)}</Text>
                    {p.notes && <Text style={{ fontSize: 11, color: colors.textSecondary }}>{p.notes}</Text>}
                  </View>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: colors.success }}>{fmtMoney(p.amount)}</Text>
                </View>
              ))}
            </Card>
          </>
        )}

        {invoice.notes && (
          <>
            <SectionHeader title="Notes" />
            <Card style={{ marginHorizontal: 16 }}>
              <Text style={{ fontSize: 14, color: colors.text, lineHeight: 20 }}>{invoice.notes}</Text>
            </Card>
          </>
        )}
      </ScrollView>

      {isOpen && balanceDue > 0 && (
        <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: 16, paddingBottom: 32, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
          <Pressable
            onPress={() => setPaymentModalVisible(true)}
            style={{ backgroundColor: colors.tint, borderRadius: 14, paddingVertical: 15, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 }}
          >
            <Ionicons name="cash-outline" size={18} color="#fff" />
            <Text style={{ color: "#fff", fontFamily: "Inter_700Bold", fontSize: 16 }}>Record Payment · {fmtMoney(balanceDue)}</Text>
          </Pressable>
        </View>
      )}

      <RecordPaymentModal
        visible={paymentModalVisible}
        onClose={() => setPaymentModalVisible(false)}
        onSave={load}
        invoiceId={id!}
        balanceDue={balanceDue}
      />
      <EmailModal
        visible={emailModalVisible}
        onClose={() => setEmailModalVisible(false)}
        invoiceId={id!}
        practiceName={practiceName}
      />
    </View>
  );
}
