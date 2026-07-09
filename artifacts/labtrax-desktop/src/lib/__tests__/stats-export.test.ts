/**
 * Unit tests for the Stats-page export builders (Task: Download stats as
 * a spreadsheet or PDF for accountants).
 *
 * The CSV/PDF content rules asserted here:
 *  - Revenue CSV mirrors the filtered series and appends a TOTAL row.
 *  - Category CSV skips zero-count categories and appends a TOTAL row.
 *  - Material CSV mirrors the materials breakdown.
 *  - Every row embeds the active-filters description so an accountant can
 *    always tell what window/filters a file was cut from.
 *  - The PDF summary rows format money and percent-change values.
 */
import { describe, expect, it } from "vitest";
import {
  localDateStamp,
  buildCategoryCsvRows,
  buildMaterialCsvRows,
  buildRevenueCsvRows,
  buildStatsPdf,
  buildSummaryPdfRows,
  statsFilterDescription,
  type StatsCategoriesData,
  type StatsExportFilters,
  type StatsRevenueData,
  type StatsSummaryData,
  type StatsWeekdayData,
} from "../stats-export";

const FILTERS: StatsExportFilters = {
  orgName: "Main Lab",
  dateFrom: "2026-03-01T00:00:00.000Z",
  dateTo: "2026-03-31T23:59:59.999Z",
  groupByLabel: "Monthly",
  categoryLabel: "Zirconia",
  material: null,
};

const REVENUE: StatsRevenueData = {
  series: [
    { period: "2026-02", revenue: "500.00", invoiceCount: 4 },
    { period: "2026-03", revenue: "1234.50", invoiceCount: 10 },
  ],
  totals: { revenue: "1734.50", invoiceCount: 14, averageInvoice: "123.89" },
};

const CATEGORIES: StatsCategoriesData = {
  totalCases: 42,
  categories: [
    { category: "implants", label: "Implants", count: 4, legacyCount: 0 },
    { category: "zirconia", label: "Zirconia", count: 18, legacyCount: 0 },
    { category: "other", label: "Other", count: 0, legacyCount: 0 },
    {
      category: "uncategorized",
      label: "Uncategorized / Legacy",
      count: 20,
      legacyCount: 20,
    },
  ],
  materials: [
    { material: "Zirconia", restorations: 20, units: 25 },
    { material: "Lithium Disilicate (Emax)", restorations: 6, units: 6 },
  ],
};

const SUMMARY: StatsSummaryData = {
  totalCases: 42,
  legacyCases: 5,
  totalRevenue: "1234.50",
  invoiceCount: 10,
  averageCaseValue: "123.45",
  topCategoryLabel: "Zirconia",
  topCategoryCount: 18,
  busiestWeekdayLabel: "Monday",
  previousPeriod: {
    totalCases: 30,
    totalRevenue: "1000.00",
    invoiceCount: 8,
    casesChangePct: 40,
    revenueChangePct: -23.5,
  },
};

const WEEKDAY: StatsWeekdayData = {
  totalCases: 42,
  weekdays: [
    { weekday: 0, label: "Monday", total: 12, byCategory: {} },
    { weekday: 1, label: "Tuesday", total: 8, byCategory: {} },
    { weekday: 2, label: "Wednesday", total: 6, byCategory: {} },
    { weekday: 3, label: "Thursday", total: 6, byCategory: {} },
    { weekday: 4, label: "Friday", total: 10, byCategory: {} },
    { weekday: 5, label: "Saturday", total: 0, byCategory: {} },
    { weekday: 6, label: "Sunday", total: 0, byCategory: {} },
  ],
};

describe("localDateStamp", () => {
  it("formats the LOCAL calendar date regardless of the runner timezone", () => {
    // Build the ISO string exactly like DateRangePicker does: local
    // start-of-day serialized with toISOString(). In UTC+ timezones the
    // ISO string's date portion is the previous day, so slicing would be
    // off by one — the stamp must still be the local date.
    const localMidnight = new Date(2026, 2, 1, 0, 0, 0); // 2026-03-01 local
    expect(localDateStamp(localMidnight.toISOString())).toBe("2026-03-01");

    const localEndOfDay = new Date(2026, 2, 31, 23, 59, 59); // 2026-03-31 local
    expect(localDateStamp(localEndOfDay.toISOString())).toBe("2026-03-31");
  });

  it("falls back to a plain slice for unparseable input", () => {
    expect(localDateStamp("not-a-date")).toBe("not-a-date");
  });
});

