import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react-native";
import { Alert } from "react-native";
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
  vi.clearAllMocks();
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

  describe("long-press locate", () => {
    beforeEach(() => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        clients: [],
      });
    });

    it("fires Alert with 'Locate Case' title on long-press of a case card", () => {
      const { getByTestId } = render(<CasesScreen />);
      const card = getByTestId(`case-card-${inProgressCase.id}`);
      fireEvent(card, "longPress");
      expect(Alert.alert).toHaveBeenCalledWith(
        "Locate Case",
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ text: "No" }),
          expect.objectContaining({ text: "Yes" }),
        ]),
      );
    });

    it("pressing Yes on the alert opens the locate modal with patient name and case number", async () => {
      const { getByTestId, queryAllByText } = render(<CasesScreen />);

      expect(queryAllByText(/Jane Doe \(#5001\)/).length).toBe(0);

      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");

      const alertCall = (Alert.alert as ReturnType<typeof vi.fn>).mock.calls[0];
      const buttons: Array<{ text: string; onPress?: () => void }> = alertCall[2];
      const yesBtn = buttons.find((b) => b.text === "Yes");
      expect(yesBtn).toBeDefined();

      await act(async () => {
        yesBtn!.onPress?.();
      });

      expect(queryAllByText(/Jane Doe \(#5001\)/).length).toBeGreaterThan(0);
    });

    it("pressing No on the alert does not open the locate modal", async () => {
      const { getByTestId, queryAllByText } = render(<CasesScreen />);

      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");

      const alertCall = (Alert.alert as ReturnType<typeof vi.fn>).mock.calls[0];
      const buttons: Array<{ text: string; onPress?: () => void; style?: string }> = alertCall[2];
      const noBtn = buttons.find((b) => b.text === "No");
      expect(noBtn).toBeDefined();

      await act(async () => {
        noBtn!.onPress?.();
      });

      expect(queryAllByText(/Jane Doe \(#5001\)/).length).toBe(0);
    });
  });
});
