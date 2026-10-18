/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToothChart } from "@/components/ToothChart";

describe("desktop tooth chart approved oval layout", () => {
  it("renders all adult teeth in Universal-number order around one complete oval", () => {
    const { container } = render(<ToothChart value="" onChange={() => {}} />);
    const svg = container.querySelector("svg[viewBox='0 0 520 520']");
    const tooth = (id: string) =>
      container.querySelector(`[data-tooth-id="${id}"]`) as SVGSVGElement;

    expect(svg).not.toBeNull();
    expect(container.querySelectorAll("[data-tooth-id]")).toHaveLength(32);
    expect(Number(tooth("1").dataset.toothX)).toBeLessThan(Number(tooth("16").dataset.toothX));
    expect(Number(tooth("32").dataset.toothX)).toBeLessThan(Number(tooth("17").dataset.toothX));
    expect(Number(tooth("8").dataset.toothY)).toBeLessThan(Number(tooth("24").dataset.toothY));
    expect(Number(tooth("1").dataset.toothY)).toBeGreaterThan(Number(tooth("32").dataset.toothY));
    expect(tooth("8").dataset.toothRotation).not.toBe("0");
    expect(tooth("24").dataset.toothRotation).not.toBe("0");
    expect(screen.getByText("PATIENT RIGHT")).toBeInTheDocument();
    expect(screen.getByText("PATIENT LEFT")).toBeInTheDocument();
  });

  it("keeps crown, pontic, missing, selected, billed, and bridge roles legible", () => {
    const { container } = render(
      <ToothChart
        value="1, 2, 3, 4"
        onChange={() => {}}
        crownTeeth={new Set(["1"])}
        ponticTeeth={new Set(["2"])}
        missingTeeth={new Set(["3"])}
        billedTeeth={new Set(["4"])}
        connectedPairs={new Set(["1-2"])}
        onConnectedPairsChange={() => {}}
      />,
    );

    expect(container.querySelector('[data-tooth-id="1"]')?.getAttribute("data-tooth-role")).toBe("crown");
    expect(container.querySelector('[data-tooth-id="2"]')?.getAttribute("data-tooth-role")).toBe("pontic");
    expect(container.querySelector('[data-tooth-id="3"]')?.getAttribute("data-tooth-role")).toBe("missing");
    expect(container.querySelector('[data-tooth-id="4"]')?.getAttribute("data-tooth-billed")).toBe("true");
    expect(container.querySelector('[data-tooth-id="1"]')?.getAttribute("data-tooth-selected")).toBe("true");
    for (const label of ["Selected", "Crown", "Pontic", "Missing", "Billed", "Bridge"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(container.querySelector('[data-tooth-id="2"] path[stroke-dasharray="3 2"]')).not.toBeNull();
    expect(container.querySelector('[data-tooth-id="4"] path[stroke="#059669"]')).not.toBeNull();
  });

  it("retains tooth toggling and connector activation", () => {
    const onChange = vi.fn();
    const onConnectedPairsChange = vi.fn();
    const { container } = render(
      <ToothChart
        value=""
        onChange={onChange}
        crownTeeth={new Set(["1", "2"])}
        onConnectedPairsChange={onConnectedPairsChange}
      />,
    );

    fireEvent.click(container.querySelector('[data-tooth-id="1"]')!);
    expect(onChange).toHaveBeenCalledWith("1");

    fireEvent.click(screen.getByRole("button", { name: /Connect teeth 1 and 2/ }));
    expect(onConnectedPairsChange).toHaveBeenCalledWith(new Set(["1-2"]));
  });
});
