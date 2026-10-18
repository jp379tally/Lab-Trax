import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react-native";
import { cleanup } from "@testing-library/react-native";
import type { CanonicalCase } from "@workspace/api-client-react";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";
import DashboardScreen, {
  CaseSortSheet,
  DUE_TOMORROW_SORT_LABELS,
  SECTION_SORT_LABELS,
  sortDueTodayCases,
  sortDueTomorrowCases,
  sortPastDueCases,
} from "../(tabs)/dashboard";
import type { ThemeColors } from "@/lib/theme-context";

afterEach(() => {
  cleanup();
  resetMockAppState();
});

const colors = {
  text: "#111111",
  textSecondary: "#222222",
  border: "#333333",
  surface: "#ffffff",
  tint: "#0000ff",
} as ThemeColors;

function makeCase(overrides: Partial<CanonicalCase>): CanonicalCase {
  return {
    id: "case-default",
    caseNumber: "1",
    doctorName: "Dr. Synthetic063",
    labLocationName: "Mill",
    restorationTypes: "Crown",
    restorationMaterials: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    dueDate: "2026-07-21T00:00:00.000Z",
    expectedDeliveryDate: null,
    status: "received",
    priority: "normal",
    ...overrides,
  } as CanonicalCase;
}

function nextBusinessDayIso(): string {
  const date = new Date();
  do date.setDate(date.getDate() + 1);
  while (date.getDay() === 0 || date.getDay() === 6);
  date.setHours(12, 0, 0, 0);
  return date.toISOString();
}

