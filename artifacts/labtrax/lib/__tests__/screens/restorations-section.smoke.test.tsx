/**
 * Smoke tests for the RestorationsSection add-restoration flow.
 *
 * The global vitest.setup.ts mocks ToothChart and ToothActionSheet to
 * `nullComponent` so the heavy chart SVG doesn't pollute other smoke tests.
 * This file overrides those two mocks so we can exercise the full
 * tap-to-add flow:
 *
 *   Tap chart → ToothActionSheet opens → walk wizard → confirm →
 *   useAddCaseRestoration.mutateAsync called with correct args
 *
 * ToothChart is replaced with a simple Pressable stub that fires
 * `onToothClick("14")` when tapped.  ToothActionSheet is restored to the real
 * implementation via importOriginal so its wizard steps are fully interactive.
 */

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockSearchParams,
  mockAddCaseRestorationMutateAsync,
} from "../../../vitest.setup";

import CaseDetailScreen from "@/app/case/[id]";
import { inProgressCase } from "./__fixtures__/cases";

// ─── Mock overrides (per-file; win over the setupFiles null-mocks) ────────────

// Interactive ToothChart stub: pressing it fires onToothClick with tooth "14".
vi.mock("@/components/ToothChart", () => {
  const React = require("react");
  const { Pressable } = require("react-native");
  type ToothChartProps = { onToothClick?: (id: string) => void; readOnly?: boolean };
  const ToothChart = ({ onToothClick }: ToothChartProps) =>
    React.createElement(Pressable, {
      testID: "mock-tooth-chart",
      onPress: () => onToothClick?.("14"),
    });
  return { ToothChart };
});

// Use the real ToothActionSheet so the wizard steps are fully interactive.
vi.mock("@/components/ToothActionSheet", async (importOriginal) => {
  return await importOriginal<typeof import("@/components/ToothActionSheet")>();
});

// ─── Shared setup ─────────────────────────────────────────────────────────────

const editableCase = { ...inProgressCase, organizationId: "org-1", restorations: [] };

