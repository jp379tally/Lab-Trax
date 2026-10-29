import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native/pure";
import type { CatalogTreeResult } from "@workspace/api-client-react";
import { CaseClinicalEditor } from "@/components/CaseClinicalEditor";
import { buildClinicalPayload, clinicalDraftFromCase, type ClinicalDraft } from "@/lib/case-clinical-edit";
import { caseHierarchyLabels, hasMixedCaseHierarchy } from "@/lib/case-hierarchy-display";
import { deriveCaseHierarchy } from "@workspace/case-taxonomy";

afterEach(async () => { await cleanup(); });

describe("Overview clinical dropdown drafts", () => {
  const source = { restorations: [{
    restorationType: "Crown", restorationSubtype: "restorative/implant/zirconia",
    material: "Zirconia", shade: "A1", toothNumber: "14",
  }] };
  const props = { canEditHierarchy: true, canEditStep: true, disabled: false };

  it("does not change the draft on open, close, catalog hydration or selecting the current option", async () => {
    const onChange = vi.fn();
    const value = clinicalDraftFromCase(source);
    const view = await render(<CaseClinicalEditor {...props} value={value} onChange={onChange} />);
    for (const id of ["case-type", "subtype", "case-material"]) {
      expect(view.queryByTestId(`clinical-${id}-${id === "case-type" ? "restorative" : "zirconia"}`)).toBeNull();
      await fireEvent.press(view.getByTestId(`clinical-${id}-select`));
      await fireEvent.press(view.getByTestId(`clinical-${id}-select`));
    }
    await fireEvent.press(view.getByTestId("clinical-case-material-select"));
    await fireEvent.press(view.getByTestId("clinical-case-material-zirconia"));
    await view.rerender(<CaseClinicalEditor {...props} value={value} onChange={onChange}
      catalog={{ labOrganizationId: "lab", caseTypes: [] }} />);
    expect(view.getByTestId("clinical-case-material-value").props.children).toBe("Zirconia");
    expect(view.getByTestId("clinical-subtype-value").props.children).toBe("Implant");
    expect(onChange).not.toHaveBeenCalled();
    expect(buildClinicalPayload(source, value, true)).toBeNull();
  });

  it("keeps compatible material when toggling subtype and leaves the original alias round trip unchanged", async () => {
    let latest: ClinicalDraft = clinicalDraftFromCase(source);
    function Editor() {
      const [value, setValue] = useState(latest);
      return <CaseClinicalEditor {...props} value={value} onChange={(next) => { latest = next; setValue(next); }} />;
    }
    const view = await render(<Editor />);
    for (const subtype of ["crown_and_bridge", "implant"]) {
      await fireEvent.press(view.getByTestId("clinical-subtype-select"));
      await fireEvent.press(view.getByTestId(`clinical-subtype-${subtype}`));
      expect(view.getByTestId("clinical-case-material-value").props.children).toBe("Zirconia");
    }
    expect(buildClinicalPayload(source, latest, true)).toBeNull();
  });

  it("keeps custom and legacy labels in the draft when their catalog is absent", async () => {
    const value = clinicalDraftFromCase({ restorations: [{
      restorationType: "My custom removable appliance",
      restorationSubtype: "removable/custom:subtype-id/custom:material-id",
      material: "Specialty multilayer material",
    }] });
    const onChange = vi.fn();
    const view = await render(<CaseClinicalEditor {...props} value={value} onChange={onChange} />);
    expect(view.getByTestId("clinical-subtype-value").props.children).toBe(value.restorationType);
    expect(view.getByTestId("clinical-case-material-value").props.children).toBe(value.material);
    await fireEvent.press(view.getByTestId("clinical-subtype-select"));
    await fireEvent.press(view.getByTestId("clinical-subtype-select"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves custom subtype identity when explicitly clearing its material without a catalog", async () => {
    const value = clinicalDraftFromCase({ restorations: [{
      restorationType: "My custom removable appliance",
      restorationSubtype: "removable/custom:subtype-id/custom:material-id",
      material: "Specialty multilayer material",
    }] });
    const onChange = vi.fn();
    const view = await render(<CaseClinicalEditor {...props} value={value} onChange={onChange} />);
    await fireEvent.press(view.getByTestId("clinical-case-material-select"));
    await fireEvent.press(view.getByTestId("clinical-case-material-"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      restorationType: value.restorationType, restorationSubtype: "removable/custom:subtype-id", material: "",
    }));
  });

  it("distinguishes an unmapped legacy material from None when explicitly clearing the draft", async () => {
    const legacy = { restorations: [{ ...source.restorations[0],
      restorationSubtype: "restorative/implant", material: "Retired proprietary ceramic",
    }] };
    const value = clinicalDraftFromCase(legacy);
    const onChange = vi.fn();
    const view = await render(<CaseClinicalEditor {...props} value={value} onChange={onChange} />);
    expect(view.getByTestId("clinical-case-material-value").props.children).toBe("Retired proprietary ceramic");
    await fireEvent.press(view.getByTestId("clinical-case-material-select"));
    expect(view.getByTestId("clinical-case-material-").props.accessibilityState.selected).toBe(false);
    await fireEvent.press(view.getByTestId("clinical-case-material-"));
    expect(onChange).toHaveBeenCalledOnce();
    expect(buildClinicalPayload(legacy, onChange.mock.calls[0][0], true)).toMatchObject({ material: null });
  });

  it("does not invent a saved choice for empty or mixed cases", async () => {
    const onChange = vi.fn();
    const view = await render(<CaseClinicalEditor {...props} empty value={clinicalDraftFromCase({ restorations: [] })} onChange={onChange} />);
    expect(view.getByTestId("clinical-case-type-value").props.children).toBe("—");
    await view.rerender(<CaseClinicalEditor {...props} mixed value={clinicalDraftFromCase(source)} onChange={onChange} />);
    for (const id of ["case-type", "subtype", "case-material"]) {
      expect(view.getByTestId(`clinical-${id}-value`).props.children).toBe("Multiple");
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps Step read-only for a lab editor and exposes only readable values for a read-only hierarchy", async () => {
    const onChange = vi.fn();
    const value = clinicalDraftFromCase({ step: "wax_setup", stepShade: "A2",
      restorations: [{ restorationType: "Full Denture", material: "Acrylic", arch: "upper" }] });
    const view = await render(<CaseClinicalEditor {...props} canEditStep={false} value={value} onChange={onChange} />);
    expect(view.queryByTestId("clinical-step-select")).toBeNull();
    expect(view.getByTestId("clinical-step-value").props.children).toBe("Wax Setup");
    expect(view.getByTestId("clinical-stepShade").props.children).toBe("A2");
    await view.rerender(<CaseClinicalEditor {...props} canEditStep={false} canEditHierarchy={false} value={value} onChange={onChange} />);
    expect(view.queryAllByRole("button")).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("distinguishes unmapped legacy rows, and uses actual custom labels when catalog options arrive", () => {
    expect(hasMixedCaseHierarchy([{ restorationType: "Historical One", material: "Old material" },
      { restorationType: "Historical Two", material: "Old material" }])).toBe(true);
    expect(hasMixedCaseHierarchy([{ restorationType: "Crown", material: "Unknown one" },
      { restorationType: "Crown", material: "Unknown two" }])).toBe(true);
    const saved = { restorationType: "Custom appliance", restorationSubtype: "removable/custom:sub/custom:mat", material: "Saved custom resin" };
    const catalog: CatalogTreeResult["data"] = { labOrganizationId: "lab", caseTypes: [{
      key: "removable", label: "Removable", subtypes: [{
        key: "custom:sub", label: "Updated custom appliance", id: "sub", isActive: true, isCustom: true, sortOrder: 0, priceKey: null,
        materials: [{ key: "custom:mat", label: "Updated custom resin", id: "mat", isActive: true, isCustom: true, sortOrder: 0, priceKey: null }],
      }],
    }] };
    expect(caseHierarchyLabels(deriveCaseHierarchy(saved.restorationType, saved.restorationSubtype, saved.material), saved, catalog))
      .toMatchObject({ subtype: "Updated custom appliance", material: "Updated custom resin" });
  });
});
