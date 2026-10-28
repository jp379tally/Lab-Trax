/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToothActionDialog } from "@/components/ToothActionDialog";
import { getCatalogMaterialsForRestoration } from "@/components/CatalogRestorationPicker";
import type { CaseRestoration } from "@/lib/types";

function restoration(id: string, toothNumber: string): CaseRestoration {
  return {
    id,
    caseId: "case-1",
    toothNumber,
    restorationType: "Crown",
    restorationSubtype: "zirconia-layered",
    material: "Layered Zirconia",
    shade: "A3.5",
    quantity: 1,
    unitPrice: 200,
  };
}

const catalog = { caseTypes: [
  { id: null, key: "restorative", label: "Restorative", subtypes: [{ id: null, key: "crown", label: "Crown", materials: [{ id: null, key: "zirconia", label: "Zirconia" }] }] },
  { id: null, key: "removable", label: "Removable", subtypes: [{ id: null, key: "dentures", label: "Dentures", materials: [{ id: null, key: "acrylic", label: "Acrylic" }] }] },
] } as never;
const ALL = ["Crown", "Coping", "Overlay", "Pontic", "Diagnostic", "Inlay/Onlay", "Offset inlay", "Veneer", "Denture", "Partial denture", "Bite splint", "Primary telescopic crown", "Secondary telescopic crown", "Attachment", "Missing"];
const REMOVABLE = ["Denture", "Partial denture", "Bite splint", "Primary telescopic crown", "Secondary telescopic crown", "Attachment"];

