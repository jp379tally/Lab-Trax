/** @vitest-environment jsdom */
// Shared top-of-column total helper: safe summing of possibly-null/string
// amounts and the ColumnTotal header cell that renders the formatted sum
// (or a placeholder while loading, so a stale sum is never shown).
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ColumnTotal, sumAmounts } from "@/components/ColumnTotal";

describe("sumAmounts", () => {
  it("returns 0 for an empty list", () => {
    expect(sumAmounts([])).toBe(0);
  });

  it("sums plain numbers", () => {
    expect(sumAmounts([10, 20.5, 0.25])).toBeCloseTo(30.75);
  });

  it("parses numeric strings (API money values are strings)", () => {
    expect(sumAmounts(["450.00", "100.50"])).toBeCloseTo(550.5);
  });

  it("treats null and undefined as 0", () => {
    expect(sumAmounts([null, undefined, 5])).toBe(5);
  });

  it("includes negative amounts (credits)", () => {
    expect(sumAmounts([100, -25.5])).toBeCloseTo(74.5);
  });

  it("ignores non-numeric strings instead of producing NaN", () => {
    expect(sumAmounts(["abc", 10])).toBe(10);
  });

  it("mixes numbers, strings, and nulls", () => {
    expect(sumAmounts(["1.25", 2, null, "-0.25", undefined])).toBeCloseTo(3);
  });
});

describe("ColumnTotal", () => {
  it("renders the formatted sum of its values", () => {
    render(
      <ColumnTotal values={["450.00", 100, null]} testId="column-total-x" />,
    );
    expect(screen.getByTestId("column-total-x").textContent).toBe("$550.00");
  });

  it("renders $0.00 for an empty list", () => {
    render(<ColumnTotal values={[]} testId="column-total-x" />);
    expect(screen.getByTestId("column-total-x").textContent).toBe("$0.00");
  });

  it("renders negative totals with currency formatting", () => {
    render(<ColumnTotal values={[-25.5]} testId="column-total-x" />);
    expect(screen.getByTestId("column-total-x").textContent).toBe("-$25.50");
  });

  it("shows a placeholder instead of a sum while loading", () => {
    render(
      <ColumnTotal values={[100]} loading testId="column-total-x" />,
    );
    expect(screen.getByTestId("column-total-x").textContent).toBe("—");
  });
});
