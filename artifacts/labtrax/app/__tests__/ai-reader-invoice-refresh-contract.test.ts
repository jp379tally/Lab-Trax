import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(import.meta.resolve("../ai-reader/extracted.tsx")),
  "utf8",
);
const manualSource = readFileSync(
  fileURLToPath(import.meta.resolve("../new-case.tsx")), "utf8",
);
const paymentSource = readFileSync(
  fileURLToPath(import.meta.resolve("../finance/receive-payments.tsx")), "utf8",
);
const helperSource = readFileSync(
  fileURLToPath(import.meta.resolve("../../lib/refresh-case-finance.ts")), "utf8",
);

describe("mobile AI reader post-create refresh contract", () => {
  const helper = helperSource;

  it("uses the shared helper after intake succeeds", () => {
    expect(source.match(/await refreshCaseFinanceQueries\(qc\)/g)).toHaveLength(1);
    expect(source.indexOf("await refreshCaseFinanceQueries(qc)")).toBeLessThan(
      source.indexOf("setUploadProgress(1)"),
    );
  });

  it("refreshes the same families for manual case entry before navigating", () => {
    expect(manualSource).toContain("await refreshCaseFinanceQueries(queryClient)");
    expect(manualSource.indexOf("await refreshCaseFinanceQueries(queryClient)"))
      .toBeLessThan(manualSource.indexOf("router.replace(`/case/${newId}`"));
  });

  it("refreshes case, worklist, and invoice families", () => {
    expect(helper).toContain('queryKey: ["getCases"]');
    expect(helper).toContain('queryKey: ["cases"]');
    expect(helper).toContain('queryKey: ["cases", "worklist"]');
    expect(helper).toContain('queryKey: ["worklist"]');
    expect(helper).toContain('queryKey: ["active-cases"]');
    expect(helper).toContain('queryKey: ["invoices"]');
  });

  it("refreshes today's sales, doctor finance, exceptions, reports, and stats", () => {
    expect(helper).toContain(
      'queryKey: ["invoices", "reports", "sales", "today"]',
    );
    expect(helper).toContain('queryKey: ["doctor-cases"]');
    expect(helper).toContain('queryKey: ["doctor-invoices"]');
    expect(helper).toContain("EXCEPTION_QUEUE_QUERY_KEY");
    expect(helper).toContain('first === "stats"');
    expect(helper).toContain('first === "reports"');
    expect(helper).toContain('first.startsWith("/api/stats/")');
  });

  it("also refreshes invoice-derived reports after a confirmed payment or reversal", () => {
    const invalidation = paymentSource.slice(paymentSource.indexOf("const invalidatePaymentViews ="), paymentSource.indexOf("useEffect(() => {", paymentSource.indexOf("const invalidatePaymentViews =")));
    expect(invalidation).toContain("refreshCaseFinanceQueries(qc)");
    expect(paymentSource).toContain("invalidatePaymentViews();");
  });
});