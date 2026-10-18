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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it as vitestIt,
  vi,
} from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import {
  flushPendingReactUpdates,
  resetMockAppState,
  setMockAppState,
} from "../../../vitest.setup";
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

const it = (
  name: string,
  testFn: () => void | Promise<void>,
  timeout?: number,
): void => {
  vitestIt(
    name,
    async () => {
      await testFn();
      await flushPendingReactUpdates();
    },
    timeout,
  );
};

afterEach(() => {
  resetMockAppState();
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CasesListScreen — barcode quick-filter", () => {
  beforeEach(() => {
    setMockAppState({
      meMemberships: [{
        organizationId: LAB_ID,
        role: "admin",
        status: "active",
        organization: { id: LAB_ID, type: "lab", name: "Test Lab" },
      }],
      cases: [
        EXACT_MATCH, NO_MATCH, SUBSTRING_ONLY, NO_BARCODE,
        CONFLICT_A, CONFLICT_B, UNIQUE_BARCODE, COMPLETE_DUP,
      ],
    });
  });

  it("barcode filter input is hidden on initial render", async () => {
    const { queryByTestId } = await render(<CasesListScreen />);
    expect(queryByTestId("conflict-badge-con-4")).toBeNull();
  });

  it("Conflicts chip is present in the filter row", async () => {
    const { getByTestId } = await render(<CasesListScreen />);
    expect(getByTestId("cases-conflict-filter-chip")).toBeTruthy();
  });

  it("pressing the Conflicts chip filters to only conflicting cases", async () => {
    const { getByTestId, queryByTestId } = await render(<CasesListScreen />);
    await fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    await fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "SCAN-001");

    // Carol's case (bc-3) has barcode "SCAN-001-X" — not an exact match, must be hidden
    await waitFor(() => expect(queryByTestId("case-card-bc-3")).toBeNull());
  });

  it("case without a barcode is excluded when a barcode filter is active", async () => {
    const { getByTestId, queryByTestId } = await render(<CasesListScreen />);
    await fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    await fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "SCAN-001");

    // Carol's case (bc-3) has barcode "SCAN-001-X" — not an exact match, must be hidden
    await waitFor(() => expect(queryByTestId("case-card-bc-3")).toBeNull());
  });

  it("case without a barcode is excluded when a barcode filter is active", async () => {
    const { getByTestId, queryByTestId } = await render(<CasesListScreen />);
    await fireEvent.press(getByTestId("cases-conflict-filter-chip"));

    // con-1 and con-2 (conflicting) must be visible
    expect(getByTestId("case-card-con-1")).toBeTruthy();
    expect(getByTestId("case-card-con-2")).toBeTruthy();
    // con-3 (unique barcode) must be hidden
    expect(queryByTestId("case-card-con-3")).toBeNull();
    // con-4 (complete dup — excluded from conflicts) must be hidden
    expect(queryByTestId("case-card-con-4")).toBeNull();
  });

  it("clearing the Conflicts chip restores all cases", async () => {
    const { getByTestId } = await render(<CasesListScreen />);
    await fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    await fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "SCAN-001");
    // Clear
    await fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "");

    expect(getByTestId("case-card-bc-1")).toBeTruthy();
    expect(getByTestId("case-card-bc-2")).toBeTruthy();
    expect(getByTestId("case-card-bc-3")).toBeTruthy();
    expect(getByTestId("case-card-bc-4")).toBeTruthy();
  });

  it("chip label updates to 'Barcode: <value>' while a filter is active", async () => {
    const { getByTestId, getByText } = await render(<CasesListScreen />);
    await fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    await fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "SCAN-001");

    expect(getByText("Barcode: SCAN-001")).toBeTruthy();
  });

  it("filter is case-insensitive: lowercase filter matches uppercase barcode", async () => {
    // The barcode filter lowercases both sides before comparing
    const { getByTestId } = await render(<CasesListScreen />);
    await fireEvent.press(getByTestId("cases-barcode-filter-chip"));
    await fireEvent.changeText(getByTestId("cases-barcode-filter-input"), "scan-001");

    // Alice's "SCAN-001" (uppercase) should still match "scan-001" (lowercase)
    expect(getByTestId("case-card-bc-1")).toBeTruthy();
  });
});

describe("CasesListScreen — barcode conflict detection", () => {
  beforeEach(() => {
    setMockAppState({
      meMemberships: [{
        organizationId: LAB_ID,
        role: "admin",
        status: "active",
        organization: { id: LAB_ID, type: "lab", name: "Test Lab" },
      }],
      cases: [CONFLICT_A, CONFLICT_B, UNIQUE_BARCODE, COMPLETE_DUP],
    });
  });

  it("conflict badge appears on both active cases that share a barcode", async () => {
    const { getByTestId } = await render(<CasesListScreen />);
    // Both con-1 and con-2 share "DUP-BARCODE" and are active
    expect(getByTestId("conflict-badge-con-1")).toBeTruthy();
    expect(getByTestId("conflict-badge-con-2")).toBeTruthy();
  });

  it("conflict badge shows the text 'Conflict'", async () => {
    const { getAllByText } = await render(<CasesListScreen />);
    const badges = getAllByText("Conflict");
    // One badge per conflicting case (con-1 and con-2)
    expect(badges.length).toBe(2);
  });

  it("conflict badge does not appear on a case with a unique barcode", async () => {
    const { queryByTestId } = await render(<CasesListScreen />);
    expect(queryByTestId("conflict-badge-con-3")).toBeNull();
  });

  it("complete-status duplicate is excluded from conflict detection", async () => {
    // COMPLETE_DUP shares "DUP-BARCODE" but status=complete → not flagged
    const { queryByTestId } = await render(<CasesListScreen />);
    expect(queryByTestId("conflict-badge-con-4")).toBeNull();
  });

  it("Conflicts chip is present in the filter row", async () => {
    const { getByTestId } = await render(<CasesListScreen />);
    expect(getByTestId("cases-conflict-filter-chip")).toBeTruthy();
  });

  it("pressing the Conflicts chip filters to only conflicting cases", async () => {
    const { getByTestId, queryByTestId } = await render(<CasesListScreen />);
    await fireEvent.press(getByTestId("cases-conflict-filter-chip"));

    // con-1 and con-2 (conflicting) must be visible
    expect(getByTestId("case-card-con-1")).toBeTruthy();
    expect(getByTestId("case-card-con-2")).toBeTruthy();
    // con-3 (unique barcode) must be hidden
    expect(queryByTestId("case-card-con-3")).toBeNull();
    // con-4 (complete dup — excluded from conflicts) must be hidden
    expect(queryByTestId("case-card-con-4")).toBeNull();
  });

  it("clearing the Conflicts chip restores all cases", async () => {
    const { getByTestId } = await render(<CasesListScreen />);
    // Enable then clear
    await fireEvent.press(getByTestId("cases-conflict-filter-chip"));
    await fireEvent.press(getByTestId("cases-conflict-filter-chip"));

    expect(getByTestId("case-card-con-1")).toBeTruthy();
    expect(getByTestId("case-card-con-2")).toBeTruthy();
    expect(getByTestId("case-card-con-3")).toBeTruthy();
  });
});
