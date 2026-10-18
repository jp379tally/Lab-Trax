/** @vitest-environment jsdom */
/**
 * Regression guard: revenue chart legend labels and reference-line values must
 * reflect the org's revenueTargetLow / revenueTargetHigh rather than the
 * module-level defaults ($85k / $95k).
 *
 * A silent failure mode: bar colors update (they read thresholds correctly) but
 * the legend still shows the old hardcoded strings — or vice versa. This test
 * pins both surfaces to the same org-specific values.
 */
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReportsPage from "@/pages/reports";

const REVENUE_SERIES_WITH_DATA = {
  ok: true,
  data: {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-03-31T23:59:59.999Z",
    groupBy: "month",
    timeZone: "UTC",
    category: null,
    series: [
      { period: "2026-01", periodStart: "2026-01-01T00:00:00.000Z", revenue: "90000.00", invoiceCount: 8 },
      { period: "2026-02", periodStart: "2026-02-01T00:00:00.000Z", revenue: "65000.00", invoiceCount: 5 },
      { period: "2026-03", periodStart: "2026-03-01T00:00:00.000Z", revenue: "75000.00", invoiceCount: 6 },
    ],
    totals: { revenue: "230000.00", invoiceCount: 19, averageInvoice: "12105.26" },
  },
};

const EMPTY_SUMMARY = {
  ok: true,
  data: {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-03-31T23:59:59.999Z",
    timeZone: "UTC",
    category: null,
    totalCases: 0,
    legacyCases: 0,
    totalRevenue: "0.00",
    invoiceCount: 0,
    averageDailyRevenue: "0.00",
    averageCaseValue: "0.00",
    topCategory: null,
    topCategoryLabel: null,
    topCategoryCount: 0,
    busiestWeekday: null,
    busiestWeekdayLabel: null,
    previousPeriod: null,
  },
};

const EMPTY_CATEGORIES = {
  ok: true,
  data: {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-03-31T23:59:59.999Z",
    totalCases: 0,
    categories: [],
    materials: [],
    caseTypes: [],
    caseSubtypes: [],
    caseMaterialSubtypes: [],
  },
};

const EMPTY_WEEKDAYS = {
  ok: true,
  data: {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-03-31T23:59:59.999Z",
    timeZone: "UTC",
    category: null,
    totalCases: 0,
    weekdays: [
      { weekday: 0, label: "Monday", total: 0, byCategory: {} },
      { weekday: 1, label: "Tuesday", total: 0, byCategory: {} },
      { weekday: 2, label: "Wednesday", total: 0, byCategory: {} },
      { weekday: 3, label: "Thursday", total: 0, byCategory: {} },
      { weekday: 4, label: "Friday", total: 0, byCategory: {} },
      { weekday: 5, label: "Saturday", total: 0, byCategory: {} },
      { weekday: 6, label: "Sunday", total: 0, byCategory: {} },
    ],
  },
};

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetStatsSummary: () => ({ data: EMPTY_SUMMARY, isLoading: false, isError: false }),
    useGetStatsCaseCategories: () => ({ data: EMPTY_CATEGORIES, isLoading: false, isError: false }),
    useGetStatsRevenueSeries: () => ({ data: REVENUE_SERIES_WITH_DATA, isLoading: false, isError: false }),
    useGetStatsWeekdayVolume: () => ({ data: EMPTY_WEEKDAYS, isLoading: false, isError: false }),
    useGetStatsRemakes: () => ({ data: undefined, isLoading: false, isError: false }),
    useGetStatsSalesForecast: () => ({ data: undefined, isLoading: false, isError: false }),
    getGetStatsCaseCategoriesQueryKey: () => ["stats", "case-categories"],
    getGetStatsSalesForecastQueryKey: () => ["stats", "sales-forecast"],
  };
});

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    /**
     * Recharts BarChart identifies children by component type reference, not
     * by React rendering — mocking ReferenceLine replaces the type token that
     * BarChart looks for and breaks rendering entirely.  We only stub
     * ResponsiveContainer (which uses ResizeObserver that jsdom lacks) and
     * leave all chart primitives including ReferenceLine untouched so recharts
     * renders their SVG label text nodes into the DOM.
     */
    ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => (
      <div>{children as React.ReactNode}</div>
    ),
  };
});

vi.mock("@/lib/stats-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stats-export")>();
  return {
    ...actual,
    downloadRevenueCsv: vi.fn(),
    downloadCategoryCsv: vi.fn(),
    downloadMaterialCsv: vi.fn(),
    downloadStatsPdf: vi.fn(),
  };
});

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const OWNER_MEMBERSHIP = {
  id: "m1",
  role: "owner",
  status: "active",
  organization: {
    id: "lab-1",
    type: "lab",
    name: "Test Lab",
    displayName: "Test Lab",
  },
};

