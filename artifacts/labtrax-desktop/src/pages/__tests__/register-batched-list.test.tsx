/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { BankAccount, BankTransaction } from "@/lib/types";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
import { RegisterTable } from "@/pages/finance/register";

const account = { id: "acct", labOrganizationId: "lab", name: "Checking", accountType: "checking", isArchived: false } as BankAccount;
const txn = (id: string, payee: string): BankTransaction => ({
  id, labOrganizationId: "lab", bankAccountId: "acct", txnDate: "2026-01-01", type: "check",
  checkNumber: null, payee, vendorId: null, memo: null, categoryId: null, debitAmount: "1",
  creditAmount: "0", netAmount: "-1", cleared: false, reconciled: false, status: "posted",
  source: "manual", runningBalance: "1", transferGroupId: null,
});

describe("register batching", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
    Element.prototype.scrollIntoView = vi.fn();
    apiFetchMock.mockReset().mockImplementation((url: string) => {
      if (url.startsWith("/finance/categories") || url.startsWith("/finance/vendors")) return Promise.resolve([]);
      const query = new URLSearchParams(url.split("?")[1]);
      if (query.get("search")) return Promise.resolve({ rows: [txn("filtered", "Filtered")], total: 1, limit: 10, offset: 0, hasMore: false, nextCursor: null });
      // The second batch is anchored on the last row of the first one and
      // repeats that row (its payee changed), so the client must de-duplicate.
      if (query.get("cursor") === "cursor-one") return Promise.resolve({ rows: [txn("one", "One updated"), txn("two", "Two")], total: 12, limit: 10, offset: 1, hasMore: false, nextCursor: "cursor-two" });
      return Promise.resolve({ rows: [txn("one", "One")], total: 12, limit: 10, offset: 0, hasMore: true, nextCursor: "cursor-one" });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requests bounded pages, de-duplicates appends, and resets on search", async () => {
    render(<RegisterTable organizationId="lab" accountId="acct" accounts={[account]} />, { wrapper: makeAuthWrapper() });
    expect(await screen.findByText("One")).toBeInTheDocument();
    expect(apiFetchMock.mock.calls.find(([url]) => String(url).startsWith("/finance/transactions"))?.[0]).toContain("limit=10");
    expect(screen.getByTestId("register-loaded-count")).toHaveTextContent("Showing 1 of 12");
    fireEvent.click(screen.getByTestId("register-load-more"));
    expect(await screen.findByText("Two")).toBeInTheDocument();
    expect(screen.getAllByText(/One/)).toHaveLength(1);
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("cursor=cursor-one"))).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/Search/i), { target: { value: "filtered" } });
    await screen.findByText("Filtered");
    await waitFor(() => expect(screen.queryByText("Two")).not.toBeInTheDocument());
    const last = apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith("/finance/transactions")).at(-1)?.[0];
    expect(last).not.toContain("cursor=");
  });
  it("uses whole calendar bounds, holds malformed dates, and resets all register filters", async () => {
    render(<RegisterTable organizationId="lab" accountId="acct" accounts={[account]} />, { wrapper: makeAuthWrapper() });
    await screen.findByText("One");
    fireEvent.change(screen.getByTitle("From date"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByTitle("To date"), { target: { value: "2026-09-02" } });
    await waitFor(() => {
      const url = apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith("/finance/transactions")).at(-1)?.[0];
      const params = new URLSearchParams(String(url).split("?")[1]);
      expect(params.get("dateFrom")).toBe("2026-09-01T00:00:00.000Z");
      expect(params.get("dateTo")).toBe("2026-09-02T23:59:59.999Z");
    });
    fireEvent.change(screen.getByTitle("From date"), { target: { value: "2026-09-03" } });
    await screen.findByText(/Choose valid register dates/);
    expect(screen.getByRole("button", { name: /Export/i })).toBeDisabled();
    fireEvent.click(screen.getByTestId("filter-reset"));
    await waitFor(() => {
      expect(screen.getByTitle("From date")).toHaveValue("");
      expect(screen.getByTitle("To date")).toHaveValue("");
      expect(screen.queryByText(/Choose valid register dates/)).toBeNull();
    });
  });
});