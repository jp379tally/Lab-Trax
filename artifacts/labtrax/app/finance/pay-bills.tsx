import React, { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Card } from "@/components/ui/Card";
import { DismissKeyboardView, scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { getJson, isForbiddenError, sendJson } from "@/lib/read-api";
import { canEditAnyLab, primaryLabOrgId, useMe } from "@/lib/auth-me";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { formatDate, formatMoney } from "@/lib/format";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { Account, PayBillsVendor, cents, dollars, newKey, plusDays, spreadCreditApplications, today, validDate } from "@/lib/accounts-payable";

type DueFilter = "all" | "today" | "30";
type Drafts = Record<string, { cash: string; credit: string }>;
const METHODS = ["check", "ach", "card", "cash", "other"] as const;

export default function PayBillsScreen() {
  const { colors } = useTheme(); const styles = useMemo(() => makeStyles(colors), [colors]); const insets = useSafeAreaInsets();
  const me = useMe(); const organizationId = primaryLabOrgId(me.data); const allowed = canEditAnyLab(me.data); const qc = useQueryClient();
  const [filter, setFilter] = useState<DueFilter>("all"); const [drafts, setDrafts] = useState<Drafts>({});
  const [paymentDate, setPaymentDate] = useState(today()); const [method, setMethod] = useState<(typeof METHODS)[number]>("check");
  const [accountId, setAccountId] = useState(""); const [reference, setReference] = useState(""); const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null); const [result, setResult] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newKey("mobile-pay-bills"));
  const submissionInFlight = useRef(false);
  const params = useMemo(() => {
    if (!organizationId) return "";
    const p = new URLSearchParams({ organizationId });
    if (filter === "today") p.set("dueBefore", today());
    if (filter === "30") p.set("dueBefore", plusDays(30));
    return p.toString();
  }, [organizationId, filter]);
  const payBills = useQuery<{ vendors: PayBillsVendor[] }>({ queryKey: ["finance", "pay-bills", params], enabled: allowed && !!params, queryFn: () => getJson(`/api/finance/pay-bills?${params}`) });
  const accounts = useQuery<Account[]>({ queryKey: ["finance-accounts", organizationId ?? ""], enabled: allowed && !!organizationId, queryFn: () => getJson(`/api/finance/accounts?organizationId=${encodeURIComponent(organizationId!)}`) });
  const bankAccounts = (accounts.data ?? []).filter((a) => !a.isArchived && a.accountType !== "undeposited_funds");
  const effectiveAccountId = bankAccounts.some((a) => a.id === accountId) ? accountId : bankAccounts[0]?.id ?? "";
  const vendors = payBills.data?.vendors ?? [];
  const selection = useMemo(() => {
    let cash = 0, credit = 0, billCount = 0; const vendorIds = new Set<string>();
    for (const vendor of vendors) for (const bill of vendor.bills) {
      const entry = drafts[bill.id]; if (!entry) continue;
      const c = cents(entry.cash) ?? 0, cr = cents(entry.credit) ?? 0;
      cash += c; credit += cr; billCount++; vendorIds.add(vendor.vendorId);
    }
    return { cash, credit, billCount, vendorCount: vendorIds.size };
  }, [vendors, drafts]);

  const mutation = useMutation({
    mutationFn: async () => {
      const problem = validate(vendors, drafts, paymentDate, effectiveAccountId, selection.cash);
      if (problem) throw new Error(problem);
      const vendorPayments = vendors.flatMap((vendor) => {
        const remainingCredits = vendor.credits.map((credit) => ({ id: credit.id, cents: cents(credit.remainingAmount) ?? 0 }));
        const allocations = vendor.bills.flatMap((bill) => {
          const draft = drafts[bill.id]; if (!draft) return [];
          const cashCents = cents(draft.cash) ?? 0; const creditCents = cents(draft.credit) ?? 0;
          const creditApplications = spreadCreditApplications(
            remainingCredits.map((credit) => ({ id: credit.id, remainingAmount: dollars(credit.cents) })),
            creditCents,
          );
          for (const application of creditApplications) {
            const credit = remainingCredits.find((item) => item.id === application.vendorCreditId);
            if (credit) credit.cents -= cents(application.amount) ?? 0;
          }
          return [{ billId: bill.id, amount: dollars(cashCents), creditApplications }];
        });
        return allocations.length ? [{ vendorId: vendor.vendorId, allocations }] : [];
      });
      return sendJson<{ payments: Array<{ id: string; amount: string }>; replayed: boolean }>("POST", "/api/finance/bill-payments", {
        organizationId, paymentDate, paymentMethod: method, bankAccountId: selection.cash > 0 ? effectiveAccountId : null,
        referenceNumber: reference.trim() || null, memo: memo.trim() || null, idempotencyKey, vendorPayments,
      });
    },
    onSuccess: (data) => {
      const count = data.payments?.length ?? 0;
      setResult(`Recorded ${count} separate vendor payment${count === 1 ? "" : "s"}.${selection.cash > 0 ? " The bank withdrawal is in the register." : " No cash moved — the bills were paid entirely with vendor credit."}${count > 1 ? " A distinct payment and withdrawal was created for each vendor." : ""}`);
      setDrafts({}); setReference(""); setMemo(""); setError(null); setIdempotencyKey(newKey("mobile-pay-bills"));
      void qc.invalidateQueries({ queryKey: ["finance"] }); void qc.invalidateQueries({ queryKey: ["bank-transactions"] });
    },
    onError: (e: Error) => setError(e.message),
  });
  if (!organizationId || !allowed) return <State colors={colors} styles={styles} insets={insets} title="Not available" body="Pay Bills is available to lab owners, admins, and billing users." icon="lock-closed-outline" />;
  if (payBills.isError || accounts.isError) {
    const forbidden = isForbiddenError(payBills.error) || isForbiddenError(accounts.error);
    return <State colors={colors} styles={styles} insets={insets} title={forbidden ? "Not available" : "Couldn't load outstanding bills"} body={forbidden ? "You don't have permission to pay bills for this lab." : "Check your connection and try again."} icon={forbidden ? "lock-closed-outline" : "cloud-offline-outline"} onRetry={() => { void payBills.refetch(); void accounts.refetch(); }} />;
  }
  return <DismissKeyboardView style={[styles.screen, { paddingTop: insets.top }]} testID="pay-bills-keyboard-dismiss">
    <Header colors={colors} styles={styles} />
    <KeyboardAwareScrollView refreshControl={<RefreshControl refreshing={payBills.isFetching && !payBills.isLoading} onRefresh={() => void payBills.refetch()} tintColor={colors.tint} />} keyboardShouldPersistTaps="handled" keyboardDismissMode={scrollKeyboardDismissMode} bottomOffset={72} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}>
      <View style={styles.intro}><Text style={styles.eyebrow}>Accounts payable</Text><Text style={styles.heading}>Pay Bills</Text><Text style={styles.subtitle}>Record payments against outstanding vendor bills. LabTrax records money you already sent; it does not send funds.</Text></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.chips}>{([["all", "All"], ["today", "Due today or earlier"], ["30", "Due in 30 days"]] as const).map(([key, label]) => <Pressable key={key} testID={`pay-bills-filter-${key}`} style={[styles.chip, filter === key && styles.chipActive]} onPress={() => { setFilter(key); setDrafts({}); }}><Text style={[styles.chipText, filter === key && styles.chipTextActive]}>{label}</Text></Pressable>)}</ScrollView>
      {payBills.isLoading || accounts.isLoading ? <Loading colors={colors} styles={styles} /> : vendors.length === 0 ? <Card style={styles.empty}><Ionicons name="checkmark-circle-outline" size={36} color={colors.success} /><Text style={styles.sectionTitle}>No outstanding bills</Text><Text style={styles.muted}>Enter a bill first, or use the register when there is no bill to track.</Text></Card> : vendors.map((vendor) => <Card key={vendor.vendorId} style={styles.card}>
        <View style={styles.between}><View style={styles.flex}><Text style={styles.sectionTitle}>{vendor.vendorName}{vendor.vendorIsActive ? "" : " (inactive)"}</Text><Text style={styles.muted}>{formatMoney(vendor.totalDue)} due{(cents(vendor.availableCredit) ?? 0) > 0 ? ` · ${formatMoney(vendor.availableCredit)} credit available` : ""}</Text></View></View>
        {vendor.bills.map((bill) => {
          const selected = !!drafts[bill.id]; const overdue = bill.dueDate.slice(0, 10) < today();
          return <View key={bill.id} style={[styles.bill, selected && styles.selected]}>
            <Pressable testID={`pay-bill-${bill.id}`} style={styles.selectRow} onPress={() => setDrafts((old) => { if (old[bill.id]) { const next = { ...old }; delete next[bill.id]; return next; } return { ...old, [bill.id]: { cash: ((cents(bill.balanceDue) ?? 0) / 100).toFixed(2), credit: "" } }; })}><View style={[styles.checkbox, selected && styles.checkboxOn]}>{selected && <Ionicons name="checkmark" size={14} color={colors.textInverse} />}</View><View style={styles.flex}><Text style={styles.rowTitle}>Bill {bill.billNumber || "—"}</Text><Text style={overdue ? styles.warning : styles.muted}>Due {formatDate(bill.dueDate)} · {formatMoney(bill.balanceDue)}</Text></View></Pressable>
            {selected && <View style={styles.amountFields}><Field label="Cash payment"><Input testID={`pay-bill-cash-${bill.id}`} value={drafts[bill.id].cash} onChangeText={(cash) => setDrafts((old) => ({ ...old, [bill.id]: { ...old[bill.id], cash } }))} styles={styles} colors={colors} /></Field><Field label="Vendor credit"><Input testID={`pay-bill-credit-${bill.id}`} editable={(cents(vendor.availableCredit) ?? 0) > 0} value={drafts[bill.id].credit} onChangeText={(credit) => setDrafts((old) => ({ ...old, [bill.id]: { ...old[bill.id], credit } }))} styles={styles} colors={colors} /></Field></View>}
          </View>;
        })}
      </Card>)}
      {!!vendors.length && <Card style={styles.card}>
        <Text style={styles.sectionTitle}>Payment details</Text>
        <Field label="Payment date"><Input testID="pay-bills-date" value={paymentDate} onChangeText={setPaymentDate} styles={styles} colors={colors} /></Field>
        <Field label="Method"><ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.chips}>{METHODS.map((value) => <Pressable key={value} testID={`pay-bills-method-${value}`} style={[styles.chip, method === value && styles.chipActive]} onPress={() => setMethod(value)}><Text style={[styles.chipText, method === value && styles.chipTextActive]}>{value.toUpperCase()}</Text></Pressable>)}</ScrollView></Field>
        <Field label="Pay from">{selection.cash <= 0 ? <Text style={styles.muted}>No bank account needed when the entire run is funded by credit.</Text> : bankAccounts.length === 0 ? <Text style={styles.warning}>Add an active bank account before recording a cash payment.</Text> : bankAccounts.map((account) => <Pressable key={account.id} testID={`pay-bills-account-${account.id}`} style={[styles.account, effectiveAccountId === account.id && styles.selected]} onPress={() => setAccountId(account.id)}><Ionicons name={effectiveAccountId === account.id ? "radio-button-on" : "radio-button-off"} size={21} color={effectiveAccountId === account.id ? colors.tint : colors.textTertiary} /><Text style={styles.rowTitle}>{account.name}</Text></Pressable>)}</Field>
        <Field label="Reference / check number"><Input testID="pay-bills-reference" value={reference} onChangeText={setReference} styles={styles} colors={colors} /></Field>
        <Field label="Memo"><Input testID="pay-bills-memo" value={memo} onChangeText={setMemo} styles={styles} colors={colors} keyboardType="default" autoCorrect={true} spellCheck={true} autoCapitalize="sentences" /></Field>
        <View style={styles.total}><Text style={styles.sectionTitle}>Cash</Text><Text style={styles.totalValue}>{formatMoney(dollars(selection.cash))}</Text></View><View style={styles.total}><Text style={styles.sectionTitle}>Credit</Text><Text style={styles.credit}>{formatMoney(dollars(selection.credit))}</Text></View>
        <Text style={styles.muted}>{selection.vendorCount > 1 ? `This run creates ${selection.vendorCount} separate vendor payments and one bank withdrawal per vendor with cash.` : "One vendor payment will be recorded."}</Text>
        {!!error && <Text style={styles.error}>{error}</Text>}{!!result && <Text style={styles.success}>{result}</Text>}
        <Pressable testID="pay-bills-submit" disabled={mutation.isPending || !selection.billCount} style={[styles.primary, (mutation.isPending || !selection.billCount) && styles.disabled]} onPress={() => { if (submissionInFlight.current) return; submissionInFlight.current = true; setError(null); setResult(null); mutation.mutate(undefined, { onSettled: () => { submissionInFlight.current = false; } }); }}>{mutation.isPending ? <ActivityIndicator color={colors.textInverse} /> : <Ionicons name="checkmark-circle-outline" size={19} color={colors.textInverse} />}<Text style={styles.primaryText}>{mutation.isPending ? "Recording…" : "Record payment"}</Text></Pressable>
      </Card>}
    </KeyboardAwareScrollView>
  </DismissKeyboardView>;
}