// Stats is a tab on the Reports page, selected via the `tab` query param.
function renderPage() {
  window.history.pushState({}, "", "/reports?tab=stats");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith("/auth/me")) {
      return { user: { id: "u1" }, memberships: [OWNER_MEMBERSHIP] };
    }
    if (endpoint.startsWith("/organizations/")) {
      return { revenueTargetLow: 70_000, revenueTargetHigh: 80_000 };
    }
    return {};
  });
});

describe("Stats page — revenue legend uses org thresholds", () => {
  it("shows legend labels derived from org revenueTargetLow/revenueTargetHigh, not the module defaults", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("< $70k")).not.toBeNull();
    });

    // Legend labels must reflect the org thresholds.
    expect(screen.getByText("< $70k")).toBeTruthy();
    expect(screen.getByText("$70k–$80k")).toBeTruthy();
    expect(screen.getByText("> $80k")).toBeTruthy();

    // The threshold sentinel element exposes the same revLow/revHigh variables
    // that are passed to ReferenceLine y={...}.  ReferenceLine SVG labels are
    // not rendered by recharts in jsdom (no real layout), so we verify via the
    // sentinel that the reference lines receive the correct numeric thresholds.
    await waitFor(() => {
      expect(screen.queryByTestId("revenue-chart-thresholds")).not.toBeNull();
    });
    const sentinel = screen.getByTestId("revenue-chart-thresholds");
    expect(sentinel.getAttribute("data-high")).toBe("80000");
    expect(sentinel.getAttribute("data-low")).toBe("70000");
  });

  it("does NOT show the hardcoded default threshold labels when org overrides are set", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("< $70k")).not.toBeNull();
    });

    // Legend labels must not contain the old hardcoded defaults.
    expect(screen.queryByText("< $85k")).toBeNull();
    expect(screen.queryByText("> $95k")).toBeNull();

    // Sentinel must not carry the default threshold values.
    const sentinel = screen.getByTestId("revenue-chart-thresholds");
    expect(sentinel.getAttribute("data-high")).not.toBe("95000");
    expect(sentinel.getAttribute("data-low")).not.toBe("85000");
  });

  it("renders without crashing when revenueTargetLow > revenueTargetHigh (inverted thresholds)", async () => {
    apiFetchMock.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith("/auth/me")) {
        return { user: { id: "u1" }, memberships: [OWNER_MEMBERSHIP] };
      }
      if (endpoint.startsWith("/organizations/")) {
        // Deliberately swapped: low (80k) > high (70k)
        return { revenueTargetLow: 80_000, revenueTargetHigh: 70_000 };
      }
      return {};
    });

    // The component must not throw — inverted thresholds produce a
    // nonsensical legend but must never crash the chart.
    expect(() => renderPage()).not.toThrow();

    // Wait for the org fetch to resolve: the legend will show `< $80k`
    // (the inverted low value) once the org settings are applied.
    await waitFor(() => {
      expect(screen.queryByText("< $80k")).not.toBeNull();
    });

    // Sentinel must expose the exact values the server returned (not
    // silently swapped or clamped to defaults).
    const sentinel = screen.getByTestId("revenue-chart-thresholds");
    expect(sentinel.getAttribute("data-low")).toBe("80000");
    expect(sentinel.getAttribute("data-high")).toBe("70000");
  });

  it("falls back to default labels ($85k / $95k) when the org has no custom thresholds", async () => {
    apiFetchMock.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith("/auth/me")) {
        return { user: { id: "u1" }, memberships: [OWNER_MEMBERSHIP] };
      }
      if (endpoint.startsWith("/organizations/")) {
        return { revenueTargetLow: null, revenueTargetHigh: null };
      }
      return {};
    });

    renderPage();

    await waitFor(() => {
      expect(screen.queryByText("< $85k")).not.toBeNull();
    });

    // Legend labels fall back to defaults.
    expect(screen.getByText("< $85k")).toBeTruthy();
    expect(screen.getByText("$85k–$95k")).toBeTruthy();
    expect(screen.getByText("> $95k")).toBeTruthy();

    // Sentinel must reflect the default threshold values — same variables used
    // for ReferenceLine y props when org has no custom targets.
    const sentinel = screen.getByTestId("revenue-chart-thresholds");
    expect(sentinel.getAttribute("data-high")).toBe("95000");
    expect(sentinel.getAttribute("data-low")).toBe("85000");
  });
});
