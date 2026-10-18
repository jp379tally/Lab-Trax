/**
 * Multi-select status filter — mobile cases list
 *
 * Guards the desktop-parity contract (see labtrax-desktop
 * src/components/MultiSelectFilter.tsx):
 * - Several statuses can be checked at once; a case is kept when its status
 *   matches ANY of them (union, not intersection).
 * - No selection means "All"; Clear resets both the draft and the applied
 *   selection, and the chip carries its own inline clear affordance.
 * - The chip summarizes the selection: the bare noun with nothing checked, the
 *   single option's label with one, and "N selected" with more.
 * - Legacy UPPERCASE status tokens still match the canonical option value.
 * - The status filter combines (AND) with the user-facing case Type picker.
 */

import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, render, fireEvent, waitFor, within } from "@testing-library/react-native";
import { resetMockAppState, setMockAppState } from "../../../vitest.setup";
import CasesListScreen from "@/app/(tabs)/index";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BASE = {
  caseNumber: "7001",
  patientFirstName: "Alice",
  patientLastName: "A",
  doctorName: "Dr. A",
  priority: "standard",
  dueDate: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  restorationTypes: "Crown",
  restorationMaterials: "Zirconia",
  firstRestorationSubtype: "restorative/crown",
};

const IN_DESIGN = { ...BASE, id: "st-design", caseNumber: "7001", status: "in_design" };
const IN_PORCELAIN = {
  ...BASE,
  id: "st-porcelain",
  caseNumber: "7002",
  patientFirstName: "Bob",
  status: "in_porcelain",
};
const QC = {
  ...BASE,
  id: "st-qc",
  caseNumber: "7003",
  patientFirstName: "Carol",
  status: "qc",
};
/** Legacy feed token — the legacy mobile endpoints still emit UPPERCASE. */
const LEGACY_PORCELAIN = {
  ...BASE,
  id: "st-legacy",
  caseNumber: "7004",
  patientFirstName: "Dave",
  status: "PORCELAIN",
};
/** Removable case parked in design — used for the Type × Status combination. */
const REMOVABLE_IN_DESIGN = {
  ...BASE,
  id: "st-removable",
  caseNumber: "7005",
  patientFirstName: "Erin",
  status: "in_design",
  restorationTypes: "Denture",
  restorationMaterials: "Acrylic",
  firstRestorationSubtype: "removable/complete_denture",
};

afterEach(() => {
  resetMockAppState();
  vi.clearAllMocks();
});

/**
 * The chip's own summary text. Scoped to the chip because the sheet's option
 * rows carry the same labels and stay mounted (the test Modal stub ignores
 * `visible`), so an unscoped text query would be ambiguous.
 */
function chipSummary(utils: Awaited<ReturnType<typeof render>>): string {
  return within(utils.getByTestId("cases-status-filter-chip")).getAllByText(
    /.+/,
  )[0]!.props.children as string;
}

/** Opens the status sheet and checks each supplied option, then applies. */
async function applyStatuses(
  utils: Awaited<ReturnType<typeof render>>,
  values: string[],
): Promise<void> {
  await waitFor(() =>
    expect(utils.getByTestId("cases-status-filter-chip")).toBeTruthy(),
  );
  await fireEvent.press(utils.getByTestId("cases-status-filter-chip"));
  await waitFor(() =>
    expect(utils.getByTestId(`cases-status-option-${values[0]}`)).toBeTruthy(),
  );
  for (const value of values) {
    await fireEvent.press(utils.getByTestId(`cases-status-option-${value}`));
  }
  await fireEvent.press(utils.getByTestId("cases-status-apply"));
}

async function renderCasesScreen(): Promise<Awaited<ReturnType<typeof render>>> {
  const utils = await render(<CasesListScreen />);
  await act(async () => undefined);
  await waitFor(() =>
    expect(utils.getByTestId("cases-status-filter-chip")).toBeTruthy(),
  );
  return utils;
}

