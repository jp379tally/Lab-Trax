import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FINANCE_INVOICES_QUERY_KEY,
  FINANCE_PAYMENT_HISTORY_QUERY_KEY,
  FINANCE_STATEMENT_SUMMARIES_QUERY_KEY,
} from "@/lib/provider-billing";

const mobileHooksSource = readFileSync(
  join(__dirname, "../../../../lib/api-client-react/src/mobile-hooks.ts"),
  "utf8",
);
const invoicesScreenSource = readFileSync(
  join(__dirname, "../finance/invoices.tsx"),
  "utf8",
);
const statementsScreenSource = readFileSync(
  join(__dirname, "../finance/statements.tsx"),
  "utf8",
);
const receivePaymentsSource = readFileSync(
  join(__dirname, "../finance/receive-payments.tsx"),
  "utf8",
);
const desktopInvoicesSource = readFileSync(
  join(__dirname, "../../../../artifacts/labtrax-desktop/src/pages/invoices.tsx"),
  "utf8",
);
const desktopStatementsSource = readFileSync(
  join(__dirname, "../../../../artifacts/labtrax-desktop/src/pages/statements.tsx"),
  "utf8",
);
const mobileTestSetupSource = readFileSync(
  join(__dirname, "../../vitest.setup.ts"),
  "utf8",
);

describe("finance query-key contract", () => {
  it("keeps invalidation prefixes aligned with the mounted finance queries", () => {
    expect(FINANCE_INVOICES_QUERY_KEY).toEqual(["invoices"]);
    expect(FINANCE_PAYMENT_HISTORY_QUERY_KEY).toEqual(["payment-history"]);
    expect(FINANCE_STATEMENT_SUMMARIES_QUERY_KEY).toEqual(["statement-account-summaries"]);

    expect(invoicesScreenSource).toContain("usePagedInvoices");
    expect(mobileHooksSource).toContain(
      "const queryKey = [...FINANCE_INVOICES_QUERY_KEY, \"paged\", params ?? {}]",
    );
    expect(mobileTestSetupSource).toContain(
      "queryKey: [...FINANCE_INVOICES_QUERY_KEY, \"paged\", params ?? {}]",
    );
    expect(mobileTestSetupSource).not.toContain(
      'queryKey: ["statement-account-summaries", "paged"',
    );
    expect(statementsScreenSource).toContain("useStatementAccountSummaries");
    expect(mobileHooksSource).toContain(
      "...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY",
    );
    expect(receivePaymentsSource).toContain(
      "qc.invalidateQueries({ queryKey: FINANCE_INVOICES_QUERY_KEY })",
    );
    expect(receivePaymentsSource).toContain(
      "qc.invalidateQueries({ queryKey: FINANCE_PAYMENT_HISTORY_QUERY_KEY })",
    );
    expect(receivePaymentsSource).toContain(
      "qc.invalidateQueries({ queryKey: FINANCE_STATEMENT_SUMMARIES_QUERY_KEY })",
    );
    expect(desktopInvoicesSource).toMatch(
      /queryKey: \[\s*\.\.\.FINANCE_INVOICES_QUERY_KEY,\s*queryString,\s*invoiceDatePreset === "today" \|\| invoiceDatePreset === "yesterday"\s*\? dateRefreshTick\s*:\s*0,\s*\]/,
    );
    expect(desktopStatementsSource).toContain(
      "queryKey: [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY, orgId]",
    );
  });
});