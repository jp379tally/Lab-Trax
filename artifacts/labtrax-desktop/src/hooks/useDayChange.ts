import { useEffect, useRef, useState } from "react";

/**
 * Returns a key that is stable within a local calendar day and changes when the
 * day rolls over. The month component is 0-based (from `getMonth()`); the value
 * is only ever compared for equality, never parsed, so the numbering is
 * irrelevant to callers.
 */
function localDayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

/** Milliseconds from `now` until the next local midnight (always > 0). */
function msUntilNextMidnight(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1, next.getTime() - now.getTime());
}

/**
 * Returns a key that changes whenever the local calendar day rolls over —
 * either because a scheduled midnight timer fired while the app was open, or
 * because the window regained focus / became visible again on a later day.
 *
 * Surfaces that render relative date labels ("Created today", "Due today",
 * "Overdue") depend on this value so those labels stay accurate without a
 * manual refresh. A desktop app is typically left open for days, so include
 * this value in `useMemo` deps for any derived list that reads the current day
 * (e.g. "due today" filtering) and reference it in the render so the component
 * re-renders on rollover.
 *
 * Web/Electron analogue of the mobile `useDayChange` hook: it uses a midnight
 * timer plus `document` visibilitychange and window focus instead of React
 * Native's AppState, because background timers can be throttled or suspended
 * while the window is hidden/minimized.
 */
export function useDayChange(): string {
  const [dayKey, setDayKey] = useState<string>(() => localDayKey());
  const dayKeyRef = useRef(dayKey);
  dayKeyRef.current = dayKey;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Re-check the current day; update state only when it actually changed so
    // we don't force needless re-renders.
    function refreshDay() {
      const next = localDayKey();
      if (next !== dayKeyRef.current) {
        setDayKey(next);
      }
    }

    // Schedule a one-shot timer for the next local midnight, then reschedule.
    function scheduleMidnight() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        refreshDay();
        scheduleMidnight();
      }, msUntilNextMidnight());
    }

    scheduleMidnight();

    // While the window is hidden/minimized the midnight timer may be throttled
    // or may not fire. When the window becomes visible or regains focus,
    // re-check the day and re-arm the timer so a wake on a later day rolls over.
    function handleWake() {
      refreshDay();
      scheduleMidnight();
    }
    function handleVisibility() {
      if (document.visibilityState === "visible") {
        handleWake();
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleWake);

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleWake);
    };
  }, []);

  return dayKey;
}
