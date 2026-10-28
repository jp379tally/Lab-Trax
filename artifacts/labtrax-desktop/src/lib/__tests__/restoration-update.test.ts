import { describe, expect, it } from "vitest";
import { buildRestorationUpdateBody } from "@/lib/restoration-update";

describe("buildRestorationUpdateBody", () => {
  it("persists the encoded subtype when a tooth-dialog material change is saved", () => {
    expect(
      buildRestorationUpdateBody({
        newToothNumber: "14",
        material: "Zirconia",
        restorationSubtype: "restorative/crown_and_bridge/zirconia",
        shade: "A2",
      }),
    ).toEqual({
      toothNumber: "14",
      material: "Zirconia",
      restorationSubtype: "restorative/crown_and_bridge/zirconia",
      shade: "A2",
    });
  });

  it("omits absent shade and empty optional product values for legacy edits", () => {
    expect(
      buildRestorationUpdateBody({
        newToothNumber: "15",
        material: "",
        restorationSubtype: undefined,
        shade: undefined,
      }),
    ).toEqual({ toothNumber: "15" });
  });

  it("persists an explicit shade clear and clears an old arch when changing to a fixed indication", () => {
    expect(buildRestorationUpdateBody({
      newToothNumber: "2", restorationType: "Coping", arch: null, shade: "",
    })).toEqual({ toothNumber: "2", restorationType: "Coping", quantity: 1, arch: null, shade: "" });
  });

  it("passes one empty-tooth arch assignment through the atomic request without expanding it", () => {
    expect(buildRestorationUpdateBody({
      newToothNumber: "", restorationType: "Denture", arch: "lower",
      material: "Acrylic", restorationSubtype: "removable/dentures/acrylic", shade: "A2",
    })).toEqual({ toothNumber: "", restorationType: "Denture", quantity: 1, arch: "lower",
      material: "Acrylic", restorationSubtype: "removable/dentures/acrylic", shade: "A2" });
  });
});
