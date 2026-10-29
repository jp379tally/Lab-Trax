import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  isValidDueTime,
  resolveAiIntakePrescriptionDueDate,
  resolveCaseDueDate,
} from "./case-due-date";

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

describe("AI intake date window", () => {
  it("adds calendar days across month and year boundaries", () => {
    expect(addCalendarDays("2026-12-29", 7)).toBe("2027-01-05");
    expect(addCalendarDays("2026-02-25", 7)).toBe("2026-03-04");
  });

  it.each([
    ["before receipt", "2026-07-31", null],
    ["on receipt", "2026-08-01", "2026-08-01"],
    ["on the turnaround boundary", "2026-08-08", "2026-08-08"],
    ["after the turnaround boundary", "2026-08-09", null],
  ])("handles a prescription date %s", (_label, prescriptionDate, expected) => {
    expect(
      resolveAiIntakePrescriptionDueDate(prescriptionDate, "2026-08-01", 7),
    ).toBe(expected);
  });

  it("preserves a valid prescription date when no turnaround is configured", () => {
    expect(
      resolveAiIntakePrescriptionDueDate("2026-08-20", "2026-08-01", null),
    ).toBe("2026-08-20");
  });

  it("omits missing or invalid prescription and received dates when a turnaround applies", () => {
    expect(resolveAiIntakePrescriptionDueDate("", "2026-08-01", 7)).toBeNull();
    expect(
      resolveAiIntakePrescriptionDueDate("2026-08-08", "2026-02-31", 7),
    ).toBeNull();
    expect(
      resolveAiIntakePrescriptionDueDate("2026-02-31", "2026-08-01", 7),
    ).toBeNull();
  });
});