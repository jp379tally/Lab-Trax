import { describe, it, expect } from "vitest";
import {
  normalizeProviderName,
  levenshtein,
  scoreProviderMatch,
  pickProviderMatch,
  ensureDrPrefix,
} from "../../scan/provider-match";

describe("normalizeProviderName", () => {
  it("strips Dr prefix, suffix credentials and punctuation", () => {
    expect(normalizeProviderName("Dr. Jane O'Smith, DDS")).toBe("jane osmith");
    expect(normalizeProviderName("Dr SMITH")).toBe("smith");
  });
});

describe("levenshtein", () => {
  it("returns 0 for equal strings and the right edit distance otherwise", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "foo")).toBe(3);
  });
});

describe("scoreProviderMatch", () => {
  it("returns 100 for exact normalised match", () => {
    expect(
      scoreProviderMatch({ providerName: "Dr. Jane Smith", scannedName: "jane smith" }),
    ).toBe(100);
  });
  it("rewards shared last name and bumps for matching practice", () => {
    const score = scoreProviderMatch({
      providerName: "Dr. John Adams",
      practiceName: "Adams Dental",
      scannedName: "Adams",
      scannedPracticeName: "Adams Dental",
    });
    expect(score).toBeGreaterThanOrEqual(45);
  });
  it("returns 0 when either side is empty", () => {
    expect(scoreProviderMatch({ providerName: "", scannedName: "x" })).toBe(0);
    expect(scoreProviderMatch({ providerName: "x", scannedName: "" })).toBe(0);
  });
});

describe("pickProviderMatch", () => {
  const candidates = [
    { providerName: "Dr. Jane Smith", practiceName: "Smile Dental", clientId: "c1" },
    { providerName: "Dr. John Smyth", practiceName: "Smyth Dental", clientId: "c2" },
    { providerName: "Dr. Bob Random", practiceName: "Other", clientId: "c3" },
  ];
  it("returns exact match when one exists", () => {
    const result = pickProviderMatch(candidates, { name: "Jane Smith" });
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") expect(result.entry.clientId).toBe("c1");
  });
  it("returns the best similar match when nothing is exact", () => {
    const result = pickProviderMatch(candidates, { name: "Dr. Smith" });
    expect(result.kind).toBe("similar");
  });
  it("returns none when nothing scores above the threshold", () => {
    const result = pickProviderMatch(candidates, { name: "Zzzz Qqqqq" });
    expect(result.kind).toBe("none");
  });
});

describe("ensureDrPrefix", () => {
  it("adds Dr. when missing and leaves existing prefix alone", () => {
    expect(ensureDrPrefix("Smith")).toBe("Dr. Smith");
    expect(ensureDrPrefix("Dr. Smith")).toBe("Dr. Smith");
    expect(ensureDrPrefix("dr Smith")).toBe("dr Smith");
  });
});
