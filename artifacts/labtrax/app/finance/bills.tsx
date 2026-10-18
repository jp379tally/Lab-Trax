import React, { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Card } from "@/components/ui/Card";
import { DismissKeyboardView, scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { NewVendorSheet, type NewVendorSheetHandle } from "@/components/NewVendorSheet";
import { getJson, isForbiddenError, sendJson, ApiError } from "@/lib/read-api";
import { canEditAnyLab, primaryLabOrgId, useMe } from "@/lib/auth-me";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { formatDate, formatMoney } from "@/lib/format";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { Bill, BillDetail, Category, Vendor, VendorApSummary, VendorCredit, cents, dollars, today, validDate } from "@/lib/accounts-payable";

type Filter = "open" | "paid" | "all";
type LineDraft = { key: string; categoryId: string; description: string; amount: string };
const newLine = (): LineDraft => ({ key: `${Date.now()}-${Math.random()}`, categoryId: "", description: "", amount: "" });

export default function BillsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const me = useMe();
  const organizationId = primaryLabOrgId(me.data);
  const allowed = canEditAnyLab(me.data);
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");
  const [entryOpen, setEntryOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);

  const params = useMemo(() => {
    if (!organizationId) return "";
    const p = new URLSearchParams({ organizationId, status: filter });
    if (search.trim()) p.set("search", search.trim());
    return p.toString();
  }, [organizationId, filter, search]);
  const bills = useQuery<Bill[]>({
    queryKey: ["finance", "bills", params],
    enabled: allowed && !!params,
    queryFn: () => getJson(`/api/finance/bills?${params}`),
  });

  if (!organizationId || !allowed) return <State title="Not available" body="Bills are available to lab owners, admins, and billing users." icon="lock-closed-outline" colors={colors} styles={styles} insets={insets} />;
  if (bills.isError) {
    const forbidden = isForbiddenError(bills.error);
    return <State title={forbidden ? "Not available" : "Couldn't load bills"} body={forbidden ? "You don't have permission to view bills for this lab." : "Check your connection and try again."} icon={forbidden ? "lock-closed-outline" : "cloud-offline-outline"} colors={colors} styles={styles} insets={insets} onRetry={() => void bills.refetch()} />;
  }
  const rows = bills.data ?? [];
  return (
    <DismissKeyboardView style={[styles.screen, { paddingTop: insets.top }]} testID="bills-keyboard-dismiss">
      <Header title="Bills" colors={colors} styles={styles} testID="bills-back" />
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode={scrollKeyboardDismissMode} refreshControl={<RefreshControl refreshing={bills.isFetching && !bills.isLoading} onRefresh={() => void bills.refetch()} tintColor={colors.tint} />} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}>
        <View style={styles.intro}><Text style={styles.eyebrow}>Accounts payable</Text><Text style={styles.heading}>Enter Bills</Text><Text style={styles.subtitle}>Track money the lab owes vendors. Saving raises what the lab owes and moves no money.</Text></View>
        <Pressable testID="bills-enter" style={styles.primary} onPress={() => setEntryOpen(true)}><Ionicons name="add" size={20} color={colors.textInverse} /><Text style={styles.primaryText}>Enter bill</Text></Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.chips}>
          {(["open", "paid", "all"] as Filter[]).map((key) => <Pressable key={key} testID={`bills-filter-${key}`} onPress={() => setFilter(key)} style={[styles.chip, filter === key && styles.chipActive]}><Text style={[styles.chipText, filter === key && styles.chipTextActive]}>{key === "open" ? "Unpaid" : key[0].toUpperCase() + key.slice(1)}</Text></Pressable>)}
        </ScrollView>
        <TextInput testID="bills-search" value={search} onChangeText={setSearch} placeholder="Search bill number, memo, vendor" placeholderTextColor={colors.textTertiary} style={styles.input} returnKeyType="search" onSubmitEditing={() => Keyboard.dismiss()} />
        <Card style={styles.card}>
          <View style={styles.between}><Text style={styles.sectionTitle}>Bills</Text><Text style={styles.amount}>{formatMoney(rows.reduce((sum, b) => sum + (cents(b.balanceDue) ?? 0) / 100, 0))} due</Text></View>
          {bills.isLoading ? <Loading text="Loading bills…" colors={colors} styles={styles} /> : rows.length === 0 ? <Empty text="No bills match this filter. Enter a bill to record what the lab owes without moving money yet." colors={colors} styles={styles} /> : rows.map((bill) => {
            const overdue = bill.status !== "paid" && bill.status !== "void" && bill.dueDate.slice(0, 10) < today();
            return <Pressable key={bill.id} testID={`bill-${bill.id}`} style={styles.billRow} onPress={() => setDetailId(bill.id)}>
              <View style={styles.flex}><Pressable testID={`bill-vendor-${bill.vendorId}`} onPress={() => setVendorId(bill.vendorId)}><Text style={styles.rowTitle}>{bill.vendorName || "Vendor"}{bill.vendorIsActive === false ? " (inactive)" : ""}</Text></Pressable><Text style={styles.muted}>Bill {bill.billNumber || "—"} · {statusLabel(bill.status)}</Text><Text style={overdue ? styles.warning : styles.muted}>Due {formatDate(bill.dueDate)}{overdue ? " · overdue" : ""}</Text></View><Text style={styles.rowAmount}>{formatMoney(bill.balanceDue)}</Text><Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
            </Pressable>;
          })}
        </Card>
      </ScrollView>
      {entryOpen && <BillEntry organizationId={organizationId} onClose={() => setEntryOpen(false)} onSaved={() => { setEntryOpen(false); void qc.invalidateQueries({ queryKey: ["finance"] }); }} />}
      {!!detailId && <BillDetailModal billId={detailId} onClose={() => setDetailId(null)} onVendor={(id) => { setDetailId(null); setVendorId(id); }} />}
      {!!vendorId && <VendorModal organizationId={organizationId} vendorId={vendorId} onClose={() => setVendorId(null)} onBill={(id) => { setVendorId(null); setDetailId(id); }} />}
    </DismissKeyboardView>
  );
}

