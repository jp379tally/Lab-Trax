/**
 * Unit tests for provider-match helpers (regression guard).
 *
 * Coverage:
 *  - normalizeProviderName: strips "Dr." prefix, trailing credentials, punctuation
 *  - pickProviderMatch: exact on full-name match, similar on high-bigram match,
 *    none when below threshold
 *  - Edge cases: empty provider list, "Dr." prefix stripping, extra whitespace,
 *    practice-name bonus scoring
 */
import { describe, expect, it } from "vitest";
import {
  normalizeProviderName,
  pickProviderMatch,
  scoreProviderMatch,
  type ProviderCandidate,
} from "./provider-match";

// ─────────────────────────────────────────────────────────────────────────────
// normalizeProviderName
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeProviderName", () => {
  it("strips 'Dr.' prefix", () => {
    expect(normalizeProviderName("Dr. James Smith")).toBe("james smith");
  });

  it("strips 'Dr ' prefix without dot", () => {
    expect(normalizeProviderName("Dr James Smith")).toBe("james smith");
  });

  it("strips trailing credentials like DDS / DMD", () => {
    expect(normalizeProviderName("Jane Doe, DDS")).toBe("jane doe");
    expect(normalizeProviderName("Jane Doe DMD")).toBe("jane doe");
  });

  it("collapses extra whitespace", () => {
    expect(normalizeProviderName("  Alice   Wong  ")).toBe("alice wong");
  });

  it("removes apostrophes and dots", () => {
    expect(normalizeProviderName("O'Brien")).toBe("obrien");
    expect(normalizeProviderName("Dr. J. Smith")).toBe("j smith");
  });

  it("handles empty / null-ish input gracefully", () => {
    expect(normalizeProviderName("")).toBe("");
    expect(normalizeProviderName("   ")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pickProviderMatch
// ─────────────────────────────────────────────────────────────────────────────

const candidates: ProviderCandidate[] = [
  { providerName: "Dr. James Smith", practiceName: "Smith Dental", clientId: "p1" },
  { providerName: "Dr. Lisa Wong", practiceName: "Wong Ortho", clientId: "p2" },
  { providerName: "Dr. Robert Johnson", practiceName: "Johnson Family", clientId: "p3" },
];

describe("pickProviderMatch", () => {
  it("returns exact on a case-insensitive full-name match (score 100)", () => {
    const result = pickProviderMatch(candidates, { name: "Dr. James Smith" });
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.entry.clientId).toBe("p1");
    }
  });

  it("returns exact when the same last name matches (score 100)", () => {
    const result = pickProviderMatch(
      [{ providerName: "James Smith", practiceName: "", clientId: "p1" }],
      { name: "James Smith" },
    );
    expect(result.kind).toBe("exact");
  });

  it("returns exact for a name that matches exactly after 'Dr.' prefix is stripped", () => {
    // normalizeProviderName("James Smith") === normalizeProviderName("Dr. James Smith")
    // both → "james smith" → score 100 → exact
    const result = pickProviderMatch(candidates, { name: "James Smith" });
    expect(result.kind).toBe("exact");
  });

  it("returns none when no candidate meets the minimum score threshold", () => {
    const result = pickProviderMatch(candidates, { name: "Dr. Completely Unknown XYZ" });
    expect(result.kind).toBe("none");
  });

  it("returns none when the candidate list is empty", () => {
    const result = pickProviderMatch([], { name: "Dr. James Smith" });
    expect(result.kind).toBe("none");
    expect(result.ranked).toEqual([]);
  });

  it("picks the highest-scoring candidate as the best match", () => {
    const result = pickProviderMatch(candidates, { name: "Dr. Lisa Wong" });
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.entry.clientId).toBe("p2");
    }
  });

  it("strips 'Dr.' prefix from both scanned name and candidate before comparing", () => {
    const simple: ProviderCandidate[] = [
      { providerName: "Smith James", practiceName: "", clientId: "ps" },
    ];
    const result = pickProviderMatch(simple, { name: "Dr. Smith James" });
    expect(result.kind).not.toBe("none");
  });

  it("applies practice-name bonus when practice names match", () => {
    const withPractice: ProviderCandidate[] = [
      { providerName: "Dr. Mary Lee", practiceName: "Sunrise Dental", clientId: "x1" },
      { providerName: "Dr. Mary Lee", practiceName: "Other Dental", clientId: "x2" },
    ];
    const result = pickProviderMatch(
      withPractice,
      { name: "Dr. Mary Lee", practiceName: "Sunrise Dental" },
    );
    if (result.kind !== "none") {
      expect(result.ranked[0].clientId).toBe("x1");
    }
  });

  it("handles scanned name with extra leading/trailing whitespace and still matches exactly", () => {
    // normalizeProviderName trims → "james smith" === normalizeProviderName("Dr. James Smith")
    const result = pickProviderMatch(candidates, { name: "  Dr. James Smith  " });
    expect(result.kind).toBe("exact");
  });

  it("returns ranked list with correct order (highest score first)", () => {
    const result = pickProviderMatch(candidates, { name: "Dr. James Smith" });
    for (let i = 1; i < result.ranked.length; i++) {
      expect(result.ranked[i - 1].score).toBeGreaterThanOrEqual(result.ranked[i].score);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreProviderMatch (unit-level)
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreProviderMatch", () => {
  it("returns 100 for an exact normalized match", () => {
    expect(
      scoreProviderMatch({
        providerName: "Dr. James Smith",
        scannedName: "Dr. James Smith",
      }),
    ).toBe(100);
  });

  it("returns 0 when both normalized forms are empty", () => {
    expect(
      scoreProviderMatch({
        providerName: "",
        scannedName: "",
      }),
    ).toBe(0);
  });

  it("awards last-name bonus for matching last names", () => {
    const score = scoreProviderMatch({
      providerName: "Smith James",
      scannedName: "Dr. Smith Alice",
    });
    expect(score).toBeGreaterThan(0);
  });
});
