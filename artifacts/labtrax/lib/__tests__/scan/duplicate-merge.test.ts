import { describe, it, expect } from "vitest";
import {
  mergeDuplicateMatches,
  defaultSelectedDuplicateId,
  localCaseToHit,
  type DuplicateHit,
} from "../../scan/duplicate-merge";
import type { LabCase } from "../../data";

const localCase = {
  id: "loc-1",
  caseNumber: "26-1",
  patientName: "Jane Doe",
  status: "INTAKE",
  createdAt: "2026-01-01T00:00:00Z",
  toothIndices: "#8",
  caseType: "Restorative",
} as unknown as LabCase;

const serverHit: DuplicateHit = {
  id: "srv-1",
  caseNumber: "26-9",
  matchKind: "fuzzy",
  source: "canonical",
  patientFirstName: "Jane",
  patientLastName: "Doe",
};

describe("mergeDuplicateMatches", () => {
  it("prefers server matches when present", () => {
    expect(mergeDuplicateMatches([serverHit], [localCase])).toEqual([serverHit]);
  });
  it("falls back to converted local matches when no server hits", () => {
    const merged = mergeDuplicateMatches([], [localCase]);
    expect(merged[0]?.source).toBe("legacy");
    expect(merged[0]?.id).toBe("loc-1");
  });
});

describe("localCaseToHit", () => {
  it("splits the patient name into first/last", () => {
    expect(localCaseToHit(localCase)).toMatchObject({
      patientFirstName: "Jane",
      patientLastName: "Doe",
      source: "legacy",
    });
  });
});

describe("defaultSelectedDuplicateId", () => {
  it("returns the first canonical id when one exists", () => {
    expect(defaultSelectedDuplicateId([{ ...serverHit, source: "legacy" }, serverHit])).toBe(
      "srv-1",
    );
  });
  it("returns empty string when no canonical hits are available", () => {
    expect(defaultSelectedDuplicateId([{ ...serverHit, source: "legacy" }])).toBe("");
  });
});