function BillEntry({ organizationId, onClose, onSaved }: { organizationId: string; onClose: () => void; onSaved: () => void }) {
  const { colors } = useTheme(); const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [vendorId, setVendorId] = useState(""); const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState(today()); const [terms, setTerms] = useState("");
  const [dueDate, setDueDate] = useState(""); const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]); const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [newVendorOpen, setNewVendorOpen] = useState(false); const vendorSheet = useRef<NewVendorSheetHandle>(null);
  const [createdVendors, setCreatedVendors] = useState<Vendor[]>([]);
  const vendors = useQuery<Vendor[]>({ queryKey: ["finance", "vendors", organizationId], queryFn: () => getJson(`/api/finance/vendors?organizationId=${encodeURIComponent(organizationId)}&includeInactive=true`) });
  const categories = useQuery<Category[]>({ queryKey: ["finance", "categories", organizationId], queryFn: () => getJson(`/api/finance/categories?organizationId=${encodeURIComponent(organizationId)}`) });
  const totalCents = lines.reduce((sum, line) => sum + (cents(line.amount) ?? 0), 0);
  // Vendors created from this form come first, right after Add new vendor, so
  // the new selection is in view and stays put when the refreshed list arrives.
  const vendorOptions = useMemo(() => {
    const loaded = vendors.data ?? [];
    if (!createdVendors.length) return loaded;
    const created = createdVendors.map((c) => loaded.find((v) => v.id === c.id) ?? c);
    return [...created, ...loaded.filter((v) => !createdVendors.some((c) => c.id === v.id))];
  }, [vendors.data, createdVendors]);
  function pickVendor(v: Vendor) {
    if (!v.isActive) { setError("Reactivate this vendor before entering a new bill."); return; }
    setVendorId(v.id); if (v.paymentTermsDays != null) setTerms(String(v.paymentTermsDays)); setError(null);
  }
  function selectCreatedVendor(vendor: Vendor) {
    // Select straight from the save response, the same way as tapping its chip.
    // The vendor lists refresh in the background and are not needed for this.
    setCreatedVendors((old) => [...old.filter((v) => v.id !== vendor.id), vendor]);
    pickVendor(vendor);
    setNewVendorOpen(false);
  }
  const save = useMutation({
    mutationFn: async (acknowledge: boolean) => {
      if (!vendorId) throw new Error("Choose an active vendor.");
      if (!validDate(billDate)) throw new Error("Enter a valid bill date in YYYY-MM-DD format.");
      if (dueDate && (!validDate(dueDate) || dueDate < billDate)) throw new Error("Enter a valid due date on or after the bill date.");
      if (terms && (!/^\d+$/.test(terms) || +terms > 365)) throw new Error("Terms must be a whole number from 0 to 365.");
      for (const line of lines) {
        if (!line.description.trim()) throw new Error("Every line needs a description.");
        if (cents(line.amount) == null) throw new Error("Every line needs a valid amount with no more than two decimals.");
      }
      return sendJson("POST", "/api/finance/bills", {
        organizationId, vendorId, billNumber: billNumber.trim() || null, billDate,
        dueDate: dueDate || null, termsDays: terms === "" ? null : +terms, memo: memo.trim() || null,
        lines: lines.map((line) => ({ categoryId: line.categoryId || null, description: line.description.trim(), amount: dollars(cents(line.amount)!) })),
        ...(acknowledge ? { acknowledgeDuplicateReference: true } : {}),
      });
    },
    onSuccess: onSaved,
    onError: (err: Error) => {
      const body = err instanceof ApiError ? err.body as { error?: { code?: string; message?: string } } : undefined;
      if (body?.error?.code === "duplicate_bill_reference") { setDuplicate(body.error.message || "This vendor already has a bill with that number."); setError(null); }
      else { setDuplicate(null); setError(err.message); }
    },
  });
  const loadingError = vendors.isError || categories.isError;
  // Android's back button closes the New vendor sheet first, never the whole bill.
  return <Modal visible animationType="slide" onRequestClose={() => { if (newVendorOpen) vendorSheet.current?.requestClose(); else onClose(); }}>
    <DismissKeyboardView style={[styles.screen, { paddingTop: insets.top }]} testID="bill-entry-keyboard-dismiss"><View style={styles.modalHeader}><Pressable testID="bill-entry-close" onPress={onClose}><Ionicons name="close" size={25} color={colors.text} /></Pressable><Text style={styles.headerTitle}>Enter bill</Text></View>
      <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode={scrollKeyboardDismissMode} bottomOffset={64} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}>
        {loadingError ? <View style={styles.notice}><Text style={styles.error}>Couldn't load vendors or categories.</Text><Pressable style={styles.secondary} onPress={() => { void vendors.refetch(); void categories.refetch(); }}><Text style={styles.secondaryText}>Try again</Text></Pressable></View> : vendors.isLoading || categories.isLoading ? <Loading text="Loading form…" colors={colors} styles={styles} /> : <>
          <Field label="Vendor"><ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.chips}>
            <Pressable testID="bill-entry-vendor-add" accessibilityRole="button" style={[styles.chip, styles.addChip]} onPress={() => setNewVendorOpen(true)}><Text style={[styles.chipText, styles.chipTextActive]}>+ Add new vendor</Text></Pressable>
            {vendorOptions.map((v) => <Pressable key={v.id} testID={`bill-entry-vendor-${v.id}`} accessibilityState={{ selected: vendorId === v.id }} style={[styles.chip, vendorId === v.id && styles.chipActive, !v.isActive && styles.disabled]} onPress={() => pickVendor(v)}><Text style={[styles.chipText, vendorId === v.id && styles.chipTextActive]}>{v.name}{v.isActive ? "" : " (inactive)"}</Text></Pressable>)}
          </ScrollView></Field>
          <Field label="Bill number"><Input testID="bill-entry-number" value={billNumber} onChangeText={setBillNumber} colors={colors} styles={styles} placeholder="Vendor's reference" /></Field>
          <Field label="Bill date"><Input testID="bill-entry-date" value={billDate} onChangeText={setBillDate} colors={colors} styles={styles} placeholder="YYYY-MM-DD" /></Field>
          <Field label="Terms (days)"><Input testID="bill-entry-terms" value={terms} onChangeText={setTerms} colors={colors} styles={styles} keyboardType="number-pad" placeholder="30" /></Field>
          <Field label="Due date"><Input testID="bill-entry-due" value={dueDate} onChangeText={setDueDate} colors={colors} styles={styles} placeholder="Blank uses terms" /><Text style={styles.muted}>Leave blank to derive the due date from terms.</Text></Field>
          <Field label="Memo"><Input testID="bill-entry-memo" value={memo} onChangeText={setMemo} colors={colors} styles={styles} /></Field>
          <Text style={styles.sectionTitle}>Line items</Text>
          {lines.map((line, index) => <Card key={line.key} style={styles.lineCard}>
            <View style={styles.between}><Text style={styles.rowTitle}>Line {index + 1}</Text>{lines.length > 1 && <Pressable testID={`bill-line-remove-${index}`} onPress={() => setLines((old) => old.filter((_, i) => i !== index))}><Ionicons name="trash-outline" size={19} color={colors.error} /></Pressable>}</View>
            <Field label="Category"><ScrollView horizontal keyboardShouldPersistTaps="handled" contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}><Pressable style={[styles.chip, !line.categoryId && styles.chipActive]} onPress={() => setLines((old) => old.map((x, i) => i === index ? { ...x, categoryId: "" } : x))}><Text style={[styles.chipText, !line.categoryId && styles.chipTextActive]}>Uncategorized</Text></Pressable>{(categories.data ?? []).map((cat) => <Pressable key={cat.id} style={[styles.chip, line.categoryId === cat.id && styles.chipActive]} onPress={() => setLines((old) => old.map((x, i) => i === index ? { ...x, categoryId: cat.id } : x))}><Text style={[styles.chipText, line.categoryId === cat.id && styles.chipTextActive]}>{cat.name}</Text></Pressable>)}</ScrollView></Field>
            <Field label="Description"><Input testID={`bill-line-description-${index}`} value={line.description} onChangeText={(value) => setLines((old) => old.map((x, i) => i === index ? { ...x, description: value } : x))} colors={colors} styles={styles} /></Field>
            <Field label="Amount"><Input testID={`bill-line-amount-${index}`} value={line.amount} onChangeText={(value) => setLines((old) => old.map((x, i) => i === index ? { ...x, amount: value } : x))} colors={colors} styles={styles} keyboardType="decimal-pad" placeholder="0.00" /></Field>
          </Card>)}
          <Pressable testID="bill-line-add" style={styles.secondary} onPress={() => setLines((old) => [...old, newLine()])}><Text style={styles.secondaryText}>+ Add line</Text></Pressable>
          <View style={styles.total}><Text style={styles.sectionTitle}>Total</Text><Text style={styles.totalValue}>{formatMoney(dollars(totalCents))}</Text></View>
          <Text style={styles.muted}>Saving a bill raises what this vendor is owed. No money leaves a bank account until it is paid in Pay Bills.</Text>
          {!!duplicate && <View style={styles.warningBox}><Text style={styles.warning}>{duplicate}</Text><Pressable testID="bill-save-anyway" disabled={save.isPending} style={[styles.warningButton, save.isPending && styles.disabled]} onPress={() => save.mutate(true)}><Text style={styles.primaryText}>Save anyway</Text></Pressable></View>}
          {!!error && <Text style={styles.error}>{error}</Text>}
          <Pressable testID="bill-save" disabled={save.isPending} style={[styles.primary, save.isPending && styles.disabled]} onPress={() => save.mutate(false)}>{save.isPending ? <ActivityIndicator color={colors.textInverse} /> : <Ionicons name="save-outline" size={18} color={colors.textInverse} />}<Text style={styles.primaryText}>{save.isPending ? "Saving…" : "Save bill"}</Text></Pressable>
        </>}
      </KeyboardAwareScrollView>
    </DismissKeyboardView>
    {/* An overlay inside the bill's modal; a second native modal may not appear on iOS. */}
    {newVendorOpen && <NewVendorSheet ref={vendorSheet} organizationId={organizationId} onClose={() => setNewVendorOpen(false)} onSaved={selectCreatedVendor} />}
  </Modal>;
}

