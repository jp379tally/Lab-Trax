import { describe, expect, it } from "vitest";
import {
  DUE_TOMORROW_SORT_LABELS,
  sortDueTomorrowCases,
  type DueTomorrowSortableCase,
} from "./due-tomorrow-sort";

interface TestCase extends DueTomorrowSortableCase {
  location?: string | null;
  typeIndicator?: string | null;
}

const selectors = {
  getLocationLabel: (caseItem: TestCase) => caseItem.location,
  getTypeIndicator: (caseItem: TestCase) => caseItem.typeIndicator,
};

function ids(cases: TestCase[], sort: Parameters<typeof sortDueTomorrowCases<TestCase>>[1]) {
  return sortDueTomorrowCases(cases, sort, selectors).map((caseItem) => caseItem.id);
}

describe("Due Tomorrow shared sorting contract", () => {
  it("defines all six sort modes in UI order", () => {
    expect(DUE_TOMORROW_SORT_LABELS).toEqual({
      entered: "Entered date",
      case_number: "Case number",
      doctor: "Doctor",
      location: "Location",
      due_date: "Due date",
      type: "Case Type",
    });
  });

  it.each([
    [
      "entered",
      [
        { id: "older", createdAt: "2026-07-18T00:00:00.000Z" },
        { id: "newer", createdAt: "2026-07-20T00:00:00.000Z" },
        { id: "missing", createdAt: null },
      ],
      ["newer", "older", "missing"],
    ],
    [
      "case_number",
      [
        { id: "ten", caseNumber: "10" },
        { id: "two", caseNumber: "2" },
        { id: "missing", caseNumber: "" },
      ],
      ["two", "ten", "missing"],
    ],
    [
      "doctor",
      [
        { id: "zulu", doctorName: "zulu" },
        { id: "alpha", doctorName: "Alpha" },
        { id: "missing", doctorName: null },
      ],
      ["alpha", "zulu", "missing"],
    ],
    [
      "location",
      [
        { id: "porcelain", location: "Porcelain" },
        { id: "model-z", location: "Model Room" },
        { id: "model-a", location: "Model Room" },
        { id: "missing", location: null },
      ],
      ["model-a", "model-z", "porcelain", "missing"],
    ],
    [
      "due_date",
      [
        { id: "late", dueDate: "2026-07-21", dueTime: "15:00" },
        { id: "early", dueDate: "2026-07-20", dueTime: "09:00" },
        { id: "missing", dueDate: null },
      ],
      ["early", "late", "missing"],
    ],
    [
      "type",
      [
        { id: "ortho", typeIndicator: "O" },
        { id: "removable", typeIndicator: "D" },
        { id: "crown", typeIndicator: "C" },
        { id: "missing", typeIndicator: null },
      ],
      ["crown", "removable", "ortho", "missing"],
    ],
  ] as const)("preserves the %s ordering semantics", (sort, cases, expected) => {
    expect(ids([...cases], sort)).toEqual(expected);
  });
});