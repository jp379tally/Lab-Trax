import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Alert, FlatList } from "react-native";
import { render, fireEvent, waitFor, act, within } from "@testing-library/react-native";
import { router } from "expo-router";
import {
  resetMockAppState,
  setMockAppState,
  setMockFetchHandler,
  resetMockFetchHandler,
  runFocusEffectCleanup,
  lastUseCasesParams,
  mockUseCasesParams,
} from "../../../vitest.setup";
import { resilientFetch } from "@/lib/query-client";
import * as apiClient from "@workspace/api-client-react";

// The mocked useFocusEffect registers its cleanup in a microtask; awaiting a
// resolved promise lets that microtask run so a cleanup is available.
async function flushFocusEffect(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderCasesScreen() {
  const screen = await render(<CasesListScreen />);
  await act(async () => undefined);
  await waitFor(() => expect(screen.getByTestId("cases-search")).toBeTruthy());
  return screen;
}

// Simulate a single blur: run one registered focus-effect cleanup. The cleanup
// calls setState (resetFilters), so wrap it in act.
async function blur(): Promise<void> {
  await act(() => {
    runFocusEffectCleanup();
  });
}

import CasesListScreen from "@/app/(tabs)/index";
import { completedCaseWithInvoice, inProgressCase } from "./__fixtures__/cases";
import { locationsOnlyHandler, withLocations } from "./__fixtures__/locations";

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

// Legacy-updated response: every id is reported as updated (server now writes
// the JSON blob for legacy lab_cases rows instead of skipping them).
function bulkStatusLegacyOnlyResponse(init?: RequestInit): Response {
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

function bulkStatusErrorResponse(status = 422, message = "Server error"): Response {
  return new Response(JSON.stringify({ message }), { status });
}

afterEach(() => {
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("CasesListScreen (read-only canonical list)", () => {
  it("opens and refreshes Cases with the complete-set summary", async () => {
    const overviewHook = vi.spyOn(apiClient, "useCasesOverview");
    const overviewRefetch = vi.fn(async () => undefined);
    const casesRefetch = vi.fn(async () => undefined);
    setMockAppState({
      cases: [inProgressCase],
      casesTotal: 1284,
      casesHasMore: true,
      casesRefetch,
      casesOverview: { refetch: overviewRefetch },
    });
    try {
      const screen = await renderCasesScreen();
      expect(screen.getByText("1,284 cases")).toBeTruthy();
      expect(screen.getByText("Load more (1 of 1284)")).toBeTruthy();
      expect(overviewHook).toHaveBeenCalled();
      await act(() => {
        screen.getByTestId("cases-list").props.refreshControl.props.onRefresh();
      });
      expect(casesRefetch).toHaveBeenCalledOnce();
      expect(overviewHook).toHaveBeenCalled();
      expect(overviewRefetch).toHaveBeenCalledOnce();
      expect(screen.getByText("Jane Doe")).toBeTruthy();
    } finally {
      overviewHook.mockRestore();
    }
  });

  it("renders without throwing when the case list is empty", async () => {
    await expect(render(<CasesListScreen />)).resolves.toBeDefined();
    await act(async () => undefined);
  });

  it('renders the "Cases" header and the empty state', async () => {
    const { getByText } = await renderCasesScreen();
    expect(getByText("Cases")).toBeTruthy();
    expect(getByText("No cases yet")).toBeTruthy();
  });

  describe("with a populated case list", () => {
    beforeEach(() => {
      setMockAppState({ cases: [inProgressCase, completedCaseWithInvoice] });
    });

    it("renders compact work details without exposing case or barcode identifiers", async () => {
      const { getByText, getAllByText, getByTestId, queryByText } = await renderCasesScreen();
      expect(getByText("Jane Doe")).toBeTruthy();
      expect(getByText("John Roe")).toBeTruthy();
      expect(getByText(inProgressCase.doctorName)).toBeTruthy();
      expect(getAllByText("Zirconia").length).toBeGreaterThan(0);
      expect(getAllByText("Teeth 8, 9").length).toBeGreaterThan(0);
      expect(getAllByText("C").length).toBeGreaterThan(0);
      expect(getByTestId(`compact-case-details-${inProgressCase.id}`)).toBeTruthy();
      expect(queryByText("#5001")).toBeNull();
      expect(queryByText("PAN-5001")).toBeNull();
    });

    it("uses removable and ortho compact labels and omits unavailable work details", async () => {
      const removableCase = {
        ...inProgressCase,
        id: "case-removable",
        patientFirstName: "Remy",
        patientLastName: "Partial",
        restorationTypes: "Partial",
        restorationMaterials: "Acrylic",
        firstRestorationSubtype: "removable/partial/acrylic",
        teeth: null,
        step: "wax_setup",
      };
      const orthoCase = {
        ...inProgressCase,
        id: "case-ortho",
        patientFirstName: "Orla",
        patientLastName: "Retainer",
        restorationTypes: "Retainer",
        restorationMaterials: "Thermoplastic",
        firstRestorationSubtype: "ortho/retainer",
        teeth: null,
        step: null,
      };
      const noWorkDetailsCase = {
        ...inProgressCase,
        id: "case-no-work-details",
        patientFirstName: "Noel",
        patientLastName: "Details",
        doctorName: null,
        restorationTypes: null,
        restorationMaterials: null,
        firstRestorationSubtype: null,
        teeth: null,
        step: null,
        casePanBarcode: null,
      };
      setMockAppState({ cases: [removableCase, orthoCase, noWorkDetailsCase] });

      const { getAllByText, getByTestId, queryByTestId } = await renderCasesScreen();
      expect(getAllByText("D").length).toBeGreaterThan(0);
      expect(getAllByText("Acrylic").length).toBeGreaterThan(0);
      expect(getAllByText("Wax Setup").length).toBeGreaterThan(0);
      // Ortho cases show the square "O" badge instead of the long label.
      expect(getAllByText("O").length).toBeGreaterThan(0);
      expect(getAllByText("Thermoplastic").length).toBeGreaterThan(0);
      expect(getByTestId("compact-case-details-case-removable")).toBeTruthy();
      expect(getByTestId("compact-case-details-case-ortho")).toBeTruthy();
      // …and the row's detail line no longer repeats "Ortho / Appliances"
      // (the Type filter picker still uses that wording, hence the scoping).
      expect(
        within(getByTestId("compact-case-details-case-ortho")).queryByText("Ortho / Appliances"),
      ).toBeNull();
      expect(queryByTestId("compact-case-details-case-no-work-details")).toBeNull();
    });

    it("shows the case count in the header", async () => {
      const { getByText } = await renderCasesScreen();
      expect(getByText("2 cases")).toBeTruthy();
    });

    it("navigates to the case detail route when a row is pressed", async () => {
      const { getByTestId } = await renderCasesScreen();
      await fireEvent.press(getByTestId(`case-card-${inProgressCase.id}`));
      expect(router.push).toHaveBeenCalledWith(`/case/${inProgressCase.id}`);
    });
  });

  describe("search is pushed to the server", () => {
    // Regression: the server returns only the 500 most-recent cases when no
    // search term is supplied, and runs the match in SQL across ALL cases when
    // one is. Filtering purely on the client therefore made every case outside
    // that 500-case window permanently unfindable in a busy lab.
    beforeEach(() => {
      setMockAppState({ cases: [inProgressCase, completedCaseWithInvoice] });
    });

    it("sends no search param while the box is empty", async () => {
      await renderCasesScreen();
      expect(lastUseCasesParams()).toEqual({ page: 1, pageSize: 10 });
    });

    it("forwards the typed search term to useCases after debouncing", async () => {
      const { getByTestId } = await renderCasesScreen();

      await fireEvent.changeText(getByTestId("cases-search"), "newman");

      await waitFor(() => {
        expect(lastUseCasesParams()).toEqual({ search: "newman", page: 1, pageSize: 10 });
      });
    });

    it("schedules nothing while the search box sits untouched", async () => {
      await renderCasesScreen();
      const rendersBefore = mockUseCasesParams.calls.length;
      // Sit past the 300ms search debounce without typing. A debounce that
      // fires anyway resets the loaded page and re-renders the screen; in real
      // use that update lands outside act() and aborts the whole test run as
      // an unhandled error.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 350));
      });
      expect(mockUseCasesParams.calls.length).toBe(rendersBefore);
    });

    it("debounces: the term is not sent on the first keystroke", async () => {
      const { getByTestId } = await renderCasesScreen();
      await fireEvent.changeText(getByTestId("cases-search"), "n");
      // Synchronously after typing, the debounce window has not elapsed.
      expect(lastUseCasesParams()).toEqual({ page: 1, pageSize: 10 });
    });

    it("stops sending a search term once the box is cleared", async () => {
      const { getByTestId } = await renderCasesScreen();

      await fireEvent.changeText(getByTestId("cases-search"), "newman");
      await waitFor(() => {
        expect(lastUseCasesParams()).toEqual({ search: "newman", page: 1, pageSize: 10 });
      });

      await fireEvent.changeText(getByTestId("cases-search"), "");
      await waitFor(() => {
        expect(lastUseCasesParams()).toEqual({ page: 1, pageSize: 10 });
      });
    });
  });

  it("appends the next ten cases from the Load more control", async () => {
    setMockAppState({
      casesByPage: {
        1: [inProgressCase],
        2: [completedCaseWithInvoice],
      },
      casesTotal: 12,
      casesHasMore: true,
    });
    const { getByTestId, findByText, getByText } = await renderCasesScreen();
    await findByText("Jane Doe");

    await fireEvent.press(getByTestId("cases-load-more"));

    expect(lastUseCasesParams()).toEqual({ page: 2, pageSize: 10 });
    expect(await findByText("John Roe")).toBeTruthy();
    expect(getByText("Jane Doe")).toBeTruthy();
  });

  it("returns to and refreshes page one after older cases were loaded", async () => {
    setMockAppState({
      casesByPage: {
        1: [inProgressCase],
        2: [completedCaseWithInvoice],
      },
      casesTotal: 12,
      casesHasMore: true,
    });
    const screen = await renderCasesScreen();
    await fireEvent.press(screen.getByTestId("cases-load-more"));
    await screen.findByText("John Roe");

    await act(() => {
      screen.getByTestId("cases-list").props.refreshControl.props.onRefresh();
    });

    await waitFor(() => {
      expect(lastUseCasesParams()).toEqual({ page: 1, pageSize: 10 });
    });
  });

  it("requests conflicts server-side and keeps a conflict whose pair is on a later page", async () => {
    const laterConflict = {
      ...completedCaseWithInvoice,
      id: "case-conflict-later-page",
      casePanBarcode: inProgressCase.casePanBarcode,
    };
    setMockAppState({
      cases: [inProgressCase, laterConflict],
      casesByPage: { 1: [inProgressCase], 2: [laterConflict] },
      casesTotal: 2,
    });
    const screen = await renderCasesScreen();

    await fireEvent.press(screen.getByTestId("cases-conflict-filter-chip"));

    expect(await screen.findByText("Jane Doe")).toBeTruthy();
    await waitFor(() => {
      expect(lastUseCasesParams()).toMatchObject({
        conflictsOnly: true,
        page: 1,
        pageSize: 10,
      });
    });
  });

  describe.skip("removed multi-select / bulk locate", () => {
    beforeEach(() => {
      // The locate sheet shows the lab's own locations (fetched from
      // /api/locations) — there is no built-in fallback list any more, so the
      // membership that resolves the lab and a realistic response are both
      // required for any station to be selectable.
      setMockAppState({
        cases: [inProgressCase, completedCaseWithInvoice],
        meMemberships: [
          {
            organizationId: "lab-org-1",
            role: "owner",
            status: "active",
            organization: { type: "lab" },
          },
        ],
      });
      setMockFetchHandler(locationsOnlyHandler());
    });

    /** Opens the bulk locate sheet and waits for the lab's locations to load. */
    async function openBulkLocate(
      getByTestId: Awaited<ReturnType<typeof render>>["getByTestId"],
    ): Promise<void> {
      await fireEvent.press(getByTestId("bulk-locate-btn"));
      await waitFor(
        () => expect(getByTestId("locate-option-loc-received")).toBeTruthy(),
        { timeout: 3_000 },
      );
    }

    it("long-pressing a case card enters selection mode and selects that case", async () => {
      const { getByTestId, getByText } = await renderCasesScreen();
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      expect(getByText("1 selected")).toBeTruthy();
    });

    it("shows the bulk Locate button when in selection mode", async () => {
      const { getByTestId, getByText } = await renderCasesScreen();
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      expect(getByTestId("bulk-locate-btn")).toBeTruthy();
      expect(getByText(/Locate \(1\)/)).toBeTruthy();
    });

    it("tapping another case while in selection mode toggles its selection", async () => {
      const { getByTestId, getByText } = await renderCasesScreen();
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      await fireEvent.press(getByTestId(`case-card-${completedCaseWithInvoice.id}`));
      expect(getByText("2 selected")).toBeTruthy();
      expect(getByText(/Locate \(2\)/)).toBeTruthy();
    });

    it("tapping a selected case while in selection mode deselects it", async () => {
      const { getByTestId, getByText } = await renderCasesScreen();
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      await fireEvent.press(getByTestId(`case-card-${completedCaseWithInvoice.id}`));
      await fireEvent.press(getByTestId(`case-card-${completedCaseWithInvoice.id}`));
      expect(getByText("1 selected")).toBeTruthy();
    });

    it("shows a Cancel button that exits selection mode", async () => {
      const { getByTestId, getByText, queryByText } = await renderCasesScreen();
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      expect(getByText("1 selected")).toBeTruthy();
      await fireEvent.press(getByTestId("selection-cancel-btn"));
      expect(queryByText("1 selected")).toBeNull();
      expect(getByText("Cases")).toBeTruthy();
    });

    it("does not navigate to case detail when tapping a case in selection mode", async () => {
      const { getByTestId } = await renderCasesScreen();
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      await fireEvent.press(getByTestId(`case-card-${completedCaseWithInvoice.id}`));
      expect(router.push).not.toHaveBeenCalled();
    });

    it("long-press followed by onPress does not deselect the item (longPressActiveRef guard)", async () => {
      const { getByTestId, getByText } = await renderCasesScreen();
      // Simulate the RN Pressable sequence: onLongPress fires, then onPress fires on lift
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      await fireEvent.press(getByTestId(`case-card-${inProgressCase.id}`));
      // The item should still be selected (not toggled off by the follow-up onPress)
      expect(getByText("1 selected")).toBeTruthy();
    });

    it("tapping Locate (N) opens the bulk locate sheet", async () => {
      const { getByTestId, getByText } = await renderCasesScreen();
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      await fireEvent.press(getByTestId("bulk-locate-btn"));
      // Sheet header shows the locate title
      expect(getByText("Locate 1 Case")).toBeTruthy();
    });

    it("calls the bulk-status endpoint with all selected case IDs", async () => {
      setMockFetchHandler(withLocations((_url, init) => bulkStatusOkResponse(init)));
      const { getByTestId, getByText } = await renderCasesScreen();

      // Select both cases
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      await fireEvent.press(getByTestId(`case-card-${completedCaseWithInvoice.id}`));
      expect(getByText("2 selected")).toBeTruthy();

      // Open bulk locate sheet and wait for the lab's locations to load
      await openBulkLocate(getByTestId);

      // Pick a station and confirm — the location's mapped status is sent,
      // never its code.
      await fireEvent.press(getByTestId("locate-option-loc-received"));
      await fireEvent.press(getByTestId("locate-sheet-confirm"));

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
      setMockFetchHandler(withLocations((_url, init) => bulkStatusOkResponse(init)));
      const { getByTestId, getByText, queryByText } = await renderCasesScreen();

      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      await openBulkLocate(getByTestId);
      await fireEvent.press(getByTestId("locate-option-loc-received"));
      await fireEvent.press(getByTestId("locate-sheet-confirm"));

      await waitFor(() => {
        expect(queryByText("1 selected")).toBeNull();
        expect(getByText("Cases")).toBeTruthy();
      });
    });

    it("exits selection mode when a legacy-only batch is located (server now updates blobs)", async () => {
      setMockFetchHandler(withLocations((_url, init) => bulkStatusLegacyOnlyResponse(init)));
      const { getByTestId, getByText, queryByText } = await renderCasesScreen();

      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      expect(getByText("1 selected")).toBeTruthy();

      await openBulkLocate(getByTestId);
      await fireEvent.press(getByTestId("locate-option-loc-received"));
      await fireEvent.press(getByTestId("locate-sheet-confirm"));

      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("bulk-status"),
          expect.anything(),
        );
      });

      // The server now updates legacy blobs, so no error alert is shown.
      expect(Alert.alert).not.toHaveBeenCalledWith(
        "Can't locate these cases",
        expect.anything(),
      );

      // All cases moved, so selection mode exits and the header returns to normal.
      await waitFor(() => {
        expect(queryByText("1 selected")).toBeNull();
        expect(getByText("Cases")).toBeTruthy();
      });
    });

    it("stays in selection mode when the bulk-status request fails (so user can retry)", async () => {
      setMockFetchHandler(withLocations(() => bulkStatusErrorResponse(422, "Server error")));
      const { getByTestId, getByText } = await renderCasesScreen();

      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      expect(getByText("1 selected")).toBeTruthy();

      await openBulkLocate(getByTestId);
      await fireEvent.press(getByTestId("locate-option-loc-received"));
      await fireEvent.press(getByTestId("locate-sheet-confirm"));

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
      setMockFetchHandler(withLocations((_url, init) => bulkStatusOkResponse(init)));
      const { getByTestId, queryByTestId } = await renderCasesScreen();

      // First bulk locate — pick a station and confirm
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      await openBulkLocate(getByTestId);
      await fireEvent.press(getByTestId("locate-option-loc-received"));
      await fireEvent.press(getByTestId("locate-sheet-confirm"));

      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("bulk-status"),
          expect.anything(),
        );
      });

      // Re-enter selection mode for a second bulk locate
      await fireEvent(getByTestId(`case-card-${completedCaseWithInvoice.id}`), "longPress");
      await openBulkLocate(getByTestId);

      // Confirm button must be disabled (no station pre-picked)
      expect(queryByTestId("locate-sheet-confirm")).toBeTruthy();
      // The previously selected "received" station should NOT be active;
      // the sheet should have reset locateTarget to null on close.
      // Verify by asserting the confirm button is now disabled (no selection).
      const confirmBtn = getByTestId("locate-sheet-confirm");
      expect(confirmBtn.props.accessibilityState?.disabled ?? confirmBtn.props.disabled).toBe(true);
    });
    it("lists the lab's custom active locations and never an inactive one", async () => {
      const { getByTestId, queryByTestId } = await renderCasesScreen();
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      await openBulkLocate(getByTestId);

      // A custom location that is not part of the built-in station list.
      expect(getByTestId("locate-option-loc-polish")).toBeTruthy();
      // Inactive locations are excluded by the activeOnly=true request.
      expect(queryByTestId("locate-option-loc-retired")).toBeNull();
    });

    it("keeps two custom locations that share a workflow status independently selectable", async () => {
      setMockFetchHandler(withLocations((_url, init) => bulkStatusOkResponse(init)));
      const { getByTestId } = await renderCasesScreen();
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      await openBulkLocate(getByTestId);

      // Both qc-mapped locations render as their own rows (the old
      // status-keyed list collapsed them into a single entry).
      expect(getByTestId("locate-option-loc-polish")).toBeTruthy();
      expect(getByTestId("locate-option-loc-glaze")).toBeTruthy();

      // A selected row renders the checkmark icon; an unselected one renders
      // an empty radio.
      const isChecked = (testID: string): boolean =>
        getByTestId(testID).children.some((node) => typeof node !== "string" && node.props.name === "checkmark-circle");

      // Selecting one checks only that row — one destination at a time.
      await fireEvent.press(getByTestId("locate-option-loc-glaze"));
      expect(isChecked("locate-option-loc-glaze")).toBe(true);
      expect(isChecked("locate-option-loc-polish")).toBe(false);

      // ...and the sibling row is independently selectable.
      await fireEvent.press(getByTestId("locate-option-loc-polish"));
      expect(isChecked("locate-option-loc-polish")).toBe(true);
      expect(isChecked("locate-option-loc-glaze")).toBe(false);

      await fireEvent.press(getByTestId("locate-sheet-confirm"));
      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("bulk-status"),
          expect.anything(),
        );
      });
      const callArgs = vi
        .mocked(resilientFetch)
        .mock.calls.find(([url]) => String(url).includes("bulk-status"));
      const sentBody = JSON.parse((callArgs![1] as RequestInit).body as string) as {
        status: string;
      };
      // The location's mapped status, not its code ("POLISH").
      expect(sentBody.status).toBe("qc");
    });

    it("shows a loading state instead of a stand-in list while locations load", async () => {
      const { getByTestId, queryByTestId } = await renderCasesScreen();
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      await fireEvent.press(getByTestId("bulk-locate-btn"));

      expect(getByTestId("locate-sheet-locations-loading")).toBeTruthy();
      expect(queryByTestId("locate-option-loc-received")).toBeNull();

      await waitFor(() => expect(getByTestId("locate-option-loc-received")).toBeTruthy());
      expect(queryByTestId("locate-sheet-locations-loading")).toBeNull();
    });

    it("shows an explicit empty state when the lab has no active locations", async () => {
      setMockFetchHandler(locationsOnlyHandler([]));
      const { getByTestId, queryByTestId } = await renderCasesScreen();
      await fireEvent(getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      await fireEvent.press(getByTestId("bulk-locate-btn"));

      await waitFor(() => expect(getByTestId("locate-sheet-locations-empty")).toBeTruthy());
      // No built-in list quietly standing in for the lab's real data.
      expect(queryByTestId("locate-option-loc-received")).toBeNull();
      expect(queryByTestId("locate-option-received")).toBeNull();
    });
  });

  describe("single-case quick actions", () => {
    beforeEach(() => {
      setMockAppState({ cases: [inProgressCase, completedCaseWithInvoice] });
    });

    it("opens quick actions without rendering the removed bulk controls", async () => {
      const screen = await renderCasesScreen();
      await fireEvent(screen.getByTestId(`case-card-${inProgressCase.id}`), "longPress");
      expect(screen.getByTestId("case-quick-actions")).toBeTruthy();
      expect(screen.queryByTestId("bulk-locate-btn")).toBeNull();
      expect(screen.queryByText(/selected/)).toBeNull();
    });

    it("suppresses the release tap after long press but keeps normal taps navigating", async () => {
      const screen = await renderCasesScreen();
      const card = screen.getByTestId(`case-card-${inProgressCase.id}`);
      await fireEvent(card, "longPress");
      await fireEvent.press(card);
      expect(router.push).not.toHaveBeenCalled();

      await fireEvent.press(screen.getByTestId("case-quick-actions-close"));
      await fireEvent.press(card);
      expect(router.push).toHaveBeenCalled();
    });

    it("does not offer quick actions for completed or deleted records", async () => {
      setMockAppState({
        cases: [
          { ...inProgressCase, status: "deleted" },
          { ...completedCaseWithInvoice, deleted: true },
        ],
      });
      const screen = await renderCasesScreen();
      expect(screen.queryByTestId("case-quick-actions")).toBeNull();
    });
  });

  describe("server-backed search", () => {
    beforeEach(() => {
      setMockAppState({ cases: [inProgressCase, completedCaseWithInvoice] });
    });

    it("filters by case number", async () => {
      const { getByTestId, queryByText, findByText } = await renderCasesScreen();
      await fireEvent.changeText(getByTestId("cases-search"), "5002");
      expect(await findByText("John Roe")).toBeTruthy();
      await waitFor(() => expect(queryByText("Jane Doe")).toBeNull());
    });

    it("filters by doctor name", async () => {
      const noMatchDoctor = {
        ...completedCaseWithInvoice,
        id: "case-other-doc",
        caseNumber: "5099",
        doctorName: "Dr. Nguyen",
      };
      setMockAppState({ cases: [inProgressCase, noMatchDoctor] });
      const { getByTestId, queryByText, findByText } = await renderCasesScreen();
      await fireEvent.changeText(getByTestId("cases-search"), "Nguyen");
      expect(await findByText("Dr. Nguyen")).toBeTruthy();
      await waitFor(() => expect(queryByText("Jane Doe")).toBeNull());
    });

    it("filters by barcode without displaying the barcode on cards", async () => {
      const { getByTestId, queryByText, findByText } = await renderCasesScreen();
      await fireEvent.changeText(getByTestId("cases-search"), "PAN-5001");
      expect(await findByText("Jane Doe")).toBeTruthy();
      await waitFor(() => expect(queryByText("John Roe")).toBeNull());
      expect(queryByText("PAN-5001")).toBeNull();
    });

    it("shows the no-results empty state when nothing matches", async () => {
      const { getByTestId, findByText } = await renderCasesScreen();
      await fireEvent.changeText(getByTestId("cases-search"), "zzz-nothing-matches");
      expect(await findByText("No matching cases")).toBeTruthy();
    });
  });

  // Task #2668: the Cases list resets its filters when the user leaves the
  // Cases section entirely (blur where the exit was NOT into a case-detail /
  // new-case screen), but preserves them when the exit is into one of those
  // in-Cases workflows so returning from a case keeps the user's place.
  describe("reset-on-blur focus effect", () => {
    beforeEach(() => {
      setMockAppState({ cases: [inProgressCase, completedCaseWithInvoice] });
    });

    it("resets filters on blur when not leaving into a case workflow", async () => {
      const { getByTestId, queryByText } = await renderCasesScreen();

      // Consume any stale leavingIntoCasesWorkflow flag left true by a prior
      // test's row-press navigation, so this blur is a genuine "left Cases".
      await flushFocusEffect();
      await blur();

      // Apply a search filter -> the Reset filters chip becomes visible.
      await fireEvent.changeText(getByTestId("cases-search"), "Jane");
      expect(queryByText("Reset filters")).toBeTruthy();

      // Blur without an in-workflow navigation -> filters reset.
      await flushFocusEffect();
      await blur();

      expect(getByTestId("cases-search").props.value).toBe("");
      expect(queryByText("Reset filters")).toBeNull();
    });

    it("preserves filters on blur when leaving into a case detail workflow", async () => {
      const { getByTestId, queryByText } = await renderCasesScreen();
      await flushFocusEffect();

      // Apply a search filter.
      await fireEvent.changeText(getByTestId("cases-search"), "Jane");
      expect(queryByText("Reset filters")).toBeTruthy();
      await flushFocusEffect();

      // Opening a case detail sets leavingIntoCasesWorkflow = true.
      await fireEvent.press(getByTestId(`case-card-${inProgressCase.id}`));
      expect(router.push).toHaveBeenCalledWith(`/case/${inProgressCase.id}`);

      // Blur into that workflow -> filters preserved.
      await blur();

      expect(getByTestId("cases-search").props.value).toBe("Jane");
      expect(queryByText("Reset filters")).toBeTruthy();
    });
  });

  // Task #2678: the other half of the preserve-on-workflow promise — when the
  // user comes BACK from an in-Cases workflow (case detail / new-case), the
  // filters they had applied are still reflected in the list. Because the tab
  // screen stays mounted across the round-trip, "restore" means the in-memory
  // filter state survives the blur-into-workflow and is re-rendered on return.
  // Covers a non-search filter (Conflicts) alongside the text search — prior
  // coverage only exercised the text search on preservation.
  describe("returning from a case workflow keeps the applied filters", () => {
    beforeEach(() => {
      setMockAppState({ cases: [inProgressCase, completedCaseWithInvoice] });
    });

    it("re-shows the search box and active-filter chip after a case round-trip", async () => {
      const { getByTestId, queryByTestId, queryByText } = await renderCasesScreen();
      // Consume any stale leavingIntoCasesWorkflow flag from a prior test.
      await flushFocusEffect();
      await blur();

      // Apply a text search AND a non-search filter (Conflicts).
      await fireEvent.changeText(getByTestId("cases-search"), "Jane");
      await fireEvent.press(getByTestId("cases-conflict-filter-chip"));

      // Both are active: search populated, reset chip visible, and the header
      // subtitle shows the "(filtered)" marker driven by the non-search filter.
      expect(getByTestId("cases-search").props.value).toBe("Jane");
      expect(queryByTestId("cases-reset-filters-chip")).toBeTruthy();
      expect(queryByText(/\(filtered\)/)).toBeTruthy();
      await flushFocusEffect();

      // Leave into an in-Cases workflow — the New button sets
      // leavingIntoCasesWorkflow so the blur PRESERVES filters instead of
      // resetting them. (The list rows are hidden by the Conflicts filter, so
      // this always-visible affordance is what drives the navigation.)
      await fireEvent.press(getByTestId("new-case-button"));
      expect(router.push).toHaveBeenCalledWith("/new-case");

      // Blur into that workflow, then re-focus as if returning to Cases.
      await blur();
      await flushFocusEffect();

      // On return, every applied filter is still reflected in the UI — the list
      // did NOT silently drop back to an unfiltered state.
      expect(getByTestId("cases-search").props.value).toBe("Jane");
      expect(queryByTestId("cases-reset-filters-chip")).toBeTruthy();
      expect(queryByText(/\(filtered\)/)).toBeTruthy();
    });
  });

  // Task #3270: a "Type" filter lets the user narrow the list to cases whose
  // first restoration maps to a top-level case type (Restorative / Removable
  // / Ortho & Appliances) via `deriveCaseHierarchy`.
  describe("Case Type filter", () => {
    const removableCase = {
      ...inProgressCase,
      id: "case-removable-type",
      caseNumber: "5010",
      patientFirstName: "Remy",
      patientLastName: "Partial",
      restorationTypes: "Partial",
      restorationMaterials: "Acrylic",
      firstRestorationSubtype: "removable/partials/acrylic",
    };
    const orthoCase = {
      ...inProgressCase,
      id: "case-ortho-type",
      caseNumber: "5011",
      patientFirstName: "Orla",
      patientLastName: "Retainer",
      restorationTypes: "Retainer",
      restorationMaterials: null,
      firstRestorationSubtype: "ortho/retainers",
    };
    const noTypeCase = {
      ...inProgressCase,
      id: "case-no-type",
      caseNumber: "5012",
      patientFirstName: "Nolan",
      patientLastName: "Blank",
      restorationTypes: null,
      restorationMaterials: null,
      firstRestorationSubtype: null,
    };

    beforeEach(() => {
      // inProgressCase resolves to "restorative" via firstRestorationSubtype.
      setMockAppState({ cases: [inProgressCase, removableCase, orthoCase, noTypeCase] });
    });

    it("shows the Type filter chip with all cases visible by default", async () => {
      const { getByTestId, getByText } = await renderCasesScreen();
      expect(getByTestId("cases-type-filter-chip")).toBeTruthy();
      expect(getByText("Jane Doe")).toBeTruthy();
      expect(getByText("Remy Partial")).toBeTruthy();
      expect(getByText("Orla Retainer")).toBeTruthy();
      expect(getByText("Nolan Blank")).toBeTruthy();
    });

    it("opens the picker and filters to Restorative cases", async () => {
      const { getByTestId, getByText, queryByText } = await renderCasesScreen();
      await fireEvent.press(getByTestId("cases-type-filter-chip"));
      await fireEvent.press(getByTestId("cases-type-option-restorative"));

      expect(getByText("Jane Doe")).toBeTruthy();
      expect(queryByText("Remy Partial")).toBeNull();
      expect(queryByText("Orla Retainer")).toBeNull();
      expect(queryByText("Nolan Blank")).toBeNull();
    });

    it("filters to Removable cases", async () => {
      const { getByTestId, getByText, queryByText } = await renderCasesScreen();
      await fireEvent.press(getByTestId("cases-type-filter-chip"));
      await fireEvent.press(getByTestId("cases-type-option-removable"));

      expect(getByText("Remy Partial")).toBeTruthy();
      expect(queryByText("Jane Doe")).toBeNull();
      expect(queryByText("Orla Retainer")).toBeNull();
    });

    it("filters to Ortho / Appliances cases", async () => {
      const { getByTestId, getByText, queryByText } = await renderCasesScreen();
      await fireEvent.press(getByTestId("cases-type-filter-chip"));
      await fireEvent.press(getByTestId("cases-type-option-ortho"));

      expect(getByText("Orla Retainer")).toBeTruthy();
      expect(queryByText("Jane Doe")).toBeNull();
      expect(queryByText("Remy Partial")).toBeNull();
    });

    it("shows the selected type as the chip label and clears back to All types", async () => {
      const { getByTestId, getAllByText, getByText, queryByText } = await renderCasesScreen();
      await fireEvent.press(getByTestId("cases-type-filter-chip"));
      await fireEvent.press(getByTestId("cases-type-option-ortho"));

      // The chip label reads "Ortho / Appliances" once the picker closes; the
      // matching row itself carries the compact "O" badge.
      expect(getAllByText("Ortho / Appliances").length).toBeGreaterThan(0);
      expect(getAllByText("O").length).toBeGreaterThan(0);
      expect(queryByText("Jane Doe")).toBeNull();

      // Re-opening and picking "All types" clears the filter again.
      await fireEvent.press(getByTestId("cases-type-filter-chip"));
      await fireEvent.press(getByTestId("cases-type-option-all"));

      expect(getByText("Jane Doe")).toBeTruthy();
      expect(getByText("Orla Retainer")).toBeTruthy();
    });

    it("resets the type filter along with the rest via Reset filters", async () => {
      const { getByTestId, findByText, queryByText } = await renderCasesScreen();
      await fireEvent.press(getByTestId("cases-type-filter-chip"));
      await fireEvent.press(getByTestId("cases-type-option-removable"));
      expect(queryByText("Jane Doe")).toBeNull();

      await fireEvent.press(getByTestId("cases-reset-filters-chip"));
      expect(await findByText("Jane Doe")).toBeTruthy();
      expect(await findByText("Type")).toBeTruthy();
    });
  });

  // Task #2668: the "Reset filters" chip surfaces only when a record-hiding
  // filter (or the text search) is active, and pressing it clears everything.
  describe("Reset filters chip", () => {
    beforeEach(() => {
      setMockAppState({ cases: [inProgressCase, completedCaseWithInvoice] });
    });

    it("is hidden until a filter (including search) is active", async () => {
      const { getByTestId, queryByTestId } = await renderCasesScreen();
      expect(queryByTestId("cases-reset-filters-chip")).toBeNull();

      await fireEvent.changeText(getByTestId("cases-search"), "Jane");
      expect(queryByTestId("cases-reset-filters-chip")).toBeTruthy();
    });

    it("clears the active search when pressed", async () => {
      const { getByTestId, queryByTestId } = await renderCasesScreen();
      await fireEvent.changeText(getByTestId("cases-search"), "Jane");

      const chip = getByTestId("cases-reset-filters-chip");
      await fireEvent.press(chip);

      expect(getByTestId("cases-search").props.value).toBe("");
      expect(queryByTestId("cases-reset-filters-chip")).toBeNull();
    });
  });
});