describe("Mobile dashboard — Due Tomorrow sorting", () => {
  it("sorts Location by visible station names when workflow statuses match", async () => {
    const sorted = sortDueTomorrowCases(
      [
        makeCase({ id: "z", labLocationName: "Zulu Room", status: "in_design" }),
        makeCase({ id: "a", labLocationName: "Alpha Room", status: "in_design" }),
      ],
      "location",
    );
    expect(sorted.map((c) => c.labLocationName)).toEqual([
      "Alpha Room",
      "Zulu Room",
    ]);
  });

  it("selecting Location through the dashboard control visibly reorders rows by badge text", async () => {
    setMockAppState({
      cases: [
        makeCase({
          id: "porcelain",
          caseNumber: "PORCELAIN-ROW",
          patientFirstName: "Porcelain",
          patientLastName: "Patient",
          status: "in_porcelain",
          labLocationName: "Zulu hidden location",
          createdAt: "2026-07-18T00:00:00.000Z",
          dueDate: nextBusinessDayIso(),
        }),
        makeCase({
          id: "model",
          caseNumber: "MODEL-ROW",
          patientFirstName: "Model",
          patientLastName: "Patient",
          status: "model_room",
          labLocationName: "Alpha hidden location",
          createdAt: "2026-07-20T00:00:00.000Z",
          dueDate: nextBusinessDayIso(),
        }),
      ],
    });

    const view = await render(React.createElement(DashboardScreen));
    const visiblePatientOrder = () =>
      view.getAllByText(/^(Model|Porcelain) Patient$/).map((node) => node.props.children);

    expect(visiblePatientOrder()).toEqual(["Model Patient", "Porcelain Patient"]);

    await fireEvent.press(
      view.getByLabelText("Sort due tomorrow cases by Entered date"),
      { stopPropagation: vi.fn() },
    );
    await fireEvent.press(view.getByLabelText("Sort by Location"));

    expect(visiblePatientOrder()).toEqual(["Model Patient", "Porcelain Patient"]);
  });

  it("offers the six requested sort choices", async () => {
    expect(Object.values(DUE_TOMORROW_SORT_LABELS)).toEqual([
      "Entered date",
      "Case number",
      "Doctor",
      "Location",
      "Due date",
      "Case Type",
    ]);
  });

  it("defaults to entered date, newest first, with missing values last", async () => {
    const cases = [
      makeCase({ id: "older", createdAt: "2026-07-18T00:00:00.000Z" }),
      makeCase({ id: "newer", createdAt: "2026-07-20T00:00:00.000Z" }),
      makeCase({ id: "missing", createdAt: null }),
    ];
    expect(sortDueTomorrowCases(cases, "entered").map((c) => c.id)).toEqual([
      "newer",
      "older",
      "missing",
    ]);
  });

  it("sorts case numbers naturally and places missing numbers last", async () => {
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

  it("sorts doctors case-insensitively with missing values last", async () => {
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

  it("sorts Location by the displayed physical station name", async () => {
    const cases = [
      makeCase({ id: "porcelain", status: "in_porcelain", labLocationName: "Alpha Room" }),
      makeCase({ id: "model-z", status: "model_room", labLocationName: "Zulu Room" }),
      makeCase({ id: "model-a", status: "model_room", labLocationName: "Beta Room" }),
      makeCase({ id: "missing", status: "", labLocationName: "Aardvark Room" }),
    ];
    expect(sortDueTomorrowCases(cases, "location").map((c) => c.id)).toEqual([
      "missing",
      "porcelain",
      "model-a",
      "model-z",
    ]);
  });

  it("sorts the displayed due date and time earliest first, not the expected delivery date", async () => {
    const cases = [
      makeCase({
        id: "late",
        dueDate: "2026-07-21T00:00:00.000Z",
        dueTime: "15:00",
        expectedDeliveryDate: "2026-07-21T00:00:00.000Z",
      }),
      makeCase({
        id: "early",
        dueDate: "2026-07-20T00:00:00.000Z",
        dueTime: "09:00",
        expectedDeliveryDate: "2026-07-21T00:00:00.000Z",
      }),
      makeCase({ id: "missing", dueDate: null, expectedDeliveryDate: "2026-07-21T00:00:00.000Z" }),
    ];
    expect(sortDueTomorrowCases(cases, "due_date").map((c) => c.id)).toEqual([
      "early",
      "late",
      "missing",
    ]);
  });

  it("uses due time to order cases with the same displayed due date", async () => {
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
  it("sorts the displayed type indicator and keeps unclassifiable cases last", async () => {
    const cases = [
      makeCase({ id: "removable", restorationTypes: "Denture" }),
      makeCase({ id: "crown", restorationTypes: "Crown" }),
      makeCase({ id: "missing", restorationTypes: null, restorationMaterials: null }),
    ];
    expect(sortDueTomorrowCases(cases, "type").map((c) => c.id)).toEqual([
      "crown",
      "removable",
      "missing",
    ]);
  });

  it("uses case id as a deterministic tie-breaker without mutating the input", async () => {
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

  it("exposes every sort choice as a selectable radio action", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const { getAllByLabelText, getByLabelText, getByText } = await render(
      React.createElement(CaseSortSheet, {
        visible: true,
        sectionLabel: "Due tomorrow",
        sort: "entered",
        labels: DUE_TOMORROW_SORT_LABELS,
        colors,
        onClose,
        onSelect,
      }),
    );

    expect(getByText("Sort due tomorrow")).toBeTruthy();
    expect(getAllByLabelText(/^Sort by /)).toHaveLength(6);
    await fireEvent.press(getByLabelText("Sort by Case number"));
    expect(onSelect).toHaveBeenCalledWith("case_number");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Mobile dashboard — Past Due and Due Today sorting", () => {
  const typeCases = [
    makeCase({ id: "removable", restorationTypes: "Denture" }),
    makeCase({ id: "crown", restorationTypes: "Crown" }),
    makeCase({ id: "missing", restorationTypes: null, restorationMaterials: null }),
  ];

  it("offers the same choices, in the same order, as the desktop sections", async () => {
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
    "sorts %s by the displayed type indicator, keeping unclassifiable cases last",
    (_section, sortSection) => {
      expect(sortSection(typeCases, "type").map((c) => c.id)).toEqual([
        "crown",
        "removable",
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

  it.each([
    ["past due", sortPastDueCases],
    ["due today", sortDueTodayCases],
  ] as const)("keeps the %s default ordered by the due date and time", (_section, sortSection) => {
    const cases = [
      makeCase({ id: "afternoon", dueTime: "15:00" }),
      makeCase({ id: "morning", dueTime: "09:00" }),
    ];
    expect(sortSection(cases, "due_date").map((c) => c.id)).toEqual(["morning", "afternoon"]);
  });

  it.each([
    ["past due", sortPastDueCases],
    ["due today", sortDueTodayCases],
  ] as const)("sorts %s by doctor when that choice is picked", (_section, sortSection) => {
    const cases = [
      makeCase({ id: "zulu", doctorName: "Zulu" }),
      makeCase({ id: "alpha", doctorName: "alpha" }),
    ];
    expect(sortSection(cases, "doctor").map((c) => c.id)).toEqual(["alpha", "zulu"]);
  });

  it("names the section it belongs to in the shared sort sheet", async () => {
    const onSelect = vi.fn();
    const { getAllByLabelText, getByLabelText, getByText } = await render(
      React.createElement(CaseSortSheet, {
        visible: true,
        sectionLabel: "Past due",
        sort: "due_date",
        labels: SECTION_SORT_LABELS,
        colors,
        onClose: vi.fn(),
        onSelect,
      }),
    );

    expect(getByText("Sort past due")).toBeTruthy();
    expect(getByLabelText("Past due sort options")).toBeTruthy();
    expect(getAllByLabelText("Close Past due sort options").length).toBeGreaterThan(0);
    expect(getAllByLabelText(/^Sort by /)).toHaveLength(8);
    await fireEvent.press(getByLabelText("Sort by Case Type"));
    expect(onSelect).toHaveBeenCalledWith("type");
  });
});