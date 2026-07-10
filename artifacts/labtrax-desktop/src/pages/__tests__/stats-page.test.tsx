/** @vitest-environment jsdom */
/**
 * Desktop Stats page tests.
 *
 * - Billing-role user (lab owner) sees the summary metric cards populated
 *   from the generated stats hooks (envelope shape: data.data).
 * - Empty states render when the window has no data.
 * - Non-billing user sees the restricted card and no metrics.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const SUMMARY = {
  ok: true,
  data: {
    from: "2026-03-01T00:00:00.000Z",
    to: "2026-03-31T23:59:59.999Z",
    timeZone: "UTC",
    category: null,
    totalCases: 42,
    legacyCases: 5,
    totalRevenue: "1234.50",
    invoiceCount: 10,
    averageCaseValue: "123.45",
    topCategory: "zirconia",
    topCategoryLabel: "Zirconia",
    topCategoryCount: 18,
    busiestWeekday: 0,
    busiestWeekdayLabel: "Monday",
    previousPeriod: {
      from: "2026-02-01T00:00:00.000Z",
      to: "2026-02-28T23:59:59.999Z",
      totalCases: 30,
      totalRevenue: "1000.00",
      invoiceCount: 8,
      averageCaseValue: "125.00",
      casesChangePct: 40,
      revenueChangePct: 23.5,
    },
  },
};

const CATEGORIES = {
  ok: true,
  data: {
    from: "2026-03-01T00:00:00.000Z",
    to: "2026-03-31T23:59:59.999Z",
    totalCases: 42,
    categories: [
      { category: "implants", label: "Implants", count: 4, legacyCount: 0 },
      { category: "zirconia", label: "Zirconia", count: 18, legacyCount: 0 },
      {
        category: "crown_bridge",
        label: "Crown & Bridge",
        count: 10,
        legacyCount: 0,
      },
      { category: "removable", label: "Removable", count: 5, legacyCount: 2 },
      { category: "other", label: "Other", count: 2, legacyCount: 0 },
      {
        category: "uncategorized",
        label: "Uncategorized / Legacy",
        count: 3,
        legacyCount: 3,
      },
    ],
    materials: [
      { material: "Zirconia", restorations: 20, units: 25 },
      { material: "Lithium Disilicate (Emax)", restorations: 6, units: 6 },
    ],
  },
};

const REVENUE = {
  ok: true,
  data: {
    from: "2026-03-01T00:00:00.000Z",
    to: "2026-03-31T23:59:59.999Z",
    groupBy: "month",
    timeZone: "UTC",
    category: null,
    series: [
      {
        period: "2026-03",
        periodStart: "2026-03-01T00:00:00.000Z",
        revenue: "1234.50",
        invoiceCount: 10,
      },
    ],
    totals: { revenue: "1234.50", invoiceCount: 10, averageInvoice: "123.45" },
  },
};

const WEEKDAYS = {
  ok: true,
  data: {
    from: "2026-03-01T00:00:00.000Z",
    to: "2026-03-31T23:59:59.999Z",
    timeZone: "UTC",
    category: null,
    weekdays: [
      { weekday: 0, label: "Monday", total: 12, byCategory: { zirconia: 12 } },
      { weekday: 1, label: "Tuesday", total: 8, byCategory: { implants: 8 } },
      { weekday: 2, label: "Wednesday", total: 6, byCategory: {} },
      { weekday: 3, label: "Thursday", total: 6, byCategory: {} },
      { weekday: 4, label: "Friday", total: 10, byCategory: {} },
      { weekday: 5, label: "Saturday", total: 0, byCategory: {} },
      { weekday: 6, label: "Sunday", total: 0, byCategory: {} },
    ],
    totalCases: 42,
  },
};

const EMPTY_SUMMARY = {
  ok: true,
  data: {
    ...SUMMARY.data,
    totalCases: 0,
    legacyCases: 0,
    totalRevenue: "0.00",
    invoiceCount: 0,
    averageCaseValue: "0.00",
    topCategory: null,
    topCategoryLabel: null,
    topCategoryCount: 0,
    busiestWeekday: null,
    busiestWeekdayLabel: null,
  },
};
const EMPTY_CATEGORIES = {
  ok: true,
  data: { ...CATEGORIES.data, totalCases: 0, categories: [], materials: [] },
};
const EMPTY_REVENUE = {
  ok: true,
  data: {
    ...REVENUE.data,
    series: [],
    totals: { revenue: "0.00", invoiceCount: 0, averageInvoice: "0.00" },
  },
};
const EMPTY_WEEKDAYS = {
  ok: true,
  data: {
    ...WEEKDAYS.data,
    totalCases: 0,
    weekdays: WEEKDAYS.data.weekdays.map((w) => ({
      ...w,
      total: 0,
      byCategory: {},
    })),
  },
};

let summaryPayload: unknown = SUMMARY;
let categoriesPayload: unknown = CATEGORIES;
let revenuePayload: unknown = REVENUE;
let weekdaysPayload: unknown = WEEKDAYS;
// Captures the params passed to the stats hooks so tests can assert the
// category/material filters are threaded through.
const seenSummaryParams: Array<Record<string, unknown>> = [];
const seenCategoriesParams: Array<Record<string, unknown>> = [];

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetStatsSummary: (params: Record<string, unknown>) => {
      seenSummaryParams.push(params);
      return {
        data: summaryPayload,
        isLoading: false,
        isError: false,
      };
    },
    useGetStatsCaseCategories: (params: Record<string, unknown>) => {
      seenCategoriesParams.push(params);
      return {
        data: categoriesPayload,
        isLoading: false,
        isError: false,
      };
    },
    useGetStatsRevenueSeries: () => ({
      data: revenuePayload,
      isLoading: false,
      isError: false,
    }),
    useGetStatsWeekdayVolume: () => ({
      data: weekdaysPayload,
      isLoading: false,
      isError: false,
    }),
    useGetStatsRemakes: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
  };
});

let meMemberships: Array<Record<string, unknown>> = [];
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (endpoint: string) => {
    if (endpoint.startsWith("/auth/me")) {
      return { user: { id: "u1" }, memberships: meMemberships };
    }
    return {};
  }),
}));

// Export side effects (blob downloads / jsPDF) are mocked out — the CSV/PDF
// content rules live in stats-export.test.ts; here we only assert wiring.
const downloadRevenueCsvMock = vi.fn();
const downloadCategoryCsvMock = vi.fn();
const downloadMaterialCsvMock = vi.fn();
const downloadStatsPdfMock = vi.fn();
vi.mock("@/lib/stats-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stats-export")>();
  return {
    ...actual,
    downloadRevenueCsv: (...args: unknown[]) => downloadRevenueCsvMock(...args),
    downloadCategoryCsv: (...args: unknown[]) =>
      downloadCategoryCsvMock(...args),
    downloadMaterialCsv: (...args: unknown[]) =>
      downloadMaterialCsvMock(...args),
    downloadStatsPdf: (...args: unknown[]) => downloadStatsPdfMock(...args),
  };
});

// Recharts' ResponsiveContainer needs real layout measurements jsdom lacks.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => (
      <div>{children as any}</div>
    ),
  };
});

import StatsPage from "@/pages/stats";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <StatsPage />
    </QueryClientProvider>,
  );
}

const OWNER_MEMBERSHIP = {
  id: "m1",
  role: "owner",
  status: "active",
  organization: {
    id: "lab-1",
    type: "lab",
    name: "Main Lab",
    displayName: "Main Lab",
  },
};

describe("StatsPage", () => {
  it("shows populated metrics and charts for a billing-role user", async () => {
    meMemberships = [OWNER_MEMBERSHIP];
    summaryPayload = SUMMARY;
    categoriesPayload = CATEGORIES;
    revenuePayload = REVENUE;
    weekdaysPayload = WEEKDAYS;
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("stats-summary-cards")).toBeTruthy();
    });
    expect(screen.getByText("42")).toBeTruthy(); // total cases
    expect(screen.getByText("$1,234.50")).toBeTruthy(); // total sales
    expect(screen.getByText("5 legacy")).toBeTruthy();
    expect(screen.getAllByText("Zirconia").length).toBeGreaterThan(0); // top category
    expect(screen.getAllByText("Monday").length).toBeGreaterThan(0);
    expect(screen.getByTestId("stats-materials-list")).toBeTruthy();
    expect(screen.queryByTestId("stats-restricted")).toBeNull();
  });

  it("renders the material filter and threads the selection into the hooks", async () => {
    meMemberships = [OWNER_MEMBERSHIP];
    summaryPayload = SUMMARY;
    categoriesPayload = CATEGORIES;
    revenuePayload = REVENUE;
    weekdaysPayload = WEEKDAYS;
    renderPage();

    const select = await waitFor(
      () => screen.getByTestId("stats-material-select") as HTMLSelectElement,
    );
    // Options come from the materials breakdown, plus "All materials".
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels[0]).toMatch(/all materials/i);
    expect(optionLabels).toContain("Zirconia");
    expect(optionLabels).toContain("Lithium Disilicate (Emax)");

    seenSummaryParams.length = 0;
    seenCategoriesParams.length = 0;
    fireEvent.change(select, { target: { value: "Zirconia" } });

    await waitFor(() => {
      const last = seenSummaryParams[seenSummaryParams.length - 1];
      expect(last?.["material"]).toBe("Zirconia");
    });
    // The filtered categories query gets the material; the options query
    // (kept unfiltered so the dropdown never collapses) must not.
    const withMaterial = seenCategoriesParams.filter(
      (p) => p?.["material"] === "Zirconia",
    );
    const withoutMaterial = seenCategoriesParams.filter(
      (p) => p?.["material"] === undefined,
    );
    expect(withMaterial.length).toBeGreaterThan(0);
    expect(withoutMaterial.length).toBeGreaterThan(0);
  });

  it("shows empty states when the window has no data", async () => {
    meMemberships = [OWNER_MEMBERSHIP];
    summaryPayload = EMPTY_SUMMARY;
    categoriesPayload = EMPTY_CATEGORIES;
    revenuePayload = EMPTY_REVENUE;
    weekdaysPayload = EMPTY_WEEKDAYS;
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("stats-revenue-empty")).toBeTruthy();
    });
    expect(screen.getByTestId("stats-categories-empty")).toBeTruthy();
    expect(screen.getByTestId("stats-materials-empty")).toBeTruthy();
    expect(screen.getByTestId("stats-weekday-empty")).toBeTruthy();
  });

  it("exports CSVs and the PDF report with the active filters threaded through", async () => {
    meMemberships = [OWNER_MEMBERSHIP];
    summaryPayload = SUMMARY;
    categoriesPayload = CATEGORIES;
    revenuePayload = REVENUE;
    weekdaysPayload = WEEKDAYS;
    downloadRevenueCsvMock.mockClear();
    downloadCategoryCsvMock.mockClear();
    downloadMaterialCsvMock.mockClear();
    downloadStatsPdfMock.mockClear();
    renderPage();

    const trigger = await waitFor(
      () => screen.getByTestId("stats-export-trigger") as HTMLButtonElement,
    );
    expect(trigger.disabled).toBe(false);

    // Apply a material filter so we can assert it reaches the export.
    fireEvent.change(screen.getByTestId("stats-material-select"), {
      target: { value: "Zirconia" },
    });

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByTestId("stats-export-menu")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("stats-export-revenue-csv"));
    expect(downloadRevenueCsvMock).toHaveBeenCalledTimes(1);
    expect(downloadRevenueCsvMock.mock.calls[0]![0]).toMatchObject({
      series: REVENUE.data.series,
    });
    expect(downloadRevenueCsvMock.mock.calls[0]![1]).toMatchObject({
      orgName: "Main Lab",
      material: "Zirconia",
      categoryLabel: null,
      groupByLabel: "Monthly",
    });
    // Menu closes after a selection.
    expect(screen.queryByTestId("stats-export-menu")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("stats-export-categories-csv"));
    expect(downloadCategoryCsvMock).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("stats-export-materials-csv"));
    expect(downloadMaterialCsvMock).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("stats-export-pdf"));
    expect(downloadStatsPdfMock).toHaveBeenCalledTimes(1);
    expect(downloadStatsPdfMock.mock.calls[0]![0]).toMatchObject({
      summary: SUMMARY.data,
      revenue: REVENUE.data,
      categories: CATEGORIES.data,
      weekday: WEEKDAYS.data,
    });
  });

  it("disables per-format items when their dataset is empty", async () => {
    meMemberships = [OWNER_MEMBERSHIP];
    summaryPayload = SUMMARY;
    categoriesPayload = EMPTY_CATEGORIES;
    revenuePayload = EMPTY_REVENUE;
    weekdaysPayload = EMPTY_WEEKDAYS;
    downloadRevenueCsvMock.mockClear();
    renderPage();

    const trigger = await waitFor(
      () => screen.getByTestId("stats-export-trigger") as HTMLButtonElement,
    );
    // Summary is still present, so the trigger (and PDF) stay available.
    expect(trigger.disabled).toBe(false);
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByTestId("stats-export-menu")).toBeTruthy();
    });

    const revenueItem = screen.getByTestId(
      "stats-export-revenue-csv",
    ) as HTMLButtonElement;
    const categoriesItem = screen.getByTestId(
      "stats-export-categories-csv",
    ) as HTMLButtonElement;
    const materialsItem = screen.getByTestId(
      "stats-export-materials-csv",
    ) as HTMLButtonElement;
    const pdfItem = screen.getByTestId("stats-export-pdf") as HTMLButtonElement;
    expect(revenueItem.disabled).toBe(true);
    expect(categoriesItem.disabled).toBe(true);
    expect(materialsItem.disabled).toBe(true);
    expect(pdfItem.disabled).toBe(false);

    fireEvent.click(revenueItem);
    expect(downloadRevenueCsvMock).not.toHaveBeenCalled();
  });

  it("shows the restricted card for a non-billing member", async () => {
    meMemberships = [
      {
        ...OWNER_MEMBERSHIP,
        id: "m2",
        role: "user",
      },
    ];
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("stats-restricted")).toBeTruthy();
    });
    expect(screen.queryByTestId("stats-summary-cards")).toBeNull();
  });
});
