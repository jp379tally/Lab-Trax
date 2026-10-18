import { reversedInvoiceSettlements } from "@workspace/db";

/**
 * One settlement that is about to be removed from the live tables.
 *
 * `settledAt` must be the date the settlement counted from — the payment's
 * recorded date or the payment session's payment date — never the moment the
 * reversal is being processed.
 */
export interface ReversedSettlementInput {
  labOrganizationId: string;
  invoiceId: string;
  sourceType: "payment" | "customer_credit_application";
  sourceId?: string | null;
  paymentSessionId?: string | null;
  amount: string | number;
  settledAt: Date;
  reversedAt?: Date;
  reversedByUserId?: string | null;
}

/**
 * Archives settlements in the same transaction that deletes them.
 *
 * Dated reports read these rows to answer for a date inside the window a
 * since-cancelled payment was in force. Without them the only evidence left
 * is today's invoice balance, which says the invoice was never settled at
 * all.
 */
export async function archiveReversedSettlements(
  tx: { insert: (table: typeof reversedInvoiceSettlements) => any },
  rows: ReversedSettlementInput[],
): Promise<void> {
  const values = rows
    .filter((row) => Number(row.amount) !== 0 && row.invoiceId)
    .map((row) => ({
      labOrganizationId: row.labOrganizationId,
      invoiceId: row.invoiceId,
      sourceType: row.sourceType,
      sourceId: row.sourceId ?? null,
      paymentSessionId: row.paymentSessionId ?? null,
      amount: Number(row.amount).toFixed(2),
      settledAt: row.settledAt,
      reversedAt: row.reversedAt ?? new Date(),
      reversedByUserId: row.reversedByUserId ?? null,
    }));
  if (!values.length) return;
  await tx.insert(reversedInvoiceSettlements).values(values);
}
