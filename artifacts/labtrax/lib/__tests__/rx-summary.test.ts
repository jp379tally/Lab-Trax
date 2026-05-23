import { describe, it, expect } from "vitest";
import { caseToRxSummary } from "../rx-summary";

describe("caseToRxSummary", () => {
  it("derives from real restorations[] when present (desktop / iTero cases)", () => {
    const summary = caseToRxSummary({
      caseType: "" as const,
      material: "",
      toothIndices: "",
      restorations: [
        { restorationType: "Crown", material: "Zirconia", toothNumber: "8" },
        { restorationType: "Crown", material: "Zirconia", toothNumber: "9" },
      ],
    });
    expect(summary.restorativeType).toBe("Crown & Bridge");
    expect(summary.materials).toEqual(["Zirconia"]);
    expect(summary.teeth).toEqual(["8", "9"]);
  });

  it("ignores legacy single-restoration fields when restorations[] is non-empty", () => {
    const summary = caseToRxSummary({
      caseType: "Removable" as const,
      material: "Acrylic",
      toothIndices: "1-16",
      restorations: [
        { restorationType: "Crown", material: "Emax", toothNumber: "14" },
      ],
    });
    expect(summary.restorativeType).toBe("Crown & Bridge");
    expect(summary.materials).toEqual(["Emax"]);
    expect(summary.teeth).toEqual(["14"]);
  });

  it("falls back to legacy single-restoration fields when restorations[] is missing", () => {
    const summary = caseToRxSummary({
      caseType: "Restorative" as const,
      material: "Zirconia",
      toothIndices: "30",
      restorations: undefined,
    });
    expect(summary.restorativeType).toBe("Crown & Bridge");
    expect(summary.materials).toEqual(["Zirconia"]);
    expect(summary.teeth).toEqual(["30"]);
  });

  it("falls back to legacy single-restoration fields when restorations[] is empty", () => {
    const summary = caseToRxSummary({
      caseType: "Restorative" as const,
      material: "PFM",
      toothIndices: "19",
      restorations: [],
    });
    expect(summary.restorativeType).toBe("Crown & Bridge");
    expect(summary.materials).toEqual(["PFM"]);
    expect(summary.teeth).toEqual(["19"]);
  });

  it("returns empty summary when no data is available at all", () => {
    const summary = caseToRxSummary({
      caseType: "" as const,
      material: "",
      toothIndices: "",
      restorations: undefined,
    });
    expect(summary.restorativeType).toBeNull();
    expect(summary.materials).toEqual([]);
    expect(summary.teeth).toEqual([]);
    expect(summary.isFullArch).toBeNull();
  });
});
