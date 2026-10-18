import { afterEach, describe, it, expect, vi } from "vitest";
import { TODAY_SALES_ROUTE, customRange, rangeForPreset } from "../sales-range";

describe("sales-range", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("today route is the reports preset, not the financial tab", () => {
    expect(TODAY_SALES_ROUTE).toBe("/manage/reports?preset=today");
  });
  it("today uses local inclusive day bounds", () => {
    const now = new Date(2025, 2, 5, 14, 30);
    const r = rangeForPreset("today", now);
    expect(new Date(r.dateFrom).getTime()).toBe(new Date(2025, 2, 5, 0, 0, 0, 0).getTime());
    expect(new Date(r.dateTo).getTime()).toBe(new Date(2025, 2, 5, 23, 59, 59, 999).getTime());
  });
  it("week starts Monday", () => {
    const r = rangeForPreset("week", new Date(2025, 2, 5));
    expect(new Date(r.dateFrom).getDate()).toBe(3);
  });
  it("validates custom dates", () => {
    expect("error" in customRange("2025-02-30", "2025-03-01")).toBe(true);
    expect("error" in customRange("2025-03-05", "2025-03-01")).toBe(true);
    expect("range" in customRange("2025-03-01", "2025-03-05")).toBe(true);
  });
  it("keeps Pacific local Today correct across UTC rollover and a DST day", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const lateLocal = rangeForPreset("today", new Date("2024-03-11T06:30:00Z"));
    expect(lateLocal).toEqual({
      dateFrom: "2024-03-10T08:00:00.000Z",
      dateTo: "2024-03-11T06:59:59.999Z",
    });
    expect(new Date(lateLocal.dateTo).getTime() - new Date(lateLocal.dateFrom).getTime() + 1).toBe(23 * 60 * 60 * 1000);
  });
});
