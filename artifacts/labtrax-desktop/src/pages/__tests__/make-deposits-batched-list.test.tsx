/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import type { BankAccount } from "@/lib/types";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
import { MakeDeposits } from "@/pages/finance/make-deposits";

const row = (id: string, amount: string, warning = false) => ({
  id, txnDate: "2026-01-01", creditAmount: amount, staleDays: warning ? 40 : 1,
  ageWarning: warning, statementDate: null, payee: id,
});
const account = { id: "bank", name: "Checking", accountType: "checking", isArchived: false } as BankAccount;

describe("make deposits batching", () => {
  beforeEach(() => {
    apiFetchMock.mockReset().mockImplementation((url: string) => {
      if (url === "/finance/make-deposits") return Promise.resolve({ moved: 1, totalAmount: "5.00" });
      const params = new URLSearchParams(url.split("?")[1]);
      // The second batch is anchored on the last row of the first one and
      // repeats that row, so the client must de-duplicate rather than double it.
      if (params.get("cursor") === "cursor-a") return Promise.resolve({
        rows: [row("a", "5.00"), row("b", "7.00")], total: 12, limit: 10, offset: 1,
        hasMore: false, nextCursor: "cursor-b", amountTotal: "99.00", staleCount: 4,
        filterOptions: { practices: [{ id: "p1", name: "Practice One" }], doctors: [] },
      });
      return Promise.resolve({
        rows: [{ ...row("a", "5.00", true), practiceId: "p1", practiceName: "Practice One" }], total: 12, limit: 10, offset: 0,
        hasMore: true, nextCursor: "cursor-a", amountTotal: "99.00", staleCount: 4,
        filterOptions: { practices: [{ id: "p1", name: "Practice One" }], doctors: [] },
      });
    });
    vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} });
  });

  it("uses full aggregates, appends uniquely, and deposits only checked loaded rows", async () => {
    render(<MakeDeposits organizationId="lab" accounts={[account]} />, { wrapper: makeAuthWrapper("/finance/make-deposits") });
    expect(await screen.findByText("a")).toBeInTheDocument();
    expect(screen.getByText("4 payments have been sitting in Undeposited Funds for over 30 days.")).toBeInTheDocument();
    expect(screen.getByText("$99.00")).toBeInTheDocument();
    expect(screen.getByTestId("make-deposits-loaded-count")).toHaveTextContent("Showing 1 of 12");
    fireEvent.click(screen.getByTestId("make-deposits-load-more"));
    expect(await screen.findByText("b")).toBeInTheDocument();
    expect(screen.getAllByText("a")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Practice"), { target: { value: "p1" } });
    await waitFor(() => expect(screen.queryByText("b")).not.toBeInTheDocument());
    expect(apiFetchMock.mock.calls.filter(([url]) => String(url).includes("practiceId=p1")).at(-1)?.[0]).not.toContain("cursor=");
    const paymentA = await screen.findByLabelText("Select payment a");
    fireEvent.click(paymentA);
    fireEvent.click(screen.getByRole("button", { name: "Make Deposits" }));
    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(([url]) => url === "/finance/make-deposits");
      expect(JSON.parse(String(call?.[1]?.body)).transactionIds).toEqual(["a"]);
    });
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("cursor=cursor-a"))).toBe(true);
  });
});