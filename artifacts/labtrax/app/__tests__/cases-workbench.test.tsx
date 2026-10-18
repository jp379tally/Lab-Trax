import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import { router } from "expo-router";
import {
  resetMockAppState,
  setMockAppState,
  lastUseCasesParams,
  mockInvalidateQueries,
  resetMockFetchHandler,
  setMockFetchHandler,
} from "../../vitest.setup";
import CasesScreen from "../(tabs)/index";
import { CasesSummary } from "@/components/CasesSummary";

const makeCase = (id: string, n: string) => ({
  id,
  caseNumber: n,
  patientFirstName: "Mina",
  patientLastName: "Okafor",
  doctorName: "Dr. Reyes",
  status: "received",
  priority: "normal",
  dueDate: null,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  totalPrice: "0.00",
  labOrganizationId: "lab-1",
});
const overview = (totalCases: number) => ({
  totalCases,
  dueToday: 3,
  conflicts: 1,
  rushCases: 2,
  processingCases: 8,
  inTransitCases: 5,
  completedCases: 9,
  overdueCases: 2,
  receivedCases: 12,
  inDesignCases: 4,
  modelRoomCases: 3,
  shippedCases: 5,
  scanCases: 1,
  millingCases: 2,
  postMillCases: 3,
  sinteringFurnaceCases: 4,
  porcelainCases: 5,
  qualityCheckCases: 6,
  onHoldCases: 7,
  remakeCases: 8,
});

const labMembership = [{
  role: "technician",
  status: "active",
  organizationId: "lab-1",
  organization: { id: "lab-1", type: "lab", name: "Test Lab" },
}];

afterEach(async () => {
  await cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  vi.restoreAllMocks();
});

