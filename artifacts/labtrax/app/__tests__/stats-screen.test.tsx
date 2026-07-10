// Stats screen — billing-role gating + summary/chart rendering smoke tests.
//
// The generated stats hooks are mocked in vitest.setup.ts and driven by
// setMockAppState overrides (statsSummary / statsCaseCategories /
// statsRevenueSeries / statsWeekdayVolume). useMe() flows through the mocked
// useQuery keyed on "auth-me" (seed memberships via meMemberships).
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react-native";
import StatsScreen from "../manage/stats";
import { setMockAppState, resetMockAppState } from "../../vitest.setup";

const OWNER_MEMBERSHIP = {
  organizationId: "lab-1",
  role: "owner",
  status: "active",
  organization: { id: "lab-1", name: "Smile Lab", type: "lab" },
};

const TECH_MEMBERSHIP = {
  organizationId: "lab-1",
  role: "technician",
  status: "active",
  organization: { id: "lab-1", name: "Smile Lab", type: "lab" },
};

const SUMMARY = {
  from: "2026-07-01T00:00:00.000Z",
  to: "2026-07-09T23:59:59.999Z",
  timeZone: "UTC",
  totalCases: 42,
  legacyCases: 5,
  totalRevenue: "12345.67",
  invoiceCount: 18,
  averageCaseValue: "293.94",
  topCategory: "zirconia",
  topCategoryLabel: "Zirconia",
  topCategoryCount: 15,
  busiestWeekday: 1,
  busiestWeekdayLabel: "Tuesday",
  previousPeriod: {
    from: "2026-06-22T00:00:00.000Z",
    to: "2026-06-30T23:59:59.999Z",
    totalCases: 30,
    totalRevenue: "9000.00",
    invoiceCount: 12,
    casesChangePct: 40,
    revenueChangePct: 37,
  },
};

const REVENUE = {
  from: SUMMARY.from,
  to: SUMMARY.to,
  groupBy: "day",
  timeZone: "UTC",
  series: [
    { period: "2026-07-01", periodStart: "2026-07-01", revenue: "100.00", invoiceCount: 2 },
    { period: "2026-07-02", periodStart: "2026-07-02", revenue: "250.00", invoiceCount: 3 },
  ],
  totals: { revenue: "350.00", invoiceCount: 5, averageInvoice: "70.00" },
};

const CATEGORIES = {
  from: SUMMARY.from,
  to: SUMMARY.to,
  totalCases: 42,
  categories: [
    { category: "zirconia", label: "Zirconia", count: 15, legacyCount: 0 },
    { category: "implants", label: "Implants", count: 10, legacyCount: 2 },
  ],
  materials: [{ material: "Zirconia", restorations: 12, units: 20 }],
};

const WEEKDAYS = {
  from: SUMMARY.from,
  to: SUMMARY.to,
  timeZone: "UTC",
  totalCases: 42,
  weekdays: [
    { weekday: 0, label: "Monday", total: 8, byCategory: {} },
    { weekday: 1, label: "Tuesday", total: 12, byCategory: {} },
    { weekday: 2, label: "Wednesday", total: 6, byCategory: {} },
    { weekday: 3, label: "Thursday", total: 7, byCategory: {} },
    { weekday: 4, label: "Friday", total: 9, byCategory: {} },
    { weekday: 5, label: "Saturday", total: 0, byCategory: {} },
    { weekday: 6, label: "Sunday", total: 0, byCategory: {} },
  ],
};

afterEach(() => {
  cleanup();
  resetMockAppState();
});

describe("StatsScreen — role gating", () => {
  it("blocks members without a billing-or-better lab role", () => {
    setMockAppState({ meMemberships: [TECH_MEMBERSHIP] });
    render(<StatsScreen />);
    expect(screen.getByTestId("stats-blocked")).toBeTruthy();
    expect(screen.getByText("Not available")).toBeTruthy();
    expect(screen.queryByTestId("stats-summary")).toBeNull();
  });

  it("blocks users with no memberships at all", () => {
    setMockAppState({ meMemberships: [] });
    render(<StatsScreen />);
    expect(screen.getByTestId("stats-blocked")).toBeTruthy();
  });
});

