import { describe, expect, it } from "vitest";
import { isValidDueTime, resolveCaseDueDate } from "./case-due-date";

describe("resolveCaseDueDate", () => {
  const entry = new Date("2025-01-01T00:00:00.000Z");
  const turnaround5 = 5; // 5-day turnaround → cap at Jan 6
  const capDate = new Date("2025-01-06T00:00:00.000Z");
  const farFuture = new Date("2025-03-01T00:00:00.000Z");
  const nearFuture = new Date("2025-01-03T00:00:00.000Z");

  describe("cap=null (defaults to enabled) with turnaround set", () => {
    it("snaps a far-future supplied date down to the cap", () => {
      const result = resolveCaseDueDate(farFuture, entry, turnaround5, null);
      expect(result).toEqual(capDate);
    });

    it("leaves a date within the cap unchanged", () => {
      const result = resolveCaseDueDate(nearFuture, entry, turnaround5, null);
      expect(result).toEqual(nearFuture);
    });

    it("falls back to entry + turnaround when no date supplied", () => {
      const result = resolveCaseDueDate(null, entry, turnaround5, null);
      expect(result).toEqual(capDate);
    });
  });

  describe("cap=false (explicitly disabled) with turnaround set", () => {
    it("passes a far-future supplied date through unchanged", () => {
      const result = resolveCaseDueDate(farFuture, entry, turnaround5, false);
      expect(result).toEqual(farFuture);
    });

    it("still falls back to entry + turnaround when no date supplied", () => {
      const result = resolveCaseDueDate(null, entry, turnaround5, false);
      expect(result).toEqual(capDate);
    });
  });

  describe("cap=null (defaults to enabled) with NO turnaround set", () => {
    it("returns the supplied date as-is when turnaround is null", () => {
      const result = resolveCaseDueDate(farFuture, entry, null, null);
      expect(result).toEqual(farFuture);
    });

    it("returns null when neither a date nor a turnaround is supplied", () => {
      const result = resolveCaseDueDate(null, entry, null, null);
      expect(result).toBeNull();
    });
  });
});

describe("case due time validation", () => {
  it.each(["00:00", "09:30", "12:05", "23:59"])("accepts %s", (value) => {
    expect(isValidDueTime(value)).toBe(true);
  });

  it.each(["24:00", "25:00", "-1:00", "9:30", "14:5", "12:60", "12.30"])(
    "rejects %s",
    (value) => {
      expect(isValidDueTime(value)).toBe(false);
    },
  );
});