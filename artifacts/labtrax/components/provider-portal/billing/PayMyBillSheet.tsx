// Pay My Bill — the mobile form for paying one statement.
//
// A port of the desktop PayMyBillDialog: the same three modes (full, partial,
// individual invoices), the same oldest-first allocation, the same validation
// wording, and the same rule that invoice accounting only changes after the
// processor confirms settlement. Mobile differs in one way only: the hosted
// checkout opens in the device browser, so the attempt is recorded durably
// (idempotency key + checkout id) before leaving the app and reconciled when
// the provider comes back.
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import {
  createProviderCheckout,
  prepareProviderCheckoutAttempt,
  providerBillingReturnUrl,
  savePendingProviderCheckout,
  type ProviderCard,
  type ProviderCheckoutOrigin,
  type ProviderStatement,
} from "@/lib/provider-billing";
import {
  allocatePayment,
  balanceDueNum,
  formatCurrency,
  formatStatementDate,
  isPayable,
  statusLabel,
  type StatementInvoice,
} from "@/lib/provider-portal-billing";

type PayMode = "full" | "partial" | "individual";

const MODES: Array<{ key: PayMode; label: string }> = [
  { key: "full", label: "Pay in Full" },
  { key: "partial", label: "Partial Payment" },
  { key: "individual", label: "Individual Invoices" },
];

export interface PayMyBillSheetProps {
  statement: ProviderStatement;
  invoices: StatementInvoice[];
  card?: ProviderCard | null;
  /**
   * Which billing surface opened this sheet. Stripe's return link cannot say,
   * so it is recorded with the attempt and read back when the provider comes
   * home — a return sent to a surface that is not mounted reconciles nowhere.
   */
  origin?: ProviderCheckoutOrigin;
  onClose: () => void;
  /** The server reported the attempt already settled — refresh in place. */
  onSettled: () => void;
  /** Hosted checkout opened in the browser; the return has to be confirmed. */
  onLaunched: (checkoutId: string) => void;
}

