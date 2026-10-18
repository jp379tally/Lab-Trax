/**
 * @vitest-environment jsdom
 *
 * Regression guard: the AVG turnaround KPI card on the Reports Summary tab
 * must show the formatted days value and the eligible case count subline when
 * /stats/summary returns avgTurnaroundDays + eligibleTurnaroundCaseCount.
 *
 * Without this test a regression in the summaryQuery, the avgTurnaround memo,
 * or the KPI card binding silently shows "—" with no test failure.
 */

import React from "react";
import { readFileSync } from "node:fs";
import { getLocalDayRange } from "@/lib/format";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, useSearch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "./test-utils";

// ── Module-level mocks (vi.mock is hoisted before imports) ───────────────────

const mockApiFetch = vi.hoisted(() => vi.fn());
const mockDownloadCsv = vi.hoisted(() => vi.fn());
const mockUseInvoiceSalesSeries = vi.hoisted(() => vi.fn());
const mockUseInvoiceDiscountsReport = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  apiFetch: mockApiFetch,
  getAccessToken: vi.fn().mockResolvedValue("tok"),
  getApiOrigin: vi.fn().mockReturnValue("http://localhost"),
  ApiError: class extends Error {},
  createUploadSession: vi.fn(),
  sendUploadChunk: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useGetInvoiceSalesSeries: (...args: unknown[]) =>
    mockUseInvoiceSalesSeries(...args),
  useGetInvoiceDiscountsReport: (...args: unknown[]) =>
    mockUseInvoiceDiscountsReport(...args),
}));

// recharts uses SVG APIs absent in jsdom; stub the components the Summary tab
// renders so it doesn't throw. Keep the rest of the real module: the Reports
// page also pulls in the Stats tab, which imports chart primitives (Legend and
// friends) that a wholesale mock would leave undefined at import time.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  BarChart: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "bar-chart" }, children),
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  Cell: () => null,
}));

vi.mock("@/components/reports/DateRangePicker", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/reports/DateRangePicker")>(),
  DateRangePicker: () => null,
  defaultRange: () => ({ from: "2025-01-01", to: "2025-12-31" }),
  rangeLabel: () => "Jan 1 – Dec 31, 2025",
}));

vi.mock("@/lib/format", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/format")>(),
  formatMoney: (n: number) => `$${Number(n).toFixed(2)}`,
  statusLabel: (s: string) => s,
  formatDate: (s: string) => s,
  formatDateTime: (s: string) => s,
  formatShortDate: (s: string) => s,
}));

