/**
 * Unit tests for duplicate-merge helpers (regression guard).
 *
 * Coverage:
 *  - mergeDuplicateMatches: zero, one, and multiple duplicates from each source
 *  - localCaseToHit: maps LabCase fields to DuplicateHit correctly
 *  - defaultSelectedDuplicateId: prefers canonical over legacy; returns "" on empty list
 *  - Server matches win over local matches unconditionally
 */
import { describe, expect, it } from "vitest";
import {
  mergeDuplicateMatches,
  localCaseToHit,
  defaultSelectedDuplicateId,
  type DuplicateHit,
} from "./duplicate-merge";
import type { LabCase } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeServerHit(id: string, kind: "exact" | "fuzzy" = "exact"): DuplicateHit {
  return {
    id,
    caseNumber: `26-${id}`,
    matchKind: kind,
    source: "canonical",
    patientFirstName: "Test",
    patientLastName: "Patient",
  };
}

function makeLocalCase(id: string, patientName = "Alice Johnson"): LabCase {
  return {
    id,
    caseNumber: `LC-${id}`,
    caseType: "Crown",
    patientName,
    status: "delivered",
    toothIndices: "14",
    createdAt: 1_700_000_000_000,
  } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// mergeDuplicateMatches
// ─────────────────────────────────────────────────────────────────────────────

describe("mergeDuplicateMatches", () => {
  it("returns server matches when both sources are non-empty", () => {
    const serverHits = [makeServerHit("a"), makeServerHit("b")];
    const localCases = [makeLocalCase("l1")];
    const result = mergeDuplicateMatches(serverHits, localCases);
    expect(result).toEqual(serverHits);
  });

  it("falls back to local cases when server list is empty", () => {
    const localCases = [makeLocalCase("l1"), makeLocalCase("l2")];
    const result = mergeDuplicateMatches([], localCases);
    expect(result).toHaveLength(2);
    expect(result.every((h) => h.source === "legacy")).toBe(true);
  });

  it("returns an empty array when both sources are empty", () => {
    expect(mergeDuplicateMatches([], [])).toEqual([]);
  });

  it("returns a single server match correctly", () => {
    const hit = makeServerHit("x");
    expect(mergeDuplicateMatches([hit], [])).toEqual([hit]);
  });

  it("returns a single local case correctly", () => {
    const local = makeLocalCase("y");
    const result = mergeDuplicateMatches([], [local]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("y");
    expect(result[0].caseNumber).toBe("LC-y");
  });

  it("preserves all server hits when there are multiple", () => {
    const hits = [makeServerHit("1"), makeServerHit("2"), makeServerHit("3", "fuzzy")];
    const result = mergeDuplicateMatches(hits, []);
    expect(result).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// localCaseToHit
// ─────────────────────────────────────────────────────────────────────────────

describe("localCaseToHit", () => {
  it("splits patientName into first and last correctly", () => {
    const hit = localCaseToHit(makeLocalCase("t1", "Alice Johnson"));
    expect(hit.patientFirstName).toBe("Alice");
    expect(hit.patientLastName).toBe("Johnson");
  });

  it("handles single-token patient name (last name only)", () => {
    const hit = localCaseToHit(makeLocalCase("t2", "Cher"));
    expect(hit.patientFirstName).toBe("Cher");
    expect(hit.patientLastName).toBe("");
  });

  it("handles multi-word last names", () => {
    const hit = localCaseToHit(makeLocalCase("t3", "Mary Van Der Berg"));
    expect(hit.patientFirstName).toBe("Mary");
    expect(hit.patientLastName).toBe("Van Der Berg");
  });

  it("sets source to legacy", () => {
    expect(localCaseToHit(makeLocalCase("t4")).source).toBe("legacy");
  });

  it("maps caseType to restorationTypes", () => {
    const hit = localCaseToHit(makeLocalCase("t5"));
    expect(hit.restorationTypes).toBe("Crown");
  });

  it("returns null for createdAt when source has a numeric timestamp (LabCase always has number)", () => {
    // localCaseToHit only forwards string createdAt values; numeric ones
    // (the real LabCase shape) become null, matching the DuplicateHit type.
    const hit = localCaseToHit(makeLocalCase("t6"));
    expect(hit.createdAt).toBeNull();
  });

  it("handles undefined / empty patientName", () => {
    const c = makeLocalCase("t7", "");
    const hit = localCaseToHit(c);
    expect(hit.patientFirstName).toBe("");
    expect(hit.patientLastName).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// defaultSelectedDuplicateId
// ─────────────────────────────────────────────────────────────────────────────

describe("defaultSelectedDuplicateId", () => {
  it("returns the id of the first canonical hit", () => {
    const hits: DuplicateHit[] = [
      { id: "l1", caseNumber: "A", matchKind: "fuzzy", source: "legacy", patientFirstName: "X", patientLastName: "Y" },
      makeServerHit("s1"),
      makeServerHit("s2"),
    ];
    expect(defaultSelectedDuplicateId(hits)).toBe("s1");
  });

  it("returns empty string when there are no canonical hits", () => {
    const hits: DuplicateHit[] = [
      { id: "l1", caseNumber: "A", matchKind: "fuzzy", source: "legacy", patientFirstName: "X", patientLastName: "Y" },
    ];
    expect(defaultSelectedDuplicateId(hits)).toBe("");
  });

  it("returns empty string for an empty list", () => {
    expect(defaultSelectedDuplicateId([])).toBe("");
  });

  it("returns the first canonical hit even when it is not first in list order", () => {
    const hits: DuplicateHit[] = [
      { id: "l1", caseNumber: "A", matchKind: "exact", source: "legacy", patientFirstName: "X", patientLastName: "Y" },
      { id: "c1", caseNumber: "B", matchKind: "exact", source: "canonical", patientFirstName: "X", patientLastName: "Y" },
    ];
    expect(defaultSelectedDuplicateId(hits)).toBe("c1");
  });
});
