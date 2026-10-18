import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { formatDueDate, formatShortDueDate, isDueToday, isPastDue } from "@/lib/format";

// The plain locale formatters (formatDate / formatShortDate) render in the
// viewer's local timezone, so a UTC-midnight timestamp shifts back a day for
// anyone west of UTC. The due-date helpers anchor + format in UTC, so the
// displayed day always equals the picked day regardless of the host timezone.
describe("formatDueDate (day-stable)", () => {
  it("keeps a YYYY-MM-DD value on the picked day", () => {
    expect(formatDueDate("2026-06-25")).toBe("06/25/2026");
  });

  it("keeps a UTC-midnight timestamp on the stored day", () => {
    expect(formatDueDate("2026-06-25T00:00:00.000Z")).toBe("06/25/2026");
  });

  it("round-trips: picked string and its stored timestamp render identically", () => {
    expect(formatDueDate("2026-01-01")).toBe(
      formatDueDate("2026-01-01T00:00:00.000Z"),
    );
    expect(formatDueDate("2026-12-31")).toBe(
      formatDueDate("2026-12-31T00:00:00.000Z"),
    );
  });

  it("renders an em dash for empty/invalid input", () => {
    expect(formatDueDate(null)).toBe("—");
    expect(formatDueDate(undefined)).toBe("—");
    expect(formatDueDate("")).toBe("—");
    expect(formatDueDate("not-a-date")).toBe("—");
  });

  it("appends the due time when a valid HH:MM time is given", () => {
    expect(formatDueDate("2026-07-29", "15:30")).toBe("07/29/2026 at 3:30 PM");
  });

  it("formats midnight and noon boundaries correctly", () => {
    expect(formatDueDate("2026-06-25", "00:00")).toBe("06/25/2026 at 12:00 AM");
    expect(formatDueDate("2026-06-25", "12:00")).toBe("06/25/2026 at 12:00 PM");
  });

  it("pads single-digit minutes", () => {
    expect(formatDueDate("2026-06-25", "09:05")).toBe("06/25/2026 at 9:05 AM");
  });

  it("falls back to date-only when the time is missing or cleared", () => {
    expect(formatDueDate("2026-06-25", null)).toBe("06/25/2026");
    expect(formatDueDate("2026-06-25", undefined)).toBe("06/25/2026");
    expect(formatDueDate("2026-06-25", "")).toBe("06/25/2026");
  });

  it("falls back to date-only when the time is invalid", () => {
    expect(formatDueDate("2026-06-25", "not-a-time")).toBe("06/25/2026");
    expect(formatDueDate("2026-06-25", "25:99")).toBe("06/25/2026");
  });
});

describe("formatShortDueDate (day-stable)", () => {
  it("keeps a YYYY-MM-DD value on the picked day", () => {
    expect(formatShortDueDate("2026-06-25")).toBe("06/25/2026");
  });

  it("keeps a UTC-midnight timestamp on the stored day", () => {
    expect(formatShortDueDate("2026-06-25T00:00:00.000Z")).toBe("06/25/2026");
  });

  it("renders an em dash for empty/invalid input", () => {
    expect(formatShortDueDate(null)).toBe("—");
    expect(formatShortDueDate("nope")).toBe("—");
  });

  it("appends the due time when a valid HH:MM time is given", () => {
    expect(formatShortDueDate("2026-07-29", "15:30")).toBe("07/29/2026 at 3:30 PM");
  });

  it("falls back to date-only when the time is missing, cleared, or invalid", () => {
    expect(formatShortDueDate("2026-06-25", null)).toBe("06/25/2026");
    expect(formatShortDueDate("2026-06-25", "")).toBe("06/25/2026");
    expect(formatShortDueDate("2026-06-25", "bogus")).toBe("06/25/2026");
  });
});

describe("isDueToday (day-stable)", () => {
  // Build today's local calendar day, then express it both as a bare
  // YYYY-MM-DD (what the date picker emits) and as the UTC-midnight timestamp
  // (what the server stores). Both must classify as "due today" regardless of
  // the host timezone — that equivalence is the off-by-one guarantee.
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const todayKey = `${yyyy}-${mm}-${dd}`;

  it("treats today's calendar day as due today (YYYY-MM-DD)", () => {
    expect(isDueToday(todayKey)).toBe(true);
  });

  it("treats today's UTC-midnight timestamp as due today", () => {
    expect(isDueToday(`${todayKey}T00:00:00.000Z`)).toBe(true);
  });

  it("does not treat other days as due today", () => {
    expect(isDueToday("2000-01-01")).toBe(false);
    expect(isDueToday("2000-01-01T00:00:00.000Z")).toBe(false);
  });

  it("is false for empty/invalid input", () => {
    expect(isDueToday(null)).toBe(false);
    expect(isDueToday("")).toBe(false);
    expect(isDueToday("nope")).toBe(false);
  });
});

describe("isPastDue (time-aware)", () => {
  // Pin "now" to local noon so times earlier and later today stay comparable
  // with the local calendar date in every configured test timezone.
  const TODAY = new Date(2026, 6, 20, 12).toISOString();
  const TODAY_DATE = "2026-07-20";
  const PAST_DATE = "2026-01-01";
  const FUTURE_DATE = "2026-12-31";

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("is overdue when due today at a time earlier than now", () => {
    expect(isPastDue(TODAY_DATE, "08:00")).toBe(true);
  });

  it("is NOT overdue when due today at a time later than now", () => {
    expect(isPastDue(TODAY_DATE, "18:00")).toBe(false);
  });

  it("is NOT overdue when due today with no time set (unchanged end-of-day behavior)", () => {
    expect(isPastDue(TODAY_DATE)).toBe(false);
    expect(isPastDue(TODAY_DATE, null)).toBe(false);
    expect(isPastDue(TODAY_DATE, undefined)).toBe(false);
  });

  it("is NOT overdue when due today with a cleared/invalid time", () => {
    expect(isPastDue(TODAY_DATE, "")).toBe(false);
    expect(isPastDue(TODAY_DATE, "not-a-time")).toBe(false);
    expect(isPastDue(TODAY_DATE, "25:99")).toBe(false);
  });

  it("is overdue for a past day regardless of time", () => {
    expect(isPastDue(PAST_DATE)).toBe(true);
    expect(isPastDue(PAST_DATE, "23:59")).toBe(true);
  });

  it("is NOT overdue for a future day regardless of time", () => {
    expect(isPastDue(FUTURE_DATE)).toBe(false);
    expect(isPastDue(FUTURE_DATE, "00:01")).toBe(false);
  });

  it("is false for empty/invalid due date input", () => {
    expect(isPastDue(null)).toBe(false);
    expect(isPastDue("")).toBe(false);
    expect(isPastDue("nope")).toBe(false);
  });
});
