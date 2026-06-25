import { describe, it, expect } from "vitest";
import { formatDueDate, formatShortDueDate, isDueToday } from "@/lib/format";

// The plain locale formatters (formatDate / formatShortDate) render in the
// viewer's local timezone, so a UTC-midnight timestamp shifts back a day for
// anyone west of UTC. The due-date helpers anchor + format in UTC, so the
// displayed day always equals the picked day regardless of the host timezone.
describe("formatDueDate (day-stable)", () => {
  it("keeps a YYYY-MM-DD value on the picked day", () => {
    expect(formatDueDate("2026-06-25")).toBe("Jun 25, 2026");
  });

  it("keeps a UTC-midnight timestamp on the stored day", () => {
    expect(formatDueDate("2026-06-25T00:00:00.000Z")).toBe("Jun 25, 2026");
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
