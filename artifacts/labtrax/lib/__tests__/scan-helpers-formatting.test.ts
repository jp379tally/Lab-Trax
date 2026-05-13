import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getActivityIcon,
  formatActivityTimestamp,
} from "../scan-helpers";

describe("getActivityIcon", () => {
  it.each([
    ["photo", "camera"],
    ["scan", "scan"],
    ["note", "document-text"],
    ["station_change", "swap-horizontal"],
    ["created", "add-circle"],
  ] as const)("maps %s to icon %s", (type, expected) => {
    expect(getActivityIcon(type).name).toBe(expected);
  });

  it("falls back to ellipse for unknown activity types", () => {
    expect(getActivityIcon("future_kind_we_have_not_added_yet").name).toBe(
      "ellipse"
    );
  });

  it("always returns a non-empty colour string", () => {
    for (const type of [
      "photo",
      "scan",
      "note",
      "station_change",
      "created",
      "courtesy_text",
    ]) {
      expect(getActivityIcon(type).color).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });
});

describe("formatActivityTimestamp", () => {
  // Use a fixed UTC instant and pin TZ to UTC for the assertion to be stable
  // across CI and dev machines.
  const ORIGINAL_TZ = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = "UTC";
  });

  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  it("formats a morning timestamp with AM and a stripped leading zero on the hour", () => {
    expect(
      formatActivityTimestamp(new Date("2024-03-15T09:05:00Z").getTime())
    ).toBe("Mar 15, 9:05 AM");
  });

  it("formats noon as 12 PM (not 0 PM)", () => {
    expect(
      formatActivityTimestamp(new Date("2024-03-15T12:00:00Z").getTime())
    ).toBe("Mar 15, 12:00 PM");
  });

  it("formats midnight as 12 AM", () => {
    expect(
      formatActivityTimestamp(new Date("2024-03-15T00:00:00Z").getTime())
    ).toBe("Mar 15, 12:00 AM");
  });

  it("zero-pads single-digit minutes", () => {
    expect(
      formatActivityTimestamp(new Date("2024-03-15T15:07:00Z").getTime())
    ).toBe("Mar 15, 3:07 PM");
  });
});
