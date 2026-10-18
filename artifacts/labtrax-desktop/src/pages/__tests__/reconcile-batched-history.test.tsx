/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
import { Reconcile } from "@/pages/finance/reconcile";

const history = (id: string, date: string) => ({
  id, statementDate: date, endingBalance: "10.00", clearedTotal: "10.00", difference: "0.00",
});

describe("reconciliation history batching", () => {
  beforeEach(() => {
    apiFetchMock.mockReset().mockImplementation((url: string) => {
      if (url.includes("/candidates")) return Promise.resolve({ startingBalance: "0", candidates: [] });
      if (url.includes("cursor=cursor-h1")) return Promise.resolve({ rows: [history("h2", "2025-01-01")], total: 11, limit: 10, offset: 1, hasMore: false, nextCursor: "cursor-h2" });
      return Promise.resolve({ rows: [history("h1", "2026-01-01")], total: 11, limit: 10, offset: 0, hasMore: true, nextCursor: "cursor-h1" });
    });
  });

  it("requests the first batch and appends Load more results", async () => {
    render(<Reconcile accountId="acct" />, { wrapper: makeAuthWrapper() });
    await waitFor(() => expect(screen.getByTestId("reconcile-history-loaded-count")).toHaveTextContent("Showing 1 of 11"));
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("limit=10") && !String(url).includes("cursor="))).toBe(true);
    fireEvent.click(screen.getByTestId("reconcile-history-load-more"));
    await waitFor(() => expect(screen.getByTestId("reconcile-history-loaded-count")).toHaveTextContent("Showing 2 of 11"));
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("cursor=cursor-h1"))).toBe(true);
  });
});