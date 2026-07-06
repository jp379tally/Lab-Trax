import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

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
 * because the app resumed from the background on a later day.
 *
 * Screens that render relative date labels ("Created today", "Due tomorrow",
 * "Overdue") depend on this value so those labels stay accurate without a
 * manual refresh. Include it in `useMemo` deps for any derived list that reads
 * the current day (e.g. "due soon" filtering).
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

    // When the app returns to the foreground, the midnight timer may not have
    // fired (background timers are unreliable / suspended on native). Re-check
    // the day and re-arm the timer so a resume on a later day rolls over.
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") {
        refreshDay();
        scheduleMidnight();
      }
    });

    return () => {
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, []);

  return dayKey;
}
