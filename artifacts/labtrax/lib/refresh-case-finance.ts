import type { QueryClient } from "@tanstack/react-query";
import { EXCEPTION_QUEUE_QUERY_KEY } from "@/lib/case-exceptions";

/** Shared by manual case entry and AI intake; finish invalidation before navigation. */
export async function refreshCaseFinanceQueries(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["getCases"] }),
    qc.invalidateQueries({ queryKey: ["cases"] }),
    qc.invalidateQueries({ queryKey: ["cases", "worklist"] }),
    qc.invalidateQueries({ queryKey: ["worklist"] }),
    qc.invalidateQueries({ queryKey: ["active-cases"] }),
    qc.invalidateQueries({ queryKey: ["invoices"] }),
    qc.invalidateQueries({ queryKey: ["invoices", "reports", "sales", "today"] }),
    qc.invalidateQueries({ queryKey: ["customer-center-summary"] }),
    qc.invalidateQueries({ queryKey: ["provider-lab-card"] }),
    qc.invalidateQueries({ queryKey: ["shared-provider-account"] }),
    qc.invalidateQueries({ queryKey: ["customer-statement-charges"] }),
    qc.invalidateQueries({ queryKey: ["practice-statements"] }),
    qc.invalidateQueries({ queryKey: ["billing", "eligible-invoice-accounts"] }),
    qc.invalidateQueries({ queryKey: ["billing", "eligible-statement-accounts"] }),
    qc.invalidateQueries({ queryKey: ["receive-payments", "statements"] }),
    qc.invalidateQueries({ queryKey: ["doctor-cases"] }),
    qc.invalidateQueries({ queryKey: ["doctor-invoices"] }),
    qc.invalidateQueries({ queryKey: EXCEPTION_QUEUE_QUERY_KEY }),
    qc.invalidateQueries({
      predicate: (query) => {
        const first = query.queryKey[0];
        return (
          first === "stats" ||
          first === "reports" ||
          (typeof first === "string" &&
            (first.startsWith("getGetStats") || first.startsWith("/api/stats/")))
        );
      },
    }),
  ]);
}