function validate(vendors: PayBillsVendor[], drafts: Drafts, date: string, accountId: string, cashTotal: number): string | null {
  if (!Object.keys(drafts).length) return "Select at least one bill to pay.";
  if (!validDate(date)) return "Enter a valid payment date in YYYY-MM-DD format.";
  if (cashTotal > 0 && !accountId) return "Choose the bank account the money comes from.";
  for (const vendor of vendors) {
    let used = 0;
    for (const bill of vendor.bills) {
      const draft = drafts[bill.id]; if (!draft) continue;
      const cash = cents(draft.cash), credit = cents(draft.credit);
      if (cash == null || credit == null) return `Enter valid amounts for bill ${bill.billNumber || bill.id}. Use no more than two decimals.`;
      if (cash < 0 || credit < 0) return "Payment and credit amounts cannot be negative.";
      if (cash + credit <= 0) return `Enter a payment or credit amount for bill ${bill.billNumber || bill.id}.`;
      if (cash + credit > (cents(bill.balanceDue) ?? 0)) return `Bill ${bill.billNumber || bill.id} for ${vendor.vendorName} only owes ${formatMoney(bill.balanceDue)}.`;
      used += credit;
    }
    if (used > (cents(vendor.availableCredit) ?? 0)) return `${vendor.vendorName} only has ${formatMoney(vendor.availableCredit)} of credit available.`;
  }
  return null;
}
function Header({ colors, styles }: { colors: ThemeColors; styles: ReturnType<typeof makeStyles> }) { return <View style={styles.header}><Pressable testID="pay-bills-back" onPress={() => router.back()}><Ionicons name="chevron-back" size={26} color={colors.text} /></Pressable><Text style={styles.headerTitle}>Pay Bills</Text></View>; }
function State({ colors, styles, insets, title, body, icon, onRetry }: { colors: ThemeColors; styles: ReturnType<typeof makeStyles>; insets: { top: number }; title: string; body: string; icon: React.ComponentProps<typeof Ionicons>["name"]; onRetry?: () => void }) { return <View style={[styles.screen, { paddingTop: insets.top }]}><Header colors={colors} styles={styles} /><View style={styles.empty}><Ionicons name={icon} size={42} color={colors.textTertiary} /><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyBody}>{body}</Text>{onRetry && <Pressable style={styles.secondary} onPress={onRetry}><Text style={styles.secondaryText}>Try again</Text></Pressable>}</View></View>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { const { colors } = useTheme(); const styles = useMemo(() => makeStyles(colors), [colors]); return <View style={styles.field}><Text style={styles.label}>{label}</Text>{children}</View>; }
function Input({ colors, styles, ...props }: React.ComponentProps<typeof TextInput> & { colors: ThemeColors; styles: ReturnType<typeof makeStyles> }) { return <TextInput keyboardType="decimal-pad" {...props} placeholderTextColor={colors.textTertiary} style={styles.input} />; }
function Loading({ colors, styles }: { colors: ThemeColors; styles: ReturnType<typeof makeStyles> }) { return <View style={styles.loading}><ActivityIndicator color={colors.tint} /><Text style={styles.muted}>Loading outstanding bills…</Text></View>; }
function makeStyles(c: ThemeColors) { return StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.backgroundSolid }, header: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm }, headerTitle: { ...Typography.h1, color: c.text }, content: { padding: Spacing.lg, gap: Spacing.md }, intro: { gap: 3 }, eyebrow: { ...Typography.label, color: c.tint }, heading: { ...Typography.h1, color: c.text }, subtitle: { ...Typography.caption, color: c.textSecondary }, chips: { gap: Spacing.sm }, chip: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.full, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, backgroundColor: c.surfaceAlt }, chipActive: { borderColor: c.tint, backgroundColor: c.tintLight }, chipText: { ...Typography.captionSemibold, color: c.textSecondary }, chipTextActive: { color: c.tint }, card: { gap: Spacing.md }, sectionTitle: { ...Typography.bodyLgMedium, color: c.text }, rowTitle: { ...Typography.bodySemibold, color: c.text }, muted: { ...Typography.caption, color: c.textSecondary }, warning: { ...Typography.captionSemibold, color: c.warning }, flex: { flex: 1 }, between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm }, bill: { gap: Spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: Spacing.md }, selected: { backgroundColor: c.tintLight, borderRadius: Radius.sm, paddingHorizontal: Spacing.sm, paddingBottom: Spacing.sm }, selectRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm }, checkbox: { width: 22, height: 22, borderWidth: 1, borderColor: c.border, borderRadius: Radius.xs, alignItems: "center", justifyContent: "center" }, checkboxOn: { backgroundColor: c.tint, borderColor: c.tint }, amountFields: { flexDirection: "row", gap: Spacing.sm }, field: { flex: 1, gap: Spacing.xs }, label: { ...Typography.captionSemibold, color: c.textSecondary }, input: { minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, backgroundColor: c.surfaceAlt, color: c.text, paddingHorizontal: Spacing.md, ...Typography.body }, account: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: Spacing.sm, borderRadius: Radius.sm, paddingHorizontal: Spacing.sm }, total: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: Spacing.sm }, totalValue: { ...Typography.h2, color: c.text }, credit: { ...Typography.h2, color: c.success }, primary: { minHeight: 48, borderRadius: Radius.full, backgroundColor: c.tint, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.sm }, primaryText: { ...Typography.bodySemibold, color: c.textInverse }, disabled: { opacity: 0.5 }, error: { ...Typography.caption, color: c.error, backgroundColor: c.errorSurface, padding: Spacing.sm, borderRadius: Radius.sm }, success: { ...Typography.caption, color: c.success, backgroundColor: c.successLight, padding: Spacing.sm, borderRadius: Radius.sm }, secondary: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.full, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm }, secondaryText: { ...Typography.captionSemibold, color: c.tint }, loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.sm, padding: Spacing.xl }, empty: { alignItems: "center", justifyContent: "center", gap: Spacing.sm, padding: Spacing.xxxl }, emptyTitle: { ...Typography.h2, color: c.text, textAlign: "center" }, emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
}); }