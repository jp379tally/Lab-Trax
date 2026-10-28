/** @vitest-environment jsdom */
/**
 * Unit tests for useTableColumns — specifically the fitColumn method.
 *
 * Invariants protected:
 *  - fitColumn stores the provided width (clamped to MIN_WIDTH) in state.
 *  - fitColumn rejects values below MIN_WIDTH and clamps them up to 48.
 *  - fitColumn persists the updated widths to localStorage (debounced).
 *  - fitColumn is distinct from resetWidth: it stores the measured width,
 *    not the column's defaultWidth.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTableColumns, type ColumnDef } from "@/hooks/useTableColumns";

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

const STORAGE_KEY = "test-table-cols";

const defs: ColumnDef<{ id: string }>[] = [
  { id: "name",   label: "Name",   menuLabel: "Name",   defaultWidth: 120, render: (r) => r.id },
  { id: "status", label: "Status", menuLabel: "Status", defaultWidth: 80,  render: (r) => r.id },
  { id: "date",   label: "Date",   menuLabel: "Date",   defaultWidth: 100, render: (r) => r.id },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useTableColumns.fitColumn", () => {
  it("sets the column width to the supplied value", () => {
    const { result } = renderHook(() => useTableColumns(defs, STORAGE_KEY));

    act(() => { result.current.fitColumn("name", 200); });

    expect(result.current.getWidth("name")).toBe(200);
  });

  it("clamps values below MIN_WIDTH (48) up to 48", () => {
    const { result } = renderHook(() => useTableColumns(defs, STORAGE_KEY));

    act(() => { result.current.fitColumn("status", 10); });

    expect(result.current.getWidth("status")).toBe(48);
  });

  it("accepts exactly MIN_WIDTH", () => {
    const { result } = renderHook(() => useTableColumns(defs, STORAGE_KEY));

    act(() => { result.current.fitColumn("date", 48); });

    expect(result.current.getWidth("date")).toBe(48);
  });

  it("leaves other column widths unchanged", () => {
    const { result } = renderHook(() => useTableColumns(defs, STORAGE_KEY));

    const beforeStatus = result.current.getWidth("status");
    act(() => { result.current.fitColumn("name", 160); });

    expect(result.current.getWidth("status")).toBe(beforeStatus);
    expect(result.current.getWidth("date")).toBe(100);
  });

  it("persists the updated widths to localStorage after the debounce", () => {
    const { result } = renderHook(() => useTableColumns(defs, STORAGE_KEY));

    act(() => { result.current.fitColumn("name", 200); });

    // Debounce has not fired yet.
    expect(localStorageMock.setItem).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(200); });

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      expect.stringContaining('"name":200'),
    );
  });

  it("stores a clamped value in localStorage when the width is below MIN_WIDTH", () => {
    const { result } = renderHook(() => useTableColumns(defs, STORAGE_KEY));

    act(() => { result.current.fitColumn("status", 5); });
    act(() => { vi.advanceTimersByTime(200); });

    const saved = JSON.parse(localStorageMock.setItem.mock.calls[0][1] as string) as {
      widths: Record<string, number>;
    };
    expect(saved.widths.status).toBe(48);
  });

  it("produces a different result than resetWidth when the measured width differs from the default", () => {
    const { result } = renderHook(() => useTableColumns(defs, STORAGE_KEY));

    // Default for "name" is 120. fitColumn with 200 should differ.
    act(() => { result.current.fitColumn("name", 200); });
    const afterFit = result.current.getWidth("name");

    act(() => { result.current.resetWidth("name"); });
    const afterReset = result.current.getWidth("name");

    expect(afterFit).toBe(200);
    expect(afterReset).toBe(120); // default
    expect(afterFit).not.toBe(afterReset);
  });

  it("can be called for all visible columns independently", () => {
    const { result } = renderHook(() => useTableColumns(defs, STORAGE_KEY));

    act(() => {
      result.current.fitColumn("name", 180);
      result.current.fitColumn("status", 60);
      result.current.fitColumn("date", 90);
    });

    expect(result.current.getWidth("name")).toBe(180);
    expect(result.current.getWidth("status")).toBe(60);
    expect(result.current.getWidth("date")).toBe(90);
  });
});

describe("useTableColumns persisted preferences", () => {
  it("restores a hidden column after the hook is remounted", () => {
    const firstLaunch = renderHook(() => useTableColumns(defs, STORAGE_KEY));

    act(() => { firstLaunch.result.current.toggleColumn("status"); });
    act(() => { vi.advanceTimersByTime(200); });
    firstLaunch.unmount();

    const nextLaunch = renderHook(() => useTableColumns(defs, STORAGE_KEY));

    expect(nextLaunch.result.current.state.hidden).toContain("status");
    expect(nextLaunch.result.current.visible.map((column) => column.id))
      .not.toContain("status");
  });
});
