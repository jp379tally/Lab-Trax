import { describe, expect, it } from "vitest";
import {
  getCatalogMaterialsForRestoration,
  getCatalogMaterialsForCrown,
} from "@/components/CatalogRestorationPicker";

describe("catalog restoration material fallback", () => {
  it("keeps crown material choices available while the catalog is unavailable", () => {
    const options = getCatalogMaterialsForCrown(undefined);
    expect(options.map((option) => option.label)).toContain("Zirconia");
    expect(options.length).toBeGreaterThan(1);
  });

  it("keeps an unmapped legacy material editable when the catalog has no match", () => {
    const options = getCatalogMaterialsForRestoration(
      undefined,
      {
        restorationType: "Legacy Crown",
        material: "Custom Legacy Ceramic",
      },
    );
    expect(options).toContainEqual({
      key: "legacy:Custom Legacy Ceramic",
      label: "Custom Legacy Ceramic",
    });
  });
});