describe("statsFilterDescription", () => {
  it("describes the window, grouping, and active filters", () => {
    const desc = statsFilterDescription(FILTERS);
    expect(desc).toContain("2026-03-01 to 2026-03-31");
    expect(desc).toContain("Grouping: Monthly");
    expect(desc).toContain("Category: Zirconia");
    expect(desc).toContain("Material: All");
  });

  it("falls back to All when no filters are applied", () => {
    const desc = statsFilterDescription({
      ...FILTERS,
      categoryLabel: null,
      material: null,
    });
    expect(desc).toContain("Category: All");
    expect(desc).toContain("Material: All");
  });
});

describe("buildRevenueCsvRows", () => {
  it("mirrors the series and appends a TOTAL row with filters on every row", () => {
    const rows = buildRevenueCsvRows(REVENUE, FILTERS);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      Period: "2026-02",
      Revenue: "500.00",
      Invoices: 4,
    });
    expect(rows[2]).toMatchObject({
      Period: "TOTAL",
      Revenue: "1734.50",
      Invoices: 14,
    });
    for (const row of rows) {
      expect(String(row["Filters"])).toContain("Category: Zirconia");
    }
  });
});

describe("buildCategoryCsvRows", () => {
  it("skips zero-count categories and appends a TOTAL row", () => {
    const rows = buildCategoryCsvRows(CATEGORIES, FILTERS);
    // 3 non-zero categories + TOTAL
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r["Category"])).toEqual([
      "Implants",
      "Zirconia",
      "Uncategorized / Legacy",
      "TOTAL",
    ]);
    expect(rows[3]).toMatchObject({ Cases: 42, "Legacy cases": 20 });
  });
});

describe("buildMaterialCsvRows", () => {
  it("mirrors the materials breakdown", () => {
    const rows = buildMaterialCsvRows(CATEGORIES, FILTERS);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      Material: "Zirconia",
      Restorations: 20,
      Units: 25,
    });
    expect(String(rows[0]!["Filters"])).toContain("Grouping: Monthly");
  });
});

describe("buildSummaryPdfRows", () => {
  it("formats money and signed percent changes", () => {
    const rows = buildSummaryPdfRows(SUMMARY);
    const byLabel = new Map(rows);
    expect(byLabel.get("Total cases")).toBe("42");
    expect(byLabel.get("Total sales")).toBe("$1,234.50");
    expect(byLabel.get("Top case type")).toBe("Zirconia (18 cases)");
    expect(byLabel.get("Busiest weekday")).toBe("Monday");
    expect(byLabel.get("Previous period sales")).toBe("$1,000.00 (30 cases)");
    expect(byLabel.get("Sales change vs previous")).toBe("-23.5%");
    expect(byLabel.get("Cases change vs previous")).toBe("+40%");
  });

  it("omits change rows when there is no comparable previous period", () => {
    const rows = buildSummaryPdfRows({
      ...SUMMARY,
      previousPeriod: {
        totalCases: 0,
        totalRevenue: "0.00",
        invoiceCount: 0,
        casesChangePct: null,
        revenueChangePct: null,
      },
    });
    const labels = rows.map(([l]) => l);
    expect(labels).not.toContain("Sales change vs previous");
    expect(labels).not.toContain("Cases change vs previous");
    expect(labels).toContain("Previous period sales");
  });

  it("dashes missing top category / weekday", () => {
    const rows = buildSummaryPdfRows({
      ...SUMMARY,
      topCategoryLabel: null,
      topCategoryCount: 0,
      busiestWeekdayLabel: null,
      previousPeriod: null,
    });
    const byLabel = new Map(rows);
    expect(byLabel.get("Top case type")).toBe("—");
    expect(byLabel.get("Busiest weekday")).toBe("—");
  });
});

describe("buildStatsPdf", () => {
  it("produces a PDF blob with a range-stamped filename", () => {
    const { blob, filename } = buildStatsPdf({
      filters: FILTERS,
      summary: SUMMARY,
      revenue: REVENUE,
      categories: CATEGORIES,
      weekday: WEEKDAY,
      generatedAt: new Date("2026-03-31T12:00:00Z"),
    });
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(1000);
    expect(filename).toBe("stats-report-Main_Lab-2026-03-01_2026-03-31.pdf");
  });

  it("still renders when sections are missing", () => {
    const { blob } = buildStatsPdf({
      filters: FILTERS,
      summary: null,
      revenue: { series: [], totals: REVENUE.totals },
      categories: null,
      weekday: null,
      generatedAt: new Date("2026-03-31T12:00:00Z"),
    });
    expect(blob.size).toBeGreaterThan(500);
  });
});
