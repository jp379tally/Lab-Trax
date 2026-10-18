import { and, eq, isNull, ne } from "drizzle-orm";
import { customerCredits, invoices } from "@workspace/db";
import { finalizedInvoiceSql } from "./recovery-billing-hold";

type QueryExecutor = {
  select: typeof import("@workspace/db").db.select;
};

export interface AccountBalanceProjection {
  labOrganizationId: string;
  providerOrganizationId: string;
  invoiceBalance: string;
  availableCredit: string;
  currentBalance: string;
  openInvoiceCount: number;
  calculatedAt: string;
}

function money(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

export async function calculateAccountBalance(
  executor: QueryExecutor,
  labOrganizationId: string,
  providerOrganizationId: string,
): Promise<AccountBalanceProjection> {
  const [invoiceRows, creditRows] = await Promise.all([
    executor
      .select({ balanceDue: invoices.balanceDue })
      .from(invoices)
      .where(
        and(
          eq(invoices.labOrganizationId, labOrganizationId),
          eq(invoices.providerOrganizationId, providerOrganizationId),
          isNull(invoices.deletedAt),
          ne(invoices.status, "void"),
          finalizedInvoiceSql(),
        ),
      ),
    executor
      .select({ remainingAmount: customerCredits.remainingAmount })
      .from(customerCredits)
      .where(
        and(
          eq(customerCredits.labOrganizationId, labOrganizationId),
          eq(customerCredits.providerOrganizationId, providerOrganizationId),
          isNull(customerCredits.reversedAt),
        ),
      ),
  ]);

  const invoiceBalance = invoiceRows.reduce(
    (sum, invoice) => sum + Math.max(0, Number(invoice.balanceDue) || 0),
    0,
  );
  const availableCredit = creditRows.reduce(
    (sum, credit) => sum + Math.max(0, Number(credit.remainingAmount) || 0),
    0,
  );

  return {
    labOrganizationId,
    providerOrganizationId,
    invoiceBalance: money(invoiceBalance),
    availableCredit: money(availableCredit),
    currentBalance: money(invoiceBalance - availableCredit),
    openInvoiceCount: invoiceRows.filter(
      (invoice) => Number(invoice.balanceDue) > 0.005,
    ).length,
    calculatedAt: new Date().toISOString(),
  };
}