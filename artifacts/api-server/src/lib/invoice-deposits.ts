import { and, eq } from "drizzle-orm";
import {
  bankAccounts,
  bankTransactionInvoices,
  bankTransactions,
  db,
  invoices,
  organizations,
} from "@workspace/db";
import { logger } from "./logger";

export type InvoiceForDeposit = {
  id: string;
  invoiceNumber: string;
  total: string;
  labOrganizationId: string;
};

/**
 * Ensure a posted deposit exists in the lab's default bank account that
 * mirrors a fully-paid invoice. Idempotent: if a deposit is already linked
 * to the invoice it is left as-is. Returns the deposit row when created or
 * already present, or null when no default account is configured.
 */
export async function ensureInvoiceDeposit(
  invoice: InvoiceForDeposit,
  userId: string | null
): Promise<{
  created: boolean;
  transactionId: string | null;
  reason?: string;
}> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, invoice.labOrganizationId),
  });
  const defaultAccountId = org?.defaultBankAccountId ?? null;
  if (!defaultAccountId) {
    return {
      created: false,
      transactionId: null,
      reason: "no_default_account",
    };
  }

  const account = await db.query.bankAccounts.findFirst({
    where: and(
      eq(bankAccounts.id, defaultAccountId),
      eq(bankAccounts.labOrganizationId, invoice.labOrganizationId)
    ),
  });
  if (!account || account.isArchived) {
    return {
      created: false,
      transactionId: null,
      reason: "default_account_unavailable",
    };
  }

  const amount = Number(invoice.total || 0);
  if (!(amount > 0)) {
    return { created: false, transactionId: null, reason: "zero_total" };
  }

  // Serialize all auto-deposit work for this invoice inside a transaction so
  // concurrent paid transitions can't create duplicate deposits, and so we
  // honor pre-existing links (manual or imported) instead of double-counting.
  try {
    return await db.transaction(async (tx) => {
      // Lock the invoice row itself so that two concurrent paid transitions
      // for the same invoice serialize here. The link-table check below would
      // otherwise miss races where neither side has inserted a link yet.
      const lockedInvoice = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.id, invoice.id))
        .for("update")
        .limit(1);
      if (!lockedInvoice.length) {
        return {
          created: false,
          transactionId: null,
          reason: "invoice_missing",
        };
      }

      const existingAny = await tx
        .select({ id: bankTransactions.id, source: bankTransactions.source })
        .from(bankTransactionInvoices)
        .innerJoin(
          bankTransactions,
          eq(bankTransactions.id, bankTransactionInvoices.bankTransactionId)
        )
        .where(eq(bankTransactionInvoices.invoiceId, invoice.id));
      if (existingAny.length) {
        return {
          created: false,
          transactionId: existingAny[0].id,
          reason: "already_linked",
        };
      }

      const [row] = await tx
        .insert(bankTransactions)
        .values({
          labOrganizationId: invoice.labOrganizationId,
          bankAccountId: account.id,
          txnDate: new Date(),
          type: "deposit",
          payee: `Invoice ${invoice.invoiceNumber}`,
          memo: `Auto-deposit for paid invoice ${invoice.invoiceNumber}`,
          debitAmount: "0.00",
          creditAmount: amount.toFixed(2),
          netAmount: amount.toFixed(2),
          cleared: false,
          status: "posted",
          source: "invoice",
          createdByUserId: userId,
        })
        .returning();
      await tx
        .insert(bankTransactionInvoices)
        .values({ bankTransactionId: row.id, invoiceId: invoice.id });
      return { created: true, transactionId: row.id };
    });
  } catch (err) {
    logger.error(
      { err, invoiceId: invoice.id },
      "Failed to create invoice deposit"
    );
    return { created: false, transactionId: null, reason: "error" };
  }
}
