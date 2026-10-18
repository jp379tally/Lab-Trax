/** @vitest-environment jsdom */
/**
 * Unit tests for the excluded-days helpers used by the Stats page tooltip.
 *
 * Coverage:
 *   - formatExcludedDate: UTC-based rendering, cross-year dates, timezone safety
 *   - buildExcludedDaysTooltip: null/zero guards, holiday name resolution,
 *     "Closed day" label, sorting across multiple years, mixed reason types,
 *     empty dates array, singular vs. plural grammar
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import {
  buildExcludedDaysTooltip,
  formatExcludedDate,
} from "@/lib/stats-excluded-days";

// ── formatExcludedDate ────────────────────────────────────────────────────────

describe("formatExcludedDate", () => {
  it("formats common dates in zero-padded MM/DD numeric style", () => {
    expect(formatExcludedDate("2026-01-01")).toBe("01/01");
    expect(formatExcludedDate("2025-12-25")).toBe("12/25");
    expect(formatExcludedDate("2024-07-04")).toBe("07/04");
    expect(formatExcludedDate("2025-11-27")).toBe("11/27");
    expect(formatExcludedDate("2026-03-20")).toBe("03/20");
  });

  it("keeps Dec 31 as 12/31 (UTC, not shifted by negative timezone offset)", () => {
    expect(formatExcludedDate("2025-12-31")).toBe("12/31");
  });

  it("keeps Jan 1 as 01/01 (UTC, not shifted by positive timezone offset)", () => {
    expect(formatExcludedDate("2026-01-01")).toBe("01/01");
  });

  it("handles a date in the second year of a multi-year span correctly", () => {
    expect(formatExcludedDate("2026-07-04")).toBe("07/04");
    expect(formatExcludedDate("2025-01-20")).toBe("01/20");
  });
});

// ── buildExcludedDaysTooltip ──────────────────────────────────────────────────

describe("buildExcludedDaysTooltip", () => {
  it("returns undefined for null input", () => {
    expect(buildExcludedDaysTooltip(null)).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(buildExcludedDaysTooltip(undefined)).toBeUndefined();
  });

  it("returns undefined when both counts are zero (no tooltip trigger)", () => {
    expect(
      buildExcludedDaysTooltip({
        holidayCount: 0,
        customClosedCount: 0,
        dates: [],
      }),
    ).toBeUndefined();
  });

  it("resolves holiday names from usHolidayNameMap for reason='holiday'", () => {
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 1,
        customClosedCount: 0,
        dates: [{ date: "2026-01-01", reason: "holiday" }],
      }) as React.ReactElement,
    );
    expect(container.textContent).toContain("01/01");
    expect(container.textContent).toContain("New Year's Day");
    expect(container.textContent).not.toContain("Closed day");
  });

  it("renders 'Closed day' label for reason='custom'", () => {
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 0,
        customClosedCount: 1,
        dates: [{ date: "2026-03-15", reason: "custom" }],
      }) as React.ReactElement,
    );
    expect(container.textContent).toContain("03/15");
    expect(container.textContent).toContain("Closed day");
    expect(container.textContent).not.toContain("US holiday");
  });

  it("renders both holiday names and Closed day labels in a mixed list", () => {
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 1,
        customClosedCount: 1,
        dates: [
          { date: "2025-12-25", reason: "holiday" },
          { date: "2026-03-20", reason: "custom" },
        ],
      }) as React.ReactElement,
    );
    expect(container.textContent).toContain("12/25");
    expect(container.textContent).toContain("Christmas Day");
    expect(container.textContent).toContain("03/20");
    expect(container.textContent).toContain("Closed day");
  });

  it("sorts dates chronologically across multiple years (earlier year first)", () => {
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 2,
        customClosedCount: 1,
        dates: [
          { date: "2026-07-04", reason: "holiday" },
          { date: "2025-11-27", reason: "holiday" },
          { date: "2026-01-15", reason: "custom" },
        ],
      }) as React.ReactElement,
    );
    const text = container.textContent ?? "";
    const posNov = text.indexOf("11/27");
    const posJan = text.indexOf("01/15");
    const posJul = text.indexOf("07/04");
    expect(posNov).toBeGreaterThanOrEqual(0);
    expect(posJan).toBeGreaterThanOrEqual(0);
    expect(posJul).toBeGreaterThanOrEqual(0);
    // 11/27 (2025) → 01/15 (2026) → 07/04 (2026)
    expect(posNov).toBeLessThan(posJan);
    expect(posJan).toBeLessThan(posJul);
  });

  it("falls back to 'US holiday' when the date doesn't match a known federal holiday", () => {
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 1,
        customClosedCount: 0,
        dates: [{ date: "2026-06-15", reason: "holiday" }],
      }) as React.ReactElement,
    );
    expect(container.textContent).toContain("06/15");
    expect(container.textContent).toContain("US holiday");
  });

  it("resolves holiday names from both years when dates span two calendar years", () => {
    // Use dates that land on weekdays so the observed-date key matches
    // the raw date:
    //   2025-12-25 = Thursday → Christmas Day key = "2025-12-25"
    //   2026-01-01 = Thursday → New Year's Day key = "2026-01-01"
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 2,
        customClosedCount: 0,
        dates: [
          { date: "2025-12-25", reason: "holiday" },
          { date: "2026-01-01", reason: "holiday" },
        ],
      }) as React.ReactElement,
    );
    expect(container.textContent).toContain("Christmas Day");
    expect(container.textContent).toContain("New Year's Day");
  });

  it("uses singular grammar for a count of 1", () => {
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 1,
        customClosedCount: 1,
        dates: [
          { date: "2026-01-01", reason: "holiday" },
          { date: "2026-03-01", reason: "custom" },
        ],
      }) as React.ReactElement,
    );
    expect(container.textContent).toContain("1 US federal holiday");
    expect(container.textContent).toContain("1 custom closed day");
    expect(container.textContent).not.toContain("1 US federal holidays");
    expect(container.textContent).not.toContain("1 custom closed days");
  });

  it("uses plural grammar for counts > 1", () => {
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 3,
        customClosedCount: 2,
        dates: [],
      }) as React.ReactElement,
    );
    expect(container.textContent).toContain("3 US federal holidays");
    expect(container.textContent).toContain("2 custom closed days");
  });

  it("renders the denominator description even when dates array is empty", () => {
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 2,
        customClosedCount: 0,
        dates: [],
      }) as React.ReactElement,
    );
    expect(container.textContent).toContain(
      "Denominator excludes 2 US federal holidays from the business-day count.",
    );
    expect(container.textContent).not.toContain("Closed day");
  });

  it("renders only the holiday part of the summary when customClosedCount is 0", () => {
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 2,
        customClosedCount: 0,
        dates: [],
      }) as React.ReactElement,
    );
    expect(container.textContent).not.toContain("custom closed");
  });

  it("renders only the custom part of the summary when holidayCount is 0", () => {
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 0,
        customClosedCount: 3,
        dates: [],
      }) as React.ReactElement,
    );
    expect(container.textContent).not.toContain("US federal");
    expect(container.textContent).toContain("3 custom closed days");
  });

  it("resolves Thanksgiving Day for the correct date", () => {
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 1,
        customClosedCount: 0,
        dates: [{ date: "2026-11-26", reason: "holiday" }],
      }) as React.ReactElement,
    );
    expect(container.textContent).toContain("11/26");
    expect(container.textContent).toContain("Thanksgiving Day");
  });

  it("resolves MLK Jr. Day for the correct date", () => {
    const { container } = render(
      buildExcludedDaysTooltip({
        holidayCount: 1,
        customClosedCount: 0,
        dates: [{ date: "2026-01-19", reason: "holiday" }],
      }) as React.ReactElement,
    );
    expect(container.textContent).toContain("01/19");
    expect(container.textContent).toContain("MLK Jr. Day");
  });
});
