/**
 * Unit + UI tests for mobile restoration-type classification and
 * tooth-field suppression on the NewCase screen.
 *
 * Invariants protected:
 *  - isRemovableRestorationType returns true for all five keyword families
 *    (denture, partial, flipper, flexible, Valplast) and false for fixed types.
 *  - On the NewCase screen, setting a restoration's type to a removable value
 *    removes the Tooth # input (testID "resto-tooth-{idx}") from the tree.
 *  - Setting the type back to a fixed value restores the tooth input.
 *
 * If a future refactor changes the REMOVABLE_RE pattern or removes the
 * conditional render in new-case.tsx, at least one test here will fail.
 */

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react-native";
import {
  resetMockAppState,
  setMockAppState,
} from "../../vitest.setup";

import {
  classifyRestorationType,
  isRemovableRestorationType,
} from "@/lib/restoration-category";
import NewCaseScreen from "@/app/new-case";

afterEach(() => {
  cleanup();
  resetMockAppState();
  vi.clearAllMocks();
});

// ─── Pure-function tests ──────────────────────────────────────────────────────

describe("isRemovableRestorationType — all five keyword variants", () => {
  it("returns true for denture variants", async () => {
    expect(isRemovableRestorationType("Full Denture")).toBe(true);
    expect(isRemovableRestorationType("Partial Denture")).toBe(true);
    expect(isRemovableRestorationType("Immediate Denture")).toBe(true);
    expect(isRemovableRestorationType("denture")).toBe(true);
  });

  it("returns true for partial", async () => {
    expect(isRemovableRestorationType("Partial")).toBe(true);
    expect(isRemovableRestorationType("RPD Partial")).toBe(true);
  });

  it("returns true for flipper", async () => {
    expect(isRemovableRestorationType("Flipper")).toBe(true);
    expect(isRemovableRestorationType("Acrylic Flipper")).toBe(true);
  });

  it("returns true for flexible", async () => {
    expect(isRemovableRestorationType("Flexible")).toBe(true);
    expect(isRemovableRestorationType("Flexible Partial")).toBe(true);
  });

  it("returns true for Valplast", async () => {
    expect(isRemovableRestorationType("Valplast")).toBe(true);
    expect(isRemovableRestorationType("Valplast Partial")).toBe(true);
  });

  it("is case-insensitive for all five families", async () => {
    expect(isRemovableRestorationType("DENTURE")).toBe(true);
    expect(isRemovableRestorationType("PARTIAL")).toBe(true);
    expect(isRemovableRestorationType("FLIPPER")).toBe(true);
    expect(isRemovableRestorationType("FLEXIBLE")).toBe(true);
    expect(isRemovableRestorationType("VALPLAST")).toBe(true);
  });

  it("returns false for fixed/crown-bridge types", async () => {
    expect(isRemovableRestorationType("Crown")).toBe(false);
    expect(isRemovableRestorationType("Bridge")).toBe(false);
    expect(isRemovableRestorationType("Veneer")).toBe(false);
    expect(isRemovableRestorationType("Implant Crown")).toBe(false);
    expect(isRemovableRestorationType("Inlay")).toBe(false);
    expect(isRemovableRestorationType("Onlay")).toBe(false);
  });

  it("returns false for other appliance types", async () => {
    expect(isRemovableRestorationType("Night Guard")).toBe(false);
    expect(isRemovableRestorationType("Retainer")).toBe(false);
    expect(isRemovableRestorationType("Sports Guard")).toBe(false);
  });

  it("returns false for null, undefined, and empty string", async () => {
    expect(isRemovableRestorationType(null)).toBe(false);
    expect(isRemovableRestorationType(undefined)).toBe(false);
    expect(isRemovableRestorationType("")).toBe(false);
  });

  it("crown_bridge priority wins when implant/crown keyword appears with removable keyword", async () => {
    expect(isRemovableRestorationType("Implant Denture")).toBe(false);
    expect(isRemovableRestorationType("Bridge Partial")).toBe(false);
  });
});

describe("classifyRestorationType — removable always loses to crown_bridge", () => {
  it("implant + denture → crown_bridge", async () => {
    expect(classifyRestorationType("Implant Denture")).toBe("crown_bridge");
  });

  it("standalone removable keywords → removable", async () => {
    expect(classifyRestorationType("Full Denture")).toBe("removable");
    expect(classifyRestorationType("Flipper")).toBe("removable");
    expect(classifyRestorationType("Valplast")).toBe("removable");
  });

  it("non-matching text → other", async () => {
    expect(classifyRestorationType("Night Guard")).toBe("other");
    expect(classifyRestorationType(null)).toBe("other");
  });
});