describe("ToothActionDialog indication workspace", () => {
  it("shows every menu choice distinctly, hides retired choices, and stages Missing until Apply", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ToothActionDialog toothId="2" restorations={[]} onClose={onClose} onConfirm={onConfirm} />);
    for (const name of ALL) expect(screen.getAllByRole("button", { name })).toHaveLength(1);
    for (const old of ["Anatomical crown", "Reduced pontic", "Mockup", "Antagonist", "Bar pillar", "Full denture"]) expect(screen.queryByRole("button", { name: old })).toBeNull();
    expect(screen.getByRole("heading", { name: "Tooth 2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Missing" }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Missing" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply missing status" }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ kind: "mark_missing", toothId: "2" });
  });
  it("hides Missing when marking missing is not allowed", () => {
    render(<ToothActionDialog toothId="2" restorations={[]} allowMarkMissing={false} onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.queryByRole("button", { name: "Missing" })).toBeNull();
  });
  it("opens unassigned teeth on Crown with the case shade and catalog materials ready", () => {
    render(<ToothActionDialog toothId="6" caseShade="A2" restorations={[]} catalog={catalog} onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByRole("button", { name: "Crown" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Zirconia" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Use case shade · A2" })).toHaveClass("border-primary");
  });
  it("opens assigned teeth on the stored type, material and shade and preserves them on shade-only edit", () => {
    const onConfirm = vi.fn();
    render(<ToothActionDialog toothId="8" caseShade="A2"
      restorations={[{ ...restoration("veneer-8", "8"), restorationType: "Veneer", restorationSubtype: "restorative/crown_and_bridge/emax", material: "e.max", shade: "A1" }]}
      materialOptions={[{ key: "emax", label: "E.max / Lithium Disilicate" }]} onClose={() => {}} onConfirm={onConfirm} />);
    expect(screen.getByRole("button", { name: "Veneer" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "A1" })).toHaveClass("border-primary");
    fireEvent.click(screen.getByRole("button", { name: "B1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      kind: "replace_tooth", restorationId: "veneer-8", role: "Veneer",
      restorationSubtype: "restorative/crown_and_bridge/emax", material: "e.max", shade: "B1",
    }));
  });
  it("assigns a veneer with explicit product and shade", () => {
    const onConfirm = vi.fn();
    render(<ToothActionDialog toothId="8" restorations={[]} caseShade="A2"
      materialOptions={[{ key: "restorative/crown_and_bridge/emax", label: "e.max" }]} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Veneer" }));
    fireEvent.click(screen.getByRole("button", { name: "e.max" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ kind: "add_crown", restorationType: "Veneer", toothId: "8", material: "e.max", shade: "A2" }));
  });
  it("keeps crown materials selectable when the catalog is unavailable", () => {
    const materialOptions = getCatalogMaterialsForRestoration(undefined, { restorationType: "Crown", material: "Legacy Ceramic" });
    render(<ToothActionDialog toothId="14" restorations={[]} materialOptions={materialOptions} onClose={() => {}} onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Zirconia" }));
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
  });
  it("never offers crown materials for removable choices, and uses their own catalog materials", () => {
    const materialOptions = [{ key: "zirconia", label: "Zirconia" }];
    const { unmount } = render(<ToothActionDialog toothId="6" restorations={[]} catalog={catalog} materialOptions={materialOptions} selectionArch="upper" onClose={() => {}} onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Denture" }));
    expect(screen.getByRole("button", { name: "Acrylic" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Zirconia" })).toBeNull();
    unmount();
    render(<ToothActionDialog toothId="6" restorations={[]} materialOptions={materialOptions} onClose={() => {}} onConfirm={() => {}} />);
    // Telescopic crowns resolve to the restorative crown context in the shared module, so they keep crown materials.
    for (const name of REMOVABLE.filter((n) => !/telescopic/.test(n))) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(screen.queryByRole("button", { name: "Zirconia" })).toBeNull();
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
    }
  });
  it("requires an explicit arch for arch-based choices and emits one arch payload; selectionArch preselects", () => {
    const onConfirm = vi.fn();
    render(<ToothActionDialog toothId="6" restorations={[]} catalog={catalog} selectedTeeth={["1", "2"]} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Denture" }));
    fireEvent.click(screen.getByRole("button", { name: "Acrylic" }));
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "lower arch" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ kind: "add_crown", restorationType: "Denture", arch: "lower", material: "Acrylic" }));
  });
  it("opens the matching arch row only for a whole-arch selection, not a single-tooth click", () => {
    const row = { ...restoration("d1", ""), restorationType: "Denture", restorationSubtype: null, material: "Acrylic", shade: "A2", arch: "upper" as const, quantity: 1 };
    const full = Array.from({ length: 16 }, (_, i) => String(i + 1));
    const onConfirm = vi.fn();
    const { unmount } = render(<ToothActionDialog toothId="1" restorations={[row]} catalog={catalog} selectionArch="upper" selectedTeeth={full} onClose={() => {}} onConfirm={onConfirm} />);
    expect(screen.getByRole("button", { name: "Denture" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "upper arch" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ kind: "replace_tooth", restorationId: "d1", role: "Denture", arch: "upper" }));
    unmount();
    render(<ToothActionDialog toothId="1" restorations={[row]} catalog={catalog} selectedTeeth={["1"]} onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByRole("button", { name: "Crown" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });
  it("keeps saved legacy fixed types visible and editable, and derives arch legacy categories", () => {
    const legacy = { ...restoration("p1", "8"), restorationType: "Pressed crown", restorationSubtype: null, material: "Press" };
    const { unmount } = render(<ToothActionDialog toothId="8" restorations={[legacy]} catalog={catalog} onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByRole("button", { name: "Pressed crown" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Crown" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    unmount();
    const arch = { ...restoration("a1", ""), restorationType: "Removable", restorationSubtype: "removable/dentures", material: "Acrylic", shade: "A2", arch: "lower" as const, quantity: 1 };
    const onConfirm = vi.fn();
    const full = Array.from({ length: 16 }, (_, i) => String(i + 17));
    render(<ToothActionDialog toothId="17" restorations={[arch]} catalog={catalog} selectionArch="lower" selectedTeeth={full} materialOptions={[{ key: "zirconia", label: "Zirconia" }]} onClose={() => {}} onConfirm={onConfirm} />);
    expect(screen.getByRole("button", { name: "Denture" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Zirconia" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ restorationId: "a1", role: "Denture", arch: "lower", restorationSubtype: "removable/dentures" }));
  });
  it("keeps custom catalog material ids as encoded custom tokens", () => {
    const custom = { caseTypes: [{ id: null, key: "restorative", label: "R", subtypes: [{ id: null, key: "crown", label: "Crown", materials: [{ id: "m-77", key: "house-zr", label: "House Zr", isCustom: true }] }] }] } as never;
    const onConfirm = vi.fn();
    render(<ToothActionDialog toothId="6" restorations={[]} catalog={custom} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "House Zr" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm.mock.calls[0][0].restorationSubtype).toContain("m-77");
  });
  it("preselects selectionArch", () => {
    render(<ToothActionDialog toothId="6" restorations={[]} catalog={catalog} selectionArch="upper" onClose={() => {}} onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Partial denture" }));
    expect(screen.getByRole("button", { name: "upper arch" })).toHaveAttribute("aria-pressed", "true");
  });
  it("cancels an in-progress assignment without applying it", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<ToothActionDialog toothId="6" caseShade="A2" restorations={[]} materialOptions={getCatalogMaterialsForRestoration(undefined, { restorationType: "Crown", material: "Zirconia" })} onClose={onClose} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Zirconia" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
  it("shows pending errors and disables Confirm while pending", () => {
    render(<ToothActionDialog toothId="6" restorations={[]} materialOptions={[{ key: "z", label: "Zirconia" }]} error="Save failed" isPending onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("requires confirmation before copy replaces an assigned tooth", () => {
    const onConfirm = vi.fn();
    render(
      <ToothActionDialog
        toothId="2"
        restorations={[restoration("rest-2", "2"), restoration("rest-4", "4")]}
        materialOptions={[{ key: "zirconia-layered", label: "Layered Zirconia" }]}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    const targets = screen.getByRole("textbox", { name: /copy assignment to teeth/i });
    fireEvent.change(targets, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: /apply copied values to teeth/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Review before replacing: #4.");
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /keep current assignments/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /apply copied values to teeth/i }));

    fireEvent.click(screen.getByRole("button", { name: /replace selected/i }));
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "copy_assignment",
      restorationId: "rest-2",
      toothNumbers: ["4"],
    });
  });
});