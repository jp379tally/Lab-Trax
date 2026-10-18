import { describe, expect, it } from "vitest";
import { analyticsQueryString, defaultAnalyticsRange, isValidRange, statusSlices } from "../register-analytics";

describe("register analytics helpers", () => {
  it("defaults to the last 30 calendar days inclusive", () => {
    expect(defaultAnalyticsRange(new Date(2026, 8, 30))).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(defaultAnalyticsRange(new Date(2026, 2, 5))).toEqual({ from: "2026-02-04", to: "2026-03-05" });
  });
  it("validates ranges", () => {
    expect(isValidRange("2026-09-01", "2026-09-30")).toBe(true);
    expect(isValidRange("2026-10-01", "2026-09-30")).toBe(false);
    expect(isValidRange("", "2026-09-30")).toBe(false);
    expect(isValidRange("2026-02-30", "2026-03-05")).toBe(false);
    expect(isValidRange("2025-09-30", "2026-09-30")).toBe(true);
    expect(isValidRange("2025-09-29", "2026-09-30")).toBe(false);
  });
  it("builds the endpoint query", () => {
    const q = new URLSearchParams(analyticsQueryString({ organizationId: "o", accountId: "a", from: "2026-09-01", to: "2026-09-30" }));
    expect(q.get("bankAccountId")).toBe("a");
    expect(q.get("dateFrom")).toBe("2026-09-01");
  });
  it("computes status percentages and handles zero", () => {
    const s = statusSlices({ postedCleared: 24, postedUncleared: 0, voided: 1, pending: 2 });
    expect(s[0].pct).toBe("88.9%");
    expect(statusSlices({ postedCleared: 0, postedUncleared: 0, voided: 0, pending: 0 })[0].pct).toBe("0.0%");
  });
});
