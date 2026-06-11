import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react-native";
import { router } from "expo-router";
import { resetMockAppState, setMockAppState } from "../../../vitest.setup";

import CasesListScreen from "@/app/(tabs)/index";
import { completedCaseWithInvoice, inProgressCase } from "./__fixtures__/cases";

afterEach(() => {
  resetMockAppState();
  vi.clearAllMocks();
});

describe("CasesListScreen (read-only canonical list)", () => {
  it("renders without throwing when the case list is empty", () => {
    expect(() => render(<CasesListScreen />)).not.toThrow();
  });

  it('renders the "Cases" header and the empty state', () => {
    const { getByText } = render(<CasesListScreen />);
    expect(getByText("Cases")).toBeTruthy();
    expect(getByText("No cases yet")).toBeTruthy();
  });

  describe("with a populated case list", () => {
    beforeEach(() => {
      setMockAppState({ cases: [inProgressCase, completedCaseWithInvoice] });
    });

    it("renders patient names and case numbers from canonical data", () => {
      const { getByText, getAllByText } = render(<CasesListScreen />);
      expect(getByText("Jane Doe")).toBeTruthy();
      expect(getByText("John Roe")).toBeTruthy();
      expect(getAllByText(/#5001/).length).toBeGreaterThan(0);
      expect(getAllByText(/#5002/).length).toBeGreaterThan(0);
    });

    it("shows the case count in the header", () => {
      const { getByText } = render(<CasesListScreen />);
      expect(getByText("2 cases")).toBeTruthy();
    });

    it("navigates to the case detail route when a row is pressed", () => {
      const { getByTestId } = render(<CasesListScreen />);
      fireEvent.press(getByTestId(`case-row-${inProgressCase.id}`));
      expect(router.push).toHaveBeenCalledWith(`/case/${inProgressCase.id}`);
    });
  });

  describe("in-memory search", () => {
    beforeEach(() => {
      setMockAppState({ cases: [inProgressCase, completedCaseWithInvoice] });
    });

    it("filters by case number", () => {
      const { getByTestId, queryAllByText } = render(<CasesListScreen />);
      fireEvent.changeText(getByTestId("cases-search"), "5002");
      expect(queryAllByText(/#5001/).length).toBe(0);
      expect(queryAllByText(/#5002/).length).toBeGreaterThan(0);
    });

    it("filters by doctor name", () => {
      const noMatchDoctor = {
        ...completedCaseWithInvoice,
        id: "case-other-doc",
        caseNumber: "5099",
        doctorName: "Dr. Nguyen",
      };
      setMockAppState({ cases: [inProgressCase, noMatchDoctor] });
      const { getByTestId, queryAllByText } = render(<CasesListScreen />);
      fireEvent.changeText(getByTestId("cases-search"), "Nguyen");
      expect(queryAllByText(/#5001/).length).toBe(0);
      expect(queryAllByText(/#5099/).length).toBeGreaterThan(0);
    });

    it("shows the no-results empty state when nothing matches", () => {
      const { getByTestId, getByText } = render(<CasesListScreen />);
      fireEvent.changeText(getByTestId("cases-search"), "zzz-nothing-matches");
      expect(getByText("No matching cases")).toBeTruthy();
    });
  });
});
