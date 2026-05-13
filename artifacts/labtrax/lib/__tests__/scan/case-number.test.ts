import { describe, it, expect } from "vitest";
import {
  nextCaseNumber,
  buildPatientInitials,
  buildToothDiagram,
  buildFinalNotes,
  effectiveToothIndices,
} from "../../scan/case-number";

describe("nextCaseNumber", () => {
  it("starts at 1 when no prior cases match the year prefix", () => {
    expect(nextCaseNumber("26", [])).toBe("26-1");
    expect(nextCaseNumber("26", ["25-7", "25-8"])).toBe("26-1");
  });

  it("returns one greater than the highest matching number", () => {
    expect(nextCaseNumber("26", ["26-1", "26-3", "26-2"])).toBe("26-4");
  });

  it("ignores malformed entries", () => {
    expect(nextCaseNumber("26", ["26-foo", "26-", "26-9"])).toBe("26-10");
  });
});

describe("buildPatientInitials", () => {
  it("turns each space-separated word into an initial with a period", () => {
    expect(buildPatientInitials("john quincy adams")).toBe("J.Q.A.");
  });
  it("handles single names and extra whitespace", () => {
    expect(buildPatientInitials("  cher ")).toBe("C.");
    expect(buildPatientInitials("")).toBe("");
  });
});

describe("buildToothDiagram", () => {
  it("returns the in-range tooth numbers", () => {
    expect(buildToothDiagram("#8, #9, #10")).toEqual([8, 9, 10]);
  });
  it("filters out-of-range numbers and returns undefined when empty", () => {
    expect(buildToothDiagram("33, 50")).toBeUndefined();
    expect(buildToothDiagram("")).toBeUndefined();
  });
});

describe("buildFinalNotes", () => {
  it("composes bracketed tags then user notes", () => {
    expect(
      buildFinalNotes({
        removableSubtype: "Partial",
        removableArch: "Both",
        removableStage: "Try-In",
        notes: "  Patient prefers softer base ",
      }),
    ).toBe("[Partial] [Upper & Lower] [Stage: Try-In] Patient prefers softer base");
  });
  it("omits empty bracket tags", () => {
    expect(buildFinalNotes({ notes: "hello" })).toBe("hello");
  });
});

describe("effectiveToothIndices", () => {
  it("uses the arch label when removable", () => {
    expect(effectiveToothIndices({ caseType: "Removable", removableArch: "Both", toothIndices: "" })).toBe(
      "Upper, Lower",
    );
    expect(effectiveToothIndices({ caseType: "Removable", removableArch: "Upper", toothIndices: "" })).toBe(
      "Upper",
    );
  });
  it("falls back to typed tooth indices otherwise", () => {
    expect(effectiveToothIndices({ caseType: "Restorative", toothIndices: "  #8, #9 " })).toBe("#8, #9");
  });
});