describe("Mobile Cases worklist", () => {
  it("shows complete-set summaries and opens case details", async () => {
    setMockAppState({
      cases: [makeCase("c1", "WB-1001")],
      casesOverview: { data: overview(1284) },
    });
    const { getByTestId, findByText } = await render(<CasesScreen />);
    expect(getByTestId("cases-summary-total-value").props.children).toBe("1,284");
    expect(getByTestId("cases-summary-overdue-value").props.children).toBe("2");
    expect(getByTestId("cases-quick-filter-processing")).toBeTruthy();
    expect(getByTestId("cases-quick-filter-scan")).toBeTruthy();
    expect(getByTestId("cases-quick-filter-remake")).toBeTruthy();
    expect(await findByText("1 case")).toBeTruthy();
    fireEvent.press(await findByText("Mina Okafor"));
    expect(router.push).toHaveBeenCalledWith("/case/c1");
  });

  it("keeps complete-set summary counts stable while search changes the paged list", async () => {
    setMockAppState({
      cases: [makeCase("c1", "WB-1001")],
      casesOverview: { data: overview(90) },
    });
    const { getByTestId } = await render(<CasesScreen />);
    await fireEvent.changeText(getByTestId("cases-search"), "zzz-no-match");
    await waitFor(() => expect(lastUseCasesParams()).toMatchObject({ search: "zzz-no-match", page: 1 }));
    expect(getByTestId("cases-summary-total-value").props.children).toBe("90");
  });

  it("preserves page append, barcode/conflict filters, and the add-case action", async () => {
    setMockAppState({
      casesByPage: { 1: [makeCase("c1", "WB-1001")], 2: [makeCase("c2", "WB-1002")] },
      casesHasMore: true,
      casesTotal: 90,
      casesOverview: { data: overview(90) },
    });
    const view = await render(<CasesScreen />);
    await view.findByTestId("case-card-c1");
    await fireEvent.press(view.getByTestId("cases-load-more"));
    await view.findByTestId("case-card-c2");
    expect(view.getByTestId("case-card-c1")).toBeTruthy();
    expect(lastUseCasesParams()).toMatchObject({ page: 2 });
    await fireEvent.press(view.getByTestId("cases-conflict-filter-chip"));
    expect(lastUseCasesParams()).toMatchObject({ conflictsOnly: true, page: 1 });
    await fireEvent.press(view.getByTestId("cases-barcode-filter-chip"));
    await fireEvent.changeText(view.getByTestId("cases-barcode-filter-input"), "WB-PAN");
    await waitFor(() => expect(lastUseCasesParams()).toMatchObject({ barcode: "WB-PAN" }));
    expect(view.getByTestId("cases-summary-total-value").props.children).toBe("90");
    await fireEvent.press(view.getByTestId("new-case-button"));
    expect(router.push).toHaveBeenCalledWith("/new-case");
    expect(view.getByTestId("cases-scan-barcode")).toBeTruthy();
  });

  it("applies a shared mobile view's search, status, and calendar-day ranges without changing case navigation", async () => {
    const savedView = {
      id: "view-received",
      labOrganizationId: "lab-1",
      name: "January received",
      filters: {
        search: "Mina",
        statusFilters: ["received"],
        mobile: {
          createdFilter: "custom",
          createdCustomFrom: "2025-01-01",
          createdCustomTo: "2025-01-31",
          dueFilter: "all",
          dueCustomFrom: "",
          dueCustomTo: "",
        },
      },
      createdAt: "2026-10-14T12:00:00.000Z",
      updatedAt: "2026-10-14T12:00:00.000Z",
    };
    setMockAppState({
      cases: [makeCase("c1", "WB-1001")],
      casesOverview: { data: overview(1) },
      meMemberships: labMembership,
      savedCaseViews: [savedView],
    });

    const screen = await render(<CasesScreen />);
    await screen.findByTestId("case-card-c1");
    await fireEvent.press(screen.getByTestId("cases-saved-views-open"));
    await screen.findByText("January received");
    await fireEvent.press(screen.getByTestId("cases-saved-view-apply-view-received"));
    await waitFor(() => expect(lastUseCasesParams()).toMatchObject({
      search: "Mina",
      status: ["received"],
      createdStart: "2025-01-01",
      createdEnd: "2025-01-31",
    }));
    await fireEvent.press(screen.getByTestId("case-card-c1"));
    expect(router.push).toHaveBeenCalledWith("/case/c1");
  });

  it("clears mobile created and due dates when applying a view saved on desktop and says why", async () => {
    const mobileView = {
      id: "view-mobile",
      labOrganizationId: "lab-1",
      name: "January received",
      filters: {
        search: "Mina",
        statusFilters: ["received"],
        mobile: {
          createdFilter: "custom",
          createdCustomFrom: "2025-01-01",
          createdCustomTo: "2025-01-31",
          dueFilter: "custom",
          dueCustomFrom: "2025-02-01",
          dueCustomTo: "2025-02-28",
        },
      },
      createdAt: "2026-10-14T12:00:00.000Z",
      updatedAt: "2026-10-14T12:00:00.000Z",
    };
    const desktopView = {
      id: "view-desktop",
      labOrganizationId: "lab-1",
      name: "Desktop received",
      filters: {
        search: "Okafor",
        statusFilters: ["qc"],
        desktop: { dateRangeFilter: "custom", customStartDate: "2026-10-01", customEndDate: "2026-10-14" },
      },
      createdAt: "2026-10-14T12:00:00.000Z",
      updatedAt: "2026-10-14T12:00:00.000Z",
    };
    setMockAppState({
      cases: [makeCase("c1", "WB-1001")],
      casesOverview: { data: overview(1) },
      meMemberships: labMembership,
      savedCaseViews: [mobileView, desktopView],
    });
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);

    const screen = await render(<CasesScreen />);
    await screen.findByTestId("case-card-c1");
    await fireEvent.press(screen.getByTestId("cases-saved-views-open"));
    await fireEvent.press(screen.getByTestId("cases-saved-view-apply-view-mobile"));
    await waitFor(() => expect(lastUseCasesParams()).toMatchObject({
      createdStart: "2025-01-01",
      createdEnd: "2025-01-31",
      dueStart: "2025-02-01",
      dueEnd: "2025-02-28",
    }));
    expect(alert).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("cases-saved-views-open"));
    await fireEvent.press(screen.getByTestId("cases-saved-view-apply-view-desktop"));
    await waitFor(() => expect(lastUseCasesParams()).toMatchObject({ search: "Okafor", status: ["qc"] }));
    const params = lastUseCasesParams() as Record<string, unknown>;
    expect(params.createdStart).toBeUndefined();
    expect(params.createdEnd).toBeUndefined();
    expect(params.dueStart).toBeUndefined();
    expect(params.dueEnd).toBeUndefined();
    expect(alert).toHaveBeenCalledWith(
      "Date filter not applied",
      expect.stringMatching(/saved on desktop.*mobile created and due dates were cleared/),
    );
  });

  it("saves, renames, and removes lab-shared views from the saved-views sheet", async () => {
    const existing = {
      id: "view-received",
      labOrganizationId: "lab-1",
      name: "January received",
      filters: {
        search: "",
        statusFilters: ["received"],
        desktop: { dateRangeFilter: "custom", customStartDate: "2026-09-01", customEndDate: "2026-09-30" },
      },
      createdAt: "2026-10-14T12:00:00.000Z",
      updatedAt: "2026-10-14T12:00:00.000Z",
    };
    let mutableView = existing;
    setMockAppState({
      cases: [makeCase("c1", "WB-1001")],
      casesOverview: { data: overview(1) },
      meMemberships: labMembership,
      savedCaseViews: [existing],
    });
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    setMockFetchHandler((url, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, method, body });
      if (method === "POST") {
        return new Response(JSON.stringify({
          ok: true,
          data: { ...existing, id: "view-new", name: body.name, filters: body.filters },
        }), { status: 201 });
      }
      if (method === "PATCH") {
        mutableView = {
          ...mutableView,
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.filters === undefined ? {} : { filters: body.filters }),
        };
        return new Response(JSON.stringify({
          ok: true,
          data: mutableView,
        }), { status: 200 });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);
    mockInvalidateQueries.mockClear();

    const screen = await render(<CasesScreen />);
    await screen.findByTestId("case-card-c1");
    await fireEvent.changeText(screen.getByTestId("cases-search"), "Okafor");
    await fireEvent.press(screen.getByTestId("cases-saved-views-open"));
    await fireEvent.changeText(screen.getByTestId("cases-saved-view-name"), "  Rush queue  ");
    await fireEvent.press(screen.getByTestId("cases-saved-view-save"));
    await waitFor(() => expect(requests.some((request) => request.method === "POST")).toBe(true));
    expect(requests.find((request) => request.method === "POST")).toEqual({
      url: "/api/cases/saved-views",
      method: "POST",
      body: {
        labOrganizationId: "lab-1",
        name: "Rush queue",
        filters: {
          search: "Okafor",
          statusFilters: [],
          mobile: {
            createdFilter: "all",
            createdCustomFrom: "",
            createdCustomTo: "",
            dueFilter: "all",
            dueCustomFrom: "",
            dueCustomTo: "",
          },
        },
      },
    });
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Saved view", expect.stringContaining("Rush queue")));

    await fireEvent.press(screen.getByTestId("cases-saved-view-row-view-received"));
    expect(screen.getByTestId("cases-saved-view-name").props.value).toBe("January received");
    await fireEvent.changeText(screen.getByTestId("cases-saved-view-name"), "February received");
    await fireEvent.press(screen.getByTestId("cases-saved-view-rename"));
    await waitFor(() => expect(requests.find((request) => request.method === "PATCH")).toEqual({
      url: "/api/cases/saved-views/view-received",
      method: "PATCH",
      body: { labOrganizationId: "lab-1", name: "February received" },
    }));

    alert.mockClear();
    await fireEvent.press(screen.getByTestId("cases-saved-view-update"));
    expect(alert).toHaveBeenCalledWith(
      "Update shared view?",
      expect.stringMatching(/everyone in your lab.*mobile created\/due date filters/),
      expect.any(Array),
    );
    const updateButtons = alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    await act(async () => {
      updateButtons.find((button) => button.text === "Update filters")?.onPress?.();
    });
    await waitFor(() => expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(2));
    expect(requests.filter((request) => request.method === "PATCH")[1]).toEqual({
      url: "/api/cases/saved-views/view-received",
      method: "PATCH",
      body: {
        labOrganizationId: "lab-1",
        filters: {
          search: "Okafor",
          statusFilters: [],
          mobile: {
            createdFilter: "all",
            createdCustomFrom: "",
            createdCustomTo: "",
            dueFilter: "all",
            dueCustomFrom: "",
            dueCustomTo: "",
          },
          desktop: { dateRangeFilter: "custom", customStartDate: "2026-09-01", customEndDate: "2026-09-30" },
        },
      },
    });
    await waitFor(() => expect(alert).toHaveBeenCalledWith(
      "Saved view updated",
      expect.stringContaining("February received"),
    ));

    alert.mockClear();
    await fireEvent.press(screen.getByTestId("cases-saved-view-delete"));
    expect(alert).toHaveBeenCalledWith(
      "Remove shared view?",
      expect.stringContaining("January received"),
      expect.any(Array),
    );
    const buttons = alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    await act(async () => {
      buttons.find((button) => button.text === "Remove")?.onPress?.();
    });
    await waitFor(() => expect(requests.find((request) => request.method === "DELETE")?.url)
      .toBe("/api/cases/saved-views/view-received?labOrganizationId=lab-1"));
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["cases", "saved-views", "lab-1"] });
  });

  it("refreshes the worklist and overview without losing loaded cards", async () => {
    const listRefetch = vi.fn(), overviewRefetch = vi.fn();
    setMockAppState({
      cases: [makeCase("c1", "WB-1001")],
      casesRefetch: listRefetch,
      casesOverview: { data: overview(90), refetch: overviewRefetch },
    });
    const view = await render(<CasesScreen />);
    await view.findByTestId("case-card-c1");
    await act(async () => {
      view.getByTestId("cases-list").props.refreshControl.props.onRefresh();
    });
    expect(listRefetch).toHaveBeenCalled();
    expect(overviewRefetch).toHaveBeenCalled();
    expect(view.getByTestId("case-card-c1")).toBeTruthy();
  });

  it("keeps empty, list loading, and list error states explicit", async () => {
    const view = await render(<CasesScreen />);
    expect(await view.findByText("No cases yet")).toBeTruthy();
    setMockAppState({ casesIsLoading: true });
    await view.rerender(<CasesScreen />);
    expect(view.getByText("Loading…")).toBeTruthy();
    setMockAppState({ casesIsLoading: false, casesIsError: true });
    await view.rerender(<CasesScreen />);
    expect(view.getByText("Couldn't load cases")).toBeTruthy();
    expect(view.getByText("Try again")).toBeTruthy();
  });

  it("filters to the overdue set using the local calendar date", async () => {
    setMockAppState({ casesOverview: { data: overview(0) } });
    const view = await render(<CasesScreen />);
    fireEvent.press(view.getByTestId("cases-quick-filter-processing"));
    await waitFor(() => expect(lastUseCasesParams()).toMatchObject({
      status: expect.arrayContaining(["in_design", "qc", "remake"]),
    }));
    expect(view.getByTestId("cases-summary-total-value").props.children).toBe("0");
    fireEvent.press(view.getByTestId("cases-quick-filter-scan"));
    await waitFor(() => expect(lastUseCasesParams()).toMatchObject({ status: ["scan"] }));
    expect(await view.findByText("Remake (8)")).toBeTruthy();
    fireEvent.press(view.getByTestId("cases-quick-filter-overdue"));
    await waitFor(() => expect(lastUseCasesParams()).toMatchObject({
      overdueOnly: true,
      localDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      page: 1,
    }));
    expect(view.getByTestId("cases-summary-total-value").props.children).toBe("0");
  });
});

describe("CasesSummary states", () => {
  it("shows em dashes while loading", async () => {
    const { getByTestId, queryByTestId } = await render(
      <CasesSummary data={undefined} isLoading isError={false} onRetry={() => {}} />,
    );
    expect(getByTestId("cases-summary-total-value").props.children).toBe("\u2014");
    expect(queryByTestId("cases-summary-error")).toBeNull();
  });

  it("shows em dashes with retry on failure, never fake zeros", async () => {
    const onRetry = vi.fn();
    const { getByTestId } = await render(
      <CasesSummary data={undefined} isLoading={false} isError onRetry={onRetry} />,
    );
    expect(getByTestId("cases-summary-overdue-value").props.children).toBe("\u2014");
    fireEvent.press(getByTestId("cases-summary-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows zeros for a successful empty set", async () => {
    const { getByTestId } = await render(
      <CasesSummary
        data={overview(0)}
        isLoading={false}
        isError={false}
        onRetry={() => {}}
      />,
    );
    expect(getByTestId("cases-summary-total-value").props.children).toBe("0");
  });
});
