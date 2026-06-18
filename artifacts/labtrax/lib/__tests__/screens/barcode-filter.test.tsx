/**
 * Barcode quick-filter — mobile cases list
 *
 * Guards:
 * - The barcode filter input is hidden until the user presses the Barcode chip.
 * - Filtering uses exact pan-barcode match: a case whose barcode contains the
 *   filter string as a substring but is not identical is excluded.
 * - The chip label updates to show the active barcode value.
 * - Clearing the filter restores the full case list.
 *
 * Barcode conflict detection:
 * - Two or more active (non-terminal) cases in the same lab with the same
 *   casePanBarcode are "conflicting". Each gets an amber "Conflict" badge.
 * - A "Conflicts" filter chip narrows the list to only conflicting cases.
 * - Terminal-status cases (complete, delivered, etc.) are excluded from
 *   conflict detection even when they share a barcode.
 */

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react-native";
import { resetMockAppState, setMockAppState } from "../../../vitest.setup";
import CasesListScreen from "@/app/(tabs)/index";

// ── Test fixtures ────────────────────────────────────────────────────────────

const BASE = {
  id: "bc-1", caseNumber: "9001",
  patientFirstName: "Alice", patientLastName: "A",
  doctorName: "Dr. A", status: "received", priority: "standard",
  dueDate: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** Exact match for "SCAN-001" */
const EXACT_MATCH = { ...BASE, id: "bc-1", caseNumber: "9001", casePanBarcode: "SCAN-001" };

/** Different barcode — should never appear when filtering "SCAN-001" */
const NO_MATCH = {
  ...BASE, id: "bc-2", caseNumber: "9002",
  patientFirstName: "Bob", patientLastName: "B",
  casePanBarcode: "SCAN-002",
};

/**
 * "SCAN-001-X" contains "SCAN-001" as a prefix/substring.
 * The filter is exact-match only, so this case must be EXCLUDED when the
 * filter value is "SCAN-001".
 */
const SUBSTRING_ONLY = {
  ...BASE, id: "bc-3", caseNumber: "9003",
  patientFirstName: "Carol", patientLastName: "C",
  casePanBarcode: "SCAN-001-X",
};

/** Case with no barcode at all — must be excluded from barcode-filtered results */
const NO_BARCODE = {
  ...BASE, id: "bc-4", caseNumber: "9004",
  patientFirstName: "Dave", patientLastName: "D",
  casePanBarcode: undefined,
};

// ── Conflict detection fixtures ───────────────────────────────────────────────

const LAB_ID = "lab-org-001";

/** Two active cases that share the same barcode in the same lab → both conflicting */
const CONFLICT_A = {
  ...BASE,
  id: "con-1", caseNumber: "8001",
  patientFirstName: "Eve", patientLastName: "E",
  casePanBarcode: "DUP-BARCODE",
  labOrganizationId: LAB_ID,
  status: "received",
};
const CONFLICT_B = {
  ...BASE,
  id: "con-2", caseNumber: "8002",
  patientFirstName: "Frank", patientLastName: "F",
  casePanBarcode: "DUP-BARCODE",
  labOrganizationId: LAB_ID,
  status: "in_progress",
};

/** Active case with a unique barcode — must NOT be flagged as conflicting */
const UNIQUE_BARCODE = {
  ...BASE,
  id: "con-3", caseNumber: "8003",
  patientFirstName: "Grace", patientLastName: "G",
  casePanBarcode: "UNIQUE-BARCODE",
  labOrganizationId: LAB_ID,
  status: "received",
};

/**
 * Complete case that happens to share the same barcode as CONFLICT_A/B.
 * Terminal-status cases are excluded from conflict detection.
 */
const COMPLETE_DUP = {
  ...BASE,
  id: "con-4", caseNumber: "8004",
  patientFirstName: "Hank", patientLastName: "H",
  casePanBarcode: "DUP-BARCODE",
  labOrganizationId: LAB_ID,
  status: "complete",
};

afterEach(() => {
  resetMockAppState();
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CasesListScreen — barcode quick-filter", () => {
  beforeEach(() => {
    setMockAppState({ cases: [EXACT_MATCH, NO_MATCH, SUBSTRING_ONLY, NO_BARCODE] });
  });

  it("barcode filter input is hidden on initial render", () => {
    const { queryByTestId } = render(<CasesListScreen />);
    expect(queryByTestId("cases-barcode-filter-input")).toBeNull();
  });

  it("pressing the Barcode chip reveals the barcode filter input", () => {
    const { getByTestId } = render(<CasesListScreen />);
    fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    expect(getByTestId("cases-barcode-filter-input")).toBeTruthy();
  });

  it("exact-match: shows only the case whose casePanBarcode equals the filter exactly", () => {
    const { getByTestId, getAllByText, queryAllByText } = render(<CasesListScreen />);
    fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "SCAN-001");

    // Alice (SCAN-001) must be visible
    expect(getAllByText(/#9001/).length).toBeGreaterThan(0);
    // Bob (SCAN-002) must be hidden
    expect(queryAllByText(/#9002/).length).toBe(0);
  });

  it("substring exclusion: SCAN-001-X does not match when filtering for SCAN-001", () => {
    const { getByTestId, queryAllByText } = render(<CasesListScreen />);
    fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "SCAN-001");

    // Carol's case (#9003) has barcode "SCAN-001-X" — not an exact match, must be hidden
    expect(queryAllByText(/#9003/).length).toBe(0);
  });

  it("case without a barcode is excluded when a barcode filter is active", () => {
    const { getByTestId, queryAllByText } = render(<CasesListScreen />);
    fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "SCAN-001");

    // Dave (#9004) has no casePanBarcode — must not appear
    expect(queryAllByText(/#9004/).length).toBe(0);
  });

  it("clearing the barcode filter restores all four cases", () => {
    const { getByTestId, getAllByText } = render(<CasesListScreen />);
    fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "SCAN-001");
    // Clear
    fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "");

    expect(getAllByText(/#9001/).length).toBeGreaterThan(0);
    expect(getAllByText(/#9002/).length).toBeGreaterThan(0);
    expect(getAllByText(/#9003/).length).toBeGreaterThan(0);
    expect(getAllByText(/#9004/).length).toBeGreaterThan(0);
  });

  it("chip label updates to 'Barcode: <value>' while a filter is active", () => {
    const { getByTestId, getByText } = render(<CasesListScreen />);
    fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "SCAN-001");

    expect(getByText("Barcode: SCAN-001")).toBeTruthy();
  });

  it("filter is case-insensitive: lowercase filter matches uppercase barcode", () => {
    // The barcode filter lowercases both sides before comparing
    const { getByTestId, getAllByText } = render(<CasesListScreen />);
    fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "scan-001");

    // Alice's "SCAN-001" (uppercase) should still match "scan-001" (lowercase)
    expect(getAllByText(/#9001/).length).toBeGreaterThan(0);
  });
});

describe("CasesListScreen — barcode conflict detection", () => {
  beforeEach(() => {
    setMockAppState({
      cases: [CONFLICT_A, CONFLICT_B, UNIQUE_BARCODE, COMPLETE_DUP],
    });
  });

  it("conflict badge appears on both active cases that share a barcode", () => {
    const { getByTestId } = render(<CasesListScreen />);
    // Both con-1 and con-2 share "DUP-BARCODE" and are active
    expect(getByTestId("conflict-badge-con-1")).toBeTruthy();
    expect(getByTestId("conflict-badge-con-2")).toBeTruthy();
  });

  it("conflict badge shows the text 'Conflict'", () => {
    const { getAllByText } = render(<CasesListScreen />);
    const badges = getAllByText("Conflict");
    // One badge per conflicting case (con-1 and con-2)
    expect(badges.length).toBe(2);
  });

  it("conflict badge does not appear on a case with a unique barcode", () => {
    const { queryByTestId } = render(<CasesListScreen />);
    expect(queryByTestId("conflict-badge-con-3")).toBeNull();
  });

  it("complete-status duplicate is excluded from conflict detection", () => {
    // COMPLETE_DUP shares "DUP-BARCODE" but status=complete → not flagged
    const { queryByTestId } = render(<CasesListScreen />);
    expect(queryByTestId("conflict-badge-con-4")).toBeNull();
  });

  it("Conflicts chip is present in the filter row", () => {
    const { getByTestId } = render(<CasesListScreen />);
    expect(getByTestId("cases-conflict-filter-chip")).toBeTruthy();
  });

  it("pressing the Conflicts chip filters to only conflicting cases", () => {
    const { getByTestId, queryAllByText, getAllByText } = render(<CasesListScreen />);
    fireEvent.press(getByTestId("cases-conflict-filter-chip"));

    // con-1 and con-2 (conflicting) must be visible
    expect(getAllByText(/#8001/).length).toBeGreaterThan(0);
    expect(getAllByText(/#8002/).length).toBeGreaterThan(0);
    // con-3 (unique barcode) must be hidden
    expect(queryAllByText(/#8003/).length).toBe(0);
    // con-4 (complete dup — excluded from conflicts) must be hidden
    expect(queryAllByText(/#8004/).length).toBe(0);
  });

  it("clearing the Conflicts chip restores all cases", () => {
    const { getByTestId, getAllByText } = render(<CasesListScreen />);
    // Enable then clear
    fireEvent.press(getByTestId("cases-conflict-filter-chip"));
    fireEvent.press(getByTestId("cases-conflict-filter-chip"));

    expect(getAllByText(/#8001/).length).toBeGreaterThan(0);
    expect(getAllByText(/#8002/).length).toBeGreaterThan(0);
    expect(getAllByText(/#8003/).length).toBeGreaterThan(0);
  });
});