describe("StatsScreen — billing-role rendering", () => {
  it("renders summary metrics, revenue totals, categories, and weekday chart", () => {
    setMockAppState({
      meMemberships: [OWNER_MEMBERSHIP],
      statsSummary: SUMMARY,
      statsRevenueSeries: REVENUE,
      statsCaseCategories: CATEGORIES,
      statsWeekdayVolume: WEEKDAYS,
    });
    render(<StatsScreen />);

    expect(screen.queryByTestId("stats-blocked")).toBeNull();
    expect(screen.getByTestId("stats-summary")).toBeTruthy();

    // Summary metrics
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("$12,345.67")).toBeTruthy();
    expect(screen.getByText("$293.94")).toBeTruthy();
    // "Zirconia" appears in the category filter chip, the top-case-type
    // metric, the category bars, and the material bars.
    expect(screen.getAllByText("Zirconia").length).toBeGreaterThan(0);
    expect(screen.getByText("15 cases")).toBeTruthy();
    expect(screen.getByText("Tuesday")).toBeTruthy();
    expect(screen.getByText("5 legacy")).toBeTruthy();

    // Revenue chart footer totals
    expect(screen.getByText(/\$350\.00 total/)).toBeTruthy();

    // Category + material bars
    expect(screen.getAllByText("Implants").length).toBeGreaterThan(0);
    expect(screen.getByText("Cases by category")).toBeTruthy();
    expect(screen.getByText("Material breakdown")).toBeTruthy();

    // Weekday chart labels (Mon-first, truncated to 3 chars)
    expect(screen.getByText("Case volume by weekday")).toBeTruthy();
    expect(screen.getByText("Mon")).toBeTruthy();
    expect(screen.getByText("Sun")).toBeTruthy();

    // Date-range presets present
    expect(screen.getByTestId("stats-range-month")).toBeTruthy();
    expect(screen.getByTestId("stats-range-12mo")).toBeTruthy();
  });

  it("opens start/end calendar pickers when the Custom range chip is tapped", () => {
    setMockAppState({
      meMemberships: [OWNER_MEMBERSHIP],
      statsSummary: SUMMARY,
      statsRevenueSeries: REVENUE,
      statsCaseCategories: CATEGORIES,
      statsWeekdayVolume: WEEKDAYS,
    });
    render(<StatsScreen />);

    // Custom chip is present alongside the presets, and the pickers are hidden
    // until it is selected.
    expect(screen.getByTestId("stats-range-custom")).toBeTruthy();
    expect(screen.queryByTestId("stats-custom-range")).toBeNull();

    fireEvent.press(screen.getByTestId("stats-range-custom"));

    // Both date-field triggers now render, seeded with a valid range.
    expect(screen.getByTestId("stats-custom-range")).toBeTruthy();
    expect(screen.getByTestId("stats-custom-from")).toBeTruthy();
    expect(screen.getByTestId("stats-custom-to")).toBeTruthy();
  });

  it("shows empty states when there is no data in the window", () => {
    setMockAppState({
      meMemberships: [OWNER_MEMBERSHIP],
      statsSummary: { ...SUMMARY, totalCases: 0, legacyCases: 0 },
      statsRevenueSeries: { ...REVENUE, series: [] },
      statsCaseCategories: { ...CATEGORIES, totalCases: 0, materials: [] },
      statsWeekdayVolume: { ...WEEKDAYS, totalCases: 0 },
    });
    render(<StatsScreen />);

    expect(screen.getByTestId("stats-revenue-empty")).toBeTruthy();
    expect(screen.getByTestId("stats-categories-empty")).toBeTruthy();
    expect(screen.getByTestId("stats-materials-empty")).toBeTruthy();
    expect(screen.getByTestId("stats-weekday-empty")).toBeTruthy();
  });
});
