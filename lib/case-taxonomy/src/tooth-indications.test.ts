import { describe, expect, it } from "vitest";
import { archSelectionTeeth, indicationCatalogContext, selectedToothArch, TOOTH_INDICATIONS, toothIndicationShapeError } from "./tooth-indications";
import { toothAssignmentSummary, parseConnectorState, updateConnectorChoices, withPonticConnectorSuggestions } from "./tooth-assignment";

describe("reference indication and arch contracts", () => {
  it("retains exactly fourteen distinct indications, including six removable/appliance choices", () => {
    expect(TOOTH_INDICATIONS).toEqual(["Crown", "Coping", "Overlay", "Pontic", "Diagnostic",
      "Inlay/Onlay", "Offset inlay", "Veneer", "Denture", "Partial denture", "Bite splint",
      "Primary telescopic crown", "Secondary telescopic crown", "Attachment"]);
    expect(new Set(TOOTH_INDICATIONS).size).toBe(14);
  });
  it("selects all sixteen teeth of only the requested arch without modifying assignments", () => {
    const assignments = [{ toothNumber: "2", restorationType: "Crown", material: "Zirconia" }];
    const before = structuredClone(assignments);
    expect(archSelectionTeeth("upper")).toEqual(Array.from({ length: 16 }, (_, i) => String(i + 1)));
    expect(archSelectionTeeth("lower")).toEqual(Array.from({ length: 16 }, (_, i) => String(i + 17)));
    expect(assignments).toEqual(before);
    expect(selectedToothArch(["1", "16"])).toBe("upper");
    expect(selectedToothArch(["1", "17"])).toBeUndefined();
  });
  it("represents a denture as one arch restoration, never sixteen tooth charges", () => {
    const row = { restorationType: "Denture", toothNumber: "", quantity: 1, arch: "upper", material: "Acrylic" };
    expect(toothIndicationShapeError(row)).toBeNull();
    expect(toothIndicationShapeError({ ...row, quantity: 16 })).toBeTruthy();
    expect(toothIndicationShapeError({ ...row, toothNumber: "1-16" })).toBeTruthy();
    expect(toothIndicationShapeError({ ...row, arch: null })).toBeTruthy();
    expect(toothAssignmentSummary([row]).units).toBe(1);
    expect(indicationCatalogContext("Denture").caseType).toBe("removable");
    expect(indicationCatalogContext("Bite splint").caseType).toBe("ortho");
  });
  it("retains fixed indications as distinct single-tooth units and Missing as nonbillable", () => {
    for (const restorationType of ["Coping", "Overlay", "Diagnostic", "Inlay/Onlay", "Offset inlay", "Veneer",
      "Primary telescopic crown", "Secondary telescopic crown", "Attachment"]) {
      expect(toothIndicationShapeError({ restorationType, toothNumber: "2", quantity: 1 })).toBeNull();
      expect(toothAssignmentSummary([{ restorationType, toothNumber: "2" }]).units).toBe(1);
    }
    expect(toothAssignmentSummary([{ restorationType: "missing", toothNumber: "2" }]).units).toBe(0);
  });
  it("connector off/on changes connectivity without changing the assignments", () => {
    const rows = [
      { toothNumber: "2", restorationType: "Crown", material: "Zirconia", shade: "A2" },
      { toothNumber: "3", restorationType: "Pontic", material: "Zirconia", shade: "A2" },
      { toothNumber: "4", restorationType: "Crown", material: "Zirconia", shade: "A2" },
    ];
    const before = structuredClone(rows);
    const active = withPonticConnectorSuggestions(null, rows);
    expect(toothAssignmentSummary(rows, updateConnectorChoices(active, new Set(["2-3", "3-4"]))).groups).toEqual([["2", "3", "4"]]);
    const off = updateConnectorChoices(active, new Set(["3-4"]));
    expect(toothAssignmentSummary(rows, off).groups).toEqual([["3", "4"]]);
    expect(withPonticConnectorSuggestions(off, rows).active.has("2-3")).toBe(false);
    const on = updateConnectorChoices(parseConnectorState(off), new Set(["2-3", "3-4"]));
    expect(toothAssignmentSummary(rows, on).groups).toEqual([["2", "3", "4"]]);
    expect(rows).toEqual(before);
  });
});
