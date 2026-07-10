/**
 * Export helpers for the desktop Stats page (Task: Download stats as a
 * spreadsheet or PDF for accountants).
 *
 * Pure row-builders are separated from the download/PDF side effects so
 * the CSV/PDF content rules are unit-testable without touching the DOM.
 * All builders operate on the SAME payloads the on-screen charts render,
 * so exports always match the currently applied filters.
 */
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { downloadCsv, safeFilename } from "./export";

export interface StatsExportFilters {
  /** Lab organization display name. */
  orgName: string;
  /** ISO date strings of the selected window. */
  dateFrom: string;
  dateTo: string;
  groupByLabel: string;
  /** Human label of the category filter, or null for all. */
  categoryLabel: string | null;
  /** Material filter value, or null for all. */
  material: string | null;
}

export interface StatsSummaryData {
  totalCases: number;
  legacyCases: number;
  totalRevenue: string;
  invoiceCount: number;
  averageDailyRevenue?: string;
  averageCaseValue: string;
  topCategoryLabel?: string | null;
  topCategoryCount?: number;
  busiestWeekdayLabel?: string | null;
  previousPeriod?: {
    totalCases: number;
    totalRevenue: string;
    invoiceCount: number;
    casesChangePct?: number | null;
    revenueChangePct?: number | null;
  } | null;
}

export interface StatsRevenueData {
  series: Array<{
    period: string;
    revenue: string;
    invoiceCount: number;
  }>;
  totals: { revenue: string; invoiceCount: number; averageInvoice: string };
}

export interface StatsCategoriesData {
  totalCases: number;
  categories: Array<{
    category: string;
    label: string;
    count: number;
    legacyCount: number;
  }>;
  materials: Array<{ material: string; restorations: number; units: number }>;
}

export interface StatsWeekdayData {
  totalCases: number;
  weekdays: Array<{
    weekday: number;
    label: string;
    total: number;
    byCategory: Record<string, number>;
  }>;
}

/**
 * Format an ISO timestamp as the LOCAL calendar date (YYYY-MM-DD).
 * The range picker stores `toISOString()` of local start/end-of-day, so
 * slicing the ISO string would show the UTC date — off by one day in
 * UTC+ timezones. Formatting local parts keeps exports matching the
 * on-screen range.
 */
export function localDateStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** One-line description of the active filters, embedded in every export. */
export function statsFilterDescription(f: StatsExportFilters): string {
  const parts = [
    `Range: ${localDateStamp(f.dateFrom)} to ${localDateStamp(f.dateTo)}`,
    `Grouping: ${f.groupByLabel}`,
    `Category: ${f.categoryLabel ?? "All"}`,
    `Material: ${f.material ?? "All"}`,
  ];
  return parts.join(" · ");
}

function rangeStamp(f: StatsExportFilters): string {
  return `${localDateStamp(f.dateFrom)}_${localDateStamp(f.dateTo)}`;
}

// ── CSV row builders (pure) ────────────────────────────────────────────

export function buildRevenueCsvRows(
  revenue: StatsRevenueData,
  filters: StatsExportFilters,
): Array<Record<string, string | number>> {
  const desc = statsFilterDescription(filters);
  const rows: Array<Record<string, string | number>> = revenue.series.map(
    (s) => ({
      Period: s.period,
      Revenue: Number(s.revenue).toFixed(2),
      Invoices: s.invoiceCount,
      Filters: desc,
    }),
  );
  rows.push({
    Period: "TOTAL",
    Revenue: Number(revenue.totals.revenue).toFixed(2),
    Invoices: revenue.totals.invoiceCount,
    Filters: desc,
  });
  return rows;
}

export function buildCategoryCsvRows(
  categories: StatsCategoriesData,
  filters: StatsExportFilters,
): Array<Record<string, string | number>> {
  const desc = statsFilterDescription(filters);
  const rows: Array<Record<string, string | number>> = categories.categories
    .filter((c) => c.count > 0)
    .map((c) => ({
      Category: c.label,
      Cases: c.count,
      "Legacy cases": c.legacyCount,
      Filters: desc,
    }));
  rows.push({
    Category: "TOTAL",
    Cases: categories.totalCases,
    "Legacy cases": categories.categories.reduce(
      (a, c) => a + c.legacyCount,
      0,
    ),
    Filters: desc,
  });
  return rows;
}

export function buildMaterialCsvRows(
  categories: StatsCategoriesData,
  filters: StatsExportFilters,
): Array<Record<string, string | number>> {
  const desc = statsFilterDescription(filters);
  return categories.materials.map((m) => ({
    Material: m.material,
    Restorations: m.restorations,
    Units: m.units,
    Filters: desc,
  }));
}

// ── CSV downloads ──────────────────────────────────────────────────────

export function downloadRevenueCsv(
  revenue: StatsRevenueData,
  filters: StatsExportFilters,
) {
  downloadCsv(
    `stats-revenue-${safeFilename(filters.orgName)}-${rangeStamp(filters)}.csv`,
    buildRevenueCsvRows(revenue, filters),
  );
}

export function downloadCategoryCsv(
  categories: StatsCategoriesData,
  filters: StatsExportFilters,
) {
  downloadCsv(
    `stats-categories-${safeFilename(filters.orgName)}-${rangeStamp(filters)}.csv`,
    buildCategoryCsvRows(categories, filters),
  );
}

export function downloadMaterialCsv(
  categories: StatsCategoriesData,
  filters: StatsExportFilters,
) {
  downloadCsv(
    `stats-materials-${safeFilename(filters.orgName)}-${rangeStamp(filters)}.csv`,
    buildMaterialCsvRows(categories, filters),
  );
}

