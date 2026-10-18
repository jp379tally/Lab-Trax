import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  lastUseCasesParams,
  mockAddCaseNoteMutateAsync,
  showMockKeyboard,
  isMockKeyboardVisible,
} from "../../../vitest.setup";

import { CaseLookupSheet } from "@/components/CaseLookupSheet";

/**
 * The dashboard's "Look Up Case" pop-up.
 *
 * What matters here:
 *   - it never searches (and never pulls the unfiltered case list) until the
 *     user has typed a couple of characters;
 *   - the term reaches the SERVER via useCases({ search }), matching how the
 *     Cases list searches, rather than filtering an already-fetched page;
 *   - tapping a result closes the sheet and opens that case;
 *   - "Scan Barcode" switches the same sheet into camera scan mode.
 */

const CASES = [
  // Restorative, in progress, has teeth → "C" badge + material + teeth, an
  // Entered date and NO completed date.
  {
    id: "case-1",
    patientFirstName: "Ada",
    patientLastName: "Lovelace",
    caseNumber: "1001",
    doctorName: "Dr. Babbage",
    status: "in_design",
    restorationTypes: "Crown",
    restorationMaterials: "Zirconia",
    teeth: "8, 9",
    receivedAt: "2026-08-01T15:00:00.000Z",
    createdAt: "2026-07-30T15:00:00.000Z",
    updatedAt: "2026-08-20T15:00:00.000Z",
  },
  // Bare row: no restoration info, no teeth, no received timestamp → the
  // Entered date falls back to createdAt and nothing else is printed.
  {
    id: "case-2",
    patientFirstName: "Grace",
    patientLastName: "Hopper",
    caseNumber: "1002",
    doctorName: "Dr. Babbage",
    status: "received",
    createdAt: "2026-08-05T15:00:00.000Z",
  },
  // Removable and complete → "D" badge + a completed date (read from
  // updatedAt, the same source the Cases list and Dashboard cards use).
  {
    id: "case-3",
    patientFirstName: "Alan",
    patientLastName: "Turing",
    caseNumber: "1003",
    doctorName: "Dr. Babbage",
    status: "complete",
    restorationTypes: "Full Denture",
    step: "wax_try_in",
    receivedAt: "2026-07-10T15:00:00.000Z",
    createdAt: "2026-07-09T15:00:00.000Z",
    updatedAt: "2026-08-12T15:00:00.000Z",
  },
];

const LAB_MEMBERSHIP = {
  organizationId: "lab-org-lookup",
  status: "active",
  role: "admin",
  organization: { type: "lab" },
};

beforeEach(() => {
  setMockAppState({ cases: CASES, meMemberships: [LAB_MEMBERSHIP] });
});

