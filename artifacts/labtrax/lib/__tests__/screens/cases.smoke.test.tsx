import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Alert } from "react-native";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import {
  resetMockAppState,
  setMockAppState,
  setMockFetchHandler,
  resetMockFetchHandler,
} from "../../../vitest.setup";
import { resilientFetch } from "@/lib/query-client";

import CasesListScreen from "@/app/(tabs)/index";
import { completedCaseWithInvoice, inProgressCase } from "./__fixtures__/cases";

function readCaseIds(init?: RequestInit): string[] {
  try {
    const body = JSON.parse((init?.body as string) ?? "{}");
    return Array.isArray(body.caseIds) ? (body.caseIds as string[]) : [];
  } catch {
    return [];
  }
}

// Full-success response: every requested case id is reported as updated.
// Echoes the request body so `updatedIds` matches the actual selected cases,
// which the client relies on to compute succeeded vs failed ids.
function bulkStatusOkResponse(init?: RequestInit): Response {
  const updatedIds = readCaseIds(init);
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        updatedIds,
        skippedLegacyIds: [],
        updatedCount: updatedIds.length,
        skippedLegacyCount: 0,
      },
    }),
    { status: 200 },
  );
}

// Legacy-only response: no case could be updated by bulk-status; every id is
// reported as a skipped legacy blob.
function bulkStatusLegacyOnlyResponse(init?: RequestInit): Response {
  const skippedLegacyIds = readCaseIds(init);
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        updatedIds: [],
        skippedLegacyIds,
        updatedCount: 0,
        skippedLegacyCount: skippedLegacyIds.length,
      },
    }),
    { status: 200 },
  );
}

function bulkStatusErrorResponse(status = 422, message = "Server error"): Response {
  return new Response(JSON.stringify({ message }), { status });
}

