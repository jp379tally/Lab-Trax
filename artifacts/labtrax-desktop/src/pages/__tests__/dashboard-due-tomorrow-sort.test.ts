/** @vitest-environment jsdom */
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LabCase } from "@/lib/types";
import { formatDate } from "@/lib/format";
import DashboardPage, {
  CasesTable,
  DUE_TOMORROW_SORT_LABELS,
  SECTION_SORT_LABELS,
  sortDueTodayCases,
  sortDueTomorrowCases,
  sortPastDueCases,
} from "../dashboard";

const mockCases = vi.hoisted(() => ({ current: [] as LabCase[] }));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: null, status: "anonymous" }),
}));

vi.mock("@/lib/ai-panel-context", () => ({
  useAiPanel: () => ({ openPanel: vi.fn() }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = JSON.stringify(queryKey);
    if (key === JSON.stringify(["cases"])) {
      return { data: mockCases.current, isLoading: false, isSuccess: true };
    }
    if (key === JSON.stringify(["auth", "me"])) {
      return {
        data: {
          memberships: [
            { status: "active", organization: { id: "lab-1", type: "lab", name: "Test Lab" } },
          ],
        },
        isLoading: false,
        isSuccess: true,
      };
    }
    return { data: undefined, isLoading: false, isSuccess: false };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));

function makeCase(overrides: Partial<LabCase>): LabCase {
  return {
    id: "case-default",
    caseNumber: "1",
    labOrganizationId: "lab-1",
    providerOrganizationId: "provider-1",
    patientFirstName: "Test",
    patientLastName: "Patient",
    doctorName: "Dr. Synthetic063",
    labLocationName: "Mill",
    restorationTypes: "Crown",
    restorationMaterials: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    receivedAt: null,
    dueDate: "2026-07-21",
    expectedDeliveryDate: null,
    status: "received",
    priority: "normal",
    ...overrides,
  };
}

afterEach(() => {
  mockCases.current = [];
  vi.useRealTimers();
});

function nextBusinessDay(): string {
  const date = new Date();
  do date.setDate(date.getDate() + 1);
  while (date.getDay() === 0 || date.getDay() === 6);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

describe("Desktop dashboard — Due Tomorrow sorting", () => {
  it("selecting Location through the dashboard control visibly reorders rows by station label", async () => {
    mockCases.current = [
      makeCase({
        id: "porcelain",
        caseNumber: "PORCELAIN-ROW",
        patientFirstName: "Porcelain",
        patientLastName: "Patient",
        status: "in_porcelain",
        labLocationName: "Alpha hidden location",
        createdAt: "2026-07-20T00:00:00.000Z",
        dueDate: nextBusinessDay(),
      }),
      makeCase({
        id: "model",
        caseNumber: "MODEL-ROW",
        patientFirstName: "Model",
        patientLastName: "Patient",
        status: "model_room",
        labLocationName: "Zulu hidden location",
        createdAt: "2026-07-18T00:00:00.000Z",
        dueDate: nextBusinessDay(),
      }),
    ];

    render(React.createElement(DashboardPage));
    const heading = screen.getByRole("heading", { name: /due tomorrow/i });
    const section = heading.closest("section")!;
    const visibleCaseNumbers = () =>
      within(section)
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0].textContent);

    expect(visibleCaseNumbers()).toEqual(["PORCELAIN-ROW", "MODEL-ROW"]);

    fireEvent.pointerDown(
      within(section).getByRole("button", { name: /sort due tomorrow cases/i }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /location/i }));

    expect(visibleCaseNumbers()).toEqual(["PORCELAIN-ROW", "MODEL-ROW"]);
    expect(within(section).getAllByText("Zulu hidden location").length).toBeGreaterThan(0);
    expect(within(section).getAllByText("Alpha hidden location").length).toBeGreaterThan(0);
  });

  it("offers the six requested sort choices", () => {
    expect(Object.values(DUE_TOMORROW_SORT_LABELS)).toEqual([
      "Entered date",
      "Case number",
      "Doctor",
      "Location",
      "Due date",
      "Case Type",
    ]);
  });

  it("defaults to entered date, newest first, with missing values last", () => {
    const cases = [
      makeCase({
        id: "older",
        createdAt: "2026-07-18T16:00:00.000Z",
        updatedAt: "2026-07-21T16:00:00.000Z",
      }),
      makeCase({
        id: "newer",
        createdAt: "2026-07-20T16:00:00.000Z",
        updatedAt: "2026-07-18T16:00:00.000Z",
      }),
      makeCase({
        id: "missing",
        createdAt: null,
        updatedAt: "2026-07-22T16:00:00.000Z",
      }),
    ];
    expect(sortDueTomorrowCases(cases, "entered").map((c) => c.id)).toEqual([
      "newer",
      "older",
      "missing",
    ]);
  });

  it("sorts case numbers naturally and places missing numbers last", () => {
    const cases = [
      makeCase({ id: "ten", caseNumber: "10" }),
      makeCase({ id: "two", caseNumber: "2" }),
      makeCase({ id: "missing", caseNumber: "" }),
    ];
    expect(sortDueTomorrowCases(cases, "case_number").map((c) => c.id)).toEqual([
      "two",
      "ten",
      "missing",
    ]);
  });

  it("sorts doctors case-insensitively with missing values last", () => {
    const cases = [
      makeCase({ id: "zulu", doctorName: "zulu" }),
      makeCase({ id: "alpha", doctorName: "Alpha" }),
      makeCase({ id: "missing", doctorName: null }),
    ];
    expect(sortDueTomorrowCases(cases, "doctor").map((c) => c.id)).toEqual([
      "alpha",
      "zulu",
      "missing",
    ]);
  });

  it("sorts Location by the displayed physical station name for same-status stations", () => {
    const cases = [
      makeCase({ id: "same-status-z", status: "model_room", labLocationId: "station-z", labLocationName: null }),
      makeCase({ id: "same-status-a", status: "model_room", labLocationId: "station-a", labLocationName: null }),
      makeCase({ id: "porcelain", status: "in_porcelain", labLocationName: "Porcelain Room" }),
      makeCase({ id: "missing", status: null, labLocationName: "Aardvark Room" }),
    ];
    expect(sortDueTomorrowCases(cases, "location", [
      { id: "station-z", value: "model_room", label: "Zulu Room" },
      { id: "station-a", value: "model_room", label: "Alpha Room" },
    ]).map((c) => c.id)).toEqual([
      "missing",
      "same-status-a",
      "porcelain",
      "same-status-z",
    ]);
  });

  it("sorts the displayed due date and time earliest first, not the expected delivery date", () => {
    const cases = [
      makeCase({
        id: "late",
        dueDate: "2026-07-21",
        dueTime: "15:00",
        expectedDeliveryDate: "2026-07-21",
      }),
      makeCase({
        id: "early",
        dueDate: "2026-07-20",
        dueTime: "09:00",
        expectedDeliveryDate: "2026-07-21",
      }),
      makeCase({ id: "missing", dueDate: null, expectedDeliveryDate: "2026-07-21" }),
    ];
    expect(sortDueTomorrowCases(cases, "due_date").map((c) => c.id)).toEqual([
      "early",
      "late",
      "missing",
    ]);
  });

  it("uses due time to order cases with the same displayed due date", () => {
    const cases = [
      makeCase({ id: "afternoon", dueTime: "15:00" }),
      makeCase({ id: "morning", dueTime: "09:00" }),
      makeCase({ id: "untimed", dueTime: null }),
    ];
    expect(sortDueTomorrowCases(cases, "due_date").map((c) => c.id)).toEqual([
      "morning",
      "afternoon",
      "untimed",
    ]);
  });
  it("sorts the displayed type indicator (C → D → O) and keeps unclassifiable cases last", () => {
    const cases = [
      makeCase({ id: "ortho", restorationTypes: "Night Guard" }),
      makeCase({ id: "removable", restorationTypes: "Denture" }),
      makeCase({ id: "crown", restorationTypes: "Crown" }),
      makeCase({ id: "missing", restorationTypes: null, restorationMaterials: null }),
    ];
    expect(sortDueTomorrowCases(cases, "type").map((c) => c.id)).toEqual([
      "crown",
      "removable",
      "ortho",
      "missing",
    ]);
  });

  it("uses case id as a deterministic tie-breaker without mutating the input", () => {
    const cases = [
      makeCase({ id: "case-z", doctorName: "Same doctor" }),
      makeCase({ id: "case-a", doctorName: "Same doctor" }),
    ];
    expect(sortDueTomorrowCases(cases, "doctor").map((c) => c.id)).toEqual([
      "case-a",
      "case-z",
    ]);
    expect(cases.map((c) => c.id)).toEqual(["case-z", "case-a"]);
  });
});

