/** @vitest-environment jsdom */
/**
 * Unit tests for useColumnWidths — specifically the fitColumn method.
 *
 * Invariants protected:
 *  - fitColumn stores the provided width (clamped to MIN_WIDTH) at the correct
 *    column index.
 *  - fitColumn rejects values below MIN_WIDTH (48) and clamps them up.
 *  - fitColumn persists the updated widths array to localStorage (debounced).
 *  - fitColumn is distinct from resetColumn: it stores the measured width,
 *    not the column default.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useColumnWidths } from "@/hooks/useColumnWidths";

// ---------------------------------------------------------------------------
// localStorage stub
// ---------------------------------------------------------------------------

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { Object.keys(store).forEach((k) => delete store[k]); }),
};

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    value: localStorageMock,
    writable: true,
    configurable: true,
  });
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  localStorageMock.removeItem.mockClear();
  localStorageMock.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Mirrors FINANCE_COL_DEFAULTS from register.tsx
const DEFAULTS = [90, 70, 160, 150, 100, 100, 110];
const _STORAGE_KEY = "test-finance-col-widths"; // reserved for future storage-key scoping tests

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useColumnWidths.fitColumn", () => {
  it("sets the indexed column width to the supplied value", () => {
    const { result } = renderHook(() => useColumnWidths(DEFAULTS, null));

    act(() => { result.current.fitColumn(0, 200); });

    expect(result.current.widths[0]).toBe(200);
  });

  it("clamps values below MIN_WIDTH (48) up to 48", () => {
    const { result } = renderHook(() => useColumnWidths(DEFAULTS, null));

    act(() => { result.current.fitColumn(2, 10); });

    expect(result.current.widths[2]).toBe(48);
  });

  it("accepts exactly MIN_WIDTH", () => {
    const { result } = renderHook(() => useColumnWidths(DEFAULTS, null));

    act(() => { result.current.fitColumn(1, 48); });

    expect(result.current.widths[1]).toBe(48);
  });

  it("leaves other column widths unchanged", () => {
    const { result } = renderHook(() => useColumnWidths(DEFAULTS, null));

    act(() => { result.current.fitColumn(0, 200); });

    // Indices 1–6 must be untouched.
    DEFAULTS.slice(1).forEach((def, i) => {
      expect(result.current.widths[i + 1]).toBe(def);
    });
  });

  it("updates totalWidth to reflect the fitted column", () => {
    const { result } = renderHook(() => useColumnWidths(DEFAULTS, null));
    const originalTotal = result.current.totalWidth;

    act(() => { result.current.fitColumn(0, 200); });

    // 200 – 90 (original col-0 default) = +110
    expect(result.current.totalWidth).toBe(originalTotal + (200 - DEFAULTS[0]));
  });

  it("persists the updated widths array after the debounce", () => {
    const { result } = renderHook(() => useColumnWidths(DEFAULTS, null));

    act(() => { result.current.fitColumn(0, 200); });

    // Debounce has not fired yet.
    expect(localStorageMock.setItem).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(200); });

    const saved = JSON.parse(
      localStorageMock.setItem.mock.calls[0][1] as string,
    ) as number[];
    expect(saved[0]).toBe(200);
    // Other slots must be preserved.
    expect(saved[1]).toBe(DEFAULTS[1]);
  });

  it("stores a clamped value in localStorage when the width is below MIN_WIDTH", () => {
    const { result } = renderHook(() => useColumnWidths(DEFAULTS, null));

    act(() => { result.current.fitColumn(3, 5); });
    act(() => { vi.advanceTimersByTime(200); });

    const saved = JSON.parse(
      localStorageMock.setItem.mock.calls[0][1] as string,
    ) as number[];
    expect(saved[3]).toBe(48);
  });

  it("scopes the storage key by userId when provided", () => {
    const { result } = renderHook(() => useColumnWidths(DEFAULTS, "user-42"));

    act(() => { result.current.fitColumn(0, 150); });
    act(() => { vi.advanceTimersByTime(200); });

    const [savedKey] = localStorageMock.setItem.mock.calls[0] as [string, string];
    expect(savedKey).toContain("user-42");
  });

  it("produces a different result than resetColumn when the measured width differs from the default", () => {
    const { result } = renderHook(() => useColumnWidths(DEFAULTS, null));

    act(() => { result.current.fitColumn(0, 200); });
    const afterFit = result.current.widths[0];

    act(() => { result.current.resetColumn(0); });
    const afterReset = result.current.widths[0];

    expect(afterFit).toBe(200);
    expect(afterReset).toBe(DEFAULTS[0]); // 90
    expect(afterFit).not.toBe(afterReset);
  });
});
