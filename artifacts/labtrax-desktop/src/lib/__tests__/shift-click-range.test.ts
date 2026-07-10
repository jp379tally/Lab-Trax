import { describe, it, expect, vi } from "vitest";
import {
  computeShiftClickRange,
  shiftKeyFromChangeEvent,
  suppressShiftClickTextSelection,
} from "../shift-click-range";

// ---------------------------------------------------------------------------
// Direct unit coverage for the shared shift-click range-selection helpers used
// by all desktop multi-select lists (Cases, Invoices, Make Deposits, Bank
// Register reconcile worksheet, Doctors merge, Accounts/Customer Center, plus
// Statements / Receive Payments / Deleted Cases). A refactor of these helpers
// could silently break range selection on every screen at once, so the pure
// logic is pinned here in addition to the per-screen integration tests.
// ---------------------------------------------------------------------------

describe("computeShiftClickRange", () => {
  const ids = ["a", "b", "c", "d", "e"] as const;

  it("selects the inclusive range when clicking downward from the anchor", () => {
    expect(computeShiftClickRange(ids, "b", "d")).toEqual(["b", "c", "d"]);
  });

  it("selects the inclusive range when clicking upward from the anchor", () => {
    // Reversed order (anchor after the clicked row) still returns the range in
    // visible order, not reversed.
    expect(computeShiftClickRange(ids, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("includes both endpoints when they are adjacent", () => {
    expect(computeShiftClickRange(ids, "a", "b")).toEqual(["a", "b"]);
  });

  it("spans the whole list from first to last", () => {
    expect(computeShiftClickRange(ids, "a", "e")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("returns null when the anchor equals the clicked row", () => {
    expect(computeShiftClickRange(ids, "c", "c")).toBeNull();
  });

  it("returns null when there is no anchor", () => {
    expect(computeShiftClickRange(ids, null, "c")).toBeNull();
  });

  it("returns null when the anchor is not in the visible list", () => {
    // e.g. the anchor row was filtered out — caller should fall back to a
    // single toggle and reset the anchor.
    expect(computeShiftClickRange(ids, "z", "c")).toBeNull();
  });

  it("returns null when the clicked id is not in the visible list", () => {
    expect(computeShiftClickRange(ids, "b", "z")).toBeNull();
  });

  it("returns null for an empty visible list", () => {
    expect(computeShiftClickRange([], "a", "b")).toBeNull();
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b", "c", "d", "e"];
    const snapshot = [...input];
    computeShiftClickRange(input, "b", "d");
    expect(input).toEqual(snapshot);
  });
});

describe("shiftKeyFromChangeEvent", () => {
  it("returns true when the backing native event has shiftKey set", () => {
    const e = {
      nativeEvent: { shiftKey: true } as unknown as MouseEvent,
    } as React.ChangeEvent<HTMLInputElement>;
    expect(shiftKeyFromChangeEvent(e)).toBe(true);
  });

  it("returns false when the backing native event has shiftKey cleared", () => {
    const e = {
      nativeEvent: { shiftKey: false } as unknown as MouseEvent,
    } as React.ChangeEvent<HTMLInputElement>;
    expect(shiftKeyFromChangeEvent(e)).toBe(false);
  });

  it("returns false when the native event has no shiftKey property", () => {
    const e = {
      nativeEvent: {} as unknown as MouseEvent,
    } as React.ChangeEvent<HTMLInputElement>;
    expect(shiftKeyFromChangeEvent(e)).toBe(false);
  });
});

describe("suppressShiftClickTextSelection", () => {
  it("prevents the default text-selection when shift is held", () => {
    const preventDefault = vi.fn();
    suppressShiftClickTextSelection({
      shiftKey: true,
      preventDefault,
    } as unknown as React.MouseEvent);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("leaves the default behavior alone for a normal click", () => {
    const preventDefault = vi.fn();
    suppressShiftClickTextSelection({
      shiftKey: false,
      preventDefault,
    } as unknown as React.MouseEvent);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
