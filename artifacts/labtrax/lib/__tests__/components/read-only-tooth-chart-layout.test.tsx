import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react-native/pure";

vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({
    colors: {
      tint: "#2563EB",
      text: "#111827",
      textSecondary: "#475569",
      textTertiary: "#64748B",
      errorText: "#B91C1C",
      success: "#16A34A",
    },
  }),
}));

vi.unmock("@/components/ReadOnlyToothChart");
vi.unmock("@/components/ToothChart");

vi.mock("react-native-svg", async () => {
  const ReactModule = await import("react");
  const { View, Text } = await import("react-native");
  const asNative = (Component: React.ElementType) =>
    (props: Record<string, unknown>) =>
      ReactModule.createElement(
        Component,
        props,
        props.children as React.ReactNode,
      );
  return {
    default: asNative(View),
    Path: asNative(View),
    Circle: asNative(View),
    Ellipse: asNative(View),
    Image: asNative(View),
    Text: asNative(Text),
    G: asNative(View),
  };
});

import { ReadOnlyToothChart } from "@/components/ReadOnlyToothChart";
import { adultToothGeometry, connectorGeometry, CHART, CONNECTOR_RADIUS } from "@/lib/tooth-geometry";
import {
  getAdultToothPosition,
  getAdultToothRotation,
} from "@/components/ToothChart";

afterEach(async () => {
  await cleanup();
});

it("counts a veneer without mislabeling it as a crown", async () => {
  const view = await render(<ReadOnlyToothChart veneerTeeth={new Set(["8"])} />);
  // Counts appear in the legend and again inside the chart between the arches.
  expect(view.getAllByText("1 veneer").length).toBeGreaterThanOrEqual(2);
});

describe("mobile read-only tooth chart approved oval layout", () => {
  it("uses the full Universal-number oval and keeps read-only roles accessible", async () => {
    const utils = await render(
      <ReadOnlyToothChart
        crownTeeth={new Set(["1"])}
        ponticTeeth={new Set(["2"])}
        missingTeeth={new Set(["3"])}
        billedTeeth={new Set(["1"])}
        selected={new Set(["1"])}
        connectedPairs={new Set(["1-2"])}
        summaryText="2 units · 1 connected group"
      />,
    );

    const tooth1 = getAdultToothPosition(1);
    const tooth16 = getAdultToothPosition(16);
    const tooth32 = getAdultToothPosition(32);
    const tooth17 = getAdultToothPosition(17);
    const tooth8 = getAdultToothPosition(8);
    const tooth24 = getAdultToothPosition(24);

    expect(tooth1.x).toBeLessThan(tooth16.x);
    expect(tooth32.x).toBeLessThan(tooth17.x);
    expect(tooth8.y).toBeLessThan(tooth24.y);
    expect(tooth1.y).toBeLessThan(tooth32.y);
    // Perspective is baked into the reference image, not applied twice by the renderer.
    expect(getAdultToothRotation(1)).toBe(0);
    const toothOne = utils.getByLabelText("Tooth 1, crown, billed, selected");
    expect(toothOne.props.onPress).toBeUndefined();
    expect(utils.getByLabelText("Tooth 2, pontic")).toBeTruthy();
    expect(utils.getByLabelText("Tooth 3, missing")).toBeTruthy();
    expect(utils.getByLabelText("Connected teeth 1 and 2")).toBeTruthy();
    const marker = connectorGeometry(1, 2);
    expect(utils.getByTestId("connector-marker-1-2").props)
      .toMatchObject({ cx: marker.x, cy: marker.y, r: CONNECTOR_RADIUS, fill: "#16A34A" });
    // One edge has one marker; bars join neighboring markers, not tooth bodies.
    expect(utils.queryByTestId("bridge-span-1-2")).toBeNull();
    expect(utils.getByText("PATIENT RIGHT")).toBeTruthy();
    expect(utils.getByText("PATIENT LEFT")).toBeTruthy();
    expect(utils.getByText("2 units · 1 connected group")).toBeTruthy();
    expect(utils.queryByText("Hide large tooth controls")).toBeNull();
    expect(utils.getByText("Crown")).toBeTruthy();
    expect(utils.getByText("Pontic")).toBeTruthy();
    expect(utils.getByText("Missing")).toBeTruthy();
    expect(utils.getByText("Billed")).toBeTruthy();
    expect(utils.getByText("Bridge")).toBeTruthy();
  });

  it("joins consecutive bridge markers without dangling bars across tooth artwork", async () => {
    const view = await render(<ReadOnlyToothChart
      crownTeeth={new Set(["2", "4"])} ponticTeeth={new Set(["3"])}
      connectedPairs={new Set(["2-3", "3-4"])} />);
    const first = connectorGeometry(2, 3);
    const second = connectorGeometry(3, 4);
    expect(view.getByTestId("bridge-span-2-3").props.d)
      .toBe(`M ${first.x} ${first.y} L ${second.x} ${second.y}`);
    expect(view.queryByTestId("bridge-span-3-4")).toBeNull();
    expect(view.getByLabelText("Connected teeth 2 and 3").props.onPress).toBeUndefined();
  });

  it("draws differentiated teeth, a V veneer badge, readable numbers, and a selection ring distinct from role", async () => {
    const utils = await render(
      <ReadOnlyToothChart
        veneerTeeth={new Set(["8"])}
        crownTeeth={new Set(["6"])}
        selected={new Set(["5"])}
      />,
    );
    expect(utils.getByLabelText("Tooth 8, veneer")).toBeTruthy();
    expect(utils.getByText("V")).toBeTruthy();
    expect(utils.getByText("C")).toBeTruthy();
    expect(utils.getByTestId("tooth-selection-5")).toBeTruthy();
    expect(utils.queryByTestId("tooth-selection-6")).toBeNull();
    expect(utils.getByLabelText("Tooth 5, unassigned, selected")).toBeTruthy();
    expect(utils.getByText("8").props.fontSize).toBe(15);
    expect(15 * (350 / CHART.width)).toBeGreaterThanOrEqual(13);
    expect(adultToothGeometry(8).width).toBeLessThan(adultToothGeometry(3).width);
    expect(CHART.height).toBeGreaterThan(CHART.width);
    const c = connectorGeometry(2, 3);
    const a = adultToothGeometry(2);
    const b = adultToothGeometry(3);
    // Connectors sit just outside the arch in the gap between neighbours.
    const dist = Math.hypot(c.x - (a.x + b.x) / 2, c.y - (a.y + b.y) / 2);
    expect(dist).toBeGreaterThan(15);
    expect(dist).toBeLessThanOrEqual(30);
    for (const n of [2, 3]) {
      const g = adultToothGeometry(n);
      expect(Math.hypot(c.x - g.x, c.y - g.y)).toBeGreaterThan(12);
    }
  });
});
