import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockSearchParams,
} from "../../../vitest.setup";

import CaseDetailScreen from "@/app/case/[id]";
import {
  completedCaseWithInvoice,
  inProgressCase,
  sampleInvoice,
} from "./__fixtures__/cases";

afterEach(() => {
  cleanup();
  setMockSearchParams({});
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("CaseDetailScreen (read-only viewer)", () => {
  describe("when the case id does not match anything", () => {
    beforeEach(() => {
      setMockSearchParams({ id: "nonexistent-case-id" });
    });

    it("renders without throwing", () => {
      expect(() => render(<CaseDetailScreen />)).not.toThrow();
    });

    it("renders the unable-to-load empty state", () => {
      const { getByText } = render(<CaseDetailScreen />);
      expect(getByText("Unable to load this case")).toBeTruthy();
    });
  });

  describe("with a normal in-progress case", () => {
    beforeEach(() => {
      setMockSearchParams({ id: inProgressCase.id });
      setMockAppState({ cases: [inProgressCase], invoices: [] });
    });

    it("renders without throwing", () => {
      expect(() => render(<CaseDetailScreen />)).not.toThrow();
    });

    it("renders the case header (case number + patient)", () => {
      const { getAllByText } = render(<CaseDetailScreen />);
      expect(getAllByText(/#5001/).length).toBeGreaterThan(0);
      expect(getAllByText(/Jane Doe/).length).toBeGreaterThan(0);
    });

    it("shows patient and doctor in the default overview section", () => {
      const { getAllByText } = render(<CaseDetailScreen />);
      expect(getAllByText(/Jane Doe/).length).toBeGreaterThan(0);
      expect(getAllByText(/Dr. Smith/).length).toBeGreaterThan(0);
    });

    it("shows notes when the Notes section is selected", () => {
      const { getByTestId, getAllByText } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-notes"));
      expect(getAllByText(/Initial impression looks good/).length).toBeGreaterThan(0);
    });

    it("shows restoration material when the Restorations section is selected", () => {
      const { getByTestId, getAllByText } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-restorations"));
      expect(getAllByText(/Zirconia/).length).toBeGreaterThan(0);
    });

    it("shows history events when the History section is selected", () => {
      const { getByTestId, getAllByText } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-history"));
      expect(getAllByText(/Status Change/).length).toBeGreaterThan(0);
    });
  });

  describe("with a completed case that has a real invoice", () => {
    beforeEach(() => {
      setMockSearchParams({ id: completedCaseWithInvoice.id });
      setMockAppState({
        cases: [completedCaseWithInvoice],
        invoices: [sampleInvoice],
      });
    });

    it("renders without throwing for a paid invoice attached to a complete case", () => {
      expect(() => render(<CaseDetailScreen />)).not.toThrow();
    });

    it("renders the completed case number in the header", () => {
      const { getAllByText } = render(<CaseDetailScreen />);
      expect(getAllByText(/#5002/).length).toBeGreaterThan(0);
    });

    it("shows the invoice number when the Invoice section is selected", () => {
      const { getByTestId, getByText } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-invoice"));
      expect(getByText(/Invoice #INV-2024-002/)).toBeTruthy();
    });
  });
});
