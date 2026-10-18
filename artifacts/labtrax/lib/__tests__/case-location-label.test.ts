import { describe, expect, it } from "vitest";
import { caseLocationLabel } from "../case-location-label";

describe("caseLocationLabel", () => {
  it("prefers the exact physical station name over workflow status", async () => {
    expect(
      caseLocationLabel({
        status: "in_design",
        labLocationId: "station-a",
        labLocationName: "Wax Room",
      }),
    ).toBe("Wax Room");
  });

  it("keeps current and remake labels independent", async () => {
    const current = {
      status: "in_design",
      labLocationName: "Wax Room",
    };
    const remake = {
      status: "in_design",
      labLocationName: "Model Room",
    };
    expect(caseLocationLabel(current)).toBe("Wax Room");
    expect(caseLocationLabel(remake)).toBe("Model Room");
  });

  it("falls back to the status when no physical name is provided", async () => {
    expect(caseLocationLabel({ status: "in_design", labLocationId: "legacy" })).toBe(
      "In Design",
    );
  });
});