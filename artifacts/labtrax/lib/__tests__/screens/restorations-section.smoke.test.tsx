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
  mockUpdateCaseRestorationMutateAsync,
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
async function renderRestorations(ponticAnchor = false) {
  setMockSearchParams({ id: editableCase.id });
  setMockAppState({
    cases: [ponticAnchor ? { ...editableCase, restorations: [{
      id: "prepared-anchor", toothNumber: "13", restorationType: "Crown", material: "Zirconia",
      restorationSubtype: "restorative/crown_and_bridge/zirconia", shade: "A2", quantity: 1, unitPrice: "120.00",
    }] } : editableCase],
    invoices: [],
    meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
  });
  const utils = await render(<CaseDetailScreen />);
  await fireEvent.press(utils.getByTestId("section-tab-restorations"));
  return utils;
}

// ─── Tap-to-add — crown ───────────────────────────────────────────────────────

describe("RestorationsSection — add crown via tap-to-add flow", () => {
  it("renders the interactive tooth chart for editors", async () => {
    const { getByTestId } = await renderRestorations();
    expect(getByTestId("mock-tooth-chart")).toBeTruthy();
  });

  it("calls useAddCaseRestoration.mutateAsync with crown payload after full wizard", async () => {
    const { getByTestId } = await renderRestorations();

    // 1. Tap a tooth → sheet opens
    await fireEvent.press(getByTestId("mock-tooth-chart"));

    // 2. Crown wizard: kind → material → shade → confirm
    await waitFor(() => expect(getByTestId("tooth-kind-crown")).toBeTruthy());
    await fireEvent.press(getByTestId("tooth-kind-crown"));

    await waitFor(() => expect(getByTestId("tooth-material-Zirconia")).toBeTruthy());
    await fireEvent.press(getByTestId("tooth-material-Zirconia"));
    await fireEvent.press(getByTestId("tooth-material-next"));

    await waitFor(() => expect(getByTestId("tooth-shade-A2")).toBeTruthy());
    await fireEvent.press(getByTestId("tooth-shade-A2"));
    await fireEvent.press(getByTestId("tooth-shade-confirm"));

    await waitFor(() => {
      expect(mockAddCaseRestorationMutateAsync).toHaveBeenCalledWith({
        caseId: editableCase.id,
        data: {
          toothNumber: "14",
          restorationType: "Crown",
          material: "Zirconia",
          restorationSubtype: "restorative/crown_and_bridge/zirconia",
          shade: "A2",
          quantity: 1,
        },
      });
    });
  });

  it("calls mutateAsync without shade when the wizard's Skip is pressed", async () => {
    const { getByTestId } = await renderRestorations();

    await fireEvent.press(getByTestId("mock-tooth-chart"));

    await waitFor(() => expect(getByTestId("tooth-kind-crown")).toBeTruthy());
    await fireEvent.press(getByTestId("tooth-kind-crown"));

    await waitFor(() => expect(getByTestId("tooth-material-PFM")).toBeTruthy());
    await fireEvent.press(getByTestId("tooth-material-PFM"));
    await fireEvent.press(getByTestId("tooth-material-next"));

    await waitFor(() => expect(getByTestId("tooth-shade-skip")).toBeTruthy());
    await fireEvent.press(getByTestId("tooth-shade-skip"));

    await waitFor(() => {
      expect(mockAddCaseRestorationMutateAsync).toHaveBeenCalledWith({
        caseId: editableCase.id,
        data: {
          toothNumber: "14",
          restorationType: "Crown",
          material: "PFM (Porcelain Fused to Metal)",
          restorationSubtype: "restorative/crown_and_bridge/pfm",
          quantity: 1,
        },
      });
    });
  });
});

// ─── Tap-to-add — pontic ──────────────────────────────────────────────────────

describe("RestorationsSection — add pontic", () => {
  it("saves a pontic only after explicit catalog material and shade choices", async () => {
    const { getByTestId } = await renderRestorations(true);

    await fireEvent.press(getByTestId("mock-tooth-chart"));

    await waitFor(() => expect(getByTestId("tooth-kind-pontic")).toBeTruthy());
    await fireEvent.press(getByTestId("tooth-kind-pontic"));
    await fireEvent.press(getByTestId("tooth-material-Zirconia"));
    await fireEvent.press(getByTestId("tooth-material-next"));
    await fireEvent.press(getByTestId("tooth-shade-A2"));
    await fireEvent.press(getByTestId("tooth-shade-confirm"));

    await waitFor(() => {
      expect(mockAddCaseRestorationMutateAsync).toHaveBeenCalledWith({
        caseId: editableCase.id,
        data: expect.objectContaining({
          toothNumber: "14",
          restorationType: "Pontic",
          quantity: 1,
          material: "Zirconia",
        }),
      });
    });
  });
});

// ─── Tap-to-add — missing ─────────────────────────────────────────────────────

