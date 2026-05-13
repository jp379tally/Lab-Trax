import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react-native";
import {
  resetMockAppState,
  setMockAppState,
} from "../../../vitest.setup";

import ScanScreen from "@/app/(tabs)/scan";
import { inProgressCase, sampleClient } from "./__fixtures__/cases";

afterEach(() => {
  cleanup();
  resetMockAppState();
});

describe("ScanScreen (smoke)", () => {
  it("renders without throwing on a fresh focus", () => {
    expect(() => render(<ScanScreen />)).not.toThrow();
  });

  it("produces a non-empty rendered tree on mount", () => {
    const { toJSON } = render(<ScanScreen />);
    expect(toJSON()).not.toBeNull();
  });

  it("renders without throwing when real cases are present in state", () => {
    setMockAppState({
      cases: [inProgressCase],
      clients: [sampleClient],
    });
    expect(() => render(<ScanScreen />)).not.toThrow();
  });
});
