import { useCallback, useRef } from "react";

/**
 * Guards a `Pressable`'s `onPress` against firing immediately after
 * `onLongPress` on the same element. RN's Pressability still fires the
 * release `onPress` right after `onLongPress` in this app in practice (see
 * the pre-existing `longPressActiveRef` pattern in `app/(tabs)/index.tsx`
 * and `app/(tabs)/dashboard.tsx`), so any `Pressable` that adds a
 * long-press action alongside its existing tap action must guard against
 * that follow-up `onPress` re-running the tap action.
 *
 * Call `markLongPress(key)` at the very top of `onLongPress` and check
 * `consumeLongPress(key)` at the very top of `onPress` — if it returns
 * `true`, this `onPress` is the release-of-a-long-press follow-up and must
 * return immediately without doing anything else.
 *
 * `key` distinguishes which rendered item was long-pressed when one guard
 * is shared across a list (e.g. rendered inside `.map()`), so pressing a
 * *different* item still runs its own tap action normally. For a single,
 * one-off `Pressable` (e.g. a full-screen lightbox), pass the same
 * constant (e.g. `true`) to both calls.
 */
export function useLongPressGuard<T = true>() {
  const activeKeyRef = useRef<T | null>(null);

  const markLongPress = useCallback((key: T): void => {
    activeKeyRef.current = key;
  }, []);

  const consumeLongPress = useCallback((key: T): boolean => {
    if (activeKeyRef.current !== null && activeKeyRef.current === key) {
      activeKeyRef.current = null;
      return true;
    }
    return false;
  }, []);

  const resetLongPress = useCallback((): void => {
    activeKeyRef.current = null;
  }, []);

  return { markLongPress, consumeLongPress, resetLongPress };
}
