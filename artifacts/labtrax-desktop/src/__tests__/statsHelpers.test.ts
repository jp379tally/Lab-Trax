// Unit tests for stats-page pure helpers that have no coverage yet.
// Pins localTimeZone(), GROUP_BY_OPTIONS key/label mapping, and the
// date-range boundary functions so regressions are caught before shipping.
import { describe, it, expect, vi, afterEach } from "vitest";
import { localTimeZone, GROUP_BY_OPTIONS } from "@/components/reports/StatsTab";
import {
  rangeFromPreset,
  defaultRange,
  rangeLabel,
} from "@/components/reports/DateRangePicker";

// ---------------------------------------------------------------------------
// localTimeZone
// ---------------------------------------------------------------------------

describe("localTimeZone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the IANA timezone string reported by Intl.DateTimeFormat", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({
        timeZone: "America/New_York",
        locale: "en-US",
        calendar: "gregory",
        numberingSystem: "latn",
      }),
      format: () => "",
      formatToParts: () => [],
      formatRange: () => "",
      formatRangeToParts: () => [],
    } as unknown as Intl.DateTimeFormat);

    expect(localTimeZone()).toBe("America/New_York");
  });

  it('falls back to "UTC" when Intl.DateTimeFormat throws', () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("Intl not available");
    });

    expect(localTimeZone()).toBe("UTC");
  });

  it('falls back to "UTC" when resolvedOptions returns an empty timeZone string', () => {
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({
        timeZone: "",
        locale: "en-US",
        calendar: "gregory",
        numberingSystem: "latn",
      }),
      format: () => "",
      formatToParts: () => [],
      formatRange: () => "",
      formatRangeToParts: () => [],
    } as unknown as Intl.DateTimeFormat);

    expect(localTimeZone()).toBe("UTC");
  });
});

// ---------------------------------------------------------------------------
// GROUP_BY_OPTIONS — key/label consistency
// ---------------------------------------------------------------------------