vi.mock("@/lib/export", () => ({
  downloadCsv: mockDownloadCsv,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const LAB_ORG = {
  id: "lab-1",
  name: "Test Lab",
  displayName: "Test Lab",
  type: "lab",
};

const ME_RESPONSE = {
  id: "u1",
  username: "labowner",
  role: "owner",
  memberships: [
    {
      id: "m1",
      status: "active",
      role: "owner",
      organization: LAB_ORG,
    },
  ],
};

// The queryFn calls apiFetch once per org and collects results into an array.
// This is what a single /stats/summary?... call returns for one org.
const SUMMARY_ROW = {
  totalCases: 10,
  avgTurnaroundDays: 2.5,
  eligibleTurnaroundCaseCount: 4,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWrapper(initialPath = "/") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  const { hook } = memoryLocation({ path: initialPath });
  const authValue = {
    ...MOCK_AUTH_DEFAULTS,
    user: { id: "u1", username: "labowner", role: "owner" } as never,
    status: "authed" as const,
    restoreStatus: "ok" as const,
    restoreNoticeDismissed: true,
  };
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <Router hook={hook}>
          <AuthContext.Provider value={authValue}>
            {children}
          </AuthContext.Provider>
        </Router>
      </QueryClientProvider>
    );
  }
  return { Wrapper };
}

// ── Import component under test (after all vi.mock calls) ─────────────────────

import ReportsPage, {
  buildSalesSparklinePoints,
  formatSalesPeriod,
} from "@/pages/reports";

function ReportUrlProbe() {
  return <output data-testid="report-url">{useSearch()}</output>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Reports Production tab — billed versus estimated values", () => {
  it("shows saved invoice totals without allocating manual fees to a restoration type", async () => {
    mockApiFetch.mockReset();
    mockDownloadCsv.mockReset();
    mockApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/auth/me") return ME_RESPONSE;
      if (endpoint.startsWith("/invoices/reports/sales-invoices")) {
        return { rows: [], total: 0, billedTotal: "0.00", offset: 0, hasMore: false };
      }
      if (endpoint.startsWith("/cases/reports/production-by-type")) return {
        items: [{ restorationType: "Crown", count: 1, units: 1, cases: 1, revenue: "119.00" }],
        crownsRollup: null,
        totals: { count: 1, units: 1, cases: 1, revenue: "119.00" },
      };
      if (endpoint.startsWith("/invoices/reports/sales")) return { totalSales: "176.00" };
      return {};
    });

    const { Wrapper } = makeWrapper("/?tab=production");
    render(React.createElement(Wrapper, null, React.createElement(ReportsPage, null)));
    await waitFor(() => expect(screen.getByText("$176.00")).toBeInTheDocument());
    expect(screen.getAllByText("$119.00").length).toBeGreaterThan(0);
    expect(screen.getByText(/those fees are not assigned to a restoration type/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    expect(mockDownloadCsv).toHaveBeenCalledWith(
      expect.stringMatching(/^production-by-type-/),
      expect.arrayContaining([expect.objectContaining({
        "Billed total": "176.00",
        "Restoration type": expect.stringContaining("not allocated by type"),
      })]),
    );
  });
});

