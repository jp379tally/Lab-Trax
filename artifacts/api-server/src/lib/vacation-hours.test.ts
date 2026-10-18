import { describe, it, expect } from "vitest";
import { calculateRequestedHours } from "./vacation-hours";

describe("calculateRequestedHours", () => {
  it("all-day = 8 h per day", () => {
    expect(
      calculateRequestedHours([
        { isAllDay: true },
        { isAllDay: true },
      ])
    ).toBe(16);
  });

  it("custom range: raw hours difference", () => {
    expect(
      calculateRequestedHours([
        { isAllDay: false, startTime: "09:00", endTime: "13:30" },
      ])
    ).toBe(4.5);
  });

  it("mixed: all-day + custom range", () => {
    expect(
      calculateRequestedHours([
        { isAllDay: true },
        { isAllDay: false, startTime: "08:00", endTime: "12:00" },
      ])
    ).toBe(12);
  });

  it("throws when endTime <= startTime (equal)", () => {
    expect(() =>
      calculateRequestedHours([
        { isAllDay: false, startTime: "09:00", endTime: "09:00" },
      ])
    ).toThrow("must be after startTime");
  });

  it("throws when endTime < startTime", () => {
    expect(() =>
      calculateRequestedHours([
        { isAllDay: false, startTime: "14:00", endTime: "09:00" },
      ])
    ).toThrow("must be after startTime");
  });

  it("throws when startTime missing on custom day", () => {
    expect(() =>
      calculateRequestedHours([{ isAllDay: false }])
    ).toThrow("startTime and endTime are required");
  });

  it("throws with no days", () => {
    expect(() => calculateRequestedHours([])).toThrow(
      "At least one day is required"
    );
  });
});
