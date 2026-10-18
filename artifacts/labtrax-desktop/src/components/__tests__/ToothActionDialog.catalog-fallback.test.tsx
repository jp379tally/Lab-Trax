/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToothActionDialog } from "@/components/ToothActionDialog";
import { getCatalogMaterialsForRestoration } from "@/components/CatalogRestorationPicker";

describe("ToothActionDialog catalog fallback", () => {
  it("keeps crown materials selectable when the catalog is unavailable", () => {
    const onConfirm = vi.fn();
    const materialOptions = getCatalogMaterialsForRestoration(undefined, {
      restorationType: "Crown",
      material: "Legacy Ceramic",
    });

    render(
      <ToothActionDialog
        toothId="14"
        restorations={[]}
        materialOptions={materialOptions}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /crown \/ restoration/i }));
    const zirconia = screen.getByRole("button", { name: "Zirconia" });
    expect(zirconia).toBeEnabled();
    fireEvent.click(zirconia);

    expect(screen.getByRole("button", { name: /next — pick shade/i })).toBeEnabled();
  });
});