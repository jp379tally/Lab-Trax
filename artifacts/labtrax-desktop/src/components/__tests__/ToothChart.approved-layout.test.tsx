/** @vitest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToothChart } from "@/components/ToothChart";
import { CaseChartPanes, RestorationSummaryPane } from "@/components/CaseChartPanes";
import { adultToothGeometry, connectorGeometry, CONNECTOR_HIT_RADIUS, CHART } from "@/lib/tooth-geometry";

describe("desktop reference-derived anatomical tooth chart", () => {
  it("includes one arch restoration in chart totals and names its arch in the neighboring summary", () => {
    const rows = [
      { toothNumber: "2", restorationType: "Crown", material: "Zirconia", shade: "A2", quantity: 1 },
      { toothNumber: "", restorationType: "Denture", material: "Acrylic", arch: "upper", quantity: 1 },
    ];
    const { container } = render(<CaseChartPanes
      label="Restoration workspace"
      details={null}
      chart={<ToothChart value="" onChange={() => {}} crownTeeth={new Set(["2"])} assignments={rows} />}
      summary={<RestorationSummaryPane headline="2 units" bridgeLabels={[]} rows={rows} />}
    />);
    expect(container.querySelector('[aria-label="Restoration totals"]')!.textContent).toContain("2Units");
    expect(container.querySelector('[aria-label="Restoration totals"]')!.textContent).toContain("1Crowns");
    expect(within(screen.getByRole("complementary", { name: "Restoration summary" })).getByText("Upper arch")).toBeTruthy();
    expect(screen.getAllByText("Denture").length).toBeGreaterThan(0);
  });

  it("derives the reference bridge HUD from connected crowns and pontics, excluding Missing", () => {
    const { container } = render(<ToothChart value="" onChange={() => {}} crownTeeth={new Set(["2", "4"])}
      ponticTeeth={new Set(["3"])} missingTeeth={new Set(["8"])} connectedPairs={new Set(["2-3", "3-4"])} />);
    const totals = container.querySelector('[aria-label="Restoration totals"]')!;
    expect(totals.textContent).toBe("3Units2Crowns1Pontics1Bridges");
    expect(container.querySelectorAll('[data-tooth-role="crown"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-tooth-role="pontic"]')).toHaveLength(1);
  });
  it("renders all adult teeth in Universal-number order around one complete oval", () => {
    const { container } = render(<ToothChart value="" onChange={() => {}} />);
    const svg = container.querySelector("svg[viewBox='0 -14 400 514']");
    const tooth = (id: string) =>
      container.querySelector(`[data-tooth-id="${id}"]`) as SVGSVGElement;

    expect(svg).not.toBeNull();
    expect(container.querySelectorAll("[data-tooth-id]")).toHaveLength(32);
    expect(container.querySelectorAll("[data-tooth-sprite]")).toHaveLength(32);
    expect(tooth("1").querySelector("image")?.getAttribute("href")).toContain("tooth-atlas");
    expect(tooth("8").querySelector("image")?.getAttribute("href")).toContain("tooth-atlas");
    expect(tooth("1").querySelector("svg")?.getAttribute("viewBox"))
      .not.toBe(tooth("8").querySelector("svg")?.getAttribute("viewBox"));
    expect(Number(tooth("1").dataset.toothX)).toBeLessThan(Number(tooth("16").dataset.toothX));
    expect(Number(tooth("32").dataset.toothX)).toBeLessThan(Number(tooth("17").dataset.toothX));
    expect(Number(tooth("8").dataset.toothY)).toBeLessThan(Number(tooth("24").dataset.toothY));
    expect(Number(tooth("1").dataset.toothY)).toBeLessThan(Number(tooth("32").dataset.toothY));
    expect(Number(tooth("1").dataset.toothY)).toBeLessThan(260);
    expect(Number(tooth("32").dataset.toothY)).toBeGreaterThan(260);
    // The reference crops already contain the anatomical perspective; rotating them a second time distorts it.
    expect(Number(tooth("1").dataset.toothRotation)).toBe(0);
    expect(Number(tooth("32").dataset.toothRotation)).toBe(0);
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
    // The legend now lives inside the chart SVG, between the arches.
    const hud = container.querySelector("svg [data-chart-hud]")!;
    for (const label of ["Units", "Crowns", "Pontics", "Bridges"]) expect(hud.textContent).toContain(label);
    expect(container.querySelector("svg [data-hud-card]")).not.toBeNull();
    expect(container.querySelectorAll("div.tooth-chart-shell > div[aria-label='Restoration totals']")).toHaveLength(0);
    expect(container.querySelector('[data-tooth-id="2"] ellipse[stroke-dasharray="3 2"]')).not.toBeNull();
    expect(container.querySelector('[data-tooth-id="4"] [data-billed-indicator="true"][fill="#059669"]')).not.toBeNull();
    expect(container.querySelector('[data-tooth-id="1"] [data-selection-ring="true"]')).not.toBeNull();
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

  it("forwards Ctrl/Shift modifiers and blocks an incompatible connector", () => {
    const onToothClick = vi.fn();
    const onConnectedPairsChange = vi.fn();
    const { container } = render(
      <ToothChart
        value=""
        onChange={() => {}}
        onToothClick={onToothClick}
        crownTeeth={new Set(["2", "3"])}
        blockedConnectorPairs={new Set(["2-3"])}
        onConnectedPairsChange={onConnectedPairsChange}
      />,
    );

    fireEvent.click(container.querySelector('[data-tooth-id="4"]')!, {
      ctrlKey: true,
      shiftKey: true,
    });
    expect(onToothClick).toHaveBeenCalledWith("4", {
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    });
    const blocked = screen.getByRole("button", {
      name: /connector between teeth 2 and 3 is blocked/i,
    });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(blocked);
    expect(onConnectedPairsChange).not.toHaveBeenCalled();
  });

  it("allows an invalid active connector to be disconnected", () => {
    const onConnectedPairsChange = vi.fn();
    render(
      <ToothChart
        value=""
        onChange={() => {}}
        crownTeeth={new Set(["2", "3"])}
        connectedPairs={new Set(["2-3"])}
        blockedConnectorPairs={new Set(["2-3"])}
        onConnectedPairsChange={onConnectedPairsChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: /connector between teeth 2 and 3 is blocked/i,
    }));
    expect(onConnectedPairsChange).toHaveBeenCalledWith(new Set());
  });

  it("keeps automatically suggested active bridge markers green and explicitly labeled", () => {
    const { container, getByRole } = render(<ToothChart
      value="" onChange={vi.fn()} onConnectedPairsChange={vi.fn()}
      crownTeeth={new Set(["2"])} ponticTeeth={new Set(["3"])}
      connectedPairs={new Set(["2-3"])} connectorSuggestions={new Set(["2-3"])}
    />);
    expect(container.querySelector('circle[fill="#22C55E"]')).not.toBeNull();
    expect(getByRole("button", { name: /Suggested connector between teeth 2 and 3/ })).toBeTruthy();
  });

  it("lays out a portrait oval with differentiated, non-overlapping teeth", () => {
    expect(CHART.height).toBeGreaterThan(CHART.width);
    expect(adultToothGeometry(8).width).toBeLessThan(adultToothGeometry(3).width);
    expect(adultToothGeometry(6).form).toBe("canine");
    expect(adultToothGeometry(19).form).toBe("molar");
    expect(adultToothGeometry(22).form).toBe("canine");
    for (const [from, to] of [[1, 16], [17, 32]]) {
      for (let n = from; n < to; n++) {
        const a = adultToothGeometry(n);
        const b = adultToothGeometry(n + 1);
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        expect(dist).toBeGreaterThan((a.width + b.width) / 2 - 3);
      }
    }
    for (let n = 1; n <= 32; n++) {
      const g = adultToothGeometry(n);
      expect(g.x - g.width).toBeGreaterThan(0);
      expect(g.x + g.width).toBeLessThan(CHART.width);
      expect(g.y - g.height / 2).toBeGreaterThan(0);
      expect(g.y + g.height / 2).toBeLessThan(CHART.height);
    }
  });

  it("keeps numbers upright and readable, with distinct selection and V role badge", () => {
    const { container } = render(
      <ToothChart value="5" onChange={() => {}} veneerTeeth={new Set(["8"])} crownTeeth={new Set(["6"])} onToothClick={() => {}} />,
    );
    const numbers = container.querySelectorAll("[data-tooth-number]");
    expect(numbers).toHaveLength(32);
    numbers.forEach((text) => {
      expect(text.getAttribute("transform")).toBeNull();
      // 400-unit canvas on a 350px phone: >= 13px.
      expect(Number(text.getAttribute("font-size")) * (350 / 400)).toBeGreaterThanOrEqual(13);
    });
    expect(container.querySelector('[data-tooth-id="8"]')?.getAttribute("data-tooth-role")).toBe("veneer");
    expect(container.querySelector('[data-tooth-id="8"] [data-tooth-badge="V"]')).not.toBeNull();
    expect(container.querySelector('[data-tooth-id="6"] [data-tooth-badge="C"]')).not.toBeNull();
    expect(container.querySelector("svg [data-chart-hud]")!.textContent).toContain("2Units");
    // Selection draws an outline but does not change the assigned role.
    expect(container.querySelector('[data-tooth-id="5"] [data-selection-ring="true"]')).not.toBeNull();
    expect(container.querySelector('[data-tooth-id="5"]')?.getAttribute("data-tooth-role")).toBe("unassigned");
    expect(container.querySelector('[data-tooth-id="6"] [data-selection-ring="true"]')).toBeNull();
    expect(container.querySelectorAll('[data-tooth-id="5"] [data-tooth-sprite] image')).toHaveLength(1);
  });

  it("places 30px connector targets at adjacent contacts, away from the tooth numbers", () => {
    const { container } = render(
      <ToothChart value="" onChange={() => {}} crownTeeth={new Set(["2", "3"])} onConnectedPairsChange={() => {}} />,
    );
    const hit = container.querySelector('[data-connector="2-3"] [data-connector-hit]')!;
    expect(Number(hit.getAttribute("r")) * 2).toBeGreaterThanOrEqual(30);
    const c = connectorGeometry(2, 3);
    const a = adultToothGeometry(2);
    const b = adultToothGeometry(3);
    // Connectors sit just outside the arch in the gap between neighbours, on the outward side.
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    expect(Math.hypot(c.x - mx, c.y - my)).toBeGreaterThan(15);
    expect(Math.hypot(c.x - mx, c.y - my)).toBeLessThanOrEqual(30);
    expect(c.x).toBeLessThan(mx); // patient-right side of the upper arch: outside = viewer-left
    for (const n of [2, 3]) {
      const g = adultToothGeometry(n);
      expect(Math.hypot(c.x - g.x, c.y - g.y)).toBeGreaterThan(12);
    }
    expect(CONNECTOR_HIT_RADIUS).toBe(15);
  });
});
