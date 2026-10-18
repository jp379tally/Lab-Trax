import { describe, it, expect } from "vitest";
import {
  computeCaseDateRange,
  caseWithinDateRange,
  deriveCaseTypeIndicator,
  type DateRangeFilter,
} from "@/lib/case-date-filter";
import type { LabCase } from "@/lib/types";

/**
 * Regression suite for the Cases page date-range filter.
 *
 * The "Received" date was removed from the UI as redundant with "Created", so
 * the filter now matches on the **created date** only — there is no received
 * date fallback. These tests pin:
 *   - Custom today→today returns cases created today, not those created earlier.
 *   - The "Today" preset matches the same set as Custom today→today.
 *   - A case whose receivedAt is today but createdAt is earlier is EXCLUDED
 *     (guards against silently reintroducing the received-date fallback).
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
    doctorName: "Dr. Synthetic063",
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

describe("Cases date-range filter — created-date only", () => {
  it("Yesterday respects 23- and 25-hour local daylight-saving days", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      for (const [month, date, hours] of [[2, 9, 23], [10, 2, 25]]) {
        const { startDate, endDate } = computeCaseDateRange("yesterday", "", "", new Date(2026, month, date, 12));
        expect((endDate!.getTime() - startDate!.getTime()) / 3600000).toBe(hours);
      }
    } finally {
      process.env.TZ = original;
    }
  });
  it.each([
    [2026, 0, 1, "2025-12-31"],
    [2026, 2, 1, "2026-02-28"],
    [2028, 2, 1, "2028-02-29"],
    [2026, 2, 9, "2026-03-08"],
    [2026, 10, 2, "2026-11-01"],
  ])("Yesterday spans the full previous local day from %s/%s/%s", (y, m, d, expected) => {
    const { startDate, endDate } = computeCaseDateRange("yesterday", "", "", new Date(y, m, d, 14));
    expect(ymd(startDate!)).toBe(expected);
    expect(startDate!.getHours()).toBe(0);
    expect(endDate!.getTime()).toBe(new Date(y, m, d).getTime());
    expect(caseWithinDateRange({ createdAt: startDate!.toISOString() }, startDate, endDate)).toBe(true);
    expect(caseWithinDateRange({ createdAt: new Date(endDate!.getTime() - 1).toISOString() }, startDate, endDate)).toBe(true);
    expect(caseWithinDateRange({ createdAt: endDate!.toISOString() }, startDate, endDate)).toBe(false);
  });
  // Created today — the ordinary case that must appear under "Today".
  const createdToday = mkCase({
    id: "created-today",
    createdAt: new Date(2026, 5, 29, 9, 0, 0).toISOString(),
  });

  // Created yesterday — must NOT appear under "Today".
  const createdYesterday = mkCase({
    id: "created-yesterday",
    createdAt: new Date(2026, 5, 28, 9, 0, 0).toISOString(),
  });

  // A legacy/mobile case created today.
  const legacyCreatedToday = mkCase({
    id: "legacy-today",
    _source: "mobile",
    createdAt: new Date(2026, 5, 29, 11, 0, 0).toISOString(),
  });

  const all = [createdToday, createdYesterday, legacyCreatedToday];

  it("Custom today→today returns cases created today only", () => {
    const ids = applyDateFilter(all, "custom", TODAY, TODAY).map((c) => c.id);
    expect(ids).toContain("created-today");
    expect(ids).toContain("legacy-today");
    expect(ids).not.toContain("created-yesterday");
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

  it("ignores receivedAt entirely — a case received today but created earlier is excluded", () => {
    // Guards against reintroducing the removed received-date fallback: the
    // received date is no longer a filter input, so only createdAt decides.
    const receivedTodayCreatedEarlier = mkCase({
      id: "received-today-created-earlier",
      receivedAt: new Date(2026, 5, 29, 9, 0, 0).toISOString(),
      createdAt: new Date(2026, 5, 1, 9, 0, 0).toISOString(),
    });
    const { startDate, endDate } = computeCaseDateRange("today", "", "", NOW);
    expect(
      caseWithinDateRange(receivedTodayCreatedEarlier, startDate, endDate),
    ).toBe(false);
  });

  it("excludes cases created before the window under 'Today'", () => {
    const result = applyDateFilter(all, "today").map((c) => c.id);
    expect(result).not.toContain("created-yesterday");
  });

  it("Status + Today combine correctly", () => {
    // Two cases created today, different statuses.
    const inDesignToday = mkCase({
      id: "in-design-today",
      status: "in_design",
      createdAt: new Date(2026, 5, 29, 8, 0, 0).toISOString(),
    });
    const rows = [createdToday, inDesignToday, createdYesterday];

    const { startDate, endDate } = computeCaseDateRange("today", "", "", NOW);
    const statusFilter = "received";
    const result = rows
      .filter((c) => statusFilter === "all" || c.status === statusFilter)
      .filter((c) => caseWithinDateRange(c, startDate, endDate))
      .map((c) => c.id);

    // Only the "received"-status case from today survives both filters.
    expect(result).toEqual(["created-today"]);
  });

  it("the 'all' selection applies no date constraint", () => {
    const { startDate, endDate } = computeCaseDateRange("all", "", "", NOW);
    expect(startDate).toBeNull();
    expect(endDate).toBeNull();
    const result = applyDateFilter(all, "all").map((c) => c.id);
    expect(result.sort()).toEqual(all.map((c) => c.id).sort());
  });

  it("excludes cases with no createdAt while a range is active", () => {
    const noDates = mkCase({ id: "no-dates", createdAt: null });
    const result = applyDateFilter([...all, noDates], "today").map((c) => c.id);
    expect(result).not.toContain("no-dates");
  });
});

describe("deriveCaseTypeIndicator — mixed restoration type classification", () => {
  it("returns 'C' when restorationTypes contains only a crown keyword", () => {
    expect(deriveCaseTypeIndicator("crown", null)).toBe("C");
  });

  it("returns 'D' when restorationTypes contains only a denture keyword", () => {
    expect(deriveCaseTypeIndicator("denture", null)).toBe("D");
  });

  it("returns null when both restorationTypes and restorationMaterials are empty", () => {
    expect(deriveCaseTypeIndicator("", "")).toBe(null);
    expect(deriveCaseTypeIndicator(null, null)).toBe(null);
  });

  it("C wins over D when both crown and denture keywords appear in restorationTypes", () => {
    expect(deriveCaseTypeIndicator("crown + denture", null)).toBe("C");
    expect(deriveCaseTypeIndicator("denture crown", null)).toBe("C");
  });

  it("zirconia material alone (no restorationTypes) returns 'C'", () => {
    expect(deriveCaseTypeIndicator(null, "zirconia")).toBe("C");
    expect(deriveCaseTypeIndicator("", "bruxzir")).toBe("C");
  });

  it("explicit removable restorationTypes wins over zirconia/PFZ material ('D' wins)", () => {
    // An explicit removable type (denture, flipper, etc.) beats a zirconia/PFZ
    // material signal — the case type the user selected takes precedence.
    expect(deriveCaseTypeIndicator("denture", "zirconia")).toBe("D");
    expect(deriveCaseTypeIndicator("flipper", "bruxzir")).toBe("D");
  });

  it("implant keyword in restorationTypes wins over denture (C wins)", () => {
    expect(deriveCaseTypeIndicator("implant + denture", null)).toBe("C");
  });

  it("bridge keyword in restorationTypes wins over partial (C wins)", () => {
    expect(deriveCaseTypeIndicator("bridge partial", null)).toBe("C");
  });

  describe("subtype-prefix path (firstRestorationSubtype)", () => {
    it("'removable/dentures/acrylic' subtype → 'D'", () => {
      expect(deriveCaseTypeIndicator(null, null, "removable/dentures/acrylic")).toBe("D");
    });

    it("'removable/nesbits/cast_metal' subtype → 'D'", () => {
      expect(deriveCaseTypeIndicator(null, null, "removable/nesbits/cast_metal")).toBe("D");
    });

    it("'restorative/crown_and_bridge/zirconia' subtype → 'C'", () => {
      expect(deriveCaseTypeIndicator(null, null, "restorative/crown_and_bridge/zirconia")).toBe("C");
    });

    it("subtype takes precedence over conflicting free-text (removable subtype + crown text → 'D')", () => {
      expect(deriveCaseTypeIndicator("crown", null, "removable/dentures/acrylic")).toBe("D");
    });

    it("falls through to free-text heuristics when subtype is null", () => {
      expect(deriveCaseTypeIndicator("denture", null, null)).toBe("D");
      expect(deriveCaseTypeIndicator("crown", null, null)).toBe("C");
    });

    it("'ortho/night_guards' subtype → 'O'", () => {
      expect(deriveCaseTypeIndicator(null, null, "ortho/night_guards")).toBe("O");
      expect(deriveCaseTypeIndicator(null, null, "ortho/retainers")).toBe("O");
      expect(deriveCaseTypeIndicator(null, null, "ortho/braces")).toBe("O");
    });

    it("ortho subtype takes precedence over conflicting free-text (ortho subtype + crown text → 'O')", () => {
      expect(deriveCaseTypeIndicator("crown", null, "ortho/night_guards")).toBe("O");
    });

    it("falls through to free-text heuristics when subtype is an unrecognised top segment", () => {
      expect(deriveCaseTypeIndicator(null, null, "surgical/guide")).toBe(null);
      expect(deriveCaseTypeIndicator("crown", null, "surgical/guide")).toBe("C");
    });
  });

  describe("ortho / appliance classification ('O')", () => {
    it("returns 'O' for representative ortho free text", () => {
      expect(deriveCaseTypeIndicator("Night Guard", null)).toBe("O");
      expect(deriveCaseTypeIndicator("nightguard", null)).toBe("O");
      expect(deriveCaseTypeIndicator("Occlusal Guard", null)).toBe("O");
      expect(deriveCaseTypeIndicator("Bite Guard", null)).toBe("O");
      expect(deriveCaseTypeIndicator("Retainer", null)).toBe("O");
      expect(deriveCaseTypeIndicator("Splint", null)).toBe("O");
      expect(deriveCaseTypeIndicator("Sports Guard", null)).toBe("O");
      expect(deriveCaseTypeIndicator("Snore Guard", null)).toBe("O");
      expect(deriveCaseTypeIndicator("Bleach Tray", null)).toBe("O");
    });

    it("an explicit ortho restoration type wins over a material-only signal", () => {
      expect(deriveCaseTypeIndicator("Night Guard", "Acrylic")).toBe("O");
      // A stray zirconia material must not turn a night guard into a crown.
      expect(deriveCaseTypeIndicator("Night Guard", "Zirconia")).toBe("O");
    });

    it("restorative and removable signals still take priority over ortho free text", () => {
      expect(deriveCaseTypeIndicator("crown + night guard", null)).toBe("C");
      expect(deriveCaseTypeIndicator("implant retainer", null)).toBe("C");
      expect(deriveCaseTypeIndicator("denture + retainer", null)).toBe("D");
    });

    it("ortho keywords in the material string alone still classify as 'O'", () => {
      expect(deriveCaseTypeIndicator(null, "night guard hard")).toBe("O");
    });
  });

  describe("AI-imported removable cases (restorationSubtype is null)", () => {
    it("'Removable' restorationType with 'Acrylic' material returns 'D'", () => {
      expect(deriveCaseTypeIndicator("Removable", "Acrylic", null)).toBe("D");
    });

    it("'Removable' restorationType with no material returns 'D'", () => {
      expect(deriveCaseTypeIndicator("Removable", null, null)).toBe("D");
    });

    it("'Removable' restorationType alone (no subtype, no material) returns 'D'", () => {
      expect(deriveCaseTypeIndicator("Removable", "", null)).toBe("D");
    });
  });
});