afterEach(() => {
  cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

async function renderSheet() {
  const onDismiss = vi.fn();
  const utils = await render(<CaseLookupSheet visible onDismiss={onDismiss} />);
  return { ...utils, onDismiss };
}

describe("CaseLookupSheet", () => {
  it("shows the minimum-characters hint before searching", async () => {
    const { getByTestId, queryByTestId } = await renderSheet();

    expect(getByTestId("case-lookup-hint")).toBeTruthy();
    expect(queryByTestId("case-lookup-result-case-1")).toBeNull();
  });

  it("keeps the hint (and issues no search) for a single character", async () => {
    const { getByTestId, queryByTestId } = await renderSheet();

    await act(async () => {
      await fireEvent.changeText(getByTestId("case-lookup-search"), "A");

      // Give the 300 ms debounce room to fire; it must not produce results.
      await new Promise((r) => setTimeout(r, 400));
    });

    expect(getByTestId("case-lookup-hint")).toBeTruthy();
    expect(queryByTestId("case-lookup-result-case-1")).toBeNull();
    expect(lastUseCasesParams()).toBeUndefined();
  });

  it("renders matching cases as the user types and pushes the term to the server", async () => {
    const { getByTestId, getByText } = await renderSheet();

    await fireEvent.changeText(getByTestId("case-lookup-search"), "Ada");

    await waitFor(() => {
      expect(getByTestId("case-lookup-result-case-1")).toBeTruthy();
    });

    // Rows carry enough to identify a case: patient, case #, doctor, status.
    expect(getByText("Ada Lovelace")).toBeTruthy();
    expect(getByText("#1001  ·  Dr. Babbage")).toBeTruthy();
    // StatusBadge renders its label uppercased.
    expect(getByText("IN DESIGN")).toBeTruthy();

    // The search term is sent to the server (the un-searched list read is
    // capped at the 500 newest cases, so client-only filtering would hide
    // older ones).
    expect(lastUseCasesParams()).toEqual({ search: "Ada" });
  });

  it("shows the entered date, type indicator and teeth on a result row", async () => {
    const { getByTestId, getByText } = await renderSheet();

    await fireEvent.changeText(getByTestId("case-lookup-search"), "Ada");

    await waitFor(() => {
      expect(getByTestId("case-lookup-result-case-1")).toBeTruthy();
    });

    // Type indicator: the shared "C" badge sits alongside the status badge.
    expect(getByText("C")).toBeTruthy();
    expect(getByText("Zirconia")).toBeTruthy();
    expect(getByText("Teeth 8, 9")).toBeTruthy();
    // Received timestamp, in the app's numeric MM/DD/YYYY format.
    expect(getByText("Entered 08/01/2026")).toBeTruthy();
  });

  it("shows a completed date only for complete cases", async () => {
    const { getByTestId, getByText, queryByText } = await renderSheet();

    await fireEvent.changeText(getByTestId("case-lookup-search"), "Babbage");

    await waitFor(() => {
      expect(getByTestId("case-lookup-result-case-3")).toBeTruthy();
    });

    // Complete removable case: "D" badge, entered + completed dates.
    expect(getByText("D")).toBeTruthy();
    expect(getByText("Entered 07/10/2026")).toBeTruthy();
    expect(getByText("Completed 08/12/2026")).toBeTruthy();

    // The in-progress case's updatedAt must NOT surface as a completed date.
    expect(queryByText("Completed 08/20/2026")).toBeNull();
  });

  it("omits type, teeth and completed date when the case has none", async () => {
    const { getByTestId, queryByTestId, getByText } = await renderSheet();

    await fireEvent.changeText(getByTestId("case-lookup-search"), "Hopper");

    await waitFor(() => {
      expect(getByTestId("case-lookup-result-case-2")).toBeTruthy();
    });

    // No restoration info and no teeth → the work line is dropped entirely
    // rather than rendering an empty label.
    expect(queryByTestId("case-lookup-work-case-2")).toBeNull();
    // Entered still shows, falling back to createdAt when receivedAt is absent.
    expect(getByTestId("case-lookup-dates-case-2")).toBeTruthy();
    expect(getByText("Entered 08/05/2026")).toBeTruthy();
  });

  it("closes the sheet and opens the case when a result is tapped", async () => {
    const { router } = await import("expo-router");
    const { getByTestId, onDismiss } = await renderSheet();

    await fireEvent.changeText(getByTestId("case-lookup-search"), "Hopper");

    await waitFor(() => {
      expect(getByTestId("case-lookup-result-case-2")).toBeTruthy();
    });

    await fireEvent.press(getByTestId("case-lookup-result-case-2"));

    expect(onDismiss).toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith("/case/case-2");
  });

  it("opens shared quick actions for the exact active server result without navigating", async () => {
    const { router } = await import("expo-router");
    const { getByTestId, getByText } = await renderSheet();

    await fireEvent.changeText(getByTestId("case-lookup-search"), "Ada");
    await waitFor(() => expect(getByTestId("case-lookup-result-case-1")).toBeTruthy());

    const row = getByTestId("case-lookup-result-case-1");
    await fireEvent(row, "longPress");

    expect(getByTestId("case-quick-actions")).toBeTruthy();
    expect(getByText("Ada Lovelace  ·  #1001")).toBeTruthy();

    await fireEvent.press(row);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("routes a selected quick action to the pressed case", async () => {
    const { getByTestId } = await renderSheet();

    await fireEvent.changeText(getByTestId("case-lookup-search"), "Ada");
    await waitFor(() => expect(getByTestId("case-lookup-result-case-1")).toBeTruthy());

    await fireEvent(getByTestId("case-lookup-result-case-1"), "longPress");
    await fireEvent.press(getByTestId("case-quick-action-note"));
    await fireEvent.changeText(getByTestId("case-quick-note-input"), "Lookup note");
    await fireEvent.press(getByTestId("case-quick-note-save"));

    await waitFor(() =>
      expect(mockAddCaseNoteMutateAsync).toHaveBeenCalledWith({
        caseId: "case-1",
        data: { noteText: "Lookup note", visibility: "internal_lab_only" },
      }),
    );
  });

  it("restores lookup after quick actions close and keeps a normal tap working", async () => {
    const { router } = await import("expo-router");
    const { getByTestId } = await renderSheet();

    await fireEvent.changeText(getByTestId("case-lookup-search"), "Ada");
    await waitFor(() => expect(getByTestId("case-lookup-result-case-1")).toBeTruthy());

    await fireEvent(getByTestId("case-lookup-result-case-1"), "longPress");
    await fireEvent.press(getByTestId("case-quick-actions-close"));

    const restoredRow = await waitFor(() => getByTestId("case-lookup-result-case-1"));
    await fireEvent.press(restoredRow);
    expect(router.push).toHaveBeenCalledWith("/case/case-1");
  });

  it("dismisses the search keyboard before replacing lookup with quick actions", async () => {
    const { getByTestId } = await renderSheet();

    await fireEvent.changeText(getByTestId("case-lookup-search"), "Ada");
    await waitFor(() => expect(getByTestId("case-lookup-result-case-1")).toBeTruthy());
    await act(async () => {
      showMockKeyboard();
    });
    expect(isMockKeyboardVisible()).toBe(true);

    await fireEvent(getByTestId("case-lookup-result-case-1"), "longPress");

    expect(isMockKeyboardVisible()).toBe(false);
    expect(getByTestId("case-quick-actions")).toBeTruthy();
  });

  it("keeps completed results tap-only", async () => {
    const { router } = await import("expo-router");
    const { getByTestId, queryByTestId } = await renderSheet();

    await fireEvent.changeText(getByTestId("case-lookup-search"), "Turing");
    await waitFor(() => expect(getByTestId("case-lookup-result-case-3")).toBeTruthy());

    const row = getByTestId("case-lookup-result-case-3");
    await fireEvent(row, "longPress");
    expect(queryByTestId("case-quick-actions")).toBeNull();

    await fireEvent.press(row);
    expect(router.push).toHaveBeenCalledWith("/case/case-3");
  });

  it("shows an empty state when nothing matches", async () => {
    setMockAppState({ cases: [] });
    const { getByTestId } = await renderSheet();

    await fireEvent.changeText(getByTestId("case-lookup-search"), "zzz");

    await waitFor(() => {
      expect(getByTestId("case-lookup-empty")).toBeTruthy();
    });
  });

  it("switches into barcode scan mode when Scan Barcode is pressed", async () => {
    const { getByTestId, queryByTestId, getByText } = await renderSheet();

    expect(queryByTestId("case-lookup-camera-wrap")).toBeNull();

    await fireEvent.press(getByTestId("case-lookup-scan-btn"));

    expect(getByTestId("case-lookup-camera-wrap")).toBeTruthy();
    expect(getByText("Scan Barcode")).toBeTruthy();
    // Torch + manual-entry fallback come along with the scanner.
    expect(getByTestId("case-lookup-torch-toggle")).toBeTruthy();
    expect(getByTestId("case-lookup-scan-tab-manual")).toBeTruthy();
    // The search field is replaced, not merely hidden behind the camera.
    expect(queryByTestId("case-lookup-search")).toBeNull();
  });

  it("returns to search mode from the scanner", async () => {
    const { getByTestId, queryByTestId } = await renderSheet();

    await fireEvent.press(getByTestId("case-lookup-scan-btn"));
    await fireEvent.press(getByTestId("case-lookup-back-to-search"));

    expect(getByTestId("case-lookup-search")).toBeTruthy();
    expect(queryByTestId("case-lookup-camera-wrap")).toBeNull();
  });

  it("renders nothing while hidden so it can't duplicate testIDs", async () => {
    const { queryByTestId } = await render(
      <CaseLookupSheet visible={false} onDismiss={vi.fn()} />,
    );
    expect(queryByTestId("case-lookup-sheet")).toBeNull();
  });
});
