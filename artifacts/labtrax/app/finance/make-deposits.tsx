import React, { useMemo, useState } from "react";
import { ActivityIndicator, Keyboard, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card } from "@/components/ui/Card";
import { DismissKeyboardView, scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { getJson, isForbiddenError, sendJson } from "@/lib/read-api";
import { canEditAnyLab, primaryLabOrgId, useMe } from "@/lib/auth-me";
import { formatDate, formatMoney } from "@/lib/format";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { useTheme, type ThemeColors } from "@/lib/theme-context";

interface BankAccount {
  id: string;
  name: string;
  accountType?: string | null;
  isArchived?: boolean | null;
}

interface DepositPayment {
  id: string;
  txnDate?: string | null;
  payee?: string | null;
  memo?: string | null;
  netAmount?: string | number | null;
  creditAmount?: string | number | null;
  staleDays?: number | null;
  ageWarning?: boolean;
  statementDate?: string | null;
  invoiceLinks?: Array<{ invoiceId: string; invoiceNumber?: string | null }>;
  paymentSession?: {
    receiptNumber?: string | null;
    customerCreditAmount?: string | number | null;
    customerCreditRemaining?: string | number | null;
    paymentMethod?: string | null;
    status?: string | null;
  } | null;
}

function amount(payment: DepositPayment): number {
  const parsed = Number(payment.netAmount ?? payment.creditAmount ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]);
}