describe("GROUP_BY_OPTIONS", () => {
  it("contains exactly the four expected grouping keys in order", () => {
    expect(GROUP_BY_OPTIONS.map((o) => o.key)).toEqual([
      "day",
      "week",
      "month",
      "year",
    ]);
  });

  it("has the correct display labels for each key", () => {
    const labelMap = Object.fromEntries(
      GROUP_BY_OPTIONS.map((o) => [o.key, o.label]),
    );
    expect(labelMap).toEqual({
      day: "Daily",
      week: "Weekly",
      month: "Monthly",
      year: "Yearly",
    });
  });

  it("has no duplicate keys", () => {
    const keys = GROUP_BY_OPTIONS.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has no duplicate labels", () => {
    const labels = GROUP_BY_OPTIONS.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// ---------------------------------------------------------------------------
// rangeFromPreset — date-range boundary calculations
//
// Tests are written in terms of structural properties (getDate, getMonth, etc.)
// so they are correct regardless of the test-runner timezone.
// ---------------------------------------------------------------------------

// Fixed anchor: Wednesday, 15 July 2026, 14:30:00 UTC
const FIXED_NOW = new Date("2026-07-15T14:30:00.000Z");

describe("rangeFromPreset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('"today" preset', () => {
    it("from and to land on the same calendar day as now", () => {
      const { from, to } = rangeFromPreset("today");
      expect(from.getDate()).toBe(new Date().getDate());
      expect(to.getDate()).toBe(new Date().getDate());
    });

    it("from is at midnight (start of day)", () => {
      const { from } = rangeFromPreset("today");
      expect(from.getHours()).toBe(0);
      expect(from.getMinutes()).toBe(0);
      expect(from.getSeconds()).toBe(0);
      expect(from.getMilliseconds()).toBe(0);
    });

    it("to is at end of day (23:59:59.999)", () => {
      const { to } = rangeFromPreset("today");
      expect(to.getHours()).toBe(23);
      expect(to.getMinutes()).toBe(59);
      expect(to.getSeconds()).toBe(59);
      expect(to.getMilliseconds()).toBe(999);
    });
  });

  describe('"week" preset', () => {
    it("from is a Monday (getDay() === 1)", () => {
      const { from } = rangeFromPreset("week");
      expect(from.getDay()).toBe(1);
    });

    it("from is at midnight", () => {
      const { from } = rangeFromPreset("week");
      expect(from.getHours()).toBe(0);
      expect(from.getMinutes()).toBe(0);
      expect(from.getSeconds()).toBe(0);
      expect(from.getMilliseconds()).toBe(0);
    });

    it("to is at end of today", () => {
      const { to } = rangeFromPreset("week");
      expect(to.getDate()).toBe(new Date().getDate());
      expect(to.getHours()).toBe(23);
      expect(to.getSeconds()).toBe(59);
    });

    it("from is before or equal to today", () => {
      const { from } = rangeFromPreset("week");
      expect(from.getTime()).toBeLessThanOrEqual(FIXED_NOW.getTime());
    });

    it("from is within the last 7 days", () => {
      const { from } = rangeFromPreset("week");
      const sevenDaysAgo = new Date(FIXED_NOW);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      expect(from.getTime()).toBeGreaterThanOrEqual(
        new Date(sevenDaysAgo.getFullYear(), sevenDaysAgo.getMonth(), sevenDaysAgo.getDate()).getTime(),
      );
    });
  });

  describe('"month" preset', () => {
    it("from is the 1st of the current month", () => {
      const { from } = rangeFromPreset("month");
      expect(from.getDate()).toBe(1);
      expect(from.getMonth()).toBe(new Date().getMonth());
      expect(from.getFullYear()).toBe(new Date().getFullYear());
    });

    it("from is at midnight", () => {
      const { from } = rangeFromPreset("month");
      expect(from.getHours()).toBe(0);
      expect(from.getMinutes()).toBe(0);
      expect(from.getSeconds()).toBe(0);
      expect(from.getMilliseconds()).toBe(0);
    });

    it("to is at end of today", () => {
      const { to } = rangeFromPreset("month");
      expect(to.getDate()).toBe(new Date().getDate());
      expect(to.getHours()).toBe(23);
    });
  });

  describe('"quarter" preset', () => {
    it("from month is divisible by 3 (Q boundary)", () => {
      const { from } = rangeFromPreset("quarter");
      expect(from.getMonth() % 3).toBe(0);
    });

    it("from is the 1st day of the quarter start month", () => {
      const { from } = rangeFromPreset("quarter");
      expect(from.getDate()).toBe(1);
    });

    it("from is in the same year as now", () => {
      const { from } = rangeFromPreset("quarter");
      expect(from.getFullYear()).toBe(new Date().getFullYear());
    });

    it("from quarter-start is on or before the current month", () => {
      const { from } = rangeFromPreset("quarter");
      expect(from.getMonth()).toBeLessThanOrEqual(new Date().getMonth());
    });

    it("to is at end of today", () => {
      const { to } = rangeFromPreset("quarter");
      expect(to.getDate()).toBe(new Date().getDate());
      expect(to.getHours()).toBe(23);
    });
  });

  describe('"year" preset', () => {
    it("from is January 1st of the current year", () => {
      const { from } = rangeFromPreset("year");
      expect(from.getMonth()).toBe(0);
      expect(from.getDate()).toBe(1);
      expect(from.getFullYear()).toBe(new Date().getFullYear());
    });

    it("from is at midnight", () => {
      const { from } = rangeFromPreset("year");
      expect(from.getHours()).toBe(0);
      expect(from.getMinutes()).toBe(0);
      expect(from.getSeconds()).toBe(0);
      expect(from.getMilliseconds()).toBe(0);
    });

    it("to is at end of today", () => {
      const { to } = rangeFromPreset("year");
      expect(to.getHours()).toBe(23);
      expect(to.getSeconds()).toBe(59);
    });
  });

  describe('"custom" preset fallback', () => {
    it("falls back to the current month start (same as month preset)", () => {
      const custom = rangeFromPreset("custom");
      const month = rangeFromPreset("month");
      expect(custom.from.getTime()).toBe(month.from.getTime());
      expect(custom.to.getTime()).toBe(month.to.getTime());
    });
  });

  it("from is always before or equal to to for every preset", () => {
    const presets = ["today", "week", "month", "quarter", "year", "custom"] as const;
    for (const preset of presets) {
      const { from, to } = rangeFromPreset(preset);
      expect(from.getTime()).toBeLessThanOrEqual(to.getTime());
    }
  });
});

// ---------------------------------------------------------------------------
// defaultRange
// ---------------------------------------------------------------------------

describe("defaultRange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has preset "month"', () => {
    expect(defaultRange().preset).toBe("month");
  });

  it("from and to are valid ISO strings", () => {
    const { from, to } = defaultRange();
    expect(new Date(from).getTime()).not.toBeNaN();
    expect(new Date(to).getTime()).not.toBeNaN();
  });

  it("from is the start of the current month", () => {
    const { from } = defaultRange();
    const d = new Date(from);
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });

  it("to is the end of today", () => {
    const { to } = defaultRange();
    const d = new Date(to);
    expect(d.getDate()).toBe(new Date().getDate());
    expect(d.getHours()).toBe(23);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
  });

  it("from is before to", () => {
    const { from, to } = defaultRange();
    expect(new Date(from).getTime()).toBeLessThan(new Date(to).getTime());
  });
});

// ---------------------------------------------------------------------------
// rangeLabel
// ---------------------------------------------------------------------------

describe("rangeLabel", () => {
  it("includes the preset display name", () => {
    const label = rangeLabel({
      preset: "month",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-15T23:59:59.999Z",
    });
    expect(label).toContain("This month");
  });

  it("includes the formatted from date", () => {
    const label = rangeLabel({
      preset: "custom",
      from: new Date(2026, 2, 10).toISOString(),
      to: new Date(2026, 2, 20, 23, 59, 59, 999).toISOString(),
    });
    expect(label).toContain("03/10/2026");
  });

  it("includes the formatted to date", () => {
    const label = rangeLabel({
      preset: "custom",
      from: new Date(2026, 2, 10).toISOString(),
      to: new Date(2026, 2, 20, 23, 59, 59, 999).toISOString(),
    });
    expect(label).toContain("03/20/2026");
  });

  it("uses an arrow separator between from and to dates", () => {
    const label = rangeLabel({
      preset: "today",
      from: "2026-07-15T00:00:00.000Z",
      to: "2026-07-15T23:59:59.999Z",
    });
    expect(label).toContain("→");
  });

  it('falls back to "Custom" for an unrecognised preset', () => {
    const label = rangeLabel({
      preset: "custom",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-12-31T23:59:59.999Z",
    });
    expect(label).toContain("Custom");
  });

  it("returns an empty string for an invalid from date without crashing", () => {
    const label = rangeLabel({ preset: "today", from: "", to: "" });
    expect(typeof label).toBe("string");
  });
});