function BillDetailModal({ billId, onClose, onVendor }: { billId: string; onClose: () => void; onVendor: (id: string) => void }) {
  const { colors } = useTheme(); const styles = useMemo(() => makeStyles(colors), [colors]); const insets = useSafeAreaInsets(); const qc = useQueryClient();
  const [reason, setReason] = useState(""); const [error, setError] = useState<string | null>(null);
  const detail = useQuery<BillDetail>({ queryKey: ["finance", "bill", billId], queryFn: () => getJson(`/api/finance/bills/${encodeURIComponent(billId)}`) });
  const voidBill = useMutation({ mutationFn: () => sendJson("POST", `/api/finance/bills/${encodeURIComponent(billId)}/void`, { reason: reason.trim() || null }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["finance"] }); onClose(); }, onError: (e: Error) => setError(e.message) });
  const bill = detail.data;
  return <Modal visible animationType="slide" onRequestClose={onClose}><DismissKeyboardView style={[styles.screen, { paddingTop: insets.top }]} testID="bill-detail-keyboard-dismiss"><View style={styles.modalHeader}><Pressable testID="bill-detail-close" onPress={onClose}><Ionicons name="close" size={25} color={colors.text} /></Pressable><Text style={styles.headerTitle}>Bill detail</Text></View><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode={scrollKeyboardDismissMode} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}>
    {detail.isLoading ? <Loading text="Loading bill…" colors={colors} styles={styles} /> : detail.isError ? <InlineError text="Couldn't load this bill." retry={() => void detail.refetch()} styles={styles} /> : bill && <>
      <Card style={styles.card}><Pressable testID="bill-detail-vendor" onPress={() => onVendor(bill.vendorId)}><Text style={styles.heading}>{bill.vendorName}{bill.vendorIsActive === false ? " (inactive)" : ""}</Text><Text style={styles.link}>View vendor A/P activity</Text></Pressable><Text style={styles.muted}>{bill.billNumber ? `Bill ${bill.billNumber} · ` : ""}{formatDate(bill.billDate)} · due {formatDate(bill.dueDate)}</Text><View style={styles.between}><Text style={styles.sectionTitle}>{statusLabel(bill.status)}</Text><Text style={styles.totalValue}>{formatMoney(bill.balanceDue)}</Text></View>{!!bill.memo && <Text style={styles.muted}>{bill.memo}</Text>}</Card>
      <Card style={styles.card}><Text style={styles.sectionTitle}>Lines</Text>{bill.lines.map((line) => <View key={line.id} style={styles.between}><Text style={styles.flexText}>{line.description}</Text><Text style={styles.amount}>{formatMoney(line.amount)}</Text></View>)}</Card>
      <Card style={styles.card}><Text style={styles.sectionTitle}>Payments and credits applied</Text>{!bill.payments.length ? <Text style={styles.muted}>Nothing has been applied.</Text> : bill.payments.map((p) => <View key={p.allocationId} style={styles.history}><Text style={styles.rowTitle}>{p.fundedByCredit ? "Vendor credit" : p.paymentMethod.toUpperCase()} · {formatMoney(p.amount)}</Text><Text style={styles.muted}>{formatDate(p.paymentDate)}{p.referenceNumber ? ` · ${p.referenceNumber}` : ""}{p.reversedAt ? " · reversed" : ""}</Text></View>)}</Card>
      <Card style={styles.card}><Text style={styles.sectionTitle}>Event history</Text>{bill.events.map((event) => <View key={event.id} style={styles.history}><Text style={styles.rowTitle}>{event.eventType.replace(/_/g, " ")}</Text><Text style={styles.muted}>{formatDate(event.occurredAt)}</Text></View>)}</Card>
      {bill.status !== "void" && <Card style={styles.card}><Text style={styles.sectionTitle}>Void bill</Text><Input testID="bill-void-reason" value={reason} onChangeText={setReason} colors={colors} styles={styles} placeholder="Reason (optional)" />{!!error && <Text style={styles.error}>{error}</Text>}<Pressable testID="bill-void" disabled={voidBill.isPending} style={[styles.danger, voidBill.isPending && styles.disabled]} onPress={() => voidBill.mutate()}>{voidBill.isPending && <ActivityIndicator color={colors.textInverse} />}<Text style={styles.primaryText}>{voidBill.isPending ? "Voiding…" : "Void bill"}</Text></Pressable></Card>}
    </>}
  </ScrollView></DismissKeyboardView></Modal>;
}

