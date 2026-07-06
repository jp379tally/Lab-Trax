import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatRelativeCreated,
  formatRelativeDue,
  getLocalDayDiff,
} from "../format";

// These helpers compare *local calendar days* (not raw millisecond diffs) so a
// case reads correctly near midnight / timezone boundaries. All inputs below are
// built with the local-time Date constructor and serialized via toISOString(),
// so the assertions hold regardless of the machine's timezone.

function localIso(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
): string {
  return new Date(year, month, day, hour, minute, 0, 0).toISOString();
}

describe("relative case-date formatters (local-day math)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fixed "now": midday on 2026-07-06 local time.
    vi.setSystemTime(new Date(2026, 6, 6, 12, 0, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getLocalDayDiff", () => {
    it("returns 0 for any time earlier today (local)", () => {
      expect(getLocalDayDiff(localIso(2026, 6, 6, 0, 1))).toBe(0);
      expect(getLocalDayDiff(localIso(2026, 6, 6, 12, 0))).toBe(0);
      expect(getLocalDayDiff(localIso(2026, 6, 6, 23, 59))).toBe(0);
    });

    it("returns -1 for yesterday and +1 for tomorrow (local)", () => {
      expect(getLocalDayDiff(localIso(2026, 6, 5, 23, 59))).toBe(-1);
      expect(getLocalDayDiff(localIso(2026, 6, 7, 0, 1))).toBe(1);
    });

    it("returns null for missing or invalid input", () => {
      expect(getLocalDayDiff(null)).toBeNull();
      expect(getLocalDayDiff(undefined)).toBeNull();
      expect(getLocalDayDiff("")).toBeNull();
      expect(getLocalDayDiff("not-a-date")).toBeNull();
    });
  });

  describe("formatRelativeCreated", () => {
    it("reads 'Created today' for any time earlier today, including late local time", () => {
      expect(formatRelativeCreated(localIso(2026, 6, 6, 0, 1))).toBe(
        "Created today",
      );
      expect(formatRelativeCreated(localIso(2026, 6, 6, 12, 0))).toBe(
        "Created today",
      );
      // Late "today" local time must NOT roll over to yesterday.
      expect(formatRelativeCreated(localIso(2026, 6, 6, 23, 59))).toBe(
        "Created today",
      );
    });

    it("reads 'Created yesterday' for the prior local day", () => {
      expect(formatRelativeCreated(localIso(2026, 6, 5, 8, 0))).toBe(
        "Created yesterday",
      );
      // Just before local midnight yesterday is still "yesterday", not "2 days ago".
      expect(formatRelativeCreated(localIso(2026, 6, 5, 23, 59))).toBe(
        "Created yesterday",
      );
    });

    it("reads 'Created N days ago' for older local days", () => {
      expect(formatRelativeCreated(localIso(2026, 6, 4, 12, 0))).toBe(
        "Created 2 days ago",
      );
      expect(formatRelativeCreated(localIso(2026, 5, 30, 12, 0))).toBe(
        "Created 6 days ago",
      );
    });

    it("treats a future created date as 'Created today'", () => {
      // Guards the ago <= 0 branch: a clock-skewed future timestamp reads today.
      expect(formatRelativeCreated(localIso(2026, 6, 7, 0, 1))).toBe(
        "Created today",
      );
    });

    it("returns an empty string for missing or invalid input", () => {
      expect(formatRelativeCreated(null)).toBe("");
      expect(formatRelativeCreated(undefined)).toBe("");
      expect(formatRelativeCreated("")).toBe("");
      expect(formatRelativeCreated("not-a-date")).toBe("");
    });
  });

  describe("formatRelativeDue", () => {
    it("reads 'Due today' for any time later today, including late local time", () => {
      expect(formatRelativeDue(localIso(2026, 6, 6, 0, 1))).toBe("Due today");
      expect(formatRelativeDue(localIso(2026, 6, 6, 12, 0))).toBe("Due today");
      // Late "today" local time must read "Due today", not "Due tomorrow".
      expect(formatRelativeDue(localIso(2026, 6, 6, 23, 59))).toBe("Due today");
    });

    it("reads 'Due tomorrow' for the next local day", () => {
      expect(formatRelativeDue(localIso(2026, 6, 7, 8, 0))).toBe("Due tomorrow");
      // Just after local midnight tomorrow is still "tomorrow", not "in 2 days".
      expect(formatRelativeDue(localIso(2026, 6, 7, 0, 1))).toBe("Due tomorrow");
    });

    it("reads 'Due in N days' for later local days", () => {
      expect(formatRelativeDue(localIso(2026, 6, 8, 12, 0))).toBe(
        "Due in 2 days",
      );
      expect(formatRelativeDue(localIso(2026, 6, 13, 12, 0))).toBe(
        "Due in 7 days",
      );
    });

    it("reads 'Overdue by 1 day' for yesterday (singular)", () => {
      expect(formatRelativeDue(localIso(2026, 6, 5, 8, 0))).toBe(
        "Overdue by 1 day",
      );
      // Late yesterday local time is still overdue by exactly 1 day.
      expect(formatRelativeDue(localIso(2026, 6, 5, 23, 59))).toBe(
        "Overdue by 1 day",
      );
    });

    it("reads 'Overdue by N days' for older local days (plural)", () => {
      expect(formatRelativeDue(localIso(2026, 6, 4, 12, 0))).toBe(
        "Overdue by 2 days",
      );
      expect(formatRelativeDue(localIso(2026, 5, 29, 12, 0))).toBe(
        "Overdue by 7 days",
      );
    });

    it("returns an empty string for missing or invalid input", () => {
      expect(formatRelativeDue(null)).toBe("");
      expect(formatRelativeDue(undefined)).toBe("");
      expect(formatRelativeDue("")).toBe("");
      expect(formatRelativeDue("not-a-date")).toBe("");
    });
  });
});
