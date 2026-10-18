import type { QueryClient } from "@tanstack/react-query";

/** Invalidate case and finance views before leaving a successful case entry. */
export async function refreshCaseFinanceQueries(qc: QueryClient): Promise<void> {
  await Promise.all([
    refreshInvoiceSalesQueries(qc),
    qc.invalidateQueries({ queryKey: ["legacy-cases-for-dropzone"] }),
    qc.invalidateQueries({ queryKey: ["doctor-cases"] }),
    qc.invalidateQueries({ queryKey: ["active-cases"] }),
  ]);
}

/** Refresh customer-balance views (Customer Center totals, the customer's
 * account and statement tabs, Receive Payments account pickers) after a
 * confirmed write that changes what a customer owes. */
export async function refreshCustomerBalanceQueries(qc: QueryClient): Promise<void> {
  await Promise.allSettled([
    qc.invalidateQueries({ queryKey: ["customer-center-summary"] }),
    qc.invalidateQueries({ queryKey: ["provider-lab-card"] }),
    qc.invalidateQueries({ queryKey: ["shared-provider-account"] }),
    qc.invalidateQueries({ queryKey: ["customer-statement-charges"] }),
    qc.invalidateQueries({ queryKey: ["practice-statements"] }),
    qc.invalidateQueries({ queryKey: ["billing", "eligible-invoice-accounts"] }),
    qc.invalidateQueries({ queryKey: ["billing", "eligible-statement-accounts"] }),
  ]);
}

/** Refresh invoice-derived tables and reports after a confirmed invoice write.
 * Without an ID this also handles bulk writes and newly created invoices. */
export async function refreshInvoiceSalesQueries(qc: QueryClient, invoiceId?: string, caseId?: string | null): Promise<void> {
  await Promise.allSettled([
    qc.invalidateQueries({ queryKey: ["invoice"] }),
    qc.invalidateQueries({ queryKey: ["invoice-detail"] }),
    ...(invoiceId ? [
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] }),
      qc.invalidateQueries({ queryKey: ["invoice-detail", invoiceId] }),
    ] : []),
    ...(caseId ? [
      qc.invalidateQueries({ queryKey: ["invoice-for-case", caseId] }),
      qc.invalidateQueries({ queryKey: ["case", caseId] }),
    ] : []),
    qc.invalidateQueries({ queryKey: ["invoice-for-case"] }),
    qc.invalidateQueries({ queryKey: ["case"] }),
    qc.invalidateQueries({ queryKey: ["cases"] }),
    qc.invalidateQueries({ queryKey: ["worklist"] }),
    qc.invalidateQueries({ queryKey: ["invoices"] }),
    qc.invalidateQueries({ queryKey: ["reports"] }),
    qc.invalidateQueries({ queryKey: ["stats"] }),
    qc.invalidateQueries({ queryKey: ["finance"] }),
    qc.invalidateQueries({ queryKey: ["statements"] }),
    qc.invalidateQueries({ queryKey: ["statement-account-summaries"] }),
    qc.invalidateQueries({ queryKey: ["organizations"] }),
    qc.invalidateQueries({ queryKey: ["doctor-invoices"] }),
    qc.invalidateQueries({
      predicate: (query) => {
        const first = query.queryKey[0];
        return typeof first === "string" &&
          (first.startsWith("getGetStats") || first.startsWith("/api/stats/"));
      },
    }),
  ]);
}