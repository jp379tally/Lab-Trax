import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react-native";
import { setMockSearchParams } from "../../../vitest.setup";

import CaseDetailScreen from "@/app/case/[id]";

beforeEach(() => {
  setMockSearchParams({ id: "nonexistent-case-id" });
});

afterEach(() => {
  setMockSearchParams({});
});

describe("CaseDetailScreen (smoke)", () => {
  it("renders without throwing when the case id does not match anything in state", () => {
    expect(() => render(<CaseDetailScreen />)).not.toThrow();
  });

  it('renders the "Case not found" empty state for an unknown id', () => {
    const { getByText } = render(<CaseDetailScreen />);
    expect(getByText("Case not found")).toBeTruthy();
  });
});
