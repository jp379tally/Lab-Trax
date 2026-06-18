/**
 * Barcode quick-filter — mobile cases list
 *
 * Guards:
 * - The barcode filter input is hidden until the user presses the Barcode chip.
 * - Filtering uses exact pan-barcode match: a case whose barcode contains the
 *   filter string as a substring but is not identical is excluded.
 * - The chip label updates to show the active barcode value.
 * - Clearing the filter restores the full case list.
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