export default function MakeDepositsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const labId = primaryLabOrgId(useMe().data);
  const allowed = canEditAnyLab(useMe().data);
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [accountId, setAccountId] = useState("");
  const [depositDate, setDepositDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  const accountsQuery = useQuery<BankAccount[]>({
    queryKey: ["finance-accounts", labId ?? ""],
    enabled: allowed && !!labId,
    staleTime: 60_000,
    queryFn: () => getJson(`/api/finance/accounts?organizationId=${encodeURIComponent(labId!)}`),
  });
  const fundsQuery = useQuery<DepositPayment[]>({
    queryKey: ["undeposited-funds", labId ?? ""],
    enabled: allowed && !!labId,
    staleTime: 30_000,
    queryFn: () => getJson(`/api/finance/undeposited-funds?organizationId=${encodeURIComponent(labId!)}`),
  });

  const targets = (accountsQuery.data ?? []).filter((a) => a.accountType !== "undeposited_funds" && !a.isArchived);
  const effectiveAccountId = targets.some((a) => a.id === accountId) ? accountId : targets[0]?.id ?? "";
  const funds = fundsQuery.data ?? [];
  const total = funds.filter((p) => selected.includes(p.id)).reduce((sum, p) => sum + amount(p), 0);

  const depositMutation = useMutation({
    mutationFn: () => {
      if (!labId || !effectiveAccountId) throw new Error("Choose an active destination account.");
      if (!selected.length) throw new Error("Select at least one payment to deposit.");
      if (!validDate(depositDate)) {
        throw new Error("Enter a valid deposit date in YYYY-MM-DD format.");
      }
      return sendJson("POST", "/api/finance/make-deposits", {
        organizationId: labId,
        bankAccountId: effectiveAccountId,
        depositDate: `${depositDate}T12:00:00.000Z`,
        transactionIds: selected,
      });
    },
    onSuccess: () => {
      setSelected([]);
      setError(null);
      void qc.invalidateQueries({ queryKey: ["undeposited-funds"] });
      void qc.invalidateQueries({ queryKey: ["undeposited-funds-summary"] });
      void qc.invalidateQueries({ queryKey: ["finance-accounts"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!labId || !allowed) {
    return <State colors={colors} styles={styles} insets={insets} icon="lock-closed-outline" title="Not available" body="Make Deposits is available to lab owners, admins, and billing users." />;
  }
  if (accountsQuery.isError || fundsQuery.isError) {
    const forbidden = isForbiddenError(accountsQuery.error) || isForbiddenError(fundsQuery.error);
    return <State colors={colors} styles={styles} insets={insets} icon={forbidden ? "lock-closed-outline" : "cloud-offline-outline"} title={forbidden ? "Not available" : "Couldn't load deposits"} body={forbidden ? "You don't have permission to manage deposits for this lab." : "Check your connection and try again."} onRetry={() => { void accountsQuery.refetch(); void fundsQuery.refetch(); }} />;
  }

  return (
    <DismissKeyboardView style={[styles.screen, { paddingTop: insets.top }]} testID="deposits-keyboard-dismiss">
      <View style={styles.header}><Pressable testID="deposits-back" onPress={() => router.back()} hitSlop={8}><Ionicons name="chevron-back" size={26} color={colors.text} /></Pressable><Text style={styles.headerTitle}>Make Deposits</Text></View>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode={scrollKeyboardDismissMode} refreshControl={<RefreshControl refreshing={fundsQuery.isFetching && !fundsQuery.isLoading} onRefresh={() => void fundsQuery.refetch()} tintColor={colors.tint} />} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}>
        <View style={styles.intro}><Text style={styles.eyebrow}>Banking</Text><Text style={styles.heading}>Make Deposits</Text><Text style={styles.subtitle}>Move received payments from Undeposited Funds into an active bank account.</Text></View>
        <Card style={styles.card}>
          <View style={styles.rowBetween}><View><Text style={styles.sectionTitle}>Undeposited Funds</Text><Text style={styles.muted}>{funds.length} payment{funds.length === 1 ? "" : "s"} available · {formatMoney(funds.reduce((sum, p) => sum + amount(p), 0))}</Text></View><Pressable testID="deposits-select-all" style={styles.secondary} onPress={() => setSelected(selected.length === funds.length ? [] : funds.map((p) => p.id))}><Text style={styles.secondaryText}>{selected.length === funds.length && funds.length ? "Clear all" : "Select all"}</Text></Pressable></View>
          {fundsQuery.isLoading ? <View style={styles.loading}><ActivityIndicator color={colors.tint} /><Text style={styles.muted}>Loading payments…</Text></View> : funds.length === 0 ? <View style={styles.emptyInline}><Ionicons name="checkmark-circle-outline" size={30} color={colors.success} /><Text style={styles.sectionTitle}>Nothing to deposit</Text><Text style={styles.muted}>Newly received payments will appear here.</Text></View> : funds.map((payment) => {
            const checked = selected.includes(payment.id);
            return <Pressable key={payment.id} testID={`deposit-payment-${payment.id}`} style={[styles.paymentRow, checked && styles.selectedRow]} onPress={() => setSelected((old) => checked ? old.filter((id) => id !== payment.id) : [...old, payment.id])}>
              <View style={[styles.checkbox, checked && styles.checkboxSelected]}>{checked && <Ionicons name="checkmark" size={14} color={colors.textInverse} />}</View>
              <View style={styles.flex}><Text style={styles.paymentName}>{payment.payee || "Customer payment"}</Text><Text style={styles.muted}>{payment.paymentSession?.receiptNumber || "Receipt pending"} · {payment.paymentSession?.paymentMethod || "payment"}{payment.txnDate ? ` · ${formatDate(payment.txnDate)}` : ""}</Text><Text style={styles.muted}>{payment.invoiceLinks?.length ? `Invoices: ${payment.invoiceLinks.map((l) => l.invoiceNumber || l.invoiceId.slice(0, 8)).join(", ")}` : "No invoice applications"}{Number(payment.paymentSession?.customerCreditAmount ?? 0) > 0 ? ` · Credit ${formatMoney(payment.paymentSession?.customerCreditAmount)}` : ""}</Text>{payment.ageWarning && <Text style={styles.warning}>Stale payment · {payment.staleDays ?? 0} days old</Text>}</View>
              <Text style={styles.amount}>{formatMoney(amount(payment))}</Text>
            </Pressable>;
          })}
        </Card>
        <Card style={styles.card}>
          <Text style={styles.sectionTitle}>Deposit details</Text>
          <Text style={styles.fieldLabel}>Destination account</Text>
          {targets.length === 0 ? <Text style={styles.warning}>No active bank account is available. Add one in Bank Register first.</Text> : targets.map((account) => <Pressable key={account.id} testID={`deposit-account-${account.id}`} style={[styles.accountRow, effectiveAccountId === account.id && styles.selectedRow]} onPress={() => setAccountId(account.id)}><View style={[styles.radio, effectiveAccountId === account.id && styles.radioSelected]}>{effectiveAccountId === account.id && <View style={styles.radioDot} />}</View><Text style={styles.paymentName}>{account.name}</Text></Pressable>)}
          <View style={styles.field}><Text style={styles.fieldLabel}>Deposit date</Text><TextInput testID="deposit-date" value={depositDate} onChangeText={setDepositDate} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textTertiary} style={styles.input} returnKeyType="done" onSubmitEditing={() => Keyboard.dismiss()} /></View>
          <View style={styles.total}><Text style={styles.sectionTitle}>Selected total</Text><Text style={styles.totalValue}>{formatMoney(total)}</Text></View>
          {error && <Text style={styles.error}>{error}</Text>}
          <Pressable testID="deposit-submit" style={[styles.primary, (!selected.length || !effectiveAccountId || depositMutation.isPending) && styles.disabled]} disabled={!selected.length || !effectiveAccountId || depositMutation.isPending} onPress={() => depositMutation.mutate()}>{depositMutation.isPending ? <ActivityIndicator color={colors.textInverse} /> : <Ionicons name="swap-horizontal-outline" size={18} color={colors.textInverse} />}<Text style={styles.primaryText}>{depositMutation.isPending ? "Depositing…" : "Create deposit"}</Text></Pressable>
        </Card>
      </ScrollView>
    </DismissKeyboardView>
  );
}

function State({ colors, styles, insets, icon, title, body, onRetry }: { colors: ThemeColors; styles: ReturnType<typeof makeStyles>; insets: { top: number }; icon: React.ComponentProps<typeof Ionicons>["name"]; title: string; body: string; onRetry?: () => void }) {
  return <View style={[styles.screen, { paddingTop: insets.top }]}><View style={styles.header}><Pressable onPress={() => router.back()}><Ionicons name="chevron-back" size={26} color={colors.text} /></Pressable><Text style={styles.headerTitle}>Make Deposits</Text></View><View style={styles.empty}><Ionicons name={icon} size={42} color={colors.textTertiary} /><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyBody}>{body}</Text>{onRetry && <Pressable style={styles.secondary} onPress={onRetry}><Text style={styles.secondaryText}>Try again</Text></Pressable>}</View></View>;
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid }, header: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm }, headerTitle: { ...Typography.h1, color: c.text }, content: { padding: Spacing.lg, gap: Spacing.md }, intro: { gap: 3 }, eyebrow: { ...Typography.label, color: c.tint }, heading: { ...Typography.h1, color: c.text }, subtitle: { ...Typography.caption, color: c.textSecondary }, card: { gap: Spacing.md }, sectionTitle: { ...Typography.bodyLgMedium, color: c.text }, muted: { ...Typography.caption, color: c.textSecondary }, rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: Spacing.sm }, flex: { flex: 1 }, secondary: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.full, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, alignSelf: "flex-start" }, secondaryText: { ...Typography.captionSemibold, color: c.tint }, paymentRow: { flexDirection: "row", gap: Spacing.sm, alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: Spacing.md }, selectedRow: { backgroundColor: c.tintLight, borderRadius: Radius.sm, paddingHorizontal: Spacing.sm }, checkbox: { width: 22, height: 22, borderWidth: 1, borderColor: c.border, borderRadius: Radius.xs, alignItems: "center", justifyContent: "center" }, checkboxSelected: { backgroundColor: c.tint, borderColor: c.tint }, paymentName: { ...Typography.bodySemibold, color: c.text }, amount: { ...Typography.bodySemibold, color: c.text }, warning: { ...Typography.caption, color: c.warning }, field: { gap: Spacing.xs }, fieldLabel: { ...Typography.captionSemibold, color: c.textSecondary }, input: { minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, backgroundColor: c.surfaceAlt, color: c.text, paddingHorizontal: Spacing.md, ...Typography.body }, accountRow: { flexDirection: "row", gap: Spacing.md, alignItems: "center", minHeight: 48, paddingHorizontal: Spacing.sm, borderRadius: Radius.sm }, radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: c.border, alignItems: "center", justifyContent: "center" }, radioSelected: { borderColor: c.tint }, radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.tint }, total: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: c.border, paddingTop: Spacing.md }, totalValue: { ...Typography.h2, color: c.text }, primary: { minHeight: 48, borderRadius: Radius.full, backgroundColor: c.tint, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: Spacing.sm }, primaryText: { ...Typography.bodySemibold, color: c.textInverse }, disabled: { opacity: 0.55 }, error: { ...Typography.caption, color: c.error, backgroundColor: c.errorSurface, padding: Spacing.sm, borderRadius: Radius.sm }, loading: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: Spacing.sm, padding: Spacing.lg }, emptyInline: { alignItems: "center", gap: Spacing.xs, padding: Spacing.lg }, empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: Spacing.sm, padding: Spacing.xxxl }, emptyTitle: { ...Typography.h2, color: c.text, textAlign: "center" }, emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center", maxWidth: 320 },
  });
}