/**
 * Regression tests for Task #2474 — "Stop duplicate practices from splitting
 * doctors".
 *
 * iTero (and other brand-aggregator) imports produce practice names with a
 * leading brand/lab prefix and a trailing bracketed code, e.g.
 *   "Heartland Dental - Family Dentistry at SouthWood [565]"
 * while the same practice created manually is just
 *   "Family Dentistry at SouthWood".
 *
 * `_normalizePracticeForSim` / `_practiceBigramSimilarity` must strip that
 * import-specific noise before scoring so the iTero import matcher
 * (`_findProviderOrgByPracticeName`, threshold >= 0.5) links to the existing
 * practice instead of spawning a duplicate — without collapsing genuinely
 * different practices.
 */
import { describe, expect, it } from "vitest";
import {
  _normalizePracticeForSim,
  _practiceBigramSimilarity,
} from "./cases.js";

describe("Task #2474 practice-name normalization", () => {
  it("strips a trailing bracketed code", () => {
    expect(_normalizePracticeForSim("Family Dentistry at SouthWood [565]")).toBe(
      _normalizePracticeForSim("Family Dentistry at SouthWood"),
    );
  });

  it("strips a leading brand/lab prefix terminated by ' - '", () => {
    expect(
      _normalizePracticeForSim("Heartland Dental - Family Dentistry at SouthWood"),
    ).toBe(_normalizePracticeForSim("Family Dentistry at SouthWood"));
  });

  it("strips both a brand prefix and a bracketed code together", () => {
    expect(
      _normalizePracticeForSim(
        "Heartland Dental - Family Dentistry at SouthWood [565]",
      ),
    ).toBe(_normalizePracticeForSim("Family Dentistry at SouthWood"));
  });

  it("does NOT strip a descriptive bracketed qualifier with no digit", () => {
    // "[East]" / "[West]" distinguish real practices and must survive.
    expect(_normalizePracticeForSim("Family Dentistry [East]")).not.toBe(
      _normalizePracticeForSim("Family Dentistry [West]"),
    );
  });

  it("does not strip a leading prefix when there is no ' - ' separator", () => {
    // A hyphen without surrounding spaces is part of the real name, not a
    // brand-prefix separator.
    expect(_normalizePracticeForSim("Smile-Bright Dental")).toBe(
      "smile bright",
    );
  });
});

describe("Task #2474 practice bigram similarity", () => {
  it("scores the SouthWood import/manual pair at the top (>= 0.5)", () => {
    const sim = _practiceBigramSimilarity(
      "Heartland Dental - Family Dentistry at SouthWood [565]",
      "Family Dentistry at SouthWood",
    );
    expect(sim).toBeGreaterThanOrEqual(0.5);
    // After normalization both reduce to the same string → exact match.
    expect(sim).toBe(1);
  });

  it("scores the Mahan Village import/manual pair above the import threshold", () => {
    const sim = _practiceBigramSimilarity(
      "Heartland Dental - Mahan Village Dental Care [985]",
      "Mahan Village Dental Care",
    );
    expect(sim).toBeGreaterThanOrEqual(0.5);
  });

  it("does NOT match genuinely different practices under the same lab", () => {
    // Two unrelated real practices: must stay below the 0.5 import threshold so
    // the matcher will not auto-link them.
    const sim = _practiceBigramSimilarity(
      "Family Dentistry at SouthWood",
      "Bright Smiles Orthodontics",
    );
    expect(sim).toBeLessThan(0.5);
  });

  it("keeps practices distinguished only by a non-numeric bracket qualifier below the cluster threshold", () => {
    // Under the previous broad bracket-stripping these collapsed to an
    // identical string (sim 1.0) and would have falsely clustered/linked. The
    // digit-guarded strip preserves "east"/"west", so the pair stays below the
    // default duplicate-suggestion threshold (0.7).
    const sim = _practiceBigramSimilarity(
      "Family Dentistry [East]",
      "Family Dentistry [West]",
    );
    expect(sim).toBeLessThan(0.7);
    expect(sim).toBeLessThan(1);
  });

  it("does NOT collapse two different practices that share a brand prefix", () => {
    // Same brand prefix, different real practice — after stripping the prefix
    // the remaining names are distinct and must not cluster.
    const sim = _practiceBigramSimilarity(
      "Heartland Dental - Family Dentistry at SouthWood [565]",
      "Heartland Dental - Mahan Village Dental Care [985]",
    );
    expect(sim).toBeLessThan(0.5);
  });
});
