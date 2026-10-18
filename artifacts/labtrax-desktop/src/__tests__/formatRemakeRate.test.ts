// Unit tests for the formatRemakeRate helper in stats.tsx.
// Pins the edge-case display rules so regressions are caught before shipping.
import { describe, it, expect } from "vitest";
import { formatRemakeRate } from "@/components/reports/StatsTab";

describe("formatRemakeRate", () => {
  it('returns "—" when totalCases is 0 (avoids division by zero)', () => {
    expect(formatRemakeRate(0, 0)).toBe("—");
    expect(formatRemakeRate(5, 0)).toBe("—");
  });

  it('returns "0.0%" when there are cases but no remakes', () => {
    expect(formatRemakeRate(0, 200)).toBe("0.0%");
  });

  it('returns "< 0.1%" for tiny non-zero rates below the display threshold', () => {
    expect(formatRemakeRate(1, 2000)).toBe("< 0.1%");
    expect(formatRemakeRate(1, 1001)).toBe("< 0.1%");
  });

  it("returns a normal percentage string for rates >= 0.1%", () => {
    expect(formatRemakeRate(1, 100)).toBe("1.0%");
    expect(formatRemakeRate(5, 200)).toBe("2.5%");
    expect(formatRemakeRate(10, 100)).toBe("10.0%");
  });

  it("rounds the rate to one decimal place", () => {
    expect(formatRemakeRate(1, 300)).toBe("0.3%");
    expect(formatRemakeRate(2, 300)).toBe("0.7%");
  });

  it('returns "0.1%" at the exact threshold (1/1000 = 0.1%, not "< 0.1%")', () => {
    expect(formatRemakeRate(1, 1000)).toBe("0.1%");
  });
});
