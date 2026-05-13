import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react-native";

import CasesScreen from "@/app/(tabs)/cases";

describe("CasesScreen (smoke)", () => {
  it("renders without throwing when the case list is empty", () => {
    expect(() => render(<CasesScreen />)).not.toThrow();
  });

  it("produces a non-empty rendered tree on mount", () => {
    const { toJSON } = render(<CasesScreen />);
    expect(toJSON()).not.toBeNull();
  });

  it('renders the "Cases" header', () => {
    const { getAllByText } = render(<CasesScreen />);
    expect(getAllByText("Cases").length).toBeGreaterThan(0);
  });
});
