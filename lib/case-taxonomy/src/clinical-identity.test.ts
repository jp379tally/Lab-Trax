import { describe, it, expect } from "vitest";
import { sameClinicalHierarchy } from "./clinical-identity";
describe("clinical dropdown round trips", () => {
  const original = { restorationType: "Crown", restorationSubtype: "restorative/implant/zirconia", material: "Zirconia" };
  it("does not mark a canonical Implant label as a clinical/pricing change", () => {
    expect(sameClinicalHierarchy(original, { ...original, restorationType: "Implant" })).toBe(true);
  });
  it("still recognizes an actual subtype or material change", () => {
    expect(sameClinicalHierarchy(original, { ...original, restorationSubtype: "restorative/crown/zirconia" })).toBe(false);
    expect(sameClinicalHierarchy(original, { ...original, material: "E.max" })).toBe(false);
    expect(sameClinicalHierarchy(original, { ...original, material: "" })).toBe(false);
  });
  it("does not conflate custom subtype or material identities with identical labels", () => {
    expect(sameClinicalHierarchy({ ...original, restorationSubtype: "restorative/custom:a/custom:m1" }, { ...original, restorationSubtype: "restorative/custom:a/custom:m2" })).toBe(false);
  });
});
