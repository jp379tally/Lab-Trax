import { afterEach, describe, expect, it } from "vitest";
import {
  calendarDateToUtcNoon,
  addCalendarDays,
  formatCalendarDate,
  getLocalCalendarDateParts,
  isCalendarDateInInclusiveRange,
  isMoreThanCalendarDaysAgo,
  isValidCalendarDate,
  parseCalendarDate,
  parseRangeDate,
  resolveAiIntakePrescriptionDueDate,
  rangeDateError,
  rangeMonthDays,
  rangeCalendarMonth,
} from "./index";

const originalTimezone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimezone;
});

describe("@workspace/calendar-date", () => {
  it("adds calendar days and preserves inclusive turnaround boundaries", () => {
    expect(addCalendarDays("2026-12-29", 7)).toBe("2027-01-05");
    expect(addCalendarDays("0001-12-29", 7)).toBe("0002-01-05");
    expect(addCalendarDays("2026-02-30", 7)).toBeNull();
    expect(addCalendarDays("2026-08-01", 1.5)).toBeNull();
    expect(isCalendarDateInInclusiveRange("2026-08-08", "2026-08-01", "2026-08-08")).toBe(true);
    expect(isCalendarDateInInclusiveRange("2026-08-09", "2026-08-01", "2026-08-08")).toBe(false);
    expect(resolveAiIntakePrescriptionDueDate("2026-08-01", "2026-08-01", 7)).toBe("2026-08-01");
    expect(resolveAiIntakePrescriptionDueDate("2026-08-08", "2026-08-01", 7)).toBe("2026-08-08");
    expect(resolveAiIntakePrescriptionDueDate("2026-08-09", "2026-08-01", 7)).toBeNull();
    expect(resolveAiIntakePrescriptionDueDate("2026-08-09", null, null)).toBe("2026-08-09");
  });

  it("keeps explicit small years and normalizes month navigation locally", () => {
    expect(parseRangeDate("5/5/0001")).toBe("0001-05-05");
    const month = rangeCalendarMonth(1, 4);
    expect(month.getFullYear()).toBe(1);
    expect(month.getMonth()).toBe(4);
    const previous = rangeCalendarMonth(2026, -1);
    expect(previous.getFullYear()).toBe(2025);
    expect(previous.getMonth()).toBe(11);
    expect(previous.getHours()).toBe(0);
  });
  it("normalizes shorthand using the local year at entry and preserves explicit years", () => {
    expect(formatCalendarDate(parseRangeDate("5/5", new Date(2031, 0, 1))!)).toBe("05/05/2031");
    expect(parseRangeDate("5/10", new Date(2032, 11, 31))).toBe("2032-05-10");
    expect(parseRangeDate("5/5/2025", new Date(2031, 0, 1))).toBe("2025-05-05");
    expect(parseRangeDate("2/29", new Date(2028, 0, 1))).toBe("2028-02-29");
  });
  it.each(["2/30/2028", "2/29/2027", "13/1", "0/5", "4/31", "5/0", "5/5/25", "5/5/0000", "2026-02-30", ""])("rejects range rollover and incomplete input %s", value => {
    expect(parseRangeDate(value, new Date(2026, 0, 1))).toBeNull();
  });
  it("validates complete inclusive ranges and creates a correct leap-month grid", () => {
    expect(rangeDateError("2026-05-05", "2026-05-05")).toBeNull();
    expect(rangeDateError("2026-05-10", "2026-05-05")).toContain("on or after");
    expect(rangeDateError("2026-05-05", null)).toContain("End date");
    const days = rangeMonthDays(2028, 1);
    expect(days).toHaveLength(42);
    expect(days.filter(Boolean)).toHaveLength(29);
    expect(days[2]).toBe("2028-02-01");
  });
  it.each([
    ["Etc/GMT+12", "UTC-12"],
    ["Pacific/Kiritimati", "UTC+14"],
  ])("keeps the exact calendar day in %s (%s)", (timezone) => {
    process.env.TZ = timezone;
    const value = "2026-01-02";

    expect(parseCalendarDate(value)).toEqual({ year: 2026, month: 1, day: 2 });
    expect(isValidCalendarDate(value)).toBe(true);
    expect(formatCalendarDate(value)).toBe("01/02/2026");
    expect(calendarDateToUtcNoon(value).toISOString()).toBe(
      "2026-01-02T12:00:00.000Z",
    );
  });

  it.each(["2026-02-29", "2026-13-01", "2026-01-02T00:00:00Z", "01/02/2026"])(
    "rejects invalid or non-calendar input %s",
    (value) => {
      expect(parseCalendarDate(value)).toBeNull();
      expect(isValidCalendarDate(value)).toBe(false);
      expect(formatCalendarDate(value)).toBeNull();
      expect(() => calendarDateToUtcNoon(value)).toThrow(RangeError);
    },
  );

  it("accepts leap days", () => {
    expect(isValidCalendarDate("2028-02-29")).toBe(true);
  });

  it("preserves four-digit years below 0100", () => {
    expect(parseCalendarDate("0001-01-02")).toEqual({
      year: 1,
      month: 1,
      day: 2,
    });
    expect(formatCalendarDate("0001-01-02")).toBe("01/02/0001");
    expect(calendarDateToUtcNoon("0001-01-02").toISOString()).toBe(
      "0001-01-02T12:00:00.000Z",
    );
  });

  describe("calendar-day age", () => {
    const today = { year: 2026, month: 7, day: 20 };

    it.each([
      ["six days", "2026-07-14", false],
      ["exactly seven days", "2026-07-13", false],
      ["eight days", "2026-07-12", true],
    ])("uses a strict seven-day boundary for %s", (_label, receivedAt, expected) => {
      expect(isMoreThanCalendarDaysAgo(receivedAt, 7, today)).toBe(expected);
    });

    it("counts weekends as ordinary calendar days", () => {
      expect(isMoreThanCalendarDaysAgo("2026-07-18", 1, today)).toBe(true);
      expect(isMoreThanCalendarDaysAgo("2026-07-19", 1, today)).toBe(false);
    });

    it.each([
      ["Etc/GMT+12", "2026-01-10", "2026-01-02T12:00:00.000Z", true],
      ["Pacific/Kiritimati", "2026-01-10", "2026-01-02T12:00:00.000Z", false],
    ])(
      "keeps date-only values stable and maps legacy timestamps to local days in %s",
      (timezone, todayText, timestamp, timestampExpected) => {
        process.env.TZ = timezone;
        const todayParts = parseCalendarDate(todayText)!;

        expect(isMoreThanCalendarDaysAgo("2026-01-02", 7, todayParts)).toBe(true);
        expect(isMoreThanCalendarDaysAgo(timestamp, 7, todayParts)).toBe(
          timestampExpected,
        );
      },
    );

    it("uses calendar days rather than elapsed hours across daylight-saving changes", () => {
      process.env.TZ = "America/New_York";
      const localToday = getLocalCalendarDateParts(
        new Date(2026, 2, 15, 12, 0, 0),
      );
      const localReceivedAt = new Date(
        2026,
        2,
        7,
        12,
        0,
        0,
      ).toISOString();

      expect(localToday).toEqual({ year: 2026, month: 3, day: 15 });
      expect(isMoreThanCalendarDaysAgo(localReceivedAt, 7, localToday)).toBe(
        true,
      );
    });

    it.each([
      null,
      undefined,
      "",
      "not-a-date",
      "2026-02-30",
      "2026-07-19T99:00:00Z",
    ])("rejects missing or invalid received dates: %s", (receivedAt) => {
      expect(isMoreThanCalendarDaysAgo(receivedAt, 7, today)).toBe(false);
    });

    it("does not treat a future received date as old", () => {
      expect(isMoreThanCalendarDaysAgo("2026-07-21", 7, today)).toBe(false);
    });
  });
});