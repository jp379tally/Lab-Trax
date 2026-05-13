import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react-native";
import {
  resetMockAppState,
  setMockAppState,
} from "../../../vitest.setup";

import CasesScreen from "@/app/(tabs)/cases";
import {
  completedCaseWithInvoice,
  inProgressCase,
  sampleClient,
  sampleInvoice,
} from "./__fixtures__/cases";

afterEach(() => {
  resetMockAppState();
});

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

  describe("with a populated case list", () => {
    beforeEach(() => {
      setMockAppState({
        cases: [inProgressCase, completedCaseWithInvoice],
        invoices: [sampleInvoice],
        clients: [sampleClient],
      });
    });

    it("renders without throwing when real cases are present", () => {
      expect(() => render(<CasesScreen />)).not.toThrow();
    });

    it("renders the case numbers from state", () => {
      const { getAllByText } = render(<CasesScreen />);
      expect(getAllByText(/#5001/).length).toBeGreaterThan(0);
      expect(getAllByText(/#5002/).length).toBeGreaterThan(0);
    });
  });
});
