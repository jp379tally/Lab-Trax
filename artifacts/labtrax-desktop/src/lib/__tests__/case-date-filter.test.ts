import { describe, it, expect } from "vitest";
import {
  computeCaseDateRange,
  caseWithinDateRange,
  type DateRangeFilter,
} from "@/lib/case-date-filter";
import type { LabCase } from "@/lib/types";

/**
 * Regression suite for the Cases page date-range filter.
 *
 * The filter was switched from created-date to received-date (with a
 * created-date fallback). A previous glitch made a Custom "today → today"
 * range show no cases for legacy/mobile cases that were *created* earlier but
 * *received* today. These tests pin:
 *   - Custom today→today returns a case received today but created earlier.
 *   - The "Today" preset matches the same set as Custom today→today.
 *   - Legacy/mobile cases with no receivedAt fall back to createdAt.
 *   - Status + Today combine correctly (date filter doesn't break combination).
 *
 * `computeCaseDateRange` takes an injectable `now` so the suite is not
 * wall-clock dependent.
 */

// A fixed "now": 2026-06-29, mid-afternoon local time.
const NOW = new Date(2026, 5, 29, 14, 30, 0);

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const TODAY = ymd(NOW); // "2026-06-29"

function mkCase(over: Partial<LabCase>): LabCase {
  return {
    id: "c",
    caseNumber: "26-1",
    patientFirstName: "Jane",
    patientLastName: "Doe",
    doctorName: "Dr. Smith",
    status: "received",
    priority: "normal",
    ...over,
  } as unknown as LabCase;
}

/** Apply a date filter selection to a list of cases, mirroring cases.tsx. */
function applyDateFilter(
  rows: LabCase[],
  filter: DateRangeFilter,
  customStart = "",
  customEnd = "",
): LabCase[] {
  const { startDate, endDate } = computeCaseDateRange(
    filter,
    customStart,
    customEnd,
    NOW,
  );
  return rows.filter((c) => caseWithinDateRange(c, startDate, endDate));
}

describe("Cases date-range filter — received-date with created-date fallback", () => {
  // A canonical case received TODAY but created weeks earlier — the exact
  // shape that the old created-date filter dropped from a today→today range.
  const receivedTodayCreatedEarlier = mkCase({
    id: "received-today",
    receivedAt: new Date(2026, 5, 29, 9, 0, 0).toISOString(),
    createdAt: new Date(2026, 5, 1, 9, 0, 0).toISOString(),
  });

  // A case received (and created) yesterday — must NOT appear for "today".
  const receivedYesterday = mkCase({
    id: "received-yesterday",
    receivedAt: new Date(2026, 5, 28, 9, 0, 0).toISOString(),
    createdAt: new Date(2026, 5, 28, 9, 0, 0).toISOString(),
  });

  // A legacy/mobile case with NO receivedAt, created today — must fall back to
  // createdAt and appear for "today".
  const legacyCreatedToday = mkCase({
    id: "legacy-today",
    _source: "mobile",
    receivedAt: null,
    createdAt: new Date(2026, 5, 29, 11, 0, 0).toISOString(),
  });

  const all = [
    receivedTodayCreatedEarlier,
    receivedYesterday,
    legacyCreatedToday,
  ];

  it("Custom today→today returns a case received today but created earlier", () => {
    const result = applyDateFilter(all, "custom", TODAY, TODAY);
    const ids = result.map((c) => c.id);
    expect(ids).toContain("received-today");
    expect(ids).not.toContain("received-yesterday");
  });

  it("the 'Today' preset matches the same set as Custom today→today", () => {
    const todayPreset = applyDateFilter(all, "today")
      .map((c) => c.id)
      .sort();
    const customTodayToToday = applyDateFilter(all, "custom", TODAY, TODAY)
      .map((c) => c.id)
      .sort();
    expect(todayPreset).toEqual(customTodayToToday);
  });

  it("includes legacy/mobile cases via the createdAt fallback when receivedAt is absent", () => {
    const result = applyDateFilter(all, "today").map((c) => c.id);
    expect(result).toContain("legacy-today");
    // Confidence the helper itself is using the fallback, not just inclusion.
    const { startDate, endDate } = computeCaseDateRange("today", "", "", NOW);
    expect(caseWithinDateRange(legacyCreatedToday, startDate, endDate)).toBe(
      true,
    );
  });

  it("excludes cases received before the window (received-yesterday under 'Today')", () => {
    const result = applyDateFilter(all, "today").map((c) => c.id);
    expect(result).not.toContain("received-yesterday");
  });

  it("Status + Today combine correctly", () => {
    // Two cases received today, different statuses.
    const receivedTodayInDesign = mkCase({
      id: "in-design-today",
      status: "in_design",
      receivedAt: new Date(2026, 5, 29, 8, 0, 0).toISOString(),
      createdAt: new Date(2026, 5, 1, 8, 0, 0).toISOString(),
    });
    const rows = [receivedTodayCreatedEarlier, receivedTodayInDesign, receivedYesterday];

    const { startDate, endDate } = computeCaseDateRange("today", "", "", NOW);
    const statusFilter = "received";
    const result = rows
      .filter((c) => statusFilter === "all" || c.status === statusFilter)
      .filter((c) => caseWithinDateRange(c, startDate, endDate))
      .map((c) => c.id);

    // Only the "received" case from today survives both filters.
    expect(result).toEqual(["received-today"]);
  });

  it("the 'all' selection applies no date constraint", () => {
    const { startDate, endDate } = computeCaseDateRange("all", "", "", NOW);
    expect(startDate).toBeNull();
    expect(endDate).toBeNull();
    const result = applyDateFilter(all, "all").map((c) => c.id);
    expect(result.sort()).toEqual(all.map((c) => c.id).sort());
  });

  it("excludes cases with neither receivedAt nor createdAt while a range is active", () => {
    const noDates = mkCase({ id: "no-dates", receivedAt: null, createdAt: null });
    const result = applyDateFilter([...all, noDates], "today").map((c) => c.id);
    expect(result).not.toContain("no-dates");
  });
});
