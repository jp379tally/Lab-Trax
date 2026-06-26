/** @vitest-environment jsdom */
/**
 * Regression suite for Task #2474 — "Stop duplicate practices from splitting
 * doctors".
 *
 * A lab can end up with two near-duplicate practices: one created manually
 * (e.g. "Family Dentistry at SouthWood") and one created from an iTero import
 * with a brand prefix + bracketed code
 * (e.g. "Heartland Dental - Family Dentistry at SouthWood [565]"). Before this
 * fix the normalized names scored ~0.61 and never surfaced in the "Suggested
 * duplicates" banner, so the admin couldn't merge them.
 *
 * `normalizePracticeNameForCompare` now strips the leading brand/lab prefix and
 * trailing bracketed code, so the real duplicate pair clusters at high
 * similarity while genuinely different practices stay separate.
 */
import { describe, it, expect } from "vitest";
import type { Organization } from "@/lib/types";
import {
  buildPracticeDuplicateClusters,
  normalizePracticeNameForCompare,
  DEFAULT_PRACTICE_DUP_SIMILARITY_THRESHOLD,
} from "@/pages/practices";

const LAB_ID = "lab1";

function provider(id: string, name: string): Organization {
  return {
    id,
    type: "provider",
    name,
    parentLabOrganizationId: LAB_ID,
    isActive: true,
  };
}

describe("normalizePracticeNameForCompare (Task #2474)", () => {
  it("strips a trailing bracketed code", () => {
    expect(
      normalizePracticeNameForCompare("Family Dentistry at SouthWood [565]"),
    ).toBe(normalizePracticeNameForCompare("Family Dentistry at SouthWood"));
  });

  it("strips a leading brand prefix terminated by ' - '", () => {
    expect(
      normalizePracticeNameForCompare(
        "Heartland Dental - Family Dentistry at SouthWood",
      ),
    ).toBe(normalizePracticeNameForCompare("Family Dentistry at SouthWood"));
  });

  it("does not strip a hyphen that is part of the real name", () => {
    expect(normalizePracticeNameForCompare("Smile-Bright Dental")).toBe(
      "smile bright",
    );
  });
});

describe("buildPracticeDuplicateClusters (Task #2474)", () => {
  const adminLabs = new Set([LAB_ID]);

  it("clusters the brand-prefixed / bracketed-code SouthWood pair", () => {
    const practices = [
      provider("p1", "Family Dentistry at SouthWood"),
      provider("p2", "Heartland Dental - Family Dentistry at SouthWood [565]"),
    ];
    const clusters = buildPracticeDuplicateClusters(
      practices,
      adminLabs,
      DEFAULT_PRACTICE_DUP_SIMILARITY_THRESHOLD,
    );
    expect(clusters).toHaveLength(1);
    expect(new Set(clusters[0].practices.map((p) => p.id))).toEqual(
      new Set(["p1", "p2"]),
    );
    expect(clusters[0].topScore).toBeGreaterThanOrEqual(
      DEFAULT_PRACTICE_DUP_SIMILARITY_THRESHOLD,
    );
  });

  it("clusters the Mahan Village pair", () => {
    const practices = [
      provider("p1", "Mahan Village Dental Care"),
      provider("p2", "Heartland Dental - Mahan Village Dental Care [985]"),
    ];
    const clusters = buildPracticeDuplicateClusters(
      practices,
      adminLabs,
      DEFAULT_PRACTICE_DUP_SIMILARITY_THRESHOLD,
    );
    expect(clusters).toHaveLength(1);
    expect(new Set(clusters[0].practices.map((p) => p.id))).toEqual(
      new Set(["p1", "p2"]),
    );
  });

  it("does NOT cluster genuinely different practices under one lab", () => {
    const practices = [
      provider("p1", "Family Dentistry at SouthWood"),
      provider("p2", "Bright Smiles Orthodontics"),
      provider("p3", "Heartland Dental - Mahan Village Dental Care [985]"),
    ];
    const clusters = buildPracticeDuplicateClusters(
      practices,
      adminLabs,
      DEFAULT_PRACTICE_DUP_SIMILARITY_THRESHOLD,
    );
    expect(clusters).toHaveLength(0);
  });

  it("does NOT cluster practices distinguished only by a non-numeric bracket qualifier", () => {
    // "[East]" / "[West]" are real qualifiers, not import codes, and must keep
    // these as separate practices.
    const practices = [
      provider("p1", "Family Dentistry [East]"),
      provider("p2", "Family Dentistry [West]"),
    ];
    const clusters = buildPracticeDuplicateClusters(
      practices,
      adminLabs,
      DEFAULT_PRACTICE_DUP_SIMILARITY_THRESHOLD,
    );
    expect(clusters).toHaveLength(0);
  });
});
