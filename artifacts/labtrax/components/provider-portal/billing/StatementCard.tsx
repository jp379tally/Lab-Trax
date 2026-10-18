// One statement row in the provider portal's billing section.
//
// Mirrors the desktop StatementCard: collapsed it shows the lab, statement
// date, invoice count and the balance due (total billed for archived
// statements); expanded it lists the statement's invoices. Loading is lazy
// and tolerant — an invoice that fails to load drops out of the *display*,
// exactly as desktop does. Paying is deliberately not tolerant: it goes
// through the section's all-or-nothing loader so nobody pays against a
// partial invoice set.
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { getJson } from "@/lib/read-api";
import type { ProviderStatement } from "@/lib/provider-billing";
import {
  balanceDueNum,
  formatCurrency,
  formatStatementDate,
  statusLabel,
  type StatementInvoice,
} from "@/lib/provider-portal-billing";

export interface StatementCardProps {
  statement: ProviderStatement;
  /** Archived statements show the total billed and offer no payment action. */
  readOnly?: boolean;
  onPay?: (statement: ProviderStatement) => void;
  payPending?: boolean;
  testID?: string;
}

export function StatementCard({
  statement,
  readOnly = false,
  onPay,
  payPending = false,
  testID,
}: StatementCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [expanded, setExpanded] = useState(false);
  const [invoices, setInvoices] = useState<StatementInvoice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const balance = balanceDueNum(statement.balanceDue);
  const hasBalance = balance > 0.005;
  const invoiceCount = Number(statement.invoiceCount ?? 0);

  async function loadInvoices() {
    if (invoices !== null || loading) return;
    if (!statement.invoiceIds?.length) {
      setInvoices([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const detail = await getJson<{ invoices: StatementInvoice[] }>(
        `/api/provider/statements/${encodeURIComponent(statement.id)}`,
      );
      setInvoices(detail.invoices);
    } catch {
      setError("Could not load the invoices on this statement.");
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadInvoices();
  }

  return (
    <View style={styles.card} testID={testID}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${statement.labName ?? "Your Lab"} statement`}
        testID={`${testID ?? "statement"}-toggle`}
        style={styles.header}
      >
        <View style={styles.headerCopy}>
          <Text style={styles.labName}>{statement.labName ?? "Your Lab"}</Text>
          <Text style={styles.meta}>
            Statement date: {formatStatementDate(statement.statementDate)}
            {invoiceCount
              ? ` · ${invoiceCount} invoice${invoiceCount === 1 ? "" : "s"}`
              : ""}
          </Text>
        </View>
        <View style={styles.headerAmount}>
          <Text style={styles.amount}>
            {readOnly
              ? formatCurrency(statement.totalAmount)
              : formatCurrency(balance)}
          </Text>
          <Text style={styles.amountLabel}>
            {readOnly ? "total billed" : "balance due"}
          </Text>
        </View>
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={18}
          color={colors.textSecondary}
        />
      </Pressable>

      {expanded ? (
        <View style={styles.body}>
          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.tint} />
              <Text style={styles.meta}>Loading invoices…</Text>
            </View>
          ) : error ? (
            <Text style={styles.error}>{error}</Text>
          ) : invoices && invoices.length === 0 ? (
            <Text style={styles.meta}>No invoices found for this statement.</Text>
          ) : (
            (invoices ?? []).map((inv) => {
              const invBalance = balanceDueNum(inv.currentBalanceDue ?? inv.balanceDue);
              return (
                <View key={inv.id} style={styles.invoiceRow}>
                  <View style={styles.invoiceCopy}>
                    <Text style={styles.invoiceNumber}>{inv.invoiceNumber}</Text>
                    <Text style={styles.meta}>
                      {inv.displayMetadata?.patientName ?? "—"} ·{" "}
                      {statusLabel(inv.status)}
                    </Text>
                  </View>
                  <View style={styles.invoiceAmounts}>
                    <Text style={styles.invoiceTotal}>{formatCurrency(inv.total)}</Text>
                    <Text
                      style={invBalance > 0.005 ? styles.invoiceDue : styles.invoicePaid}
                    >
                      {invBalance > 0.005 ? formatCurrency(invBalance) : "Paid"}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
          <View style={styles.footerRow}>
            <Text style={styles.meta}>
              Total billed: {formatCurrency(statement.totalAmount)}
            </Text>
            {!readOnly ? (
              <Text style={styles.footerBalance}>
                Balance due: {formatCurrency(balance)}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {!readOnly && hasBalance && onPay ? (
        <Pressable
          onPress={() => onPay(statement)}
          disabled={payPending}
          accessibilityRole="button"
          testID={`${testID ?? "statement"}-pay`}
          style={[
            styles.payButton,
            { backgroundColor: colors.tint, opacity: payPending ? 0.6 : 1 },
          ]}
        >
          <Text style={styles.payButtonText}>
            {payPending ? "Loading…" : `View & Pay — ${formatCurrency(balance)} due`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.md,
      backgroundColor: c.surface,
      overflow: "hidden",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      padding: Spacing.md,
      minHeight: 56,
    },
    headerCopy: { flex: 1, gap: 2 },
    labName: { ...Typography.bodyMedium, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
    error: { ...Typography.caption, color: c.error },
    headerAmount: { alignItems: "flex-end", gap: 2 },
    amount: { ...Typography.bodySemibold, color: c.text },
    amountLabel: { ...Typography.caption, color: c.textSecondary },
    body: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      padding: Spacing.md,
      gap: Spacing.sm,
    },
    loadingRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    invoiceRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    invoiceCopy: { flex: 1, gap: 2 },
    invoiceNumber: { ...Typography.bodyMedium, color: c.text },
    invoiceAmounts: { alignItems: "flex-end", gap: 2 },
    invoiceTotal: { ...Typography.bodyMedium, color: c.text },
    invoiceDue: { ...Typography.captionSemibold, color: c.warning },
    invoicePaid: { ...Typography.caption, color: c.success },
    footerRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingTop: Spacing.sm,
    },
    footerBalance: { ...Typography.captionSemibold, color: c.text },
    payButton: {
      margin: Spacing.md,
      marginTop: 0,
      minHeight: 40,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: Spacing.md,
    },
    payButtonText: { ...Typography.captionSemibold, color: "#fff" },
  });
}