describe("RestorationsSection — mark missing", () => {
  it("calls mutateAsync with Missing restorationType and unitPrice 0 on missing tap", async () => {
    const { getByTestId } = await renderRestorations();

    await fireEvent.press(getByTestId("mock-tooth-chart"));

    await waitFor(() => expect(getByTestId("tooth-kind-missing")).toBeTruthy());
    await fireEvent.press(getByTestId("tooth-kind-missing"));

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
    const { getByTestId, getByText } = await renderRestorations(true);

    await fireEvent.press(getByTestId("mock-tooth-chart"));

    await waitFor(() => expect(getByTestId("tooth-kind-pontic")).toBeTruthy());
    await fireEvent.press(getByTestId("tooth-kind-pontic"));
    await fireEvent.press(getByTestId("tooth-material-Zirconia"));
    await fireEvent.press(getByTestId("tooth-material-next"));
    await fireEvent.press(getByTestId("tooth-shade-A2"));
    await fireEvent.press(getByTestId("tooth-shade-confirm"));

    await waitFor(() => {
      expect(getByText(/Network error: could not save restoration/i)).toBeTruthy();
    });
  });

  it("does not dismiss the sheet when the mutation rejects (so the user can retry)", async () => {
    const { getByTestId, queryByTestId } = await renderRestorations();

    await fireEvent.press(getByTestId("mock-tooth-chart"));

    await waitFor(() => expect(getByTestId("tooth-kind-missing")).toBeTruthy());
    await fireEvent.press(getByTestId("tooth-kind-missing"));

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
  it("does not render the interactive mock-tooth-chart for a non-editor", async () => {
    // Default meMemberships = undefined → canEdit === false.
    setMockSearchParams({ id: inProgressCase.id });
    setMockAppState({ cases: [inProgressCase], invoices: [] });
    const { queryByTestId } = await render(<CaseDetailScreen />);
    await fireEvent.press(queryByTestId("section-tab-restorations")!);
    expect(queryByTestId("mock-tooth-chart")).toBeNull();
  });
});

// ─── Inline restoration-type edit — taxonomy subtype round-trip ───────────────
//
// Verifies that:
//   1. A taxonomy-matched label causes the PATCH to include restorationSubtype.
//   2. A subsequent free-text edit causes the PATCH to omit restorationSubtype
//      (the server-stored value from the first edit is not overwritten by the
//      second PATCH payload).
//   3. Cancelling the edit form never fires a PATCH.

const typeEditCase = { ...inProgressCase, organizationId: "org-1" };

async function renderTypeEditing() {
  setMockSearchParams({ id: typeEditCase.id });
  setMockAppState({
    cases: [typeEditCase],
    invoices: [],
    meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
  });
  const utils = await render(<CaseDetailScreen />);
  await fireEvent.press(utils.getByTestId("section-tab-restorations"));
  return utils;
}

describe("RestorationsSection — inline restoration-type edit taxonomy subtype", () => {
  it("includes restorationSubtype on taxonomy-matched save, omits it on subsequent free-text save", async () => {
    const { getByTestId } = await renderTypeEditing();

    // ── First edit: taxonomy-matched label "Crown & Bridge" ──
    await waitFor(() => expect(getByTestId("edit-restoration-type-rest-1")).toBeTruthy());
    await fireEvent.press(getByTestId("edit-restoration-type-rest-1"));

    await waitFor(() => expect(getByTestId("edit-type-input-rest-1")).toBeTruthy());
    await fireEvent.changeText(getByTestId("edit-type-input-rest-1"), "Crown & Bridge");
    await fireEvent.press(getByTestId("save-restoration-type-rest-1"));

    await waitFor(() => {
      expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenCalledWith({
        caseId: typeEditCase.id,
        restorationId: "rest-1",
        data: {
          restorationType: "Crown & Bridge",
          restorationSubtype: "restorative/crown_and_bridge",
        },
      });
    });

    mockUpdateCaseRestorationMutateAsync.mockClear();

    // After save the edit form closes; pencil button reappears.
    await waitFor(() => expect(getByTestId("edit-restoration-type-rest-1")).toBeTruthy());

    // ── Second edit: free-text value ──
    await fireEvent.press(getByTestId("edit-restoration-type-rest-1"));

    await waitFor(() => expect(getByTestId("edit-type-input-rest-1")).toBeTruthy());
    await fireEvent.changeText(getByTestId("edit-type-input-rest-1"), "My Custom Free Text");
    await fireEvent.press(getByTestId("save-restoration-type-rest-1"));

    await waitFor(() => {
      expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenCalledTimes(1);
      expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenCalledWith({
        caseId: typeEditCase.id,
        restorationId: "rest-1",
        data: { restorationType: "My Custom Free Text" },
      });
    });
    // Note: toHaveBeenCalledWith above uses exact deep equality — if restorationSubtype
    // were present in the second PATCH data object the assertion would fail, confirming
    // the stored taxonomy subtype is not overwritten.
  });

  it("does not call mutateAsync when the edit form is cancelled", async () => {
    const { getByTestId } = await renderTypeEditing();

    await waitFor(() => expect(getByTestId("edit-restoration-type-rest-1")).toBeTruthy());
    await fireEvent.press(getByTestId("edit-restoration-type-rest-1"));

    await waitFor(() => expect(getByTestId("edit-type-input-rest-1")).toBeTruthy());
    await fireEvent.changeText(getByTestId("edit-type-input-rest-1"), "Crown & Bridge");

    // Cancel instead of saving.
    await fireEvent.press(getByTestId("cancel-restoration-type-rest-1"));

    // Edit form closes, pencil reappears — no PATCH was fired.
    await waitFor(() => expect(getByTestId("edit-restoration-type-rest-1")).toBeTruthy());
    expect(mockUpdateCaseRestorationMutateAsync).not.toHaveBeenCalled();
  });
});