function VendorModal({ organizationId, vendorId, onClose, onBill }: { organizationId: string; vendorId: string; onClose: () => void; onBill: (id: string) => void }) {
  const { colors } = useTheme(); const styles = useMemo(() => makeStyles(colors), [colors]); const insets = useSafeAreaInsets(); const qc = useQueryClient();
  const [showCredit, setShowCredit] = useState(false); const [number, setNumber] = useState(""); const [date, setDate] = useState(today()); const [amount, setAmount] = useState(""); const [memo, setMemo] = useState(""); const [categoryId, setCategoryId] = useState(""); const [error, setError] = useState<string | null>(null);
  const summary = useQuery<VendorApSummary>({ queryKey: ["finance", "ap-summary", organizationId, vendorId], queryFn: () => getJson(`/api/finance/vendors/${encodeURIComponent(vendorId)}/ap-summary?organizationId=${encodeURIComponent(organizationId)}`) });
  const categories = useQuery<Category[]>({ queryKey: ["finance", "categories", organizationId], queryFn: () => getJson(`/api/finance/categories?organizationId=${encodeURIComponent(organizationId)}`) });
  const credit = useMutation({ mutationFn: () => {
    const amountCents = cents(amount); if (!validDate(date)) throw new Error("Enter a valid credit date."); if (amountCents == null || amountCents <= 0) throw new Error("Enter a credit amount greater than zero.");
    return sendJson("POST", "/api/finance/vendor-credits", { organizationId, vendorId, creditNumber: number.trim() || null, creditDate: date, categoryId: categoryId || null, memo: memo.trim() || null, amount: dollars(amountCents) });
  }, onSuccess: () => { setShowCredit(false); setAmount(""); setMemo(""); setNumber(""); setError(null); void summary.refetch(); void qc.invalidateQueries({ queryKey: ["finance"] }); }, onError: (e: Error) => setError(e.message) });
  const data = summary.data;
  return <Modal visible animationType="slide" onRequestClose={onClose}><DismissKeyboardView style={[styles.screen, { paddingTop: insets.top }]} testID="vendor-ap-keyboard-dismiss"><View style={styles.modalHeader}><Pressable testID="vendor-ap-close" onPress={onClose}><Ionicons name="close" size={25} color={colors.text} /></Pressable><Text style={styles.headerTitle}>Vendor A/P</Text></View><KeyboardAwareScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode={scrollKeyboardDismissMode} bottomOffset={60} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}>
    {summary.isLoading ? <Loading text="Loading vendor activity…" colors={colors} styles={styles} /> : summary.isError ? <InlineError text="Couldn't load vendor A/P activity." retry={() => void summary.refetch()} styles={styles} /> : data && <>
      <View style={styles.intro}><Text style={styles.heading}>{data.vendor.name}{data.vendor.isActive ? "" : " (inactive)"}</Text><Text style={styles.subtitle}>Vendor bills, credits, and payments remain viewable when inactive.</Text></View>
      <View style={styles.metrics}><Metric label="Amount due" value={data.amountDue} styles={styles} /><Metric label="Overdue" value={data.overdueAmount} styles={styles} warning /><Metric label="Unapplied credit" value={data.unappliedCreditAmount} styles={styles} /></View>
      <Pressable testID="vendor-credit-open" disabled={!data.vendor.isActive} style={[styles.primary, !data.vendor.isActive && styles.disabled]} onPress={() => setShowCredit(!showCredit)}><Ionicons name="add-circle-outline" size={19} color={colors.textInverse} /><Text style={styles.primaryText}>{data.vendor.isActive ? "Record vendor credit" : "Reactivate vendor to record credit"}</Text></Pressable>
      {showCredit && <Card style={styles.card}><Text style={styles.sectionTitle}>New vendor credit</Text><Field label="Credit number"><Input testID="vendor-credit-number" value={number} onChangeText={setNumber} colors={colors} styles={styles} /></Field><Field label="Credit date"><Input testID="vendor-credit-date" value={date} onChangeText={setDate} colors={colors} styles={styles} /></Field><Field label="Amount"><Input testID="vendor-credit-amount" value={amount} onChangeText={setAmount} colors={colors} styles={styles} keyboardType="decimal-pad" /></Field><Field label="Category"><ScrollView horizontal keyboardShouldPersistTaps="handled" contentContainerStyle={styles.chips}>{(categories.data ?? []).map((cat) => <Pressable key={cat.id} onPress={() => setCategoryId(cat.id)} style={[styles.chip, categoryId === cat.id && styles.chipActive]}><Text style={[styles.chipText, categoryId === cat.id && styles.chipTextActive]}>{cat.name}</Text></Pressable>)}</ScrollView></Field><Field label="Memo"><Input testID="vendor-credit-memo" value={memo} onChangeText={setMemo} colors={colors} styles={styles} /></Field>{!!error && <Text style={styles.error}>{error}</Text>}<Pressable testID="vendor-credit-save" disabled={credit.isPending} style={[styles.primary, credit.isPending && styles.disabled]} onPress={() => credit.mutate()}>{credit.isPending && <ActivityIndicator color={colors.textInverse} />}<Text style={styles.primaryText}>{credit.isPending ? "Saving…" : "Save credit"}</Text></Pressable></Card>}
      <Card style={styles.card}><Text style={styles.sectionTitle}>Bills</Text>{!data.bills.length ? <Text style={styles.muted}>No bills.</Text> : data.bills.map((b) => <Pressable key={b.id} style={styles.history} onPress={() => onBill(b.id)}><View style={styles.between}><Text style={styles.rowTitle}>{b.billNumber || "Bill"}</Text><Text style={styles.amount}>{formatMoney(b.balanceDue)}</Text></View><Text style={styles.muted}>{formatDate(b.billDate)} · {statusLabel(b.status)}</Text></Pressable>)}</Card>
      <Card style={styles.card}><Text style={styles.sectionTitle}>Credits</Text>{!data.credits.length ? <Text style={styles.muted}>No credits.</Text> : data.credits.map((c) => <View key={c.id} style={styles.history}><Text style={styles.rowTitle}>{c.creditNumber || "Credit"} · {formatMoney(c.amount)}</Text><Text style={styles.muted}>{formatDate(c.creditDate)} · {formatMoney(c.remainingAmount)} remaining</Text></View>)}</Card>
      <Card style={styles.card}><Text style={styles.sectionTitle}>Payments</Text>{!data.payments.length ? <Text style={styles.muted}>No payments.</Text> : data.payments.map((p) => <View key={p.id} style={styles.history}><Text style={styles.rowTitle}>{p.paymentMethod.toUpperCase()} · {formatMoney(p.totalAmount)}</Text><Text style={styles.muted}>{formatDate(p.paymentDate)}{p.referenceNumber ? ` · ${p.referenceNumber}` : ""}</Text></View>)}</Card>
    </>}
  </KeyboardAwareScrollView></DismissKeyboardView></Modal>;
}

