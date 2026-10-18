/**
 * Live settlement figures for a generated practice statement.
 *
 * A `practice_statements` row freezes billed / paid / balance-due at the
 * moment the statement is generated. That snapshot is part of the immutable
 * issued record — the PDF renders from it — so it is never rewritten when a
 * payment is later recorded. Every surface that reports how much of a
 * statement has been settled therefore has to derive the figures from the
 * current state of the statement's own invoices instead of reading the
 * snapshot back.
 */

function round(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

export type StatementInvoiceState = {
  total: string | number | null;
  balanceDue: string | number | null;
  status: string;
};

export type LiveStatementFigures = {
  /** Amount of the statement's invoices that has actually been settled. */
  totalPaid: string;
  /** Amount of the statement's invoices still outstanding. */
  balanceDue: string;
};

/**
 * Sum the settled and outstanding amounts across a statement's invoices.
 *
 * `invoiceById` holds only invoices that still exist; a deleted invoice is
 * simply absent. A deleted or voided invoice contributes to neither figure:
 * it stops being owed without ever having been paid, so it lowers the balance
 * due without inflating the amount paid.
 */
export function deriveLiveStatementFigures(
  invoiceIds: string[],
  invoiceById: Map<string, StatementInvoiceState>,
): LiveStatementFigures {
  let paid = 0;
  let outstanding = 0;
  for (const invoiceId of invoiceIds) {
    const invoice = invoiceById.get(invoiceId);
    if (!invoice || invoice.status === "void") continue;
    const balanceDue = Math.max(0, Number(invoice.balanceDue ?? 0));
    outstanding += balanceDue;
    paid += Math.max(0, Number(invoice.total ?? 0) - balanceDue);
  }
  return { totalPaid: round(paid), balanceDue: round(outstanding) };
}
