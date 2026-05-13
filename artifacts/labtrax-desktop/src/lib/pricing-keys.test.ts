import { describe, it, expect } from "vitest";
import { isTierMissing } from "./pricing-keys";

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
