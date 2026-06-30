import { describe, it, expect } from "vitest";
import {
  normalizeDoctorForCompare,
  doctorNameSimilarity,
  resolveLabDupThreshold,
  DEFAULT_DUP_SIMILARITY_THRESHOLD,
} from "./doctor-similarity.js";

describe("normalizeDoctorForCompare", () => {
  it("strips the dr./dr prefix as a whole word", () => {
    expect(normalizeDoctorForCompare("Dr. Kanesha Cole")).toBe("kanesha cole");
    expect(normalizeDoctorForCompare("dr kanesha cole")).toBe("kanesha cole");
  });

  it("does not strip 'dr' inside another word", () => {
    expect(normalizeDoctorForCompare("Drake")).toBe("drake");
    expect(normalizeDoctorForCompare("Andrew")).toBe("andrew");
  });

  it("collapses punctuation and whitespace", () => {
    expect(normalizeDoctorForCompare("  Kanesha   Cole!! ")).toBe("kanesha cole");
  });

  it("handles null/undefined", () => {
    expect(normalizeDoctorForCompare(null)).toBe("");
    expect(normalizeDoctorForCompare(undefined)).toBe("");
  });
});

describe("doctorNameSimilarity", () => {
  it("treats a normalized-equal pair (dr. prefix) as an exact match", () => {
    expect(doctorNameSimilarity("Kanesha Cole", "Dr. Kanesha Cole")).toBe(1);
  });

  it("scores close typos above the default threshold", () => {
    expect(
      doctorNameSimilarity("Kanesha Cole", "Kanesha Coles")
    ).toBeGreaterThan(DEFAULT_DUP_SIMILARITY_THRESHOLD);
  });

  it("scores unrelated names below the default threshold", () => {
    expect(
      doctorNameSimilarity("Kanesha Cole", "Robert Smith")
    ).toBeLessThan(DEFAULT_DUP_SIMILARITY_THRESHOLD);
  });

  it("returns 0 when either name is empty after normalization", () => {
    expect(doctorNameSimilarity("Dr.", "Kanesha Cole")).toBe(0);
    expect(doctorNameSimilarity("", "Kanesha Cole")).toBe(0);
  });
});

describe("resolveLabDupThreshold", () => {
  it("returns the default when unset", () => {
    expect(resolveLabDupThreshold(null)).toBe(DEFAULT_DUP_SIMILARITY_THRESHOLD);
    expect(resolveLabDupThreshold(undefined)).toBe(DEFAULT_DUP_SIMILARITY_THRESHOLD);
    expect(resolveLabDupThreshold("")).toBe(DEFAULT_DUP_SIMILARITY_THRESHOLD);
  });

  it("parses numeric strings", () => {
    expect(resolveLabDupThreshold("0.8")).toBe(0.8);
    expect(resolveLabDupThreshold(0.6)).toBe(0.6);
  });

  it("clamps to the 0.5–0.95 range", () => {
    expect(resolveLabDupThreshold(0.1)).toBe(0.5);
    expect(resolveLabDupThreshold(0.99)).toBe(0.95);
  });

  it("falls back to the default on non-finite input", () => {
    expect(resolveLabDupThreshold("abc")).toBe(DEFAULT_DUP_SIMILARITY_THRESHOLD);
  });
});
