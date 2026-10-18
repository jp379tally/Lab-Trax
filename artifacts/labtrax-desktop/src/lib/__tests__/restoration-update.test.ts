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

  it("omits empty optional values for legacy edits", () => {
    expect(
      buildRestorationUpdateBody({
        newToothNumber: "15",
        material: "",
        restorationSubtype: undefined,
        shade: "",
      }),
    ).toEqual({ toothNumber: "15" });
  });
});