export function PayMyBillSheet({
  statement,
  invoices,
  card = null,
  origin = "portal",
  onClose,
  onSettled,
  onLaunched,
}: PayMyBillSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const statementBalance = balanceDueNum(statement.balanceDue);
  const hasCard = !!card?.hasCard;

  const [mode, setMode] = useState<PayMode>("full");
  const [savePaymentMethod, setSavePaymentMethod] = useState(!hasCard);
  const [partialAmount, setPartialAmount] = useState(statementBalance.toFixed(2));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payableInvoices = useMemo(() => invoices.filter(isPayable), [invoices]);
  const [selections, setSelections] = useState<
    Record<string, { checked: boolean; amount: string }>
  >(() =>
    Object.fromEntries(
      invoices
        .filter(isPayable)
        .map((inv) => [
          inv.id,
          { checked: true, amount: balanceDueNum(inv.balanceDue).toFixed(2) },
        ]),
    ),
  );

  const selectedTotal = useMemo(() => {
    if (mode !== "individual") return 0;
    return Object.values(selections).reduce((sum, s) => {
      if (!s.checked) return sum;
      const n = parseFloat(s.amount);
      return sum + (isNaN(n) ? 0 : n);
    }, 0);
  }, [mode, selections]);

  async function submitPayments(allocations: { invoiceId: string; amount: number }[]) {
    if (allocations.length === 0) {
      setError(
        "No invoices to pay. Please select at least one invoice with a valid amount.",
      );
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const total = allocations.reduce((sum, a) => sum + a.amount, 0);
      // Recorded before the request so a crash (or a second tap) resumes the
      // same checkout instead of starting a second charge.
      const attempt = await prepareProviderCheckoutAttempt({
        mode: `pay-my-bill:${statement.id}`,
        invoiceIds: allocations.map((a) => a.invoiceId),
        amount: total.toFixed(2),
        providerOrganizationId: statement.providerOrganizationId,
        // Stripe's return link cannot say which billing surface it came from,
        // so the launching surface records itself here and the return handler
        // reads it back instead of guessing.
        origin,
      });
      const checkout = await createProviderCheckout({
        allocations,
        savePaymentMethod,
        providerOrganizationId: statement.providerOrganizationId,
        idempotencyKey: attempt.idempotencyKey,
        successUrl: providerBillingReturnUrl(),
        cancelUrl: providerBillingReturnUrl(true),
      });
      if (checkout.status === "succeeded") {
        onSettled();
        onClose();
        return;
      }
      if (!checkout.url) {
        throw new Error(
          checkout.status === "pending"
            ? "Checkout is still being prepared. Please try again."
            : "This checkout is no longer available. Refresh your balance before retrying.",
        );
      }
      await savePendingProviderCheckout({ ...attempt, checkoutId: checkout.checkoutId });
      const supported = await Linking.canOpenURL(checkout.url);
      if (!supported) throw new Error("Your device cannot open the secure checkout page.");
      await Linking.openURL(checkout.url);
      onLaunched(checkout.checkoutId);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not start secure card checkout. Please try again.",
      );
      setSubmitting(false);
    }
  }

  async function handleSubmit() {
    if (submitting) return;
    if (mode === "full") {
      await submitPayments(allocatePayment(invoices, statementBalance));
      return;
    }
    if (mode === "partial") {
      const parsed = parseFloat(partialAmount);
      if (isNaN(parsed) || parsed <= 0) {
        setError("Please enter a valid amount greater than zero.");
        return;
      }
      if (parsed > statementBalance + 0.005) {
        setError(
          `Amount cannot exceed the statement balance of ${formatCurrency(statementBalance)}.`,
        );
        return;
      }
      await submitPayments(allocatePayment(invoices, parsed));
      return;
    }
    const allocations: { invoiceId: string; amount: number }[] = [];
    for (const [invoiceId, sel] of Object.entries(selections)) {
      if (!sel.checked) continue;
      const parsed = parseFloat(sel.amount);
      if (isNaN(parsed) || parsed <= 0.005) continue;
      const inv = invoices.find((i) => i.id === invoiceId);
      if (!inv) continue;
      const cap = balanceDueNum(inv.balanceDue);
      if (parsed > cap + 0.005) {
        setError(
          `Amount for invoice ${inv.invoiceNumber} exceeds its balance of ${formatCurrency(cap)}.`,
        );
        return;
      }
      allocations.push({ invoiceId, amount: Math.round(parsed * 100) / 100 });
    }
    await submitPayments(allocations);
  }

  const submitLabel = submitting
    ? "Opening secure checkout…"
    : mode === "individual"
      ? `Continue to Checkout — ${formatCurrency(selectedTotal)}`
      : mode === "full"
        ? `Continue to Checkout — ${formatCurrency(statementBalance)}`
        : "Continue to Checkout";

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      {/*
        The sheet carries its own dismissal layer. A modal renders in its own
        touch tree, so the portal's layer cannot close the keyboard for the
        amount fields in here.
      */}
      <DismissKeyboardView style={styles.backdrop} testID="pay-my-bill-keyboard-dismiss">
        <View style={styles.sheet} testID="provider-portal-pay-my-bill">
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>Pay My Bill</Text>
              <Text style={styles.subtitle}>
                {statement.labName ?? "Your Lab"} · Statement{" "}
                {formatStatementDate(statement.statementDate)}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="Close"
              testID="pay-my-bill-close"
              hitSlop={8}
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          <View style={styles.totals}>
            <Text style={styles.totalsText}>
              Total billed: {formatCurrency(statement.totalAmount)}
            </Text>
            <Text style={styles.totalsDue} testID="pay-my-bill-balance">
              Balance due: {formatCurrency(statementBalance)}
            </Text>
          </View>

          <View style={styles.modeRow}>
            {MODES.map(({ key, label }) => {
              const active = mode === key;
              return (
                <Pressable
                  key={key}
                  onPress={() => setMode(key)}
                  disabled={submitting}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  testID={`pay-my-bill-mode-${key}`}
                  style={[
                    styles.modeChip,
                    {
                      borderColor: active ? colors.tint : colors.border,
                      backgroundColor: active ? colors.tint : "transparent",
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.modeText,
                      { color: active ? "#fff" : colors.textSecondary },
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            testID="pay-my-bill-body"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={scrollKeyboardDismissMode}
          >
            {mode === "full" && (
              <View style={styles.field}>
                <Text style={styles.label}>Amount (full balance)</Text>
                <View style={styles.readonlyInput}>
                  <Text style={styles.readonlyText}>
                    ${statementBalance.toFixed(2)}
                  </Text>
                </View>
                <Text style={styles.hint}>
                  Will be distributed oldest-first across {payableInvoices.length} open{" "}
                  {payableInvoices.length === 1 ? "invoice" : "invoices"}.
                </Text>
              </View>
            )}

            {mode === "partial" && (
              <View style={styles.field}>
                <Text style={styles.label}>Amount to pay</Text>
                <TextInput
                  value={partialAmount}
                  onChangeText={setPartialAmount}
                  editable={!submitting}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={colors.textTertiary}
                  accessibilityLabel="Amount to pay"
                  testID="pay-my-bill-partial-amount"
                  style={styles.input}
                />
                <Text style={styles.hint}>
                  Maximum: {formatCurrency(statementBalance)}. Distributed oldest-first
                  across open invoices.
                </Text>
              </View>
            )}

            {mode === "individual" && (
              <View style={styles.field}>
                {invoices.length === 0 ? (
                  <Text style={styles.hint}>No invoices loaded for this statement.</Text>
                ) : (
                  invoices.map((inv) => {
                    const canPay = isPayable(inv);
                    const sel = selections[inv.id];
                    return (
                      <View key={inv.id} style={styles.invoiceRow}>
                        <Pressable
                          onPress={() =>
                            setSelections((prev) => ({
                              ...prev,
                              [inv.id]: {
                                amount:
                                  prev[inv.id]?.amount ??
                                  balanceDueNum(inv.balanceDue).toFixed(2),
                                checked: !(prev[inv.id]?.checked ?? false),
                              },
                            }))
                          }
                          disabled={!canPay || submitting}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: sel?.checked ?? false }}
                          accessibilityLabel={`Pay invoice ${inv.invoiceNumber}`}
                          testID={`pay-my-bill-invoice-${inv.id}`}
                          style={styles.invoiceCheck}
                        >
                          <Ionicons
                            name={
                              canPay && sel?.checked ? "checkbox" : "square-outline"
                            }
                            size={20}
                            color={canPay ? colors.tint : colors.textTertiary}
                          />
                        </Pressable>
                        <View style={styles.invoiceCopy}>
                          <Text style={styles.invoiceNumber}>{inv.invoiceNumber}</Text>
                          <Text style={styles.invoiceMeta}>
                            {inv.displayMetadata?.patientName ?? "—"} ·{" "}
                            {statusLabel(inv.status)} ·{" "}
                            {formatCurrency(inv.balanceDue)} due
                          </Text>
                        </View>
                        {canPay ? (
                          <TextInput
                            value={sel?.amount ?? "0.00"}
                            onChangeText={(value) =>
                              setSelections((prev) => ({
                                ...prev,
                                [inv.id]: { amount: value, checked: true },
                              }))
                            }
                            editable={!submitting && (sel?.checked ?? false)}
                            keyboardType="decimal-pad"
                            accessibilityLabel={`Pay amount for invoice ${inv.invoiceNumber}`}
                            testID={`pay-my-bill-amount-${inv.id}`}
                            style={styles.amountInput}
                          />
                        ) : (
                          <Text style={styles.invoiceMeta}>—</Text>
                        )}
                      </View>
                    );
                  })
                )}
                <View style={styles.selectedTotalRow}>
                  <Text style={styles.hint}>Selected total:</Text>
                  <Text style={styles.selectedTotal} testID="pay-my-bill-selected-total">
                    {formatCurrency(selectedTotal)}
                  </Text>
                </View>
              </View>
            )}

            <View style={styles.cardChoice}>
              <Text style={styles.label}>Secure card payment</Text>
              <Text style={styles.hint}>
                {hasCard
                  ? `Stripe Checkout will offer your saved ${(card?.brand ?? "card").toUpperCase()} ending in ${card?.last4}. You can choose another card in Checkout.`
                  : "No shared card is saved yet. Stripe Checkout will ask for a card."}
              </Text>
              <View style={styles.switchRow}>
                <Switch
                  value={savePaymentMethod}
                  onValueChange={setSavePaymentMethod}
                  disabled={submitting}
                  accessibilityLabel="Save this card as the shared card"
                  testID="pay-my-bill-save-card"
                />
                <Text style={styles.switchLabel}>
                  {hasCard
                    ? "Use any newly entered card as the shared card."
                    : "Save this card as the shared card for future payments."}
                </Text>
              </View>
              <Text style={styles.securityNote}>
                Your card details are entered and stored by Stripe. LabTrax never sees
                the full card number.
              </Text>
            </View>

            {error ? (
              <Text style={styles.error} testID="pay-my-bill-error">
                {error}
              </Text>
            ) : null}
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              onPress={onClose}
              disabled={submitting}
              accessibilityRole="button"
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => void handleSubmit()}
              disabled={submitting || statementBalance <= 0.005}
              accessibilityRole="button"
              testID="pay-my-bill-submit"
              style={[
                styles.primaryButton,
                {
                  backgroundColor: colors.tint,
                  opacity: submitting || statementBalance <= 0.005 ? 0.6 : 1,
                },
              ]}
            >
              {submitting ? <ActivityIndicator color="#fff" /> : null}
              <Text style={styles.primaryButtonText}>{submitLabel}</Text>
            </Pressable>
          </View>
        </View>
      </DismissKeyboardView>
    </Modal>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
    sheet: {
      backgroundColor: c.backgroundSolid,
      borderTopLeftRadius: Radius.lg,
      borderTopRightRadius: Radius.lg,
      padding: Spacing.lg,
      gap: Spacing.md,
      maxHeight: "92%",
    },
    header: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.md },
    headerCopy: { flex: 1, gap: 2 },
    title: { ...Typography.h2, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary },
    totals: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.lg },
    totalsText: { ...Typography.caption, color: c.textSecondary },
    totalsDue: { ...Typography.captionSemibold, color: c.warning },
    modeRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs },
    modeChip: {
      borderWidth: 1,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      minHeight: 36,
      justifyContent: "center",
    },
    modeText: { ...Typography.captionSemibold },
    body: { maxHeight: 360 },
    bodyContent: { gap: Spacing.md, paddingBottom: Spacing.sm },
    field: { gap: Spacing.xs },
    label: { ...Typography.captionSemibold, color: c.text },
    hint: { ...Typography.caption, color: c.textSecondary, lineHeight: 18 },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.md,
      color: c.text,
      ...Typography.body,
    },
    readonlyInput: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.md,
      backgroundColor: c.surfaceAlt,
    },
    readonlyText: { ...Typography.body, color: c.text },
    invoiceRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    invoiceCheck: { padding: Spacing.xs },
    invoiceCopy: { flex: 1, gap: 2 },
    invoiceNumber: { ...Typography.bodyMedium, color: c.text },
    invoiceMeta: { ...Typography.caption, color: c.textSecondary },
    amountInput: {
      width: 92,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.sm,
      color: c.text,
      ...Typography.caption,
      textAlign: "right",
    },
    selectedTotalRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingTop: Spacing.sm,
    },
    selectedTotal: { ...Typography.bodySemibold, color: c.text },
    cardChoice: {
      gap: Spacing.sm,
      padding: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    switchRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    switchLabel: { ...Typography.caption, color: c.text, flex: 1 },
    securityNote: { ...Typography.caption, color: c.textTertiary, lineHeight: 17 },
    error: { ...Typography.caption, color: c.error },
    footer: { flexDirection: "row", justifyContent: "flex-end", gap: Spacing.sm },
    secondaryButton: {
      minHeight: 44,
      paddingHorizontal: Spacing.lg,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
    },
    secondaryButtonText: { ...Typography.bodyMedium, color: c.text },
    primaryButton: {
      flex: 1,
      minHeight: 44,
      borderRadius: Radius.md,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.md,
    },
    primaryButtonText: { ...Typography.bodySemibold, color: "#fff", textAlign: "center" },
  });
}
