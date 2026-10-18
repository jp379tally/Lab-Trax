/** @vitest-environment jsdom */
/**
 * Desktop Stats page tests.
 *
 * - Billing-role user (lab owner) sees the summary metric cards populated
 *   from the generated stats hooks (envelope shape: data.data).
 * - Empty states render when the window has no data.
 * - Non-billing user sees the restricted card and no metrics.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    averageDailyRevenue: "39.82",
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
    caseTypes: [
      { label: "Restorative", count: 32 },
      { label: "Removable", count: 5 },
      { label: "Other", count: 2 },
    ],
    caseSubtypes: [],
    caseMaterialSubtypes: [],
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
  data: { ...CATEGORIES.data, totalCases: 0, categories: [], materials: [], caseTypes: [] },
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

// Two doctors so tests can exercise both the Doctor dropdown's population
// and the doctorName filter's wiring/combination with other filters.
const REMAKES = {
  ok: true,
  data: {
    from: "2026-03-01T00:00:00.000Z",
    to: "2026-03-31T23:59:59.999Z",
    timeZone: "UTC",
    totalRemakes: 3,
    rechargedRemakes: 2,
    nonRechargedRemakes: 1,
    remakeReasons: [
      { reason: "Shade mismatch", count: 2 },
      { reason: "Fit: Margins", count: 1 },
    ],
    byDoctor: [
      { doctorName: "Dr Stats", count: 2 },
      { doctorName: "Dr Second", count: 1 },
    ],
    byReason: [
      { reason: "Shade mismatch", count: 2 },
      { reason: "Fit: Margins", count: 1 },
    ],
    byType: [
      { typeName: "Restorative", count: 2 },
      { typeName: "Removable", count: 1 },
    ],
    timeSeries: [
      { period: "2026-W10", periodStart: "2026-03-02T00:00:00.000Z", count: 3 },
    ],
    records: [
      {
        id: "case-1",
        caseNumber: "SYN-CASE-001",
        originalCaseId: "case-0",
        originalCaseNumber: "C-1000",
        receivedAt: "2026-03-15T12:00:00.000Z",
        reason: "Shade mismatch",
        reasonKey: "shade_wrong",
        recharged: true,
        returnedToLab: false,
        category: "crown_bridge",
        source: "canonical",
        doctorName: "Dr Stats",
      },
      {
        id: "case-2",
        caseNumber: "C-1002",
        originalCaseId: null,
        originalCaseNumber: null,
        receivedAt: "2026-03-10T09:00:00.000Z",
        reason: "Shade mismatch",
        reasonKey: "shade_wrong",
        recharged: true,
        returnedToLab: true,
        category: "crown_bridge",
        source: "canonical",
        doctorName: "Dr Stats",
      },
      {
        id: "case-3",
        caseNumber: "C-1003",
        originalCaseId: null,
        originalCaseNumber: null,
        receivedAt: "2026-03-05T09:00:00.000Z",
        reason: "Fit: Margins",
        reasonKey: "fit_margins",
        recharged: false,
        returnedToLab: false,
        category: "removable",
        source: "canonical",
        doctorName: "Dr Second",
      },
    ],
  },
};

let summaryPayload: unknown = SUMMARY;
let categoriesPayload: unknown = CATEGORIES;
let revenuePayload: unknown = REVENUE;
let weekdaysPayload: unknown = WEEKDAYS;
// Independently controllable so tests can prove the Doctor dropdown is
// sourced from the date-scoped options query, not the (possibly further
// filtered) main remakes query.
let remakesPayload: unknown = undefined;
let remakesDoctorOptionsPayload: unknown = undefined;
// Captures the params passed to the stats hooks so tests can assert the
// category/material filters are threaded through.
const seenSummaryParams: Array<Record<string, unknown>> = [];
const seenCategoriesParams: Array<Record<string, unknown>> = [];
const seenRemakesParams: Array<Record<string, unknown>> = [];
const seenRemakesDoctorOptionsParams: Array<Record<string, unknown>> = [];
let statsHookLoading = false;
let statsHookError = false;
let remakesHookLoading = false;
let remakesHookError = false;

afterEach(() => {
  statsHookLoading = false;
  statsHookError = false;
  remakesHookLoading = false;
  remakesHookError = false;
});

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetStatsSummary: (params: Record<string, unknown>) => {
      seenSummaryParams.push(params);
      return {
        data: summaryPayload,
        isLoading: statsHookLoading,
        isError: statsHookError,
      };
    },
    useGetStatsCaseCategories: (params: Record<string, unknown>) => {
      seenCategoriesParams.push(params);
      return {
        data: categoriesPayload,
        isLoading: statsHookLoading,
        isError: statsHookError,
      };
    },
    useGetStatsRevenueSeries: () => ({
      data: revenuePayload,
      isLoading: statsHookLoading,
      isError: statsHookError,
    }),
    useGetStatsWeekdayVolume: () => ({
      data: weekdaysPayload,
      isLoading: statsHookLoading,
      isError: statsHookError,
    }),
    useGetStatsRemakes: (
      params: Record<string, unknown>,
      options?: { query?: { queryKey?: unknown[] } },
    ) => {
      const key = options?.query?.queryKey;
      const isDoctorOptionsQuery =
        Array.isArray(key) && key.includes("doctor-options");
      if (isDoctorOptionsQuery) {
        seenRemakesDoctorOptionsParams.push(params);
        return { data: remakesDoctorOptionsPayload, isLoading: remakesHookLoading, isError: remakesHookError };
      }
      seenRemakesParams.push(params);
      return { data: remakesPayload, isLoading: remakesHookLoading, isError: remakesHookError };
    },
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

import ReportsPage from "@/pages/reports";

// Stats now lives as a tab inside the Reports page, so every test drives the
// merged page with `?tab=stats` selected (the tab is read from the URL on
// mount, exactly as an old /stats bookmark redirect delivers it).
function renderPage() {
  window.history.pushState({}, "", "/reports?tab=stats");
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ReportsPage />
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
    expect(screen.getByTestId("stats-casetypes-chart")).toBeTruthy();
    expect(screen.getByTestId("stats-case-analytics-grid")).toBeTruthy();
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
    expect(screen.getByTestId("stats-casetypes-empty")).toBeTruthy();
    expect(screen.getByTestId("stats-weekday-empty")).toBeTruthy();
  });

  it("keeps loading and error states legible inside the dashboard cards", async () => {
    meMemberships = [OWNER_MEMBERSHIP];
    statsHookLoading = true;
    renderPage();
    expect(await screen.findAllByText("Loading…")).not.toHaveLength(0);

    cleanup();
    statsHookLoading = false;
    statsHookError = true;
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("stats-summary-error")).toBeTruthy();
      expect(screen.getAllByText(/Could not load this chart/).length).toBeGreaterThan(0);
    });
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
      expect(screen.getByTestId("reports-restricted")).toBeTruthy();
    });
    expect(screen.queryByTestId("stats-summary-cards")).toBeNull();
    // The Stats tab itself is not offered without a billing role.
    expect(screen.queryByRole("button", { name: "Stats" })).toBeNull();
  });

  it("renders the Stats dashboard inside the Reports page tab strip", async () => {
    meMemberships = [OWNER_MEMBERSHIP];
    summaryPayload = SUMMARY;
    categoriesPayload = CATEGORIES;
    revenuePayload = REVENUE;
    weekdaysPayload = WEEKDAYS;
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("stats-summary-cards")).toBeTruthy();
    });
    // The merged page keeps its Reports identity and the full tab strip.
    expect(screen.getByRole("heading", { name: "Reports" })).toBeTruthy();
    for (const label of [
      "Summary",
      "Production",
      "Sales",
      "Forecast",
      "Profit & Loss",
      "Balance Sheet",
      "Stats",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it('switches to the Forecast tab in-page from "View full forecast"', async () => {
    meMemberships = [OWNER_MEMBERSHIP];
    summaryPayload = SUMMARY;
    categoriesPayload = CATEGORIES;
    revenuePayload = REVENUE;
    weekdaysPayload = WEEKDAYS;
    renderPage();

    const link = await waitFor(() =>
      screen.getByTestId("forecast-view-details-link"),
    );
    // It is an in-page tab switch, never a navigation away from Reports.
    expect(link.tagName).toBe("BUTTON");
    fireEvent.click(link);

    await waitFor(() => {
      expect(screen.queryByTestId("stats-summary-cards")).toBeNull();
    });
    expect(window.location.pathname).toBe("/reports");
  });

  it("keeps the Stats filters from clobbering the other tabs' date range", async () => {
    meMemberships = [OWNER_MEMBERSHIP];
    summaryPayload = SUMMARY;
    categoriesPayload = CATEGORIES;
    revenuePayload = REVENUE;
    weekdaysPayload = WEEKDAYS;
    renderPage();

    // The Stats tab owns its own filter bar (the shared Reports header
    // controls step aside for it), so this picker belongs to Stats.
    await waitFor(() => screen.getByTestId("stats-groupby-select"));
    fireEvent.change(screen.getByTestId("date-range-preset"), {
      target: { value: "year" },
    });
    await waitFor(() => {
      const last = seenSummaryParams[seenSummaryParams.length - 1]!;
      expect(new Date(last["dateFrom"] as string).getMonth()).toBe(0);
    });
    fireEvent.change(screen.getByTestId("stats-groupby-select"), {
      target: { value: "year" },
    });
    const statsUrl = new URLSearchParams(window.location.search);
    expect(statsUrl.get("tab")).toBe("stats");
    expect(statsUrl.get("stats-preset")).toBe("year");
    expect(statsUrl.get("stats-groupBy")).toBe("year");
    expect(statsUrl.get("preset")).toBe("month");

    // Switching to a finance tab reveals the shared header range, which the
    // Stats filter must not have moved off its own default (this month).
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    await waitFor(() => {
      expect(screen.queryByTestId("stats-groupby-select")).toBeNull();
    });
    expect(
      (screen.getByTestId("date-range-preset") as HTMLSelectElement).value,
    ).toBe("month");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("summary");
    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    await waitFor(() => expect((screen.getByTestId("stats-groupby-select") as HTMLSelectElement).value).toBe("year"));
    expect((screen.getByTestId("date-range-preset") as HTMLSelectElement).value).toBe("year");
  });
});

describe("Remake Records filters", () => {
  function setBaseline() {
    meMemberships = [OWNER_MEMBERSHIP];
    summaryPayload = SUMMARY;
    categoriesPayload = CATEGORIES;
    revenuePayload = REVENUE;
    weekdaysPayload = WEEKDAYS;
    remakesPayload = REMAKES;
    remakesDoctorOptionsPayload = REMAKES;
    seenSummaryParams.length = 0;
    seenCategoriesParams.length = 0;
    seenRemakesParams.length = 0;
    seenRemakesDoctorOptionsParams.length = 0;
  }

  it("renders the remake summary and lower report sections as separate visual panels", async () => {
    setBaseline();
    renderPage();

    await waitFor(() => screen.getByTestId("stats-remakes-summary"));
    expect(screen.getByTestId("stats-remakes-total").textContent).toBe("3");
    for (const title of [
      "Remake reasons",
      "Remake trend",
      "By type",
      "By doctor",
      "Remake records",
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }

    const reasonBars = within(screen.getByTestId("stats-remakes-reasons"));
    expect(reasonBars.getByRole("img", { name: "2 remakes" })).toBeTruthy();
    expect(reasonBars.getByRole("img", { name: "1 remake" })).toBeTruthy();
    expect(reasonBars.getByText("2", { exact: true })).toBeTruthy();
    expect(reasonBars.getByText("1", { exact: true })).toBeTruthy();
    expect(screen.getByTestId("stats-remakes-records").textContent).toContain("SYN-CASE-001");
  });

  it("shows a compact remake error state when the report is unavailable", async () => {
    setBaseline();
    remakesHookError = true;
    renderPage();

    expect(await screen.findByText("Could not load remakes.")).toBeTruthy();
    expect(screen.queryByTestId("stats-remakes-summary")).toBeNull();
  });

  it("labels the existing category filter as a remake-type filter", async () => {
    setBaseline();
    renderPage();

    const typeSelect = await waitFor(
      () => screen.getByTestId("stats-remakes-type-select") as HTMLSelectElement,
    );
    expect(typeSelect.getAttribute("aria-label")).toBe("Remake type");
    expect(Array.from(typeSelect.options).map((o) => o.textContent)).toEqual([
      "All types",
      "Crown & Bridge",
      "Removable",
      "Implant",
    ]);
  });

  it("populates the Doctor filter from the date-scoped options query, not the (possibly further-filtered) main query", async () => {
    setBaseline();
    // Simulate a reason filter already narrowing the main query's byDoctor
    // down to one doctor, while the options query (no reason filter) still
    // sees both — the dropdown must reflect the latter.
    remakesPayload = {
      ok: true,
      data: { ...REMAKES.data, byDoctor: [{ doctorName: "Dr Stats", count: 2 }] },
    };
    remakesDoctorOptionsPayload = REMAKES;
    renderPage();

    const doctorSelect = await waitFor(
      () => screen.getByTestId("stats-remakes-doctor-select") as HTMLSelectElement,
    );
    const labels = Array.from(doctorSelect.options).map((o) => o.textContent);
    expect(labels).toEqual(["All doctors", "Dr Stats", "Dr Second"]);
  });

  it("threads the selected doctor into the remakes query but not the doctor-options query", async () => {
    setBaseline();
    renderPage();

    const doctorSelect = await waitFor(
      () => screen.getByTestId("stats-remakes-doctor-select") as HTMLSelectElement,
    );
    seenRemakesParams.length = 0;
    seenRemakesDoctorOptionsParams.length = 0;
    fireEvent.change(doctorSelect, { target: { value: "Dr Second" } });

    await waitFor(() => {
      const last = seenRemakesParams[seenRemakesParams.length - 1];
      expect(last?.["doctorName"]).toBe("Dr Second");
    });
    expect(
      seenRemakesDoctorOptionsParams.every((p) => p["doctorName"] === undefined),
    ).toBe(true);
  });

  it("scopes the date-range preset to the remakes queries without changing the page-wide Stats range", async () => {
    setBaseline();
    renderPage();

    await waitFor(() =>
      screen.getByTestId("stats-remakes-date-preset"),
    );
    const firstSummary = seenSummaryParams[0]!;
    seenRemakesParams.length = 0;
    seenRemakesDoctorOptionsParams.length = 0;

    fireEvent.change(screen.getByTestId("stats-remakes-date-preset"), {
      target: { value: "year" },
    });

    await waitFor(() => {
      expect(seenRemakesParams.length).toBeGreaterThan(0);
    });
    const lastRemakes = seenRemakesParams[seenRemakesParams.length - 1]!;
    const lastDoctorOptions =
      seenRemakesDoctorOptionsParams[seenRemakesDoctorOptionsParams.length - 1]!;
    const from = new Date(lastRemakes["dateFrom"] as string);
    expect(from.getMonth()).toBe(0);
    expect(from.getDate()).toBe(1);
    expect(from.getFullYear()).toBe(new Date().getFullYear());
    // Both remake queries move together...
    expect(lastDoctorOptions["dateFrom"]).toBe(lastRemakes["dateFrom"]);
    expect(lastDoctorOptions["dateTo"]).toBe(lastRemakes["dateTo"]);
    // ...but the rest of the Stats page's date range is untouched.
    const lastSummary = seenSummaryParams[seenSummaryParams.length - 1]!;
    expect(lastSummary["dateFrom"]).toBe(firstSummary["dateFrom"]);
    expect(lastSummary["dateTo"]).toBe(firstSummary["dateTo"]);
  });

  it("supports a custom start/end date range", async () => {
    setBaseline();
    renderPage();

    const presetSelect = await waitFor(
      () => screen.getByTestId("stats-remakes-date-preset") as HTMLSelectElement,
    );
    fireEvent.change(presetSelect, { target: { value: "custom" } });

    const fromInput = await waitFor(
      () => screen.getByTestId("stats-remakes-date-from") as HTMLInputElement,
    );
    const toInput = screen.getByTestId("stats-remakes-date-to") as HTMLInputElement;

    fireEvent.change(fromInput, { target: { value: "2026-01-05" } });
    fireEvent.blur(fromInput);
    fireEvent.change(toInput, { target: { value: "2026-01-20" } });
    fireEvent.blur(toInput);

    await waitFor(() => {
      const last = seenRemakesParams[seenRemakesParams.length - 1]!;
      expect(last["dateFrom"]).toBe(new Date(2026, 0, 5).toISOString());
      expect(last["dateTo"]).toBe(
        new Date(2026, 0, 20, 23, 59, 59, 999).toISOString(),
      );
    });
  });

  it("combines date, doctor, and type filters into a single remakes query", async () => {
    setBaseline();
    renderPage();
    await waitFor(() => screen.getByTestId("stats-remakes-doctor-select"));
    seenRemakesParams.length = 0;

    fireEvent.change(screen.getByTestId("stats-remakes-date-preset"), {
      target: { value: "year" },
    });
    fireEvent.change(screen.getByTestId("stats-remakes-doctor-select"), {
      target: { value: "Dr Second" },
    });
    fireEvent.change(screen.getByTestId("stats-remakes-type-select"), {
      target: { value: "crown_bridge" },
    });

    await waitFor(() => {
      const last = seenRemakesParams[seenRemakesParams.length - 1]!;
      expect(last["doctorName"]).toBe("Dr Second");
      expect(last["remakeCategory"]).toBe("crown_bridge");
    });
    const last = seenRemakesParams[seenRemakesParams.length - 1]!;
    const from = new Date(last["dateFrom"] as string);
    expect(from.getMonth()).toBe(0);
    expect(from.getDate()).toBe(1);
  });

  it('shows "Clear filters" once any remake filter is active, and it resets date, doctor, type, and reason together', async () => {
    setBaseline();
    renderPage();

    await waitFor(() => screen.getByTestId("stats-remakes-doctor-select"));
    expect(screen.queryByText("Clear filters")).toBeNull();

    fireEvent.change(screen.getByTestId("stats-remakes-date-preset"), {
      target: { value: "year" },
    });
    fireEvent.change(screen.getByTestId("stats-remakes-doctor-select"), {
      target: { value: "Dr Second" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "shade_wrong" },
    });

    const clearBtn = await screen.findByText("Clear filters");
    fireEvent.click(clearBtn);

    await waitFor(() => {
      expect(
        (screen.getByTestId("stats-remakes-date-preset") as HTMLSelectElement).value,
      ).toBe("month");
    });
    expect(
      (screen.getByTestId("stats-remakes-doctor-select") as HTMLSelectElement).value,
    ).toBe("");
    expect((screen.getByLabelText("Reason") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByText("Clear filters")).toBeNull();
  });

  it("exports exactly the rows currently shown in the remake records table", async () => {
    setBaseline();
    let capturedBlob: Blob | undefined;
    const createObjectURL = vi.fn((b: Blob) => {
      capturedBlob = b;
      return "blob:mock";
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }),
    );

    renderPage();
    const exportBtn = await screen.findByText("Export CSV");
    fireEvent.click(exportBtn);

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const csvText = await capturedBlob!.text();
    const lines = csvText.trim().split("\r\n");
    expect(lines.length).toBe(1 + REMAKES.data.records.length);
    for (const rec of REMAKES.data.records) {
      expect(csvText).toContain(rec.caseNumber);
    }
    vi.unstubAllGlobals();
  });
});
