import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { refreshCaseFinanceQueries, refreshCustomerBalanceQueries, refreshInvoiceSalesQueries } from "../refresh-case-finance";

const derivedKeys = [
  ["invoices", "paged", { status: "open" }],
  ["invoices", "reports", "sales", "today", "lab-a"],
  ["invoice", "invoice-a"],
  ["invoice-for-case", "case-a"],
  ["case", "case-a"],
  ["cases", "worklist", "lab-a"],
  ["reports", "sales", "lab-a"],
  ["reports", "sales-series", "lab-a", "month"],
  ["reports", "sales-forecast", "lab-a"],
  ["stats", "summary", "lab-a"],
  ["getGetStatsSummary", { organizationId: "lab-a" }],
  ["/api/stats/revenue-series", "lab-a"],
  ["statement-account-summaries", "lab-a"],
  ["finance", "accounts", "lab-a"],
  ["doctor-invoices", "lab-a"],
  ["organizations"],
  ["customer-center-summary"],
  ["shared-provider-account", "lab-a", "practice-a"],
  ["customer-statement-charges", "practice-a", "lab-a", "all", "", "", 0],
  ["billing", "eligible-invoice-accounts", "lab-a"],
  ["billing", "eligible-statement-accounts", "lab-a"],
] as const;

function clientWithCachedViews() {
  const client = new QueryClient();
  for (const key of derivedKeys) client.setQueryData(key, { total: "5.00" });
  client.setQueryData(["unrelated", "catalog"], {});
  return client;
}

describe("invoice-derived view refresh", () => {
  it.each([
    ["single invoice update", (client: QueryClient) => refreshInvoiceSalesQueries(client, "invoice-a", "case-a")],
    ["new or bulk invoice write", (client: QueryClient) => refreshInvoiceSalesQueries(client)],
    ["case intake with invoice creation", (client: QueryClient) => refreshCaseFinanceQueries(client)],
  ])("%s invalidates table, daily/monthly sales, forecasting and stats caches", async (_label, refresh) => {
    const client = clientWithCachedViews();
    await refresh(client);
    for (const key of derivedKeys) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
    expect(client.getQueryState(["unrelated", "catalog"])?.isInvalidated).toBe(false);
  });
});

describe("customer-balance view refresh", () => {
  // The exact key shapes the Customer Center, customer account tabs and
  // Receive Payments pickers cache under.
  const balanceKeys = [
    ["customer-center-summary"],
    ["provider-lab-card", "lab-a", "practice-a"],
    ["shared-provider-account", "lab-a", "practice-a"],
    ["customer-statement-charges", "practice-a", "lab-a", "all", "", "", 0],
    ["practice-statements", { practiceId: "practice-a", labOrgId: "lab-a" }],
    ["billing", "eligible-invoice-accounts", "lab-a"],
    ["billing", "eligible-statement-accounts", "lab-a"],
  ] as const;

  it("invalidates every customer-balance view and nothing unrelated", async () => {
    const client = new QueryClient();
    for (const key of balanceKeys) client.setQueryData(key, { balance: "5.00" });
    client.setQueryData(["billing", "settings", "lab-a"], {});
    client.setQueryData(["unrelated", "catalog"], {});
    await refreshCustomerBalanceQueries(client);
    for (const key of balanceKeys) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
    expect(client.getQueryState(["billing", "settings", "lab-a"])?.isInvalidated).toBe(false);
    expect(client.getQueryState(["unrelated", "catalog"])?.isInvalidated).toBe(false);
  });
});