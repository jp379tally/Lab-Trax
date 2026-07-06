import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";

import { useDayChange } from "@/hooks/useDayChange";

describe("useDayChange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (AppState.addEventListener as ReturnType<typeof vi.fn>).mockClear();
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

  it("rolls the day key over when the app resumes on a later day", () => {
    vi.setSystemTime(new Date(2026, 6, 6, 23, 59, 0, 0));

    const { result } = renderHook(() => useDayChange());
    const initial = result.current;

    // Grab the AppState "change" listener the hook registered.
    const addEventListener = AppState.addEventListener as ReturnType<typeof vi.fn>;
    const handler = addEventListener.mock.calls.at(-1)?.[1] as (state: string) => void;
    expect(typeof handler).toBe("function");

    // Simulate resuming from the background on the next day without the
    // midnight timer having fired (native timers are suspended in background).
    act(() => {
      vi.setSystemTime(new Date(2026, 6, 7, 9, 0, 0, 0));
      handler("active");
    });

    expect(result.current).not.toBe(initial);
  });

  it("keeps the same key when the day has not changed", () => {
    vi.setSystemTime(new Date(2026, 6, 6, 8, 0, 0, 0));

    const { result } = renderHook(() => useDayChange());
    const initial = result.current;

    // Advance a few hours, still the same calendar day.
    vi.advanceTimersByTime(3 * 60 * 60 * 1000);

    expect(result.current).toBe(initial);
  });
});