describe("Desktop dashboard — Past Due and Due Today sorting", () => {
  const typeCases = [
    makeCase({ id: "ortho", restorationTypes: "Retainer" }),
    makeCase({ id: "removable", restorationTypes: "Denture" }),
    makeCase({ id: "crown", restorationTypes: "Crown" }),
    makeCase({ id: "missing", restorationTypes: null, restorationMaterials: null }),
  ];

  it("offers Case Type as a sort choice in both sections", () => {
    expect(Object.values(SECTION_SORT_LABELS)).toEqual([
      "Due date",
      "Entered date",
      "Case #",
      "Patient name",
      "Doctor",
      "Location / Status",
      "Priority",
      "Case Type",
    ]);
  });

  it.each([
    ["past due", sortPastDueCases],
    ["due today", sortDueTodayCases],
  ] as const)(
    "sorts %s by the displayed type indicator (C → D → O), keeping unclassifiable cases last",
    (_section, sortSection) => {
      expect(sortSection(typeCases, "type").map((c) => c.id)).toEqual([
        "crown",
        "removable",
        "ortho",
        "missing",
      ]);
    },
  );

  it.each([
    ["past due", sortPastDueCases],
    ["due today", sortDueTodayCases],
  ] as const)(
    "breaks %s case-type ties on case id without mutating the input",
    (_section, sortSection) => {
      const cases = [
        makeCase({ id: "crown-z", restorationTypes: "Crown" }),
        makeCase({ id: "crown-a", restorationTypes: "Bridge" }),
      ];
      expect(sortSection(cases, "type").map((c) => c.id)).toEqual(["crown-a", "crown-z"]);
      expect(cases.map((c) => c.id)).toEqual(["crown-z", "crown-a"]);
    },
  );

  it("keeps the past due default ordered by the displayed due date and time", () => {
    const cases = [
      makeCase({ id: "later", dueDate: "2026-07-19", dueTime: "15:00" }),
      makeCase({ id: "earlier", dueDate: "2026-07-19", dueTime: "09:00" }),
      makeCase({ id: "oldest", dueDate: "2026-07-18", dueTime: null }),
    ];
    expect(sortPastDueCases(cases, "due_date").map((c) => c.id)).toEqual([
      "oldest",
      "earlier",
      "later",
    ]);
  });

  it.each([
    ["past due", sortPastDueCases],
    ["due today", sortDueTodayCases],
  ] as const)("sorts %s by created date when updatedAt disagrees", (_section, sortSection) => {
    const cases = [
      makeCase({
        id: "newer",
        createdAt: "2026-09-20T16:00:00.000Z",
        updatedAt: "2026-09-18T16:00:00.000Z",
      }),
      makeCase({
        id: "older",
        createdAt: "2026-09-19T16:00:00.000Z",
        updatedAt: "2026-10-06T16:00:00.000Z",
      }),
    ];
    expect(sortSection(cases, "entered").map((c) => c.id)).toEqual(["older", "newer"]);
  });

  it("keeps the Past Due count and visible rows aligned when a denture case's due date is refreshed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 20, 12, 0, 0));
    mockCases.current = [
      makeCase({
        id: "denture-case",
        caseNumber: "DENTURE-1",
        patientFirstName: "Denture",
        patientLastName: "Case",
        receivedAt: "2026-07-12",
        dueDate: "2026-01-01",
        restorationTypes: "Denture",
      }),
      makeCase({
        id: "future-due",
        caseNumber: "FUTURE-DUE",
        patientFirstName: "Future",
        patientLastName: "Due",
        receivedAt: "2026-07-01",
        dueDate: "2026-12-31",
      }),
      makeCase({
        id: "missing-due",
        caseNumber: "MISSING-DUE",
        patientFirstName: "Missing",
        patientLastName: "Due",
        receivedAt: "2026-07-01",
        dueDate: null,
      }),
      makeCase({
        id: "today-date-only",
        caseNumber: "TODAY-DATE-ONLY",
        patientFirstName: "Today",
        patientLastName: "DateOnly",
        dueDate: "2026-07-20",
      }),
      makeCase({
        id: "today-elapsed",
        caseNumber: "TODAY-ELAPSED",
        patientFirstName: "Today",
        patientLastName: "Elapsed",
        dueDate: "2026-07-20",
        dueTime: "08:00",
      }),
      makeCase({
        id: "today-upcoming",
        caseNumber: "TODAY-UPCOMING",
        patientFirstName: "Today",
        patientLastName: "Upcoming",
        dueDate: "2026-07-20",
        dueTime: "18:00",
      }),
      makeCase({
        id: "closed",
        caseNumber: "CLOSED",
        patientFirstName: "Closed",
        patientLastName: "Case",
        status: "delivered",
        dueDate: "2026-01-01",
      }),
    ];

    const view = render(React.createElement(DashboardPage));
    const section = screen.getByRole("heading", { name: /past due/i }).closest("section")!;
    const caseRows = () => within(section).getAllByRole("row").slice(1);

    expect(within(section).getByTestId("dashboard-past-due-count").textContent).toBe("2");
    expect(within(section).getByText("2 active cases past due.")).toBeTruthy();
    expect(caseRows()).toHaveLength(2);
    expect(within(section).getByText("Denture Case")).toBeTruthy();
    expect(within(section).getByText("Today Elapsed")).toBeTruthy();
    expect(within(section).queryByText("Future Due")).toBeNull();
    expect(within(section).queryByText("Missing Due")).toBeNull();
    expect(within(section).queryByText("Today DateOnly")).toBeNull();
    expect(within(section).queryByText("Today Upcoming")).toBeNull();
    expect(within(section).queryByText("Closed Case")).toBeNull();

    mockCases.current = mockCases.current.map((caseItem) =>
      caseItem.id === "denture-case"
        ? { ...caseItem, dueDate: "2026-12-31" }
        : caseItem,
    );
    view.rerender(React.createElement(DashboardPage));

    expect(within(section).getByTestId("dashboard-past-due-count").textContent).toBe("1");
    expect(within(section).getByText("1 active case past due.")).toBeTruthy();
    expect(caseRows()).toHaveLength(1);
    expect(within(section).queryByText("Denture Case")).toBeNull();
    expect(within(section).getByText("Today Elapsed")).toBeTruthy();
  });
});

