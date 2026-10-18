// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { RegisterAnalyticsPanels } from "../RegisterAnalyticsPanels";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock("recharts", () => {
  const P = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { ResponsiveContainer: P, BarChart: P, PieChart: P, Pie: P, Bar: P, Cell: P, CartesianGrid: P, XAxis: P, YAxis: P, Tooltip: P };
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><RegisterAnalyticsPanels organizationId="o" accountId="a" /></QueryClientProvider>);
}

describe("RegisterAnalyticsPanels", () => {
  it("shows zero state, not fake zeros", async () => {
    apiFetch.mockResolvedValue({ daily: [], payees: [], statuses: { postedCleared: 0, postedUncleared: 0, voided: 0, pending: 0 }, totalEntries: 0 });
    wrap();
    await waitFor(() => expect(screen.getAllByText("No entries in this date range.").length).toBe(3));
    expect(apiFetch.mock.calls[0][0]).toContain("/finance/register-analytics?");
  });
  it("shows error with retry", async () => {
    apiFetch.mockRejectedValue(new Error("x"));
    wrap();
    await waitFor(() => expect(screen.getAllByText("Retry").length).toBe(3));
  });
  it("renders data with accessible values", async () => {
    apiFetch.mockResolvedValue({ daily: [{ date: "2026-09-02", payments: "10.00", deposits: "25.50" }], payees: [{ payee: "Heartland Dental", payments: "0", deposits: "25.50", volume: "25.50" }], statuses: { postedCleared: 1, postedUncleared: 0, voided: 0, pending: 0 }, totalEntries: 1 });
    wrap();
    await waitFor(() => expect(screen.getByText("Heartland Dental")).toBeTruthy());
    fireEvent.click(screen.getByTestId("toggle-daily-details"));
    expect(screen.getByTestId("cash-flow-values").textContent).toContain("25.50");
    expect(screen.getByText(/Deposits .*25\.50 \/ Payments/)).toBeTruthy();
  });
  it("keys the whole-set analytics by account and period, refreshes with finance writes, and hides failed refreshes", async () => {
    apiFetch.mockReset().mockImplementation(async (url: string) => {
      const account = new URLSearchParams(url.split("?")[1]).get("bankAccountId");
      return { daily: [{ date: "2026-09-02", payments: "10.00", deposits: "25.50" }], payees: [{ payee: account === "b" ? "Other account payee" : "Selected account payee", payments: "10", deposits: "25.50", volume: "35.50" }], statuses: { postedCleared: 1, postedUncleared: 0, voided: 0, pending: 0 }, totalEntries: 1 };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderPanel = (accountId: string) => <QueryClientProvider client={qc}><RegisterAnalyticsPanels organizationId="o" accountId={accountId} /></QueryClientProvider>;
    const page = render(renderPanel("a"));
    await screen.findByText("Selected account payee");
    page.rerender(renderPanel("b"));
    await screen.findByText("Other account payee");
    expect(screen.queryByText("Selected account payee")).toBeNull();
    fireEvent.change(screen.getByTestId("analytics-from"), { target: { value: "2026-09-02" } });
    fireEvent.change(screen.getByTestId("analytics-to"), { target: { value: "2026-09-02" } });
    await waitFor(() => expect(apiFetch.mock.calls.at(-1)?.[0]).toContain("dateTo=2026-09-02"));
    apiFetch.mockRejectedValue(new Error("refresh failed"));
    await qc.invalidateQueries({ queryKey: ["finance"] });
    await waitFor(() => expect(screen.getAllByText("Unable to load analytics.")).toHaveLength(3));
    expect(screen.queryByText("Other account payee")).toBeNull();
  });
});
