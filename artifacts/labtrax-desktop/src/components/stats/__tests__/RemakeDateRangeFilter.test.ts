// Pins remakeRangeFromPreset()'s boundary math (mirrors the coverage style of
// statsHelpers.test.ts for the shared DateRangePicker) so the Remake Records
// section's date filter presets stay correct — especially "yesterday" and
// "lastYear", which don't exist on the shared control and roll across
// month/year boundaries.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  remakeRangeFromPreset,
  defaultRemakeDateRange,
  DEFAULT_REMAKE_DATE_PRESET,
} from "@/components/stats/RemakeDateRangeFilter";

// Fixed anchor: Wednesday, 15 July 2026, 14:30:00 UTC (same anchor used by
// statsHelpers.test.ts's rangeFromPreset suite, for parallel behaviour).
const FIXED_NOW = new Date("2026-07-15T14:30:00.000Z");

describe("remakeRangeFromPreset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('"today" preset', () => {
    it("spans midnight to end of day on the current date", () => {
      const { from, to } = remakeRangeFromPreset("today");
      const now = new Date();
      expect(from.getDate()).toBe(now.getDate());
      expect(from.getHours()).toBe(0);
      expect(to.getDate()).toBe(now.getDate());
      expect(to.getHours()).toBe(23);
      expect(to.getMinutes()).toBe(59);
    });
  });

  describe('"yesterday" preset', () => {
    it("spans midnight to end of day, one calendar day before today", () => {
      const { from, to } = remakeRangeFromPreset("yesterday");
      const now = new Date();
      const expectedDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      expect(from.getDate()).toBe(expectedDay.getDate());
      expect(from.getMonth()).toBe(expectedDay.getMonth());
      expect(from.getHours()).toBe(0);
      expect(to.getDate()).toBe(expectedDay.getDate());
      expect(to.getHours()).toBe(23);
    });

    it("rolls back across a month boundary", () => {
      vi.setSystemTime(new Date("2026-03-01T09:00:00.000Z"));
      const { from, to } = remakeRangeFromPreset("yesterday");
      expect(from.getMonth()).toBe(1); // February
      expect(from.getDate()).toBe(28); // 2026 is not a leap year
      expect(to.getMonth()).toBe(1);
      expect(to.getDate()).toBe(28);
    });

    it("rolls back across a year boundary", () => {
      vi.setSystemTime(new Date("2026-01-01T09:00:00.000Z"));
      const { from, to } = remakeRangeFromPreset("yesterday");
      expect(from.getFullYear()).toBe(2025);
      expect(from.getMonth()).toBe(11); // December
      expect(from.getDate()).toBe(31);
      expect(to.getFullYear()).toBe(2025);
    });

    it("never spans more than one calendar day", () => {
      const { from, to } = remakeRangeFromPreset("yesterday");
      expect(to.getTime() - from.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
    });
  });

  describe('"week" / "month" / "year" presets', () => {
    it("week starts on a Monday", () => {
      const { from } = remakeRangeFromPreset("week");
      expect(from.getDay()).toBe(1);
    });

    it("month starts on the 1st of the current month", () => {
      const { from } = remakeRangeFromPreset("month");
      expect(from.getDate()).toBe(1);
      expect(from.getMonth()).toBe(new Date().getMonth());
    });

    it("year starts on January 1st of the current year", () => {
      const { from } = remakeRangeFromPreset("year");
      expect(from.getMonth()).toBe(0);
      expect(from.getDate()).toBe(1);
      expect(from.getFullYear()).toBe(new Date().getFullYear());
    });
  });

  describe('"lastYear" preset', () => {
    it("spans the full previous calendar year (Jan 1 - Dec 31), not a trailing 365 days", () => {
      const { from, to } = remakeRangeFromPreset("lastYear");
      const thisYear = new Date().getFullYear();
      expect(from.getFullYear()).toBe(thisYear - 1);
      expect(from.getMonth()).toBe(0);
      expect(from.getDate()).toBe(1);
      expect(from.getHours()).toBe(0);
      expect(to.getFullYear()).toBe(thisYear - 1);
      expect(to.getMonth()).toBe(11);
      expect(to.getDate()).toBe(31);
      expect(to.getHours()).toBe(23);
    });

    it("does not include any part of the current year", () => {
      const { to } = remakeRangeFromPreset("lastYear");
      expect(to.getTime()).toBeLessThan(new Date(new Date().getFullYear(), 0, 1).getTime());
    });
  });

  describe('"custom" preset fallback', () => {
    it("falls back to the current month (same as the month preset)", () => {
      const custom = remakeRangeFromPreset("custom");
      const month = remakeRangeFromPreset("month");
      expect(custom.from.getTime()).toBe(month.from.getTime());
      expect(custom.to.getTime()).toBe(month.to.getTime());
    });
  });

  it("from is always before or equal to to for every preset", () => {
    const presets = ["today", "yesterday", "week", "month", "year", "lastYear", "custom"] as const;
    for (const preset of presets) {
      const { from, to } = remakeRangeFromPreset(preset);
      expect(from.getTime()).toBeLessThanOrEqual(to.getTime());
    }
  });
});

describe("defaultRemakeDateRange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to the DEFAULT_REMAKE_DATE_PRESET (month)", () => {
    expect(DEFAULT_REMAKE_DATE_PRESET).toBe("month");
    const range = defaultRemakeDateRange();
    expect(range.preset).toBe("month");
  });

  it("from/to match remakeRangeFromPreset(DEFAULT_REMAKE_DATE_PRESET) as ISO strings", () => {
    const range = defaultRemakeDateRange();
    const { from, to } = remakeRangeFromPreset(DEFAULT_REMAKE_DATE_PRESET);
    expect(range.from).toBe(from.toISOString());
    expect(range.to).toBe(to.toISOString());
  });
});
