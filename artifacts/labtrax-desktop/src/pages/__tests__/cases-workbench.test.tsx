/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import CasesPage from "@/pages/cases";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";
import { toast } from "sonner";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));
vi.mock("@/components/FieldCombobox", () => ({
  FieldCombobox: ({ value, onChange, placeholder }: {
    value: string; onChange: (value: string) => void; placeholder: string;
  }) => <input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />,
}));

const makeCase = (id: string, caseNumber = id) => ({
  id,
  caseNumber,
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const OVERVIEW = {
  totalCases: 1284, dueToday: 37, conflicts: 4, rushCases: 12,
  processingCases: 42, inTransitCases: 311, completedCases: 1374, overdueCases: 62,
  receivedCases: 311, inDesignCases: 156, modelRoomCases: 98, shippedCases: 845,
  scanCases: 1, millingCases: 2, postMillCases: 3, sinteringFurnaceCases: 4,
  porcelainCases: 5, qualityCheckCases: 6, onHoldCases: 7, remakeCases: 8,
};

function renderPage(privileged = false) {
  const Wrapper = makeAuthWrapper("/cases", privileged ? { user: { id: "test-admin", username: "test-admin", role: "admin", userType: "lab" }, status: "authed" } : {});
  return render(
    <Wrapper>
      <AiPanelContext.Provider value={{ openPanel: () => {} }}>
        <CasesPage />
      </AiPanelContext.Provider>
    </Wrapper>,
  );
}

function doubleClickRow(row: HTMLElement) {
  fireEvent.click(row, { detail: 1 });
  fireEvent.click(row, { detail: 2 });
  fireEvent.doubleClick(row, { detail: 2 });
}

async function expectSummaryCount(id: string, value: string) {
  await waitFor(() => expect(screen.getByTestId(`cases-summary-${id}`)).toHaveTextContent(value));
}

function stub(
  overview: () => Promise<Response> | Response,
  invoice?: Record<string, unknown>,
  detail?: () => Promise<Response>,
  enablePaging = false,
  extras: {
    organizations?: Array<{ id: string; type: string; name: string }>;
    savedViews?: Array<Record<string, any>>;
  } = {},
) {
  const savedViews = [...(extras.savedViews ?? [])];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/cases/saved-views")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const view = {
          id: `view-${savedViews.length + 1}`,
          labOrganizationId: body.labOrganizationId,
          name: body.name,
          filters: body.filters,
          createdAt: "2026-10-14T12:00:00.000Z",
          updatedAt: "2026-10-14T12:00:00.000Z",
        };
        savedViews.push(view);
        return json({ ok: true, data: view }, 201);
      }
      return json({ ok: true, data: savedViews });
    }
    if (url.pathname.match(/\/cases\/saved-views\/[^/]+$/)) {
      const id = url.pathname.split("/").pop()!;
      const index = savedViews.findIndex((view) => view.id === id);
      if (init?.method === "PATCH" && index >= 0) {
        const body = JSON.parse(String(init.body));
        savedViews[index] = {
          ...savedViews[index],
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.filters === undefined ? {} : { filters: body.filters }),
        };
        return json({ ok: true, data: savedViews[index] });
      }
      if (init?.method === "DELETE" && index >= 0) {
        savedViews.splice(index, 1);
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname.endsWith("/cases/overview")) {
      const response = await overview();
      if (!response.ok) return response;
      const body = await response.clone().json();
      return json(body?.data ? body : { data: body }, response.status);
    }
    if (url.pathname.endsWith("/cases/worklist")) {
      const search = url.searchParams.get("search");
      const page = Number(url.searchParams.get("page") ?? "1");
      return json({
        rows: search ? [] : page === 1
          ? [makeCase("c1", "WB-1001"), makeCase("c2", "WB-1002")]
          : [makeCase("c3", "WB-1003")],
        total: search ? 0 : 1284,
        salesTotal: "0.00",
        page,
        pageSize: 10,
        hasMore: enablePaging && page === 1,
      });
    }
    if (url.pathname.endsWith("/cases/c1") && detail) return detail();
    if (url.pathname.endsWith("/cases/c1")) return json({
      ...makeCase("c1", "WB-1001"), attachments: [],
      events: [{
        id: "move-c1", eventType: "status_changed",
        occurredAt: "2025-01-02T12:00:00Z",
        metadataJson: { fromStatus: "received", toStatus: "in_design" },
      }],
    });
    if (url.pathname.endsWith("/cases/c2")) return json(makeCase("c2", "WB-1002"));
    if (url.pathname.endsWith("/attachments")) return json({ attachments: [] });
    if (invoice && url.pathname.endsWith("/invoices")) return json([invoice]);
    if (invoice && url.pathname.endsWith(`/invoices/${invoice.id}`)) return json(invoice);
    if (url.pathname.includes("/organizations")) return json(extras.organizations ?? []);
    if (url.pathname.includes("/locations")) return json([]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Cases workbench", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("shows complete-set totals and a readable worklist", async () => {
    const fetchMock = stub(() => json(OVERVIEW));
    renderPage();
    expect(screen.getByTestId("cases-summary")).toBeInTheDocument();
    await expectSummaryCount("total", "1,284");
    await expectSummaryCount("processing", "42");
    await expectSummaryCount("in-transit", "311");
    await expectSummaryCount("completed", "1,374");
    await expectSummaryCount("overdue", "62");
    expect(screen.getByTestId("cases-status-filter")).toHaveTextContent("Location: All");
    await screen.findByText("WB-1001");
    expect(screen.getByText("2 of 1284 loaded")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([i]) => String(i).includes("/cases/overview"))).toHaveLength(1);
  });

  it("keeps complete-set counts stable when search filters the list", async () => {
    const fetchMock = stub(() => json(OVERVIEW));
    renderPage();
    await screen.findByText("WB-1001");
    fireEvent.change(screen.getByPlaceholderText(/Search case #/i), { target: { value: "nobody" } });
    expect(await screen.findByText("No cases match the current filters.")).toBeInTheDocument();
    await expectSummaryCount("total", "1,284");
    const overviewCalls = fetchMock.mock.calls.filter(([i]) => String(i).includes("/cases/overview"));
    expect(overviewCalls).toHaveLength(1);
  });

  it("keeps complete-set counts stable while loading another page", async () => {
    const pagedFetch = stub(() => json(OVERVIEW), undefined, undefined, true);
    renderPage();
    await screen.findByText("WB-1001");
    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));
    expect(await screen.findByText("WB-1003")).toBeInTheDocument();
    await waitFor(() => {
      const request = pagedFetch.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost"))
        .find((url) => url.pathname.endsWith("/cases/worklist") && url.searchParams.get("page") === "2");
      expect(request).toBeDefined();
    });
    await expectSummaryCount("total", "1,284");
  });

  it("refreshes the worklist and complete-set summary on their polling interval", async () => {
    const fetchMock = stub(() => json(OVERVIEW));
    vi.useFakeTimers();
    try {
      await act(async () => {
        renderPage();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(screen.getByText("WB-1001")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fetchMock.mock.calls.filter(([i]) => String(i).includes("/cases/worklist"))).toHaveLength(2);
      expect(fetchMock.mock.calls.filter(([i]) => String(i).includes("/cases/overview"))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the summary and unchanged populated rows without blanking the table", async () => {
    const fetchMock = stub(() => json(OVERVIEW));
    renderPage();
    await screen.findByText("WB-1001");
    const refresh = screen.getByRole("button", { name: "Refresh" });
    await waitFor(() => expect(refresh).not.toBeDisabled());
    fireEvent.click(refresh);
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([i]) => String(i).includes("/cases/worklist"))).toHaveLength(2);
      expect(fetchMock.mock.calls.filter(([i]) => String(i).includes("/cases/overview"))).toHaveLength(2);
    });
    await waitFor(() => expect(refresh).not.toBeDisabled());
    expect(screen.getByText("WB-1001")).toBeInTheDocument();
    expect(screen.getByText("2 of 1284 loaded")).toBeInTheDocument();
  });

  it("selects a row into the docked detail panel", async () => {
    stub(() => json(OVERVIEW));
    renderPage();
    await screen.findByText("WB-1001");
    fireEvent.click(await screen.findByText("WB-1001"));
    expect(await screen.findByTestId("case-drawer")).toBeInTheDocument();
    expect(screen.getByTestId("case-row-c1")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("case-detail-empty")).not.toBeInTheDocument();
    expect(await screen.findByText("Location Changed")).toBeInTheDocument();
    expect(screen.getByText("Case History")).toBeInTheDocument();
  });

  it("keeps quick status filters server-backed and independent of complete-set counts", async () => {
    const fetchMock = stub(() => json(OVERVIEW));
    renderPage();
    await screen.findByText("WB-1001");
    fireEvent.click(screen.getByTestId("cases-quick-filter-processing"));
    await waitFor(() => {
      const request = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost"))
        .filter((url) => url.pathname.endsWith("/cases/worklist"))
        .at(-1)!;
      expect(request.searchParams.getAll("status")).toEqual(expect.arrayContaining(["in_design", "qc", "remake"]));
    });
    await expectSummaryCount("total", "1,284");
    expect(screen.getByTestId("cases-quick-filter-scan")).toHaveTextContent("Scan1");
    fireEvent.click(screen.getByTestId("cases-quick-filter-scan"));
    await waitFor(() => {
      const request = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost"))
        .filter((url) => url.pathname.endsWith("/cases/worklist"))
        .at(-1)!;
      expect(request.searchParams.getAll("status")).toEqual(["scan"]);
    });
    expect(screen.getByTestId("cases-quick-filter-remake")).toHaveTextContent("Remake8");
    fireEvent.click(screen.getByTestId("cases-quick-filter-overdue"));
    await waitFor(() => {
      const request = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost"))
        .filter((url) => url.pathname.endsWith("/cases/worklist"))
        .at(-1)!;
      expect(request.searchParams.get("overdueOnly")).toBe("true");
      expect(request.searchParams.get("localDate")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
    await expectSummaryCount("total", "1,284");
  });

  it("applies a shared saved view without changing the existing date or status filters", async () => {
    const view = {
      id: "saved-triage",
      labOrganizationId: "lab-1",
      name: "Received this month",
      filters: {
        search: "Mina",
        statusFilters: ["received"],
        desktop: {
          dateRangeFilter: "custom",
          customStartDate: "2026-10-01",
          customEndDate: "2026-10-14",
        },
      },
      createdAt: "2026-10-14T12:00:00.000Z",
      updatedAt: "2026-10-14T12:00:00.000Z",
    };
    const fetchMock = stub(() => json(OVERVIEW), undefined, undefined, false, {
      organizations: [{ id: "lab-1", type: "lab", name: "Test Lab" }],
      savedViews: [view],
    });
    renderPage();
    await screen.findByText("WB-1001");
    await screen.findByRole("option", { name: "Received this month" });
    fireEvent.change(screen.getByTestId("cases-saved-view-select"), { target: { value: view.id } });
    fireEvent.click(screen.getByTestId("cases-saved-view-apply"));
    await waitFor(() => {
      const request = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost"))
        .find((url) => url.pathname.endsWith("/cases/worklist") && url.searchParams.get("search") === "Mina");
      expect(request).toBeDefined();
      expect(request?.searchParams.get("receivedStart")).toBe("2026-10-01");
      expect(request?.searchParams.get("receivedEnd")).toBe("2026-10-14");
    });
    expect(screen.getByPlaceholderText(/Search case #/i)).toHaveValue("Mina");
    expect(screen.getByLabelText("Date")).toHaveValue("custom");
    expect(screen.getByTestId("cases-status-filter")).toHaveTextContent("Received");
  });

  it("clears desktop dates when applying a view saved on mobile and says why", async () => {
    const view = {
      id: "saved-mobile",
      labOrganizationId: "lab-1",
      name: "Due this week",
      filters: {
        search: "Okafor",
        statusFilters: ["qc"],
        mobile: {
          createdFilter: "all",
          createdCustomFrom: "",
          createdCustomTo: "",
          dueFilter: "custom",
          dueCustomFrom: "2026-10-12",
          dueCustomTo: "2026-10-18",
        },
      },
      createdAt: "2026-10-14T12:00:00.000Z",
      updatedAt: "2026-10-14T12:00:00.000Z",
    };
    sessionStorage.setItem("cases_filters_v4", JSON.stringify({
      search: "",
      statusFilters: [],
      priorityFilters: [],
      caseTypeFilters: [],
      dateRangeFilter: "custom",
      customStartDate: "2026-09-01",
      customEndDate: "2026-09-30",
      sortKey: "createdAt",
      sortDir: "desc",
    }));
    const fetchMock = stub(() => json(OVERVIEW), undefined, undefined, false, {
      organizations: [{ id: "lab-1", type: "lab", name: "Test Lab" }],
      savedViews: [view],
    });
    const info = vi.spyOn(toast, "info").mockImplementation(() => "toast");
    renderPage();
    await screen.findByText("WB-1001");
    await screen.findByRole("option", { name: "Due this week" });
    fireEvent.change(screen.getByTestId("cases-saved-view-select"), { target: { value: view.id } });
    fireEvent.click(screen.getByTestId("cases-saved-view-apply"));
    await waitFor(() => {
      const request = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost"))
        .filter((url) => url.pathname.endsWith("/cases/worklist"))
        .at(-1)!;
      expect(request.searchParams.get("search")).toBe("Okafor");
      expect(request.searchParams.get("receivedStart")).toBeNull();
      expect(request.searchParams.get("receivedEnd")).toBeNull();
    });
    expect(screen.getByLabelText("Date")).toHaveValue("all");
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/saved on mobile.*desktop dates were cleared/));
  });

  it("saves, renames, and removes shared saved views through the in-page name dialog", async () => {
    const fetchMock = stub(() => json(OVERVIEW), undefined, undefined, false, {
      organizations: [{ id: "lab-1", type: "lab", name: "Test Lab" }],
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await screen.findByText("WB-1001");
    fireEvent.change(screen.getByPlaceholderText(/Search case #/i), { target: { value: "Mina" } });
    fireEvent.click(screen.getByTestId("cases-saved-view-save"));
    const saveDialog = await screen.findByRole("dialog", { name: "Save Cases view" });
    const saveInput = within(saveDialog).getByLabelText("View name");
    expect(within(saveDialog).getByTestId("cases-saved-view-name-submit")).toBeDisabled();
    fireEvent.change(saveInput, { target: { value: "   " } });
    expect(within(saveDialog).getByTestId("cases-saved-view-name-submit")).toBeDisabled();
    fireEvent.change(saveInput, { target: { value: "  Team triage  " } });
    fireEvent.click(within(saveDialog).getByTestId("cases-saved-view-name-submit"));
    await screen.findByRole("option", { name: "Team triage" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save Cases view" })).not.toBeInTheDocument());
    expect(screen.getByTestId("cases-saved-view-select")).toHaveValue("view-1");

    fireEvent.click(screen.getByTestId("cases-saved-view-rename"));
    const renameDialog = await screen.findByRole("dialog", { name: "Rename Cases view" });
    fireEvent.keyDown(within(renameDialog).getByLabelText("View name"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename Cases view" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId("cases-saved-view-rename"));
    const reopened = await screen.findByRole("dialog", { name: "Rename Cases view" });
    const renameInput = within(reopened).getByLabelText("View name");
    expect(renameInput).toHaveValue("Team triage");
    fireEvent.change(renameInput, { target: { value: "Renamed triage" } });
    fireEvent.click(within(reopened).getByTestId("cases-saved-view-name-submit"));
    await screen.findByRole("option", { name: "Renamed triage" });

    fireEvent.click(screen.getByTestId("cases-saved-view-delete"));
    await waitFor(() => {
      expect(screen.queryByRole("option", { name: "Renamed triage" })).not.toBeInTheDocument();
    });
    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: new URL(String(input), "http://localhost"),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));
    const saved = calls.filter((call) => call.url.pathname.endsWith("/cases/saved-views") && call.method === "POST");
    expect(saved).toHaveLength(1);
    expect(saved[0].body).toEqual({
      labOrganizationId: "lab-1",
      name: "Team triage",
      filters: {
        search: "Mina",
        statusFilters: [],
        desktop: { dateRangeFilter: "all", customStartDate: "", customEndDate: "" },
      },
    });
    const renamed = calls.filter((call) => call.url.pathname.endsWith("/cases/saved-views/view-1") && call.method === "PATCH");
    expect(renamed.map((call) => call.body)).toEqual([{ labOrganizationId: "lab-1", name: "Renamed triage" }]);
    const removed = calls.find((call) => call.url.pathname.endsWith("/cases/saved-views/view-1") && call.method === "DELETE");
    expect(removed?.url.searchParams.get("labOrganizationId")).toBe("lab-1");
  });

  it("updates a shared view from current desktop filters without changing its name or mobile dates", async () => {
    const mobileDates = {
      createdFilter: "custom",
      createdCustomFrom: "2026-10-01",
      createdCustomTo: "2026-10-12",
      dueFilter: "all",
      dueCustomFrom: "",
      dueCustomTo: "",
    };
    const fetchMock = stub(() => json(OVERVIEW), undefined, undefined, false, {
      organizations: [{ id: "lab-1", type: "lab", name: "Test Lab" }],
      savedViews: [{
        id: "view-1",
        labOrganizationId: "lab-1",
        name: "Team triage",
        filters: {
          search: "Before",
          statusFilters: ["received"],
          mobile: mobileDates,
        },
      }],
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await screen.findByText("WB-1001");

    fireEvent.change(screen.getByPlaceholderText(/Search case #/i), { target: { value: "Updated search" } });
    fireEvent.change(screen.getByTestId("cases-saved-view-select"), { target: { value: "view-1" } });
    fireEvent.click(screen.getByTestId("cases-saved-view-update"));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([input, init]) =>
        new URL(String(input), "http://localhost").pathname.endsWith("/cases/saved-views/view-1")
        && init?.method === "PATCH");
      expect(patch).toBeDefined();
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
        labOrganizationId: "lab-1",
        filters: {
          search: "Updated search",
          statusFilters: [],
          desktop: { dateRangeFilter: "all", customStartDate: "", customEndDate: "" },
          mobile: mobileDates,
        },
      });
    });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/everyone in your lab.*desktop date filters/));
    expect(await screen.findByRole("option", { name: "Team triage" })).toBeInTheDocument();
  });

  it("opens an unselected case from an ordinary-cell double-click", async () => {
    stub(() => json(OVERVIEW));
    renderPage();
    const row = await screen.findByTestId("case-row-c2");
    doubleClickRow(row);

    const pane = await screen.findByTestId("case-drawer");
    expect(screen.getByTestId("case-row-c2")).toHaveAttribute("aria-selected", "true");
    expect(pane.parentElement?.className).not.toContain("lg:sticky");
  });

  it("fits a Cases column to visible content on header-handle double-click without opening a row", async () => {
    const storageKey = "labtrax_cases_columns_v3";
    const savedColumns = localStorage.getItem(storageKey);
    localStorage.removeItem(storageKey);
    stub(() => json(OVERVIEW));
    const view = renderPage();

    try {
      await screen.findByText("WB-1001");
      const table = screen.getByTestId("case-row-c1").closest("table");
      expect(table).not.toBeNull();

      const cells = Array.from(
        table!.querySelectorAll<HTMLElement>('[data-col-id="caseNumber"]'),
      );
      expect(cells).toHaveLength(3);
      Object.defineProperty(cells[1], "scrollWidth", { configurable: true, value: 212 });
      Object.defineProperty(cells[2], "scrollWidth", { configurable: true, value: 196 });

      const header = table!.querySelector<HTMLElement>('th[data-col-id="caseNumber"]');
      expect(header).not.toBeNull();
      const resizeHandle = header!.lastElementChild as HTMLElement;
      const caseNumberColumn = table!.querySelectorAll("col")[2] as HTMLElement;
      expect(caseNumberColumn.style.width).toBe("160px");

      fireEvent.doubleClick(resizeHandle);

      // The widest visible case number (212px) plus the existing 8px buffer.
      expect(caseNumberColumn.style.width).toBe("220px");
      expect(screen.queryByTestId("case-drawer")).not.toBeInTheDocument();
      expect(screen.getByTestId("case-row-c1")).toHaveAttribute("aria-selected", "false");
    } finally {
      view.unmount();
      if (savedColumns === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, savedColumns);
    }
  });

  it("navigates rows with arrow keys, selects with Space, and opens with Enter without bulk-selecting", async () => {
    stub(() => json(OVERVIEW));
    renderPage();
    const firstRow = await screen.findByTestId("case-row-c1");
    const secondRow = screen.getByTestId("case-row-c2");

    firstRow.focus();
    fireEvent.keyDown(firstRow, { key: "ArrowDown" });
    expect(document.activeElement).toBe(secondRow);
    expect(firstRow).toHaveAttribute("tabindex", "-1");
    expect(secondRow).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(secondRow, { key: " " });
    expect(secondRow).toHaveAttribute("aria-selected", "true");
    expect(within(secondRow).getByRole("checkbox")).not.toBeChecked();
    fireEvent.keyDown(secondRow, { key: "Enter" });
    const pane = await screen.findByTestId("case-drawer");
    expect(pane.parentElement?.className).not.toContain("lg:sticky");
    expect(secondRow).toHaveAttribute("aria-selected", "true");
  });

  it("shows legitimate zero totals for an empty authorized set", async () => {
    stub(() => json({
      totalCases: 0, dueToday: 0, conflicts: 0, rushCases: 0,
      processingCases: 0, inTransitCases: 0, completedCases: 0, overdueCases: 0,
      receivedCases: 0, inDesignCases: 0, modelRoomCases: 0, shippedCases: 0,
      scanCases: 0, millingCases: 0, postMillCases: 0, sinteringFurnaceCases: 0,
      porcelainCases: 0, qualityCheckCases: 0, onHoldCases: 0, remakeCases: 0,
    }));
    renderPage();
    await screen.findByText("WB-1001");
    await expectSummaryCount("total", "0");
  });
  it("expands the same editor with its draft intact and preserves direct saving", async () => {
    stub(() => json(OVERVIEW));
    renderPage();
    fireEvent.click(await screen.findByText("WB-1001"));
    const pane = await screen.findByTestId("case-drawer");
    fireEvent.click(screen.getByRole("tab", { name: "Lab Slip" }));
    fireEvent.click(screen.getByTestId("case-details-edit"));
    const firstName = screen.getByPlaceholderText("Patient first name");
    fireEvent.change(firstName, { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Open Case" }));
    expect(screen.getAllByTestId("case-drawer")).toHaveLength(1);
    expect(screen.getByTestId("case-drawer")).toBe(pane);
    expect(screen.getByPlaceholderText("Patient first name")).toBe(firstName);
    expect(firstName).toHaveValue("Unsaved name");
    expect(screen.queryByText("Case History")).not.toBeInTheDocument();
    expect(screen.getByTestId("case-row-c1")).toHaveAttribute("aria-selected", "true");
    expect(pane.parentElement?.className).not.toContain("lg:sticky");
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() => expect(screen.queryByPlaceholderText("Patient first name")).not.toBeInTheDocument());
    expect(screen.queryByText("Save Changes")).not.toBeInTheDocument();
    const close = pane.querySelector('button[aria-label="Close case drawer"]');
    expect(close).toBeTruthy();
    await waitFor(() => expect(close).toBeEnabled());
    fireEvent.click(close!);
    await waitFor(() => expect(screen.queryByTestId("case-drawer")).not.toBeInTheDocument());
  });

  it("shows History loading while the selected case detail is pending", async () => {
    let resolveDetail!: (response: Response) => void;
    const detail = new Promise<Response>((resolve) => { resolveDetail = resolve; });
    stub(() => json(OVERVIEW), undefined, () => detail);
    renderPage();
    fireEvent.click(await screen.findByText("WB-1001"));
    const pane = await screen.findByTestId("case-drawer");
    expect(within(pane).getByText("Case History")).toBeInTheDocument();
    expect(within(pane).getByText("Loading…")).toBeInTheDocument();
    expect(within(pane).queryByText("No activity logged yet.")).not.toBeInTheDocument();
    resolveDetail(json({ ...makeCase("c1", "WB-1001"), events: [] }));
    expect(await within(pane).findByText("No activity logged yet.")).toBeInTheDocument();
  });

  it("starts each selection and reopened presentation on History, without resetting a same-case refresh", async () => {
    stub(() => json(OVERVIEW));
    renderPage();
    fireEvent.click(await screen.findByText("WB-1001"));
    await screen.findByText("Location Changed");
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    expect(screen.queryByText("Case History")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("case-row-c1"));
    expect(screen.queryByText("Case History")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("case-row-c2"));
    expect(await screen.findByText("No activity logged yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: "Close case drawer" }));
    await waitFor(() => expect(screen.queryByTestId("case-drawer")).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId("case-row-c2"));
    expect(await screen.findByText("Case History")).toBeInTheDocument();
    expect(await screen.findByText("No activity logged yet.")).toBeInTheDocument();
  });

  it("shows unavailable summary values and a retry action when overview fails", async () => {
    const overview = vi.fn(() => json({ message: "boom" }, 500));
    stub(overview);
    renderPage();
    await screen.findByText("WB-1001");
    expect(await screen.findByText("Case totals are unavailable.")).toBeInTheDocument();
    await expectSummaryCount("total", "—");
    expect(overview).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2));
  });

  it("guards unsaved edits when selecting another visible row", async () => {
    stub(() => json(OVERVIEW));
    renderPage();
    fireEvent.click(await screen.findByText("WB-1001"));
    await screen.findByTestId("case-drawer");
    fireEvent.click(screen.getByRole("tab", { name: /Restorations/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add manually" }));
    fireEvent.change(await screen.findByPlaceholderText("Case Type…"), { target: { value: "Crown" } });
    fireEvent.click(screen.getByRole("button", { name: "Add restoration" }));
    await screen.findByText("Save Changes");
    fireEvent.click(screen.getByTestId("case-row-c2"));
    expect(await screen.findByRole("heading", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(screen.getByTestId("case-row-c1")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByTestId("case-row-c1")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Save Changes")).toBeInTheDocument();
    expect(screen.queryByText("Case History")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("case-row-c2"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.getByTestId("case-row-c2")).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByText("Save Changes")).not.toBeInTheDocument();
    expect(screen.getByText("Case History")).toBeInTheDocument();
  });

  it("prompts once before double-click switching, keeps the original presentation on cancel, and expands after acceptance", async () => {
    stub(() => json(OVERVIEW));
    renderPage();
    fireEvent.click(await screen.findByText("WB-1001"));
    const pane = await screen.findByTestId("case-drawer");
    fireEvent.click(screen.getByRole("tab", { name: /Restorations/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add manually" }));
    fireEvent.change(await screen.findByPlaceholderText("Case Type…"), { target: { value: "Crown" } });
    fireEvent.click(screen.getByRole("button", { name: "Add restoration" }));
    await screen.findByText("Save Changes");

    doubleClickRow(screen.getByTestId("case-row-c2"));
    expect(await screen.findByRole("heading", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Unsaved changes" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByTestId("case-row-c1")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("case-drawer")).toBe(pane);
    expect(pane.parentElement?.className).toContain("lg:sticky");
    expect(screen.getByText("Save Changes")).toBeInTheDocument();
    expect(screen.queryByText("Case History")).not.toBeInTheDocument();

    doubleClickRow(screen.getByTestId("case-row-c2"));
    expect(await screen.findByRole("heading", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Unsaved changes" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.getByTestId("case-row-c2")).toHaveAttribute("aria-selected", "true"));
    const switchedPane = await screen.findByTestId("case-drawer");
    expect(switchedPane.parentElement?.className).not.toContain("lg:sticky");
    expect(screen.getByText("Case History")).toBeInTheDocument();
  });

  it("keeps the unsaved-edit confirmation when opening another row with Enter", async () => {
    stub(() => json(OVERVIEW));
    renderPage();
    fireEvent.click(await screen.findByText("WB-1001"));
    await screen.findByTestId("case-drawer");
    fireEvent.click(screen.getByRole("tab", { name: /Restorations/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add manually" }));
    fireEvent.change(await screen.findByPlaceholderText("Case Type…"), { target: { value: "Crown" } });
    fireEvent.click(screen.getByRole("button", { name: "Add restoration" }));
    await screen.findByText("Save Changes");

    const secondRow = screen.getByTestId("case-row-c2");
    secondRow.focus();
    fireEvent.keyDown(secondRow, { key: " " });
    expect(await screen.findByRole("heading", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(screen.getByTestId("case-row-c1")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByTestId("case-row-c1")).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(secondRow, { key: "Enter" });
    expect(await screen.findByRole("heading", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(screen.getByTestId("case-row-c1")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByTestId("case-row-c1")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Case History")).not.toBeInTheDocument();

    fireEvent.keyDown(secondRow, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.getByTestId("case-row-c2")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("case-drawer").parentElement?.className).not.toContain("lg:sticky");
  });

  it("shows legitimate zero totals for an empty authorized set", async () => {
    stub(() => json({
      totalCases: 0, dueToday: 0, conflicts: 0, rushCases: 0,
      processingCases: 0, inTransitCases: 0, completedCases: 0, overdueCases: 0,
      receivedCases: 0, inDesignCases: 0, modelRoomCases: 0, shippedCases: 0,
      scanCases: 0, millingCases: 0, postMillCases: 0, sinteringFurnaceCases: 0,
      porcelainCases: 0, qualityCheckCases: 0, onHoldCases: 0, remakeCases: 0,
    }));
    renderPage();
    await screen.findByText("WB-1001");
    await expectSummaryCount("total", "0");
  });
  it("expands the same editor with its draft intact and preserves direct saving", async () => {
    stub(() => json(OVERVIEW));
    renderPage();
    fireEvent.click(await screen.findByText("WB-1001"));
    const pane = await screen.findByTestId("case-drawer");
    fireEvent.click(screen.getByRole("tab", { name: "Lab Slip" }));
    fireEvent.click(screen.getByTestId("case-details-edit"));
    const firstName = screen.getByPlaceholderText("Patient first name");
    fireEvent.change(firstName, { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Open Case" }));
    expect(screen.getAllByTestId("case-drawer")).toHaveLength(1);
    expect(screen.getByTestId("case-drawer")).toBe(pane);
    expect(screen.getByPlaceholderText("Patient first name")).toBe(firstName);
    expect(firstName).toHaveValue("Unsaved name");
    expect(screen.queryByText("Case History")).not.toBeInTheDocument();
    expect(screen.getByTestId("case-row-c1")).toHaveAttribute("aria-selected", "true");
    expect(pane.parentElement?.className).not.toContain("lg:sticky");
    // The incoming editor saves directly; expansion must not restore the old
    // two-stage save flow or create a second editor.
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() => expect(screen.queryByPlaceholderText("Patient first name")).not.toBeInTheDocument());
    expect(screen.queryByText("Save Changes")).not.toBeInTheDocument();
    const close = pane.querySelector('button[aria-label="Close case drawer"]');
    expect(close).toBeTruthy();
    await waitFor(() => expect(close).toBeEnabled());
    fireEvent.click(close!);
    await waitFor(() => expect(screen.queryByTestId("case-drawer")).not.toBeInTheDocument());
  });

  it("keeps the active tab and draft when double-clicking the selected case", async () => {
    stub(() => json(OVERVIEW));
    renderPage();
    fireEvent.click(await screen.findByText("WB-1001"));
    const pane = await screen.findByTestId("case-drawer");
    fireEvent.click(screen.getByRole("tab", { name: "Lab Slip" }));
    fireEvent.click(screen.getByTestId("case-details-edit"));
    const firstName = screen.getByPlaceholderText("Patient first name");
    fireEvent.change(firstName, { target: { value: "Draft stays here" } });

    doubleClickRow(screen.getByTestId("case-row-c1"));

    expect(screen.getByTestId("case-drawer")).toBe(pane);
    expect(screen.getByPlaceholderText("Patient first name")).toBe(firstName);
    expect(firstName).toHaveValue("Draft stays here");
    expect(screen.queryByText("Case History")).not.toBeInTheDocument();
    expect(pane.parentElement?.className).not.toContain("lg:sticky");
  });
  it("cancels drafts, applies valid shorthand atomically, persists and reopens the applied range", async () => {
    const fetchMock = stub(() => json(OVERVIEW));
    const view = renderPage();
    await screen.findByText("WB-1001");
    const requests = () => fetchMock.mock.calls.filter(([i]) => String(i).includes("/cases/worklist"));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "5/5/2025" } });
    fireEvent.blur(screen.getByLabelText("Start date"));
    expect(screen.getByLabelText("Start date")).toHaveValue("05/05/2025");
    expect(requests()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Date")).toHaveValue("all");
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "custom" } });
    expect(screen.getByLabelText("Start date")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "5/5/2025" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "5/10/2025" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(String(requests().at(-1)?.[0])).toContain("receivedEnd=2025-05-10"));
    expect(String(requests().at(-1)?.[0])).toContain("page=1");
    expect(String(requests().at(-1)?.[0])).toContain("receivedStart=2025-05-05");
    fireEvent.click(screen.getByRole("button", { name: /Edit range/ }));
    expect(screen.getByLabelText("End date")).toHaveValue("05/10/2025");
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "5/4/2025" } });
    fireEvent.blur(screen.getByLabelText("End date"));
    expect(screen.getByRole("alert")).toHaveTextContent("on or after");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const persisted = sessionStorage.getItem("cases_filters_v4")!;
    expect(JSON.parse(persisted)).toMatchObject({ dateRangeFilter: "custom", customEndDate: "2025-05-10" });
    view.unmount();
    // Leaving Cases clears its saved filters; a page reload preserves the
    // session's blob rather than executing React's route-unmount cleanup.
    sessionStorage.setItem("cases_filters_v4", persisted);
    renderPage();
    expect(screen.getByLabelText("Date")).toHaveValue("custom");
    fireEvent.click(screen.getByRole("button", { name: /Edit range/ }));
    expect(screen.getByLabelText("End date")).toHaveValue("05/10/2025");
  });
  it("keeps the active Invoice tab and its dirty editor when expanding", async () => {
    stub(() => json(OVERVIEW), {
      id: "preview-invoice", invoiceNumber: "INV-PREVIEW", labOrganizationId: "lab-1", caseId: "c1",
      status: "open", issuedAt: "2026-01-15T12:00:00Z", dueAt: "2026-01-30T12:00:00Z", createdAt: "2026-01-15T12:00:00Z",
      tax: 0, discount: 0, total: 110, subtotal: 110, balanceDue: 110, amountPaid: 0, notes: "Saved note", payments: [],
      displayMetadata: { patientName: "Mina Okafor", billTo: "Dr. Reyes", lineItems: [{ item: "Crown", quantity: 1, unitPrice: 110, lineTotal: 110 }] },
      items: [{ id: "line-1", description: "Crown", quantity: 1, unitPrice: 110, lineTotal: 110, restorationId: null }],
    });
    renderPage(true);
    fireEvent.click(await screen.findByText("WB-1001"));
    const pane = await screen.findByTestId("case-drawer");
    fireEvent.click(screen.getByRole("tab", { name: "Invoice" }));
    const notes = await screen.findByLabelText("Notes");
    await waitFor(() => expect(notes).toHaveValue("Saved note"));
    fireEvent.change(notes, { target: { value: "Unsaved invoice note" } });
    fireEvent.click(screen.getByRole("button", { name: "Open Case" }));
    expect(screen.getByTestId("case-drawer")).toBe(pane);
    expect(screen.getByLabelText("Notes")).toBe(notes);
    expect(notes).toHaveValue("Unsaved invoice note");
    expect(screen.getAllByLabelText("Notes")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close case drawer" }));
    expect(await screen.findByText("Discard changes?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Keep editing"));
    fireEvent.click(screen.getByTestId("case-row-c2"));
    expect(await screen.findByText("Discard changes?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Keep editing"));
    expect(notes).toHaveValue("Unsaved invoice note");
    expect(screen.getByTestId("case-row-c1")).toHaveAttribute("aria-selected", "true");
    expect(within(pane).queryByText("Case History")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("case-row-c2"));
    fireEvent.click(await screen.findByText("Discard changes"));
    expect(await screen.findByText("Case History")).toBeInTheDocument();
  });
});