// ── PDF report ─────────────────────────────────────────────────────────

export interface StatsPdfOptions {
  filters: StatsExportFilters;
  summary: StatsSummaryData | null;
  revenue: StatsRevenueData | null;
  categories: StatsCategoriesData | null;
  weekday: StatsWeekdayData | null;
  generatedAt: Date;
}

function money(v: string | number): string {
  const n = typeof v === "string" ? Number(v) : v;
  if (Number.isNaN(n)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n);
}

/**
 * Metric/value pairs for the PDF summary table — pulled out as a pure
 * function so the summary content rules are unit-testable.
 */
export function buildSummaryPdfRows(
  summary: StatsSummaryData,
): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Total cases", String(summary.totalCases)],
    ["Legacy cases", String(summary.legacyCases)],
    ["Total sales", money(summary.totalRevenue)],
    ["Invoices", String(summary.invoiceCount)],
    ["Average daily sales", money(summary.averageDailyRevenue ?? "0.00")],
    ["Average case value", money(summary.averageCaseValue)],
    [
      "Top case type",
      summary.topCategoryLabel
        ? `${summary.topCategoryLabel} (${summary.topCategoryCount ?? 0} cases)`
        : "—",
    ],
    ["Busiest weekday", summary.busiestWeekdayLabel ?? "—"],
  ];
  const prev = summary.previousPeriod;
  if (prev) {
    rows.push([
      "Previous period sales",
      `${money(prev.totalRevenue)} (${prev.totalCases} cases)`,
    ]);
    if (prev.revenueChangePct !== null && prev.revenueChangePct !== undefined) {
      rows.push([
        "Sales change vs previous",
        `${prev.revenueChangePct >= 0 ? "+" : ""}${prev.revenueChangePct}%`,
      ]);
    }
    if (prev.casesChangePct !== null && prev.casesChangePct !== undefined) {
      rows.push([
        "Cases change vs previous",
        `${prev.casesChangePct >= 0 ? "+" : ""}${prev.casesChangePct}%`,
      ]);
    }
  }
  return rows;
}

export function buildStatsPdf(opts: StatsPdfOptions): {
  blob: Blob;
  filename: string;
} {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const marginX = 48;
  const pageW = doc.internal.pageSize.getWidth();

  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("Stats report", marginX, 56);
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text(opts.filters.orgName, marginX, 74);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(statsFilterDescription(opts.filters), marginX, 90, {
    maxWidth: pageW - marginX * 2,
  });
  doc.text(
    `Generated ${opts.generatedAt.toLocaleString("en-US")}`,
    pageW - marginX,
    56,
    { align: "right" },
  );
  doc.setTextColor(0);

  let y = 108;
  const sectionGap = 18;

  function lastTableY(): number {
    const d = doc as unknown as { lastAutoTable?: { finalY?: number } };
    return d.lastAutoTable?.finalY ?? y;
  }

  function sectionTitle(title: string) {
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text(title, marginX, y);
    doc.setFont("helvetica", "normal");
    y += 8;
  }

  if (opts.summary) {
    sectionTitle("Summary");
    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      head: [["Metric", "Value"]],
      body: buildSummaryPdfRows(opts.summary),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
    });
    y = lastTableY() + sectionGap;
  }

  if (opts.revenue && opts.revenue.series.length > 0) {
    sectionTitle(`Sales over time (${opts.filters.groupByLabel.toLowerCase()})`);
    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      head: [["Period", "Revenue", "Invoices"]],
      body: [
        ...opts.revenue.series.map((s) => [
          s.period,
          money(s.revenue),
          String(s.invoiceCount),
        ]),
        [
          "TOTAL",
          money(opts.revenue.totals.revenue),
          String(opts.revenue.totals.invoiceCount),
        ],
      ],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
      columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
      didParseCell: (data) => {
        if (
          data.section === "body" &&
          data.row.index === (opts.revenue?.series.length ?? 0)
        ) {
          data.cell.styles.fontStyle = "bold";
        }
      },
    });
    y = lastTableY() + sectionGap;
  }

  if (opts.categories && opts.categories.totalCases > 0) {
    sectionTitle("Cases by category");
    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      head: [["Category", "Cases", "Legacy cases"]],
      body: opts.categories.categories
        .filter((c) => c.count > 0)
        .map((c) => [c.label, String(c.count), String(c.legacyCount)]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
      columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
    });
    y = lastTableY() + sectionGap;
  }

  if (opts.categories && opts.categories.materials.length > 0) {
    sectionTitle("Material breakdown");
    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      head: [["Material", "Restorations", "Units"]],
      body: opts.categories.materials.map((m) => [
        m.material,
        String(m.restorations),
        String(m.units),
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
      columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
    });
    y = lastTableY() + sectionGap;
  }

  if (opts.weekday && opts.weekday.totalCases > 0) {
    sectionTitle("Case volume by weekday");
    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      head: [["Weekday", "Cases"]],
      body: opts.weekday.weekdays.map((w) => [w.label, String(w.total)]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
      columnStyles: { 1: { halign: "right" } },
    });
    y = lastTableY() + sectionGap;
  }

  const filename = `stats-report-${safeFilename(opts.filters.orgName)}-${rangeStamp(opts.filters)}.pdf`;
  const arrayBuffer = doc.output("arraybuffer") as ArrayBuffer;
  return { blob: new Blob([arrayBuffer], { type: "application/pdf" }), filename };
}

export function downloadStatsPdf(opts: StatsPdfOptions) {
  const { blob, filename } = buildStatsPdf(opts);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