afterEach(() => {
  resetMockAppState();
  resetMockFetchHandler();
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
      fireEvent.press(getByTestId(`case-card-${inProgressCase.id}`));
      expect(router.push).toHaveBeenCalledWith(`/case/${inProgressCase.id}`);
    });
  });

  describe("multi-select / bulk locate", () => {
    beforeEach(() => {
      setMockAppState({ cases: [inProgressCase, completedCaseWithInvoice] });
    });

    it("long-pressing a case card enters selection mode and selects that case", () => {
      const { getByTestId, getByText } = render(<CasesListScreen />);
      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      expect(getByText("1 selected")).toBeTruthy();
    });

    it("shows the bulk Locate button when in selection mode", () => {
      const { getByTestId, getByText } = render(<CasesListScreen />);
      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      expect(getByTestId("bulk-locate-btn")).toBeTruthy();
      expect(getByText(/Locate \(1\)/)).toBeTruthy();
    });

    it("tapping another case while in selection mode toggles its selection", () => {
      const { getByTestId, getByText } = render(<CasesListScreen />);
      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      fireEvent.press(getByTestId(`case-card-${completedCaseWithInvoice.id}`));
      expect(getByText("2 selected")).toBeTruthy();
      expect(getByText(/Locate \(2\)/)).toBeTruthy();
    });

    it("tapping a selected case while in selection mode deselects it", () => {
      const { getByTestId, getByText } = render(<CasesListScreen />);
      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      fireEvent.press(getByTestId(`case-card-${completedCaseWithInvoice.id}`));
      fireEvent.press(getByTestId(`case-card-${completedCaseWithInvoice.id}`));
      expect(getByText("1 selected")).toBeTruthy();
    });

    it("shows a Cancel button that exits selection mode", () => {
      const { getByTestId, getByText, queryByText } = render(<CasesListScreen />);
      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      expect(getByText("1 selected")).toBeTruthy();
      fireEvent.press(getByTestId("selection-cancel-btn"));
      expect(queryByText("1 selected")).toBeNull();
      expect(getByText("Cases")).toBeTruthy();
    });

    it("does not navigate to case detail when tapping a case in selection mode", () => {
      const { getByTestId } = render(<CasesListScreen />);
      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      fireEvent.press(getByTestId(`case-card-${completedCaseWithInvoice.id}`));
      expect(router.push).not.toHaveBeenCalled();
    });

    it("long-press followed by onPress does not deselect the item (longPressActiveRef guard)", () => {
      const { getByTestId, getByText } = render(<CasesListScreen />);
      // Simulate the RN Pressable sequence: onLongPress fires, then onPress fires on lift
      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      fireEvent.press(getByTestId(`case-card-${inProgressCase.id}`));
      // The item should still be selected (not toggled off by the follow-up onPress)
      expect(getByText("1 selected")).toBeTruthy();
    });

    it("tapping Locate (N) opens the bulk locate sheet", () => {
      const { getByTestId, getByText } = render(<CasesListScreen />);
      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      fireEvent.press(getByTestId("bulk-locate-btn"));
      // Sheet header shows the locate title
      expect(getByText("Locate 1 Case")).toBeTruthy();
    });

    it("calls the bulk-status endpoint with all selected case IDs", async () => {
      setMockFetchHandler((_url, init) => bulkStatusOkResponse(init));
      const { getByTestId, getByText } = render(<CasesListScreen />);

      // Select both cases
      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      fireEvent.press(getByTestId(`case-card-${completedCaseWithInvoice.id}`));
      expect(getByText("2 selected")).toBeTruthy();

      // Open bulk locate sheet
      fireEvent.press(getByTestId("bulk-locate-btn"));

      // Pick a station and confirm
      fireEvent.press(getByTestId("locate-option-received"));
      fireEvent.press(getByTestId("locate-sheet-confirm"));

      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("bulk-status"),
          expect.objectContaining({ method: "POST" }),
        );
      });

      const callArgs = vi.mocked(resilientFetch).mock.calls.find(([url]) =>
        String(url).includes("bulk-status"),
      );
      expect(callArgs).toBeTruthy();
      const sentBody = JSON.parse((callArgs![1] as RequestInit).body as string) as {
        caseIds: string[];
        status: string;
      };
      expect(sentBody.caseIds).toContain(inProgressCase.id);
      expect(sentBody.caseIds).toContain(completedCaseWithInvoice.id);
      expect(sentBody.status).toBe("received");
    });

    it("exits selection mode when bulk locate succeeds", async () => {
      setMockFetchHandler((_url, init) => bulkStatusOkResponse(init));
      const { getByTestId, getByText, queryByText } = render(<CasesListScreen />);

      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      fireEvent.press(getByTestId("bulk-locate-btn"));
      fireEvent.press(getByTestId("locate-option-received"));
      fireEvent.press(getByTestId("locate-sheet-confirm"));

      await waitFor(() => {
        expect(queryByText("1 selected")).toBeNull();
        expect(getByText("Cases")).toBeTruthy();
      });
    });

    it("shows a legacy-only error and stays in selection mode when every selected case is legacy", async () => {
      setMockFetchHandler((_url, init) => bulkStatusLegacyOnlyResponse(init));
      const { getByTestId, getByText } = render(<CasesListScreen />);

      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      expect(getByText("1 selected")).toBeTruthy();

      fireEvent.press(getByTestId("bulk-locate-btn"));
      fireEvent.press(getByTestId("locate-option-received"));
      fireEvent.press(getByTestId("locate-sheet-confirm"));

      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("bulk-status"),
          expect.anything(),
        );
      });

      // A clear legacy-format explanation is shown (not a success toast).
      await waitFor(() => {
        expect(Alert.alert).toHaveBeenCalledWith(
          "Can't locate these cases",
          expect.stringContaining("older format"),
        );
      });

      // No case actually moved, so the success path must NOT fire: selection
      // mode stays active so the user keeps their selection.
      expect(getByText("1 selected")).toBeTruthy();
    });

    it("stays in selection mode when the bulk-status request fails (so user can retry)", async () => {
      setMockFetchHandler(() => bulkStatusErrorResponse(422, "Server error"));
      const { getByTestId, getByText } = render(<CasesListScreen />);

      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      expect(getByText("1 selected")).toBeTruthy();

      fireEvent.press(getByTestId("bulk-locate-btn"));
      fireEvent.press(getByTestId("locate-option-received"));
      fireEvent.press(getByTestId("locate-sheet-confirm"));

      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("bulk-status"),
          expect.anything(),
        );
      });

      // Selection mode must still be active so the user can retry
      await waitFor(() => {
        expect(getByText("1 selected")).toBeTruthy();
      });
    });

    it("reopening bulk locate after a completed locate shows no preselected station (locateTarget reset)", async () => {
      setMockFetchHandler((_url, init) => bulkStatusOkResponse(init));
      const { getByTestId, queryByTestId } = render(<CasesListScreen />);

      // First bulk locate — pick a station and confirm
      fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      fireEvent.press(getByTestId("bulk-locate-btn"));
      fireEvent.press(getByTestId("locate-option-received"));
      fireEvent.press(getByTestId("locate-sheet-confirm"));

      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("bulk-status"),
          expect.anything(),
        );
      });

      // Re-enter selection mode for a second bulk locate
      fireEvent(getByTestId(`case-card-${completedCaseWithInvoice.id}`), "longPress");
      fireEvent.press(getByTestId("bulk-locate-btn"));

      // Confirm button must be disabled (no station pre-picked)
      expect(queryByTestId("locate-sheet-confirm")).toBeTruthy();
      // The previously selected "received" station should NOT be active;
      // the sheet should have reset locateTarget to null on close.
      // Verify by asserting the confirm button is now disabled (no selection).
      const confirmBtn = getByTestId("locate-sheet-confirm");
      expect(confirmBtn.props.accessibilityState?.disabled ?? confirmBtn.props.disabled).toBe(true);
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