describe("CasesListScreen — multi-select status filter", () => {
  beforeEach(() => {
    setMockAppState({ cases: [IN_DESIGN, IN_PORCELAIN, QC] });
  });

  it("shows every case and the bare 'Status' label before anything is selected", async () => {
    const utils = await renderCasesScreen();
    expect(utils.getByTestId("case-card-st-design")).toBeTruthy();
    expect(utils.getByTestId("case-card-st-porcelain")).toBeTruthy();
    expect(utils.getByTestId("case-card-st-qc")).toBeTruthy();
    expect(chipSummary(utils)).toBe("Location");
  });

  it("keeps cases matching ANY of the checked statuses", async () => {
    const utils = await renderCasesScreen();
    await applyStatuses(utils, ["in_design", "in_porcelain"]);

    expect(utils.getByTestId("case-card-st-design")).toBeTruthy();
    expect(utils.getByTestId("case-card-st-porcelain")).toBeTruthy();
    // qc was not checked
    expect(utils.queryByTestId("case-card-st-qc")).toBeNull();
  });

  it("summarizes one selection with the option's label and several with a count", async () => {
    const utils = await renderCasesScreen();

    await applyStatuses(utils, ["in_design"]);
    expect(chipSummary(utils)).toBe("In Design");

    await applyStatuses(utils, ["in_porcelain"]);
    expect(chipSummary(utils)).toBe("2 selected");

    await applyStatuses(utils, ["qc"]);
    expect(chipSummary(utils)).toBe("3 selected");
  });

  it("shows the running count inside the sheet while options are toggled", async () => {
    const utils = await renderCasesScreen();
    await fireEvent.press(utils.getByTestId("cases-status-filter-chip"));

    expect(utils.getByTestId("cases-status-filter-summary").props.children).toBe(
      "All locations",
    );
    await fireEvent.press(utils.getByTestId("cases-status-option-in_design"));
    await fireEvent.press(utils.getByTestId("cases-status-option-qc"));
    expect(utils.getByTestId("cases-status-filter-summary").props.children).toBe(
      "2 selected",
    );
  });

  it("unchecking a status inside the sheet removes it from the selection", async () => {
    const utils = await renderCasesScreen();
    await fireEvent.press(utils.getByTestId("cases-status-filter-chip"));
    await fireEvent.press(utils.getByTestId("cases-status-option-in_design"));
    await fireEvent.press(utils.getByTestId("cases-status-option-qc"));
    // Toggle "qc" back off before applying
    await fireEvent.press(utils.getByTestId("cases-status-option-qc"));
    await fireEvent.press(utils.getByTestId("cases-status-apply"));

    expect(utils.getByTestId("case-card-st-design")).toBeTruthy();
    expect(utils.queryByTestId("case-card-st-qc")).toBeNull();
  });

  it("Clear inside the sheet resets to all cases", async () => {
    const utils = await renderCasesScreen();
    await applyStatuses(utils, ["in_design"]);
    expect(utils.queryByTestId("case-card-st-qc")).toBeNull();

    await fireEvent.press(utils.getByTestId("cases-status-filter-chip"));
    await fireEvent.press(utils.getByTestId("cases-status-clear"));

    expect(utils.getByTestId("case-card-st-design")).toBeTruthy();
    expect(utils.getByTestId("case-card-st-qc")).toBeTruthy();
    expect(chipSummary(utils)).toBe("Location");
  });

  it("the chip's inline clear resets the selection without opening the sheet", async () => {
    const utils = await renderCasesScreen();
    await applyStatuses(utils, ["in_design", "in_porcelain"]);

    await fireEvent.press(utils.getByTestId("cases-status-filter-chip-clear"));

    expect(utils.getByTestId("case-card-st-qc")).toBeTruthy();
    expect(chipSummary(utils)).toBe("Location");
  });

  it("applying an empty selection means All", async () => {
    const utils = await renderCasesScreen();
    await fireEvent.press(utils.getByTestId("cases-status-filter-chip"));
    await fireEvent.press(utils.getByTestId("cases-status-apply"));

    expect(utils.getByTestId("case-card-st-design")).toBeTruthy();
    expect(utils.getByTestId("case-card-st-porcelain")).toBeTruthy();
    expect(utils.getByTestId("case-card-st-qc")).toBeTruthy();
  });
});

describe("CasesListScreen — status filter normalization", () => {
  it("matches a legacy UPPERCASE status token against the canonical option", async () => {
    setMockAppState({ cases: [IN_PORCELAIN, LEGACY_PORCELAIN, QC] });
    const utils = await renderCasesScreen();
    await applyStatuses(utils, ["in_porcelain"]);

    // Both the canonical "in_porcelain" and the legacy "PORCELAIN" case match.
    expect(utils.getByTestId("case-card-st-porcelain")).toBeTruthy();
    expect(utils.getByTestId("case-card-st-legacy")).toBeTruthy();
    expect(utils.queryByTestId("case-card-st-qc")).toBeNull();
  });
});

describe("CasesListScreen — status filter combines with the Type picker", () => {
  it("narrows to cases matching both a checked status and the selected type", async () => {
    setMockAppState({ cases: [IN_DESIGN, REMOVABLE_IN_DESIGN, QC] });
    const utils = await renderCasesScreen();

    await applyStatuses(utils, ["in_design"]);
    // Both in-design cases survive the status filter …
    expect(utils.getByTestId("case-card-st-design")).toBeTruthy();
    expect(utils.getByTestId("case-card-st-removable")).toBeTruthy();
    expect(utils.queryByTestId("case-card-st-qc")).toBeNull();

    // … then the Type picker narrows further (AND, not OR).
    await fireEvent.press(utils.getByTestId("cases-type-filter-chip"));
    await fireEvent.press(utils.getByTestId("cases-type-option-removable"));

    expect(utils.getByTestId("case-card-st-removable")).toBeTruthy();
    expect(utils.queryByTestId("case-card-st-design")).toBeNull();
    expect(utils.queryByTestId("case-card-st-qc")).toBeNull();
  });
});