describe("Desktop dashboard — Entered date display and table layout", () => {
  it.each(["past due", "due today", "due tomorrow", "recent cases", "no due date"] as const)(
    "shows persisted creation dates and preserves pre-repair presentation in %s",
    (section) => {
      const older = makeCase({
        id: `${section}-older`,
        caseNumber: `${section}-older`,
        createdAt: "2026-09-19T16:00:00.000Z",
        updatedAt: "2026-10-06T16:00:00.000Z",
        dueDate: "2026-09-20",
        step: "wax-up",
      } as Partial<LabCase>);
      const newer = makeCase({
        id: `${section}-newer`,
        caseNumber: `${section}-newer`,
        createdAt: "2026-09-20T16:00:00.000Z",
        updatedAt: "2026-10-05T16:00:00.000Z",
        dueDate: "2026-09-21",
        step: "wax-up",
      } as Partial<LabCase>);
      const showActivity = section === "recent cases";
      const showTypeIndicator = !showActivity && section !== "no due date";
      const showStep = showTypeIndicator;
      const onSelect = vi.fn();
      const { container, unmount } = render(
        React.createElement(CasesTable, {
          cases: [older, newer],
          loading: false,
          emptyText: "No cases",
          onSelect,
          showActivity,
          showTypeIndicator,
          showStep,
        }),
      );

      const table = container.querySelector("table")!;
      const headers = within(table).getAllByRole("columnheader");
      const rows = within(table).getAllByRole("row").slice(1);
      expect(headers).toHaveLength(showTypeIndicator ? 7 : 6);
      expect(headers.slice(0, 6).map((h) => h.textContent)).toEqual(
        ["Case #", "Patient", "Doctor", "Status", "Location", "Due date"],
      );
      for (const row of rows) {
        const cells = within(row).getAllByRole("cell");
        expect(cells).toHaveLength(headers.length);
        for (const cell of cells) expect(cell.className).not.toContain("whitespace-nowrap");
      }
      // Entered date stays readable in the secondary line under the patient.
      expect(within(rows[0]).getAllByRole("cell")[1]).toHaveTextContent(formatDate(older.createdAt));
      expect(within(rows[0]).getAllByRole("cell")[1]).not.toHaveTextContent(formatDate(older.updatedAt));
      if (showTypeIndicator) expect(headers[6]).toHaveTextContent("Type");

      fireEvent.click(rows[0]);
      expect(onSelect).toHaveBeenCalledWith(older);
      unmount();
    },
  );
});