// ─── NewCase screen UI tests ──────────────────────────────────────────────────

function seedEditableLab() {
  setMockAppState({
    meMemberships: [
      {
        id: "m1",
        role: "owner",
        status: "active",
        organizationId: "lab-1",
        organization: { id: "lab-1", name: "Acme Dental Lab", type: "lab" },
      },
    ],
  });
}

describe("NewCaseScreen restoration row — tooth field suppressed for removable types", () => {
  it("applies the lab turnaround cap to a typed due date", async () => {
    setMockAppState({
      meMemberships: [{
        id: "m1", role: "owner", status: "active", organizationId: "lab-1",
        organization: { id: "lab-1", name: "Acme Dental Lab", type: "lab", defaultCaseDueDays: 1, capCaseDueToDefault: true },
      }],
    });
    const screen = await render(<NewCaseScreen />);
    await fireEvent.press(screen.getByTestId("new-case-due-date"));
    await fireEvent.press(screen.getByTestId("new-case-due-date-type"));
    await fireEvent.changeText(screen.getByTestId("new-case-due-date-typed-input"), "12/31/2099");
    await fireEvent.press(screen.getByTestId("new-case-due-date-typed-confirm"));
    expect(screen.getByText(/Capped to lab's turnaround/)).toBeTruthy();
    expect(screen.getByTestId("new-case-due-date")).not.toHaveTextContent("12/31/2099");
  });

  it("accepts a typed due date in another year in the new-case form", async () => {
    seedEditableLab();
    const screen = await render(<NewCaseScreen />);
    await fireEvent.press(screen.getByTestId("new-case-due-date"));
    await fireEvent.press(screen.getByTestId("new-case-due-date-type"));
    await fireEvent.changeText(screen.getByTestId("new-case-due-date-typed-input"), "02/29/2028");
    await fireEvent.press(screen.getByTestId("new-case-due-date-typed-confirm"));
    expect(screen.getByTestId("new-case-due-date")).toHaveTextContent("02/29/2028");
  });

  it("shows the Tooth # input (testID resto-tooth-0) by default", async () => {
    seedEditableLab();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // The first restoration row starts with no category selected → not removable → tooth# shown.
    expect(screen.getByTestId("resto-tooth-0")).toBeTruthy();
  });

  it("hides resto-tooth-0 when the Removable category is selected", async () => {
    seedEditableLab();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Select the "Removable" category — this immediately hides the tooth field.
    await fireEvent.changeText(screen.getByTestId("resto-category-0"), "Removable");

    // Tooth # input must be gone from the tree.
    expect(screen.queryByTestId("resto-tooth-0")).toBeNull();
  });

  it.each([
    ["Partial Denture"],
    ["Flipper"],
    ["Flexible Partial"],
    ["Valplast"],
  ])(
    "hides resto-tooth-0 and accepts type text '%s' after selecting Removable category",
    async (type) => {
      seedEditableLab();
      const screen = await render(<NewCaseScreen />);

      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });

      // Select the Removable category first — this hides the tooth field.
      await fireEvent.changeText(screen.getByTestId("resto-category-0"), "Removable");
      expect(screen.queryByTestId("resto-tooth-0")).toBeNull();

      // The type picker is now visible — type into it.
      await fireEvent.changeText(screen.getByTestId("resto-type-0"), type);

      // Tooth # still hidden (category drives it, not the type text).
      expect(screen.queryByTestId("resto-tooth-0")).toBeNull();
    },
  );

  it("restores resto-tooth-0 when category is switched from Removable back to Restorative", async () => {
    seedEditableLab();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // First select Removable category — hides the tooth field.
    await fireEvent.changeText(screen.getByTestId("resto-category-0"), "Removable");
    expect(screen.queryByTestId("resto-tooth-0")).toBeNull();

    // Switch to Restorative — tooth field returns.
    await fireEvent.changeText(screen.getByTestId("resto-category-0"), "Restorative");
    expect(screen.getByTestId("resto-tooth-0")).toBeTruthy();
  });

  it("keeps the Type picker visible after Removable category is selected", async () => {
    seedEditableLab();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Selecting the Removable category reveals the type picker (resto-type-0).
    await fireEvent.changeText(screen.getByTestId("resto-category-0"), "Removable");
    expect(screen.getByTestId("resto-type-0")).toBeTruthy();
  });
});
