import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatRelativeCreated,
  formatRelativeDue,
  getLocalDayDiff,
  getDueDayDiff,
  parseDueTimeMinutes,
  formatDueTime,
  isDueTimePast,
  formatDueDateOnly,
  formatDueDate,
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

// Due dates (and expectedDeliveryDate) are transmitted by the server as a
// UTC-midnight-anchored calendar day with no real time-of-day — unlike a
// genuine timestamp such as createdAt. Fixtures for getDueDayDiff /
// formatRelativeDue / formatDueDate must be built this way (matching
// toDateInput's contract elsewhere in the app) so the tests exercise the
// real wire format rather than a local-time timestamp.
function dueIso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString();
}

describe("relative case-date formatters (local-day math)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fixed "now": midday on 2026-07-06 local time.
    vi.setSystemTime(new Date(2026, 6, 6, 12, 0, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("getLocalDayDiff", () => {
    it("returns 0 for any time earlier today (local)", async () => {
      expect(getLocalDayDiff(localIso(2026, 6, 6, 0, 1))).toBe(0);
      expect(getLocalDayDiff(localIso(2026, 6, 6, 12, 0))).toBe(0);
      expect(getLocalDayDiff(localIso(2026, 6, 6, 23, 59))).toBe(0);
    });

    it("returns -1 for yesterday and +1 for tomorrow (local)", async () => {
      expect(getLocalDayDiff(localIso(2026, 6, 5, 23, 59))).toBe(-1);
      expect(getLocalDayDiff(localIso(2026, 6, 7, 0, 1))).toBe(1);
    });

    it("returns null for missing or invalid input", async () => {
      expect(getLocalDayDiff(null)).toBeNull();
      expect(getLocalDayDiff(undefined)).toBeNull();
      expect(getLocalDayDiff("")).toBeNull();
      expect(getLocalDayDiff("not-a-date")).toBeNull();
    });
  });

  describe("getDueDayDiff", () => {
    it("returns 0 for a due date matching today's UTC calendar day", async () => {
      expect(getDueDayDiff(dueIso(2026, 6, 6))).toBe(0);
    });

    it("returns -1 for yesterday and +1 for tomorrow (UTC calendar day)", async () => {
      expect(getDueDayDiff(dueIso(2026, 6, 5))).toBe(-1);
      expect(getDueDayDiff(dueIso(2026, 6, 7))).toBe(1);
    });

    it("returns null for missing or invalid input", async () => {
      expect(getDueDayDiff(null)).toBeNull();
      expect(getDueDayDiff(undefined)).toBeNull();
      expect(getDueDayDiff("")).toBeNull();
      expect(getDueDayDiff("not-a-date")).toBeNull();
    });

    it("never shifts a UTC-midnight due date back a day for a viewer behind UTC", async () => {
      // A case due "July 6" (server-encoded as UTC midnight) must still read
      // as due today for a viewer in a negative-offset timezone whose local
      // wall clock also reads July 6. getLocalDayDiff gets this wrong for
      // due-date-shaped values: its local getters would read the UTC instant
      // as "July 5, 8pm" in America/New_York, shifting the day back by one.
      vi.stubEnv("TZ", "America/New_York");
      vi.setSystemTime(new Date(2026, 6, 6, 10, 0, 0, 0)); // local July 6, 10am (NY)
      expect(getDueDayDiff(dueIso(2026, 6, 6))).toBe(0);
    });

    it("never shifts a UTC-midnight due date forward a day for a viewer ahead of UTC", async () => {
      vi.stubEnv("TZ", "Pacific/Auckland"); // UTC+12/+13
      vi.setSystemTime(new Date(2026, 6, 6, 22, 0, 0, 0)); // local July 6, 10pm (Auckland)
      expect(getDueDayDiff(dueIso(2026, 6, 6))).toBe(0);
    });
  });

  describe("parseDueTimeMinutes", () => {
    it("parses a valid HH:MM string into minutes since midnight", async () => {
      expect(parseDueTimeMinutes("00:00")).toBe(0);
      expect(parseDueTimeMinutes("09:05")).toBe(545);
      expect(parseDueTimeMinutes("15:30")).toBe(930);
      expect(parseDueTimeMinutes("23:59")).toBe(1439);
    });

    it("returns null for missing, empty, or malformed input", async () => {
      expect(parseDueTimeMinutes(null)).toBeNull();
      expect(parseDueTimeMinutes(undefined)).toBeNull();
      expect(parseDueTimeMinutes("")).toBeNull();
      expect(parseDueTimeMinutes("25:00")).toBeNull();
      expect(parseDueTimeMinutes("12:60")).toBeNull();
      expect(parseDueTimeMinutes("3:30 PM")).toBeNull();
      expect(parseDueTimeMinutes("not-a-time")).toBeNull();
    });
  });

  describe("formatDueTime", () => {
    it("formats 24h HH:MM as a 12h clock string", async () => {
      expect(formatDueTime("00:00")).toBe("12:00 AM");
      expect(formatDueTime("09:05")).toBe("9:05 AM");
      expect(formatDueTime("12:00")).toBe("12:00 PM");
      expect(formatDueTime("15:30")).toBe("3:30 PM");
      expect(formatDueTime("23:59")).toBe("11:59 PM");
    });

    it("returns null for missing, empty, or malformed input", async () => {
      expect(formatDueTime(null)).toBeNull();
      expect(formatDueTime(undefined)).toBeNull();
      expect(formatDueTime("")).toBeNull();
      expect(formatDueTime("not-a-time")).toBeNull();
    });
  });

  describe("isDueTimePast", () => {
    // "now" is fixed to local noon (12:00:00.000) by the outer beforeEach.
    it("is false for a time later today", async () => {
      expect(isDueTimePast("12:01")).toBe(false);
      expect(isDueTimePast("15:30")).toBe(false);
    });

    it("is true for a time earlier today", async () => {
      expect(isDueTimePast("11:59")).toBe(true);
      expect(isDueTimePast("09:00")).toBe(true);
    });

    it("treats the exact current minute as already past (inclusive boundary)", async () => {
      expect(isDueTimePast("12:00")).toBe(true);
    });

    it("is false when there is no time to compare", async () => {
      expect(isDueTimePast(null)).toBe(false);
      expect(isDueTimePast(undefined)).toBe(false);
      expect(isDueTimePast("")).toBe(false);
    });
  });

  describe("formatRelativeCreated", () => {
    it("reads 'Created today' for any time earlier today, including late local time", async () => {
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

    it("reads 'Created yesterday' for the prior local day", async () => {
      expect(formatRelativeCreated(localIso(2026, 6, 5, 8, 0))).toBe(
        "Created yesterday",
      );
      // Just before local midnight yesterday is still "yesterday", not "2 days ago".
      expect(formatRelativeCreated(localIso(2026, 6, 5, 23, 59))).toBe(
        "Created yesterday",
      );
    });

    it("reads 'Created N days ago' for older local days", async () => {
      expect(formatRelativeCreated(localIso(2026, 6, 4, 12, 0))).toBe(
        "Created 2 days ago",
      );
      expect(formatRelativeCreated(localIso(2026, 5, 30, 12, 0))).toBe(
        "Created 6 days ago",
      );
    });

    it("treats a future created date as 'Created today'", async () => {
      // Guards the ago <= 0 branch: a clock-skewed future timestamp reads today.
      expect(formatRelativeCreated(localIso(2026, 6, 7, 0, 1))).toBe(
        "Created today",
      );
    });

    it("returns an empty string for missing or invalid input", async () => {
      expect(formatRelativeCreated(null)).toBe("");
      expect(formatRelativeCreated(undefined)).toBe("");
      expect(formatRelativeCreated("")).toBe("");
      expect(formatRelativeCreated("not-a-date")).toBe("");
    });
  });

  describe("formatRelativeDue — date only (no dueTime)", () => {
    it("reads 'Due today' for a due date on today's UTC calendar day", async () => {
      expect(formatRelativeDue(dueIso(2026, 6, 6))).toBe("Due today");
    });

    it("reads 'Due tomorrow' for the next UTC calendar day", async () => {
      expect(formatRelativeDue(dueIso(2026, 6, 7))).toBe("Due tomorrow");
    });

    it("reads 'Due in N days' for later UTC calendar days", async () => {
      expect(formatRelativeDue(dueIso(2026, 6, 8))).toBe("Due in 2 days");
      expect(formatRelativeDue(dueIso(2026, 6, 13))).toBe("Due in 7 days");
    });

    it("reads 'Overdue by 1 day' for yesterday (singular)", async () => {
      expect(formatRelativeDue(dueIso(2026, 6, 5))).toBe("Overdue by 1 day");
    });

    it("reads 'Overdue by N days' for older UTC calendar days (plural)", async () => {
      expect(formatRelativeDue(dueIso(2026, 6, 4))).toBe("Overdue by 2 days");
      expect(formatRelativeDue(dueIso(2026, 5, 29))).toBe("Overdue by 7 days");
    });

    it("returns an empty string for missing or invalid input", async () => {
      expect(formatRelativeDue(null)).toBe("");
      expect(formatRelativeDue(undefined)).toBe("");
      expect(formatRelativeDue("")).toBe("");
      expect(formatRelativeDue("not-a-date")).toBe("");
    });

    it("treats a cleared time (empty string, null, or omitted) identically", async () => {
      expect(formatRelativeDue(dueIso(2026, 6, 6), "")).toBe("Due today");
      expect(formatRelativeDue(dueIso(2026, 6, 6), null)).toBe("Due today");
      expect(formatRelativeDue(dueIso(2026, 6, 6))).toBe("Due today");
    });

    it("never shifts a UTC-midnight due date for a viewer behind UTC", async () => {
      vi.stubEnv("TZ", "America/New_York");
      vi.setSystemTime(new Date(2026, 6, 6, 10, 0, 0, 0));
      expect(formatRelativeDue(dueIso(2026, 6, 6))).toBe("Due today");
    });
  });

  describe("formatRelativeDue — date + time", () => {
    it("appends the formatted time to 'Due today' when the time has not passed", async () => {
      // "now" is local noon; 3:30pm is still ahead.
      expect(formatRelativeDue(dueIso(2026, 6, 6), "15:30")).toBe(
        "Due today at 3:30 PM",
      );
    });

    it("reads 'Overdue today' once the same-day due time has passed", async () => {
      // "now" is local noon; 9:00am has already passed.
      expect(formatRelativeDue(dueIso(2026, 6, 6), "09:00")).toBe(
        "Overdue today at 9:00 AM",
      );
    });

    it("appends the time to 'Due tomorrow' regardless of the current clock", async () => {
      expect(formatRelativeDue(dueIso(2026, 6, 7), "08:00")).toBe(
        "Due tomorrow at 8:00 AM",
      );
    });

    it("appends the time to 'Due in N days'", async () => {
      expect(formatRelativeDue(dueIso(2026, 6, 8), "17:00")).toBe(
        "Due in 2 days at 5:00 PM",
      );
    });

    it("appends the time to an overdue (past-day) label", async () => {
      expect(formatRelativeDue(dueIso(2026, 6, 5), "10:00")).toBe(
        "Overdue by 1 day at 10:00 AM",
      );
      expect(formatRelativeDue(dueIso(2026, 6, 4), "14:15")).toBe(
        "Overdue by 2 days at 2:15 PM",
      );
    });

    it("ignores a dueTime when there is no due date at all", async () => {
      expect(formatRelativeDue(null, "15:30")).toBe("");
      expect(formatRelativeDue(undefined, "15:30")).toBe("");
    });
  });

  describe("formatDueDateOnly / formatDueDate", () => {
    it("formats a UTC-midnight due date as an absolute calendar string", async () => {
      expect(formatDueDateOnly(dueIso(2026, 6, 29))).toBe("07/29/2026");
    });

    it("returns an em dash for missing or invalid input", async () => {
      expect(formatDueDateOnly(null)).toBe("—");
      expect(formatDueDateOnly(undefined)).toBe("—");
      expect(formatDueDateOnly("not-a-date")).toBe("—");
    });

    it("appends the formatted time when present", async () => {
      expect(formatDueDate(dueIso(2026, 6, 29), "15:30")).toBe(
        "07/29/2026 at 3:30 PM",
      );
    });

    it("omits the time suffix when the time is cleared or absent", async () => {
      expect(formatDueDate(dueIso(2026, 6, 29), null)).toBe("07/29/2026");
      expect(formatDueDate(dueIso(2026, 6, 29), "")).toBe("07/29/2026");
      expect(formatDueDate(dueIso(2026, 6, 29))).toBe("07/29/2026");
    });

    it("returns an em dash (never a wrong day) when there is no due date, even with a time", async () => {
      expect(formatDueDate(null, "15:30")).toBe("—");
    });

    it("never shifts the calendar day for a viewer outside UTC", async () => {
      vi.stubEnv("TZ", "America/New_York");
      expect(formatDueDateOnly(dueIso(2026, 6, 29))).toBe("07/29/2026");
      vi.stubEnv("TZ", "Pacific/Auckland");
      expect(formatDueDateOnly(dueIso(2026, 6, 29))).toBe("07/29/2026");
    });
  });
});
