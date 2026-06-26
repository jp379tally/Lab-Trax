/**
 * Unit tests for the draft-invoice preview on new-case.tsx.
 *
 * Invariants protected:
 *  - The read-only "Invoice preview" section renders line items, per-line
 *    amounts, "not priced" badges, and the total returned by the
 *    /invoices/preview-draft endpoint (mocked via usePreviewDraftInvoice).
 *  - The preview is hidden until at least one restoration has both a tooth
 *    number and a type (the same rows the case would be created with).
 *  - A failed preview shows a non-blocking fallback message.
 */

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react-native";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";

import NewCaseScreen from "@/app/new-case";

function seedEditableLab() {
  setMockAppState({
    meMemberships: [
      {
        id: "m1",
        role: "owner",
        status: "active",
        organizationId: "lab-1",
        organization: { id: "lab-1", name: "Acme Dental Lab", type: "lab" },
      },
    ],
  });
}

afterEach(() => {
  cleanup();
  resetMockAppState();
  vi.clearAllMocks();
});

describe("NewCaseScreen — draft-invoice preview", () => {
  it("renders line items, a not-priced badge, and the total after a restoration is entered", async () => {
    seedEditableLab();
    setMockAppState({
      previewDraftResult: {
        lineItems: [
          {
            description: "Zirconia Crown",
            toothLabel: "#14",
            quantity: 1,
            unitPrice: "120.00",
            lineTotal: "120.00",
            priced: true,
          },
          {
            description: "Custom Abutment",
            toothLabel: "#15",
            quantity: 1,
            unitPrice: "0.00",
            lineTotal: "0.00",
            priced: false,
          },
        ],
        subtotal: "120.00",
        total: "120.00",
      },
    });

    const screen = render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Fill the first restoration row so the preview has something to price.
    fireEvent.changeText(screen.getByTestId("resto-tooth-0"), "14");
    fireEvent.changeText(screen.getByTestId("resto-type-0"), "Crown");

    await waitFor(
      () => {
        expect(screen.getByTestId("invoice-preview")).toBeTruthy();
        expect(screen.getByTestId("invoice-preview-line-0")).toBeTruthy();
      },
      { timeout: 2000 },
    );

    expect(screen.getByText(/Zirconia Crown/)).toBeTruthy();
    expect(screen.getByTestId("invoice-preview-notpriced-1")).toBeTruthy();
    expect(screen.getByTestId("invoice-preview-total").props.children).toEqual([
      "$",
      "120.00",
    ]);
  });

  it("does not render the preview until a restoration has a tooth and a type", async () => {
    seedEditableLab();
    const screen = render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Only a tooth number, no type → row is skipped, no preview.
    fireEvent.changeText(screen.getByTestId("resto-tooth-0"), "14");

    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    expect(screen.queryByTestId("invoice-preview")).toBeNull();
  });

  it("shows a non-blocking fallback when the preview request fails", async () => {
    seedEditableLab();
    setMockAppState({ previewDraftResult: "error" });

    const screen = render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    fireEvent.changeText(screen.getByTestId("resto-tooth-0"), "14");
    fireEvent.changeText(screen.getByTestId("resto-type-0"), "Crown");

    await waitFor(
      () => {
        expect(
          screen.getByText(/Couldn't load the invoice preview/i),
        ).toBeTruthy();
      },
      { timeout: 2000 },
    );
  });
});