describe("Reports SummaryTab — AVG turnaround KPI card", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/auth/me") return ME_RESPONSE;
      if (endpoint === "/cases") return [];
      if (endpoint === "/invoices") return [];
      if (endpoint.startsWith("/invoices/reports/sales")) {
        return {
          totalSales: "0",
          openBalance: "0",
          invoices: 0,
          paidInvoices: 0,
          openInvoices: 0,
        };
      }
      // Each org gets one /stats/summary call; the queryFn collects the results.
      if (endpoint.startsWith("/stats/summary")) return SUMMARY_ROW;
      return {};
    });
  });

  it("shows the formatted days value when summaryQuery returns avgTurnaroundDays", async () => {
    const { Wrapper } = makeWrapper("/");
    render(React.createElement(Wrapper, null, React.createElement(ReportsPage, null)));

    await waitFor(
      () => {
        expect(screen.getByText("2.5 days")).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
  }, 15_000);

  it("shows the eligible case count subline under the AVG turnaround card", async () => {
    const { Wrapper } = makeWrapper("/");
    render(React.createElement(Wrapper, null, React.createElement(ReportsPage, null)));

    await waitFor(
      () => {
        expect(screen.getByText("4 eligible cases")).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
  }, 15_000);

  it('shows "—" placeholder when avgTurnaroundDays is null / no eligible data', async () => {
    // Override: return a row with no eligible turnaround data.
    mockApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/auth/me") return ME_RESPONSE;
      if (endpoint === "/cases") return [];
      if (endpoint === "/invoices") return [];
      if (endpoint.startsWith("/invoices/reports/sales")) {
        return { totalSales: "0", openBalance: "0", invoices: 0, paidInvoices: 0, openInvoices: 0 };
      }
      if (endpoint.startsWith("/stats/summary")) {
        return { totalCases: 5, avgTurnaroundDays: null, eligibleTurnaroundCaseCount: null };
      }
      return {};
    });

    const { Wrapper } = makeWrapper("/");
    render(React.createElement(Wrapper, null, React.createElement(ReportsPage, null)));

    await waitFor(
      () => {
        // "—" is rendered only by the Avg turnaround card when data is absent;
        // the other KPI cards always show monetary values or counts.
        expect(screen.getByText("—")).toBeInTheDocument();
        // Confirm the label is present so we know the card rendered.
        expect(screen.getByText("Avg turnaround")).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
  }, 15_000);
});

describe("Reports SalesTab — calendar-safe period labels", () => {
  beforeEach(() => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    mockApiFetch.mockReset();
    mockDownloadCsv.mockReset();
    mockUseInvoiceSalesSeries.mockReset();
    mockUseInvoiceDiscountsReport.mockReset();
    mockUseInvoiceSalesSeries.mockImplementation((params: { groupBy: string }) => {
      const groupBy = params.groupBy;
      const periodStart =
        groupBy === "day"
          ? "2026-09-07T00:00:00.000Z"
          : groupBy === "week"
            ? "2026-08-31T00:00:00.000Z"
            : "2026-09-01T00:00:00.000Z";
      return {
        data: {
          ok: true,
          data: {
            from: "2026-01-01",
            to: "2026-12-31",
            groupBy,
            timeZone: "America/Los_Angeles",
            series: [
              {
                periodStart,
                gross: "125.00",
                discounts: "5.00",
                net: "120.00",
                tax: "0.00",
                billedTotal: "120.00",
                count: 1,
                avg: "120.00",
              },
            ],
            totals: {
              gross: "125.00",
              discounts: "5.00",
              net: "120.00",
              tax: "0.00",
              billedTotal: "120.00",
              count: 1,
              avg: "120.00",
            },
          },
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      };
    });
    mockUseInvoiceDiscountsReport.mockReturnValue({
      data: {
        ok: true,
        data: {
          from: "2026-01-01",
          to: "2026-12-31",
          groupBy: "month",
          timeZone: "America/Los_Angeles",
          series: [
            {
              periodStart: "2026-09-01T00:00:00.000Z",
              amount: "32.50",
              count: 2,
            },
          ],
          items: [
            { item: "Invoice-level discount", amount: "12.50", count: 1 },
            { item: "Courtesy", amount: "20.00", count: 1 },
          ],
          practices: [
            {
              practiceId: "practice-1",
              practiceName: "North Dental",
              doctorName: "Dr North",
              amount: "32.50",
              count: 2,
            },
          ],
          totals: { amount: "32.50", count: 2 },
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/auth/me") return ME_RESPONSE;
      if (endpoint.startsWith("/invoices/reports/sales-invoices")) {
        return { rows: [], total: 0, billedTotal: "0.00", offset: 0, hasMore: false };
      }
      return {};
    });
  });

  it("preserves UTC-midnight calendar dates west of UTC for day, week, and month", () => {
    expect(formatSalesPeriod("2026-09-07T00:00:00.000Z", "day")).toBe("09/07/2026");
    expect(formatSalesPeriod("2026-08-31T00:00:00.000Z", "week")).toBe("08/31/2026");
    expect(formatSalesPeriod("2026-09-07T00:00:00.000Z", "week")).toBe("09/07/2026");
    expect(formatSalesPeriod("2026-09-01T00:00:00.000Z", "month")).toBe("09/2026");
  });

  it("opens the dashboard Today destination with the same local-day bounds for metrics and invoices", async () => {
    const source = readFileSync("src/pages/dashboard.tsx", "utf8");
    const href = source.match(/href="(\/reports\?tab=sales&preset=today)"/)?.[1];
    expect(href).toBe("/reports?tab=sales&preset=today");
    const day = getLocalDayRange();
    const { Wrapper } = makeWrapper(href!);
    render(React.createElement(Wrapper, null, React.createElement(ReportsPage, null)));
    await screen.findByTestId("sales-invoices-empty");
    const salesParams = mockUseInvoiceSalesSeries.mock.calls
      .map(([params]) => params as Record<string, string>)
      .find((params) => params.dateFrom === day.dateFrom);
    expect(salesParams?.dateTo).toBe(day.dateTo);
    const invoicePath = mockApiFetch.mock.calls.find(([url]) =>
      (url as string).startsWith("/invoices/reports/sales-invoices?"))?.[0] as string;
    expect(invoicePath).toBeTruthy();
    const invoiceParams = new URL(invoicePath, "http://localhost").searchParams;
    expect(invoiceParams.get("dateFrom")).toBe(day.dateFrom);
    expect(invoiceParams.get("dateTo")).toBe(day.dateTo);
  });

  it("restores exact Sales filters into requests and writes user grouping and tab changes to the URL", async () => {
    const from = "2025-01-01T00:00:00.000Z";
    const to = "2025-01-31T23:59:59.999Z";
    const initial = new URLSearchParams({ tab: "sales", org: "lab-1", preset: "month", from, to, groupBy: "day" });
    const { Wrapper } = makeWrapper(`/reports?${initial}`);
    render(<Wrapper><ReportsPage /><ReportUrlProbe /></Wrapper>);
    await screen.findByTestId("sales-invoices-empty");
    const salesRequests = mockUseInvoiceSalesSeries.mock.calls
      .map(([params]) => params as Record<string, string>);
    expect(salesRequests.length).toBeGreaterThan(0);
    for (const request of salesRequests) {
      expect(request.dateFrom).toBe(from);
      expect(request.dateTo).toBe(to);
      expect(request.groupBy).toBe("day");
      expect(request.organizationId).toBe("lab-1");
    }
    expect(mockUseInvoiceDiscountsReport).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: from, dateTo: to, groupBy: "day", organizationId: "lab-1" }),
      expect.anything(),
    );
    fireEvent.click(screen.getByRole("button", { name: "week" }));
    await waitFor(() => expect(new URLSearchParams(screen.getByTestId("report-url").textContent!).get("groupBy")).toBe("week"));
    fireEvent.click(screen.getByRole("button", { name: "Production" }));
    const url = new URLSearchParams(screen.getByTestId("report-url").textContent!);
    expect(url.get("tab")).toBe("production");
    expect(url.get("from")).toBe(from);
    expect(url.get("to")).toBe(to);
  });

  it("keeps breakdown and CSV weekly labels aligned after replacing the chart", async () => {
    const { Wrapper } = makeWrapper("/?tab=sales");
    render(React.createElement(Wrapper, null, React.createElement(ReportsPage, null)));

    await waitFor(() => expect(screen.getAllByText("09/2026").length).toBeGreaterThanOrEqual(1));

    fireEvent.click(screen.getByRole("button", { name: "week" }));

    await waitFor(() =>
      expect(screen.getAllByText("08/31/2026").length).toBeGreaterThanOrEqual(1),
    );
    expect(screen.queryByText("Billed total over time")).not.toBeInTheDocument();
    expect(screen.queryByText("08/30/2026")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    expect(mockDownloadCsv).toHaveBeenCalledWith(
      expect.stringMatching(/^sales-week-\d{4}-\d{2}-\d{2}\.csv$/),
      expect.arrayContaining([
        expect.objectContaining({ Period: "08/31/2026", "Billed total": "120.00" }),
      ]),
    );
  });

  it("renders the daily calendar date without a local-time shift", async () => {
    const { Wrapper } = makeWrapper("/?tab=sales");
    render(React.createElement(Wrapper, null, React.createElement(ReportsPage, null)));

    fireEvent.click(await screen.findByRole("button", { name: "day" }));

    await waitFor(() =>
      expect(screen.getAllByText("09/07/2026").length).toBeGreaterThanOrEqual(1),
    );
    expect(screen.queryByText("09/06/2026")).not.toBeInTheDocument();
  });

  it("shows discount breakdowns and exports them as CSV", async () => {
    const { Wrapper } = makeWrapper("/?tab=sales");
    render(React.createElement(Wrapper, null, React.createElement(ReportsPage, null)));

    expect((await screen.findAllByText("$32.50")).length).toBeGreaterThan(0);
    expect(screen.getByText("Discounts given")).toBeInTheDocument();
    expect(screen.getByText("Courtesy")).toBeInTheDocument();
    expect(screen.getByText("North Dental")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export discounts CSV" }));
    expect(mockDownloadCsv).toHaveBeenCalledWith(
      expect.stringMatching(/^discounts-month-\d{4}-\d{2}-\d{2}\.csv$/),
      expect.arrayContaining([
        expect.objectContaining({
          Section: "Item",
          Item: "Courtesy",
          Amount: "20.00",
          Count: 1,
        }),
        expect.objectContaining({
          Section: "Practice",
          Practice: "North Dental",
          Doctor: "Dr North",
        }),
      ]),
    );
  });

  it("shows zero discounts and an empty-state message", async () => {
    mockUseInvoiceDiscountsReport.mockReturnValue({
      data: { ok: true, data: {
        series: [], items: [], practices: [],
        totals: { amount: "0.00", count: 0 },
      } },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    const { Wrapper } = makeWrapper("/?tab=sales");
    render(React.createElement(Wrapper, null, React.createElement(ReportsPage, null)));
    expect(await screen.findByText("No discounts were given in this range.")).toBeInTheDocument();
    expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0);
  });

  it("maps each Sales sparkline to its own current-range series and keeps totals authoritative", async () => {
    const seriesResult = {
      data: {
        ok: true,
        data: {
          series: [
            { periodStart: "2026-09-01", billedTotal: "100.00", net: "80.00", gross: "90.00", discounts: "2.00", avg: "50.00", tax: "0.00", count: 2 },
            { periodStart: "2026-09-02", billedTotal: "220.00", net: "190.00", gross: "205.00", discounts: "7.00", avg: "110.00", tax: "0.00", count: 2 },
            { periodStart: "2026-09-03", billedTotal: "160.00", net: "120.00", gross: "155.00", discounts: "3.00", avg: "80.00", tax: "0.00", count: 2 },
          ],
          totals: {
            billedTotal: "420.00",
            net: "321.00",
            gross: "450.00",
            discounts: "12.00",
            avg: "105.00",
            tax: "0.00",
            count: 6,
          },
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    mockUseInvoiceSalesSeries.mockImplementation(() => seriesResult);
    const { Wrapper } = makeWrapper("/?tab=sales");
    render(<Wrapper><ReportsPage /></Wrapper>);

    await screen.findByTestId("sales-sparkline-billedTotal");
    expect(screen.getByTestId("sales-metric-value-billedTotal")).toHaveTextContent("$420.00");
    expect(screen.getByTestId("sales-metric-value-net")).toHaveTextContent("$321.00");
    expect(screen.getByTestId("sales-metric-value-gross")).toHaveTextContent("$450.00");
    expect(screen.getByTestId("sales-metric-value-discounts")).toHaveTextContent("$12.00");
    expect(screen.getByTestId("sales-metric-value-avg")).toHaveTextContent("$105.00");
    expect(screen.getByTestId("sales-sparkline-billedTotal").querySelector("polyline"))
      .toHaveAttribute("points", "0,21 50,3 100,12");
    expect(screen.getByTestId("sales-sparkline-net").querySelector("polyline"))
      .toHaveAttribute("points", "0,21 50,3 100,14.454545454545453");
    expect(screen.getByTestId("sales-sparkline-discounts").querySelector("polyline"))
      .toHaveAttribute("points", "0,21 50,3 100,17.4");
    expect(screen.queryByText(/previous period/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search invoices/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/all statuses/i)).not.toBeInTheDocument();
  });

  it("does not draw a sparkline from an empty or single-bucket range", async () => {
    expect(buildSalesSparklinePoints([])).toBeNull();
    expect(buildSalesSparklinePoints(["125.00"])).toBeNull();
    expect(buildSalesSparklinePoints(["100", "invalid"])).toBeNull();

    const { Wrapper } = makeWrapper("/?tab=sales");
    render(<Wrapper><ReportsPage /></Wrapper>);
    await screen.findByTestId("sales-invoices-empty");

    expect(screen.queryByTestId("sales-sparkline-billedTotal")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sales-sparkline-net")).not.toBeInTheDocument();
  });
});
