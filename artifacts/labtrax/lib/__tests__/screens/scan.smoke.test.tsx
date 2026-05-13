import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react-native";

import ScanScreen from "@/app/(tabs)/scan";

describe("ScanScreen (smoke)", () => {
  it("renders without throwing on a fresh focus", () => {
    expect(() => render(<ScanScreen />)).not.toThrow();
  });

  it("produces a non-empty rendered tree on mount", () => {
    const { toJSON } = render(<ScanScreen />);
    expect(toJSON()).not.toBeNull();
  });
});
