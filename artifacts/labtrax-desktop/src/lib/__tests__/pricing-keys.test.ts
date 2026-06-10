import { describe, it, expect } from "vitest";
import { formatPriceTwoDecimals, isTierMissing } from "../pricing-keys";

describe("isTierMissing", () => {
  const tiers = [{ name: "Standard" }, { name: "Premium" }];

  it("returns false when no tier is assigned", () => {
    expect(isTierMissing(null, tiers)).toBe(false);
    expect(isTierMissing("", tiers)).toBe(false);
    expect(isTierMissing("   ", tiers)).toBe(false);
    expect(isTierMissing(undefined, tiers)).toBe(false);
  });

  it("returns false when assigned tier exists (case-insensitive, trimmed)", () => {
    expect(isTierMissing("Standard", tiers)).toBe(false);
    expect(isTierMissing("standard", tiers)).toBe(false);
    expect(isTierMissing("  PREMIUM  ", tiers)).toBe(false);
  });

  it("returns true when assigned tier no longer exists in the lab", () => {
    expect(isTierMissing("Corporate", tiers)).toBe(true);
    expect(isTierMissing("Old Standard", tiers)).toBe(true);
  });

  it("returns false when there are no tiers loaded yet (avoid false positives mid-fetch)", () => {
    expect(isTierMissing("Standard", [])).toBe(false);
  });
});

describe("formatPriceTwoDecimals", () => {
  it("pads whole numbers to two decimals", () => {
    expect(formatPriceTwoDecimals("119")).toBe("119.00");
    expect(formatPriceTwoDecimals("99")).toBe("99.00");
  });

  it("pads a single cent digit to two", () => {
    expect(formatPriceTwoDecimals("99.5")).toBe("99.50");
  });

  it("passes through valid two-decimal values unchanged", () => {
    expect(formatPriceTwoDecimals("119.00")).toBe("119.00");
  });

  it("leaves empty (or whitespace-only) input empty", () => {
    expect(formatPriceTwoDecimals("")).toBe("");
    expect(formatPriceTwoDecimals("   ")).toBe("");
  });

  it("returns non-numeric input unchanged", () => {
    expect(formatPriceTwoDecimals("abc")).toBe("abc");
    expect(formatPriceTwoDecimals("12px")).toBe("12px");
  });
});
