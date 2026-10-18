/**
 * Cases filter sheets must paint an opaque panel.
 *
 * The Cases list sheets (Date created, Date due, custom range, status and case
 * type) all render inside a `transparent` React Native Modal and share one
 * panel style. The light theme's `background` token is literally
 * "transparent" — it exists so full-screen scroll views can sit on the app
 * gradient — so filling the panel with it made the sheet see-through and the
 * case list bled through the options. Guard the shared panel fill here.
 */

import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, render } from "@testing-library/react-native";
import { resetMockAppState, setMockAppState } from "../../../vitest.setup";
import CasesListScreen from "@/app/(tabs)/index";

/**
 * Local flatten — the test renderer's `StyleSheet.flatten` returns style arrays
 * untouched, so merge them here to read the effective values.
 */
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => Object.assign(acc, flatten(entry)),
      {},
    );
  }
  return (style ?? {}) as Record<string, unknown>;
}

const CASE = {
  id: "sheet-case-1",
  caseNumber: "9001",
  patientFirstName: "Alice",
  patientLastName: "A",
  doctorName: "Dr. A",
  priority: "standard",
  status: "in_design",
  dueDate: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  restorationTypes: "Crown",
  restorationMaterials: "Zirconia",
  firstRestorationSubtype: "restorative/crown",
};

beforeEach(() => {
  setMockAppState({ cases: [CASE] });
});

afterEach(() => {
  resetMockAppState();
  vi.clearAllMocks();
});

describe("CasesListScreen — filter sheet panel", () => {
  it("fills the sheet panel with an opaque surface, not the transparent background token", async () => {
    const utils = await render(<CasesListScreen />);
    await act(async () => undefined);
    const panel = utils.getByTestId("cases-status-sheet-panel");
    const style = flatten(panel.props.style) as { backgroundColor?: string };

    expect(style.backgroundColor).toBeTruthy();
    expect(style.backgroundColor).not.toBe("transparent");
    expect(style.backgroundColor).not.toMatch(/rgba\([^)]*,\s*0(\.0+)?\s*\)$/);
    // Matches the opaque surface the shared FormSheet/locate sheets use.
    expect(style.backgroundColor).toBe("#F4F7FB");
  });

  it("keeps the sheet's rounded top corners", async () => {
    const utils = await render(<CasesListScreen />);
    await act(async () => undefined);
    const style = flatten(
      utils.getByTestId("cases-status-sheet-panel").props.style,
    ) as { borderTopLeftRadius?: number; borderTopRightRadius?: number };

    expect(style.borderTopLeftRadius).toBeGreaterThan(0);
    expect(style.borderTopRightRadius).toBeGreaterThan(0);
  });
});
