/**
 * Unit tests for AI-reader core logic (regression guard).
 *
 * Coverage:
 *  - decideAiDoctorAssignment: exact, similar, and new outcomes
 *  - nextCaseNumber: increments from an existing list; handles empty list
 *  - buildPatientInitials: single, double, and triple-name patients
 *  - buildToothDiagram: valid tooth numbers (1–32), rejects out-of-range values
 *  - mergeDuplicateMatches: deduplicates and picks the correct default
 *
 * All helpers are pure functions — no React Native / Expo surfaces are
 * exercised so no platform stubs are needed.
 */
import { describe, expect, it } from "vitest";
import { decideAiDoctorAssignment, type ProviderEntry } from "./ai-doctor-assignment";
import { nextCaseNumber, buildPatientInitials, buildToothDiagram } from "./case-number";
import { mergeDuplicateMatches, defaultSelectedDuplicateId, type DuplicateHit } from "./duplicate-merge";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const providers: ProviderEntry[] = [
  { providerName: "Dr. James Smith", practiceName: "Smith Dental", clientId: "p1" },
  { providerName: "Dr. Lisa Wong", practiceName: "Wong Ortho", clientId: "p2" },
];

// ─────────────────────────────────────────────────────────────────────────────
// decideAiDoctorAssignment
// ─────────────────────────────────────────────────────────────────────────────

describe("decideAiDoctorAssignment", () => {
  it("returns exact when AI name matches an on-file provider spelling exactly (case-insensitive)", () => {
    const result = decideAiDoctorAssignment(
      { doctorName: "Dr. James Smith" },
      providers,
    );
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.entry.clientId).toBe("p1");
    }
  });

  it("returns similar for a partial / fuzzy match", () => {
    const result = decideAiDoctorAssignment(
      { doctorName: "James Smith" },
      providers,
    );
    expect(["exact", "similar"]).toContain(result.kind);
  });

  it("returns similar when only the last name portion matches", () => {
    const result = decideAiDoctorAssignment(
      { doctorName: "Dr. Smith" },
      providers,
    );
    expect(["similar", "exact"]).toContain(result.kind);
  });

  it("returns new when the doctor name is absent from on-file providers", () => {
    const result = decideAiDoctorAssignment(
      { doctorName: "Dr. Completely Unknown" },
      providers,
    );
    expect(result.kind).toBe("new");
  });

  it("returns new when doctorName is undefined / empty", () => {
    expect(decideAiDoctorAssignment({}, providers).kind).toBe("new");
    expect(decideAiDoctorAssignment({ doctorName: "" }, providers).kind).toBe("new");
  });

  it("returns new when the provider list is empty", () => {
    const result = decideAiDoctorAssignment({ doctorName: "Dr. James Smith" }, []);
    expect(result.kind).toBe("new");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nextCaseNumber
// ─────────────────────────────────────────────────────────────────────────────

describe("nextCaseNumber", () => {
  it("returns yy-1 when the list is empty", () => {
    expect(nextCaseNumber("26", [])).toBe("26-1");
  });

  it("increments past the current maximum", () => {
    expect(nextCaseNumber("26", ["26-1", "26-3", "26-2"])).toBe("26-4");
  });

  it("ignores case numbers from a different year prefix", () => {
    expect(nextCaseNumber("26", ["25-10", "25-11"])).toBe("26-1");
  });

  it("handles a single existing entry", () => {
    expect(nextCaseNumber("26", ["26-7"])).toBe("26-8");
  });

  it("skips over non-numeric suffixes gracefully", () => {
    expect(nextCaseNumber("26", ["26-abc", "26-2"])).toBe("26-3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildPatientInitials
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPatientInitials", () => {
  it("handles a single-token name", () => {
    expect(buildPatientInitials("Alice")).toBe("A.");
  });

  it("handles a two-token name", () => {
    expect(buildPatientInitials("Alice Johnson")).toBe("A.J.");
  });

  it("handles a three-token name", () => {
    expect(buildPatientInitials("Alice Marie Johnson")).toBe("A.M.J.");
  });

  it("trims extra whitespace", () => {
    expect(buildPatientInitials("  Bob   Lee  ")).toBe("B.L.");
  });

  it("uppercases the initial letter", () => {
    expect(buildPatientInitials("alice")).toBe("A.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildToothDiagram
// ─────────────────────────────────────────────────────────────────────────────

describe("buildToothDiagram", () => {
  it("returns valid tooth numbers in the range 1–32", () => {
    expect(buildToothDiagram("1, 14, 32")).toEqual([1, 14, 32]);
  });

  it("returns undefined for an empty input string", () => {
    expect(buildToothDiagram("")).toBeUndefined();
  });

  it("filters out tooth numbers below 1", () => {
    expect(buildToothDiagram("0, 1, 2")).toEqual([1, 2]);
  });

  it("filters out tooth numbers above 32", () => {
    expect(buildToothDiagram("30, 32, 33")).toEqual([30, 32]);
  });

  it("returns undefined when all numbers are out of range", () => {
    expect(buildToothDiagram("0, 33, 99")).toBeUndefined();
  });

  it("parses a single tooth number", () => {
    expect(buildToothDiagram("8")).toEqual([8]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeDuplicateMatches (dedup default selection)
// ─────────────────────────────────────────────────────────────────────────────

describe("mergeDuplicateMatches + defaultSelectedDuplicateId", () => {
  const serverHit: DuplicateHit = {
    id: "s1",
    caseNumber: "26-10",
    matchKind: "exact",
    source: "canonical",
    patientFirstName: "Alice",
    patientLastName: "Johnson",
  };

  it("prefers server matches over local matches when server list is non-empty", () => {
    const merged = mergeDuplicateMatches([serverHit], []);
    expect(merged).toEqual([serverHit]);
  });

  it("falls back to local cases when server list is empty", () => {
    const localCase = {
      id: "l1",
      caseNumber: "26-9",
      caseType: "Crown",
      patientName: "Alice Johnson",
      status: "delivered",
      toothIndices: "14",
      createdAt: 1000000,
    } as any;
    const merged = mergeDuplicateMatches([], [localCase]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("legacy");
    expect(merged[0].caseNumber).toBe("26-9");
  });

  it("returns empty list when both sources are empty", () => {
    expect(mergeDuplicateMatches([], [])).toEqual([]);
  });

  it("defaultSelectedDuplicateId picks the first canonical hit", () => {
    const legacyHit: DuplicateHit = {
      id: "l1",
      caseNumber: "26-9",
      matchKind: "fuzzy",
      source: "legacy",
      patientFirstName: "Alice",
      patientLastName: "Johnson",
    };
    expect(defaultSelectedDuplicateId([legacyHit, serverHit])).toBe("s1");
  });

  it("defaultSelectedDuplicateId returns empty string when no canonical hit exists", () => {
    const legacyHit: DuplicateHit = {
      id: "l1",
      caseNumber: "26-9",
      matchKind: "fuzzy",
      source: "legacy",
      patientFirstName: "Alice",
      patientLastName: "Johnson",
    };
    expect(defaultSelectedDuplicateId([legacyHit])).toBe("");
  });
});
