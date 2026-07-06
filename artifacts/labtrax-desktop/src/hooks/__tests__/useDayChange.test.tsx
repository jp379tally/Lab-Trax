/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useDayChange } from "@/hooks/useDayChange";

describe("useDayChange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rolls the day key over when a scheduled midnight passes", () => {
    // Just before local midnight.
    vi.setSystemTime(new Date(2026, 6, 6, 23, 59, 0, 0));

    const { result } = renderHook(() => useDayChange());
    const initial = result.current;

    // Advance the clock past midnight, then let the scheduled timer fire.
    act(() => {
      vi.setSystemTime(new Date(2026, 6, 7, 0, 1, 0, 0));
      vi.advanceTimersByTime(2 * 60 * 1000);
    });

    expect(result.current).not.toBe(initial);
  });

  it("rolls the day key over when the window regains focus on a later day", () => {
    vi.setSystemTime(new Date(2026, 6, 6, 23, 59, 0, 0));

    const { result } = renderHook(() => useDayChange());
    const initial = result.current;

    // Simulate the window waking on the next day without the midnight timer
    // having fired (timers can be throttled while the window is hidden).
    act(() => {
      vi.setSystemTime(new Date(2026, 6, 7, 9, 0, 0, 0));
      window.dispatchEvent(new Event("focus"));
    });

    expect(result.current).not.toBe(initial);
  });

  it("rolls the day key over when the tab becomes visible on a later day", () => {
    vi.setSystemTime(new Date(2026, 6, 6, 23, 59, 0, 0));

    const { result } = renderHook(() => useDayChange());
    const initial = result.current;

    act(() => {
      vi.setSystemTime(new Date(2026, 6, 7, 9, 0, 0, 0));
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(result.current).not.toBe(initial);
  });

  it("keeps the same key when the day has not changed", () => {
    vi.setSystemTime(new Date(2026, 6, 6, 8, 0, 0, 0));

    const { result } = renderHook(() => useDayChange());
    const initial = result.current;

    // Advance a few hours, still the same calendar day.
    act(() => {
      vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    });

    expect(result.current).toBe(initial);
  });
});
