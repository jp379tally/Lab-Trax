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
    Text: asNative(Text),
    G: asNative(View),
  };
});

import { ReadOnlyToothChart } from "@/components/ReadOnlyToothChart";
import {
  getAdultToothPosition,
  getAdultToothRotation,
} from "@/components/ToothChart";

afterEach(async () => {
  await cleanup();
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
    expect(tooth1.y).toBeGreaterThan(tooth32.y);
    expect(getAdultToothRotation(8)).not.toBe(0);
    const toothOne = utils.getByLabelText("Tooth 1, crown, billed, selected");
    expect(toothOne.props.onPress).toBeUndefined();
    expect(utils.getByLabelText("Tooth 2, pontic")).toBeTruthy();
    expect(utils.getByLabelText("Tooth 3, missing")).toBeTruthy();
    expect(utils.getByLabelText("Connected teeth 1 and 2")).toBeTruthy();
    expect(utils.getByTestId("bridge-span-1-2")).toBeTruthy();
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
});
