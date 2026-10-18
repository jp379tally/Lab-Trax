/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock("@/components/finance/FinanceShell", () => ({
  FinanceShell: ({ children }: { children: (value: { organizationId: string; accounts: [] }) => React.ReactNode }) =>
    <>{children({ organizationId: "lab", accounts: [] })}</>,
}));
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PaymentElement: () => null, useStripe: () => null, useElements: () => null,
}));
vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn(() => null) }));
import ReceivePaymentsPage from "@/pages/finance/receive-payments";

const statement = (id: string) => ({ id, periodStart: "2026-01-01", periodEnd: "2026-01-31", savedBalanceDue: "10", invoiceCount: 1 });

describe("receive payment statement batching", () => {
  beforeEach(() => {
    apiFetchMock.mockReset().mockImplementation((url: string) => {
      if (url.includes("/card/config")) return Promise.reject(new Error("disabled"));
      if (url.includes("/eligible-statement-accounts")) return Promise.resolve([
        { providerOrganizationId: "practice", providerName: "Practice", statementId: "s1", sentAt: "2026-02-01", invoiceCount: 1, currentBalanceDue: "10" },
      ]);
      if (url.includes("/accounts/practice/statements")) {
        if (url.includes("cursor=cursor-s1")) return Promise.resolve({ rows: [statement("s2")], total: 11, limit: 10, offset: 1, hasMore: false, nextCursor: "cursor-s2" });
        return Promise.resolve({ rows: [statement("s1")], total: 11, limit: 10, offset: 0, hasMore: true, nextCursor: "cursor-s1" });
      }
      if (url.includes("/statements/s1")) return Promise.resolve({ ...statement("s1"), invoices: [] });
      return Promise.resolve({});
    });
  });

  it("loads and appends bounded statement pages", async () => {
    render(<ReceivePaymentsPage />, { wrapper: makeAuthWrapper() });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Practice" }));
    await waitFor(() => expect(screen.getByTestId("expected-payments")).toHaveTextContent("$10.00"));
    fireEvent.click(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("receive-statements-loaded-count")).toHaveTextContent("Showing 1 of 11"));
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("limit=10") && !String(url).includes("cursor="))).toBe(true);
    fireEvent.click(screen.getByTestId("receive-statements-load-more"));
    await waitFor(() => expect(screen.getByTestId("receive-statements-loaded-count")).toHaveTextContent("Showing 2 of 11"));
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("cursor=cursor-s1"))).toBe(true);
  });
});