afterEach(() => {
  cleanup();
  setMockSearchParams({});
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

/** Renders the detail screen as an editor and navigates to Restorations. */
function renderRestorations() {
  setMockSearchParams({ id: editableCase.id });
  setMockAppState({
    cases: [editableCase],
    invoices: [],
    meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
  });
  const utils = render(<CaseDetailScreen />);
  fireEvent.press(utils.getByTestId("section-tab-restorations"));
  return utils;
}

// ─── Tap-to-add — crown ───────────────────────────────────────────────────────

describe("RestorationsSection — add crown via tap-to-add flow", () => {
  it("renders the interactive tooth chart for editors", () => {
    const { getByTestId } = renderRestorations();
    expect(getByTestId("mock-tooth-chart")).toBeTruthy();
  });

  it("calls useAddCaseRestoration.mutateAsync with crown payload after full wizard", async () => {
    const { getByTestId } = renderRestorations();

    // 1. Tap a tooth → sheet opens
    fireEvent.press(getByTestId("mock-tooth-chart"));

    // 2. Crown wizard: kind → material → shade → confirm
    await waitFor(() => expect(getByTestId("tooth-kind-crown")).toBeTruthy());
    fireEvent.press(getByTestId("tooth-kind-crown"));

    await waitFor(() => expect(getByTestId("tooth-material-Zirconia")).toBeTruthy());
    fireEvent.press(getByTestId("tooth-material-Zirconia"));
    fireEvent.press(getByTestId("tooth-material-next"));

    await waitFor(() => expect(getByTestId("tooth-shade-A2")).toBeTruthy());
    fireEvent.press(getByTestId("tooth-shade-A2"));
    fireEvent.press(getByTestId("tooth-shade-confirm"));

    await waitFor(() => {
      expect(mockAddCaseRestorationMutateAsync).toHaveBeenCalledWith({
        caseId: editableCase.id,
        data: {
          toothNumber: "14",
          restorationType: "Crown",
          material: "Zirconia",
          shade: "A2",
          quantity: 1,
        },
      });
    });
  });

  it("calls mutateAsync without shade when the wizard's Skip is pressed", async () => {
    const { getByTestId } = renderRestorations();

    fireEvent.press(getByTestId("mock-tooth-chart"));

    await waitFor(() => expect(getByTestId("tooth-kind-crown")).toBeTruthy());
    fireEvent.press(getByTestId("tooth-kind-crown"));

    await waitFor(() => expect(getByTestId("tooth-material-PFM")).toBeTruthy());
    fireEvent.press(getByTestId("tooth-material-PFM"));
    fireEvent.press(getByTestId("tooth-material-next"));

    await waitFor(() => expect(getByTestId("tooth-shade-skip")).toBeTruthy());
    fireEvent.press(getByTestId("tooth-shade-skip"));

    await waitFor(() => {
      expect(mockAddCaseRestorationMutateAsync).toHaveBeenCalledWith({
        caseId: editableCase.id,
        data: {
          toothNumber: "14",
          restorationType: "Crown",
          material: "PFM",
          quantity: 1,
        },
      });
    });
  });
});

// ─── Tap-to-add — pontic ──────────────────────────────────────────────────────

describe("RestorationsSection — add pontic", () => {
  it("calls mutateAsync with Pontic restorationType immediately on pontic tap", async () => {
    const { getByTestId } = renderRestorations();

    fireEvent.press(getByTestId("mock-tooth-chart"));

    await waitFor(() => expect(getByTestId("tooth-kind-pontic")).toBeTruthy());
    fireEvent.press(getByTestId("tooth-kind-pontic"));

    await waitFor(() => {
      expect(mockAddCaseRestorationMutateAsync).toHaveBeenCalledWith({
        caseId: editableCase.id,
        data: {
          toothNumber: "14",
          restorationType: "Pontic",
          quantity: 1,
        },
      });
    });
  });
});

// ─── Tap-to-add — missing ─────────────────────────────────────────────────────

describe("RestorationsSection — mark missing", () => {
  it("calls mutateAsync with Missing restorationType and unitPrice 0 on missing tap", async () => {
    const { getByTestId } = renderRestorations();

    fireEvent.press(getByTestId("mock-tooth-chart"));

    await waitFor(() => expect(getByTestId("tooth-kind-missing")).toBeTruthy());
    fireEvent.press(getByTestId("tooth-kind-missing"));

    await waitFor(() => {
      expect(mockAddCaseRestorationMutateAsync).toHaveBeenCalledWith({
        caseId: editableCase.id,
        data: {
          toothNumber: "14",
          restorationType: "Missing",
          quantity: 1,
          unitPrice: 0,
        },
      });
    });
  });
});

// ─── Error path ───────────────────────────────────────────────────────────────

describe("RestorationsSection — rejected mutation surfaces in-sheet error", () => {
  beforeEach(() => {
    mockAddCaseRestorationMutateAsync.mockRejectedValueOnce(
      new Error("Network error: could not save restoration"),
    );
  });

  it("shows the server error message inside the sheet after a failed pontic save", async () => {
    const { getByTestId, getByText } = renderRestorations();

    fireEvent.press(getByTestId("mock-tooth-chart"));

    await waitFor(() => expect(getByTestId("tooth-kind-pontic")).toBeTruthy());
    fireEvent.press(getByTestId("tooth-kind-pontic"));

    await waitFor(() => {
      expect(getByText(/Network error: could not save restoration/i)).toBeTruthy();
    });
  });

  it("does not dismiss the sheet when the mutation rejects (so the user can retry)", async () => {
    const { getByTestId, queryByTestId } = renderRestorations();

    fireEvent.press(getByTestId("mock-tooth-chart"));

    await waitFor(() => expect(getByTestId("tooth-kind-missing")).toBeTruthy());
    fireEvent.press(getByTestId("tooth-kind-missing"));

    // After the rejection the kind buttons stay mounted (sheet not closed).
    await waitFor(() => {
      expect(mockAddCaseRestorationMutateAsync).toHaveBeenCalled();
    });
    // The sheet remains open: the close button is still present.
    expect(queryByTestId("tooth-action-close")).toBeTruthy();
  });
});

// ─── Read-only viewer — no chart interaction ───────────────────────────────────

describe("RestorationsSection — read-only viewer sees ReadOnlyToothChart, not interactive chart", () => {
  it("does not render the interactive mock-tooth-chart for a non-editor", () => {
    // Default meMemberships = undefined → canEdit === false.
    setMockSearchParams({ id: inProgressCase.id });
    setMockAppState({ cases: [inProgressCase], invoices: [] });
    const { queryByTestId } = render(<CaseDetailScreen />);
    fireEvent.press(queryByTestId("section-tab-restorations")!);
    expect(queryByTestId("mock-tooth-chart")).toBeNull();
  });
});