function Header({ title, colors, styles, testID }: { title: string; colors: ThemeColors; styles: ReturnType<typeof makeStyles>; testID: string }) { return <View style={styles.header}><Pressable testID={testID} onPress={() => router.back()} hitSlop={8}><Ionicons name="chevron-back" size={26} color={colors.text} /></Pressable><Text style={styles.headerTitle}>{title}</Text></View>; }
function State({ title, body, icon, colors, styles, insets, onRetry }: { title: string; body: string; icon: React.ComponentProps<typeof Ionicons>["name"]; colors: ThemeColors; styles: ReturnType<typeof makeStyles>; insets: { top: number }; onRetry?: () => void }) { return <View style={[styles.screen, { paddingTop: insets.top }]}><Header title="Bills" colors={colors} styles={styles} testID="bills-back" /><View style={styles.empty}><Ionicons name={icon} size={42} color={colors.textTertiary} /><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyBody}>{body}</Text>{onRetry && <Pressable style={styles.secondary} onPress={onRetry}><Text style={styles.secondaryText}>Try again</Text></Pressable>}</View></View>; }
function Loading({ text, colors, styles }: { text: string; colors: ThemeColors; styles: ReturnType<typeof makeStyles> }) { return <View style={styles.loading}><ActivityIndicator color={colors.tint} /><Text style={styles.muted}>{text}</Text></View>; }
function Empty({ text, colors, styles }: { text: string; colors: ThemeColors; styles: ReturnType<typeof makeStyles> }) { return <View style={styles.emptyInline}><Ionicons name="document-text-outline" size={32} color={colors.textTertiary} /><Text style={styles.muted}>{text}</Text></View>; }
function InlineError({ text, retry, styles }: { text: string; retry: () => void; styles: ReturnType<typeof makeStyles> }) { return <View style={styles.notice}><Text style={styles.error}>{text}</Text><Pressable style={styles.secondary} onPress={retry}><Text style={styles.secondaryText}>Try again</Text></Pressable></View>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { const { colors } = useTheme(); const styles = useMemo(() => makeStyles(colors), [colors]); return <View style={styles.field}><Text style={styles.label}>{label}</Text>{children}</View>; }
function Input(props: React.ComponentProps<typeof TextInput> & { colors: ThemeColors; styles: ReturnType<typeof makeStyles> }) { const { colors, styles, ...rest } = props; return <TextInput {...rest} placeholderTextColor={colors.textTertiary} style={styles.input} />; }
function Metric({ label, value, styles, warning }: { label: string; value: string; styles: ReturnType<typeof makeStyles>; warning?: boolean }) { return <View style={styles.metric}><Text style={styles.muted}>{label}</Text><Text style={warning ? styles.warningAmount : styles.metricAmount}>{formatMoney(value)}</Text></View>; }
function statusLabel(value: string) { return ({ open: "Unpaid", partially_paid: "Partly paid", paid: "Paid", void: "Void" } as Record<string, string>)[value] || value; }

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid }, header: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm }, modalHeader: { flexDirection: "row", alignItems: "center", gap: Spacing.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }, headerTitle: { ...Typography.h1, color: c.text }, content: { padding: Spacing.lg, gap: Spacing.md }, intro: { gap: 3 }, eyebrow: { ...Typography.label, color: c.tint }, heading: { ...Typography.h1, color: c.text }, subtitle: { ...Typography.caption, color: c.textSecondary }, card: { gap: Spacing.md }, lineCard: { gap: Spacing.sm, backgroundColor: c.surfaceAlt }, sectionTitle: { ...Typography.bodyLgMedium, color: c.text }, rowTitle: { ...Typography.bodySemibold, color: c.text }, muted: { ...Typography.caption, color: c.textSecondary }, flex: { flex: 1 }, flexText: { flex: 1, ...Typography.body, color: c.text }, between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.md }, chips: { gap: Spacing.sm }, chip: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.full, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, backgroundColor: c.surfaceAlt }, chipActive: { borderColor: c.tint, backgroundColor: c.tintLight }, chipText: { ...Typography.captionSemibold, color: c.textSecondary }, chipTextActive: { color: c.tint }, addChip: { borderStyle: "dashed", borderColor: c.tint }, input: { minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, backgroundColor: c.surfaceAlt, color: c.text, paddingHorizontal: Spacing.md, ...Typography.body }, field: { gap: Spacing.xs }, label: { ...Typography.captionSemibold, color: c.textSecondary }, primary: { minHeight: 48, borderRadius: Radius.full, backgroundColor: c.tint, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: Spacing.sm }, primaryText: { ...Typography.bodySemibold, color: c.textInverse }, secondary: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.full, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, alignSelf: "flex-start" }, secondaryText: { ...Typography.captionSemibold, color: c.tint }, danger: { minHeight: 46, borderRadius: Radius.full, backgroundColor: c.error, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.sm }, disabled: { opacity: 0.5 }, billRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: Spacing.md }, rowAmount: { ...Typography.bodySemibold, color: c.text }, amount: { ...Typography.bodySemibold, color: c.text }, warning: { ...Typography.captionSemibold, color: c.warning }, warningBox: { borderWidth: 1, borderColor: c.warning, backgroundColor: c.warningSurface, borderRadius: Radius.md, padding: Spacing.md, gap: Spacing.sm }, warningButton: { minHeight: 42, borderRadius: Radius.full, backgroundColor: c.warning, alignItems: "center", justifyContent: "center" }, error: { ...Typography.caption, color: c.error, backgroundColor: c.errorSurface, padding: Spacing.sm, borderRadius: Radius.sm }, link: { ...Typography.captionSemibold, color: c.tint, marginTop: 2 }, total: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: c.border, paddingTop: Spacing.md }, totalValue: { ...Typography.h2, color: c.text }, history: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: Spacing.sm, gap: 2 }, loading: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: Spacing.sm, padding: Spacing.xl }, notice: { gap: Spacing.md, alignItems: "center" }, emptyInline: { alignItems: "center", gap: Spacing.sm, padding: Spacing.xl }, empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: Spacing.sm, padding: Spacing.xxxl }, emptyTitle: { ...Typography.h2, color: c.text, textAlign: "center" }, emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" }, metrics: { flexDirection: "row", gap: Spacing.sm }, metric: { flex: 1, borderRadius: Radius.md, backgroundColor: c.surfaceAlt, padding: Spacing.md, gap: 3 }, metricAmount: { ...Typography.bodySemibold, color: c.text }, warningAmount: { ...Typography.bodySemibold, color: c.warning },
  });
}