/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToothActionDialog } from "@/components/ToothActionDialog";
import { ToothChart } from "@/components/ToothChart";

describe("indication workspace", () => {
  it("defaults to Crown, lists exact choices, and requires an arch for dentures", () => {
    const onConfirm = vi.fn();
    render(<ToothActionDialog toothId="5" restorations={[]} onClose={() => {}} onConfirm={onConfirm}
      materialOptions={[{ key: "zirc", label: "Zirconia" }]} />);
    expect(screen.getByRole("button", { name: "Crown" }).getAttribute("aria-pressed")).toBe("true");
    for (const n of ["Coping", "Overlay", "Pontic", "Diagnostic", "Inlay/Onlay", "Offset inlay", "Veneer", "Denture", "Partial denture", "Bite splint", "Primary telescopic crown", "Secondary telescopic crown", "Attachment", "Missing"])
      expect(screen.getByRole("button", { name: n })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Denture" }));
    expect(screen.queryByRole("button", { name: "Zirconia" })).toBeNull();
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "upper arch" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ kind: "add_crown", restorationType: "Denture", arch: "upper" }));
  });
  it("emits crown payload only on Confirm", () => {
    const onConfirm = vi.fn();
    render(<ToothActionDialog toothId="5" restorations={[]} onClose={() => {}} onConfirm={onConfirm} materialOptions={[{ key: "zirc", label: "Zirconia" }]} />);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Zirconia" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ kind: "add_crown", restorationType: "Crown", material: "Zirconia" }));
  });
});

describe("chart HUD", () => {
  it("lists missing teeth even when assignments omit them", () => {
    const { container } = render(<ToothChart value="" onChange={() => {}} missingTeeth={new Set(["9"])}
      assignments={[{ toothNumber: "3", restorationType: "Crown" }]} />);
    expect(container.querySelector('svg [data-hud-card="9"]')!.textContent).toContain("Type: Missing");
  });
  it("renders assignments inside the svg and calls onArchSelect", () => {
    const onArchSelect = vi.fn();
    const { container } = render(<ToothChart value="" onChange={() => {}} onArchSelect={onArchSelect}
      crownTeeth={new Set(["3", "4"])} assignments={[{ toothNumber: "3", restorationType: "Crown", material: "Zirconia", shade: "A2" }, { toothNumber: "4", restorationType: "Crown", material: "E.max", shade: "B1" }]} />);
    const hud = container.querySelector("svg [data-chart-hud]")!;
    expect(hud.textContent).toContain("Material: Zirconia");
    expect(hud.textContent).toContain("Material: E.max");
    expect(hud.textContent).not.toContain("Type: Missing");
    fireEvent.click(screen.getByRole("button", { name: "Select lower arch" }));
    expect(onArchSelect).toHaveBeenCalledWith("lower", expect.arrayContaining(["17", "32"]));
  });
});
