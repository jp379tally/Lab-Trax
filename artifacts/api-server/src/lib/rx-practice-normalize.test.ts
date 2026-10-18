/**
 * Unit tests for normalizeRxPracticeName.
 */
import { describe, it, expect } from "vitest";
import { normalizeRxPracticeName } from "./rx-practice-normalize";

describe("normalizeRxPracticeName", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeRxPracticeName("  Sunrise Dental  ")).toBe("sunrise dental");
  });

  it("collapses multiple internal spaces to a single space", () => {
    expect(normalizeRxPracticeName("Nicholas  Eli  Kizirian")).toBe(
      "nicholas eli kizirian",
    );
  });

  it("lowercases the result", () => {
    expect(normalizeRxPracticeName("Maple DENTAL")).toBe("maple dental");
  });

  it("collapses tabs and newlines as well", () => {
    expect(normalizeRxPracticeName("Oak\t\tDental\nCenter")).toBe(
      "oak dental center",
    );
  });

  it("returns empty string for blank input", () => {
    expect(normalizeRxPracticeName("   ")).toBe("");
  });

  it("is idempotent on already-normalized input", () => {
    const name = "sunshine dental";
    expect(normalizeRxPracticeName(name)).toBe(name);
  });
});
