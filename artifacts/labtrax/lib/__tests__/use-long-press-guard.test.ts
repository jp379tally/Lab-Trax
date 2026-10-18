import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react-native";

import { useLongPressGuard } from "@/lib/use-long-press-guard";

describe("useLongPressGuard", () => {
  it("consumes exactly one matching key after markLongPress", async () => {
    const { result } = await renderHook(() => useLongPressGuard<string>());

    result.current.markLongPress("a");

    // The follow-up onPress for the same key is absorbed once.
    expect(result.current.consumeLongPress("a")).toBe(true);

    // A second, unrelated press on the same key is a genuine tap again.
    expect(result.current.consumeLongPress("a")).toBe(false);
  });

  it("can clear an interrupted long press before a later tap", async () => {
    const { result } = await renderHook(() => useLongPressGuard<string>());

    result.current.markLongPress("case-1");
    result.current.resetLongPress();

    expect(result.current.consumeLongPress("case-1")).toBe(false);
  });

  it("does not absorb a press when no long-press was marked", async () => {
    const { result } = await renderHook(() => useLongPressGuard<string>());

    expect(result.current.consumeLongPress("a")).toBe(false);
  });

  it("only absorbs the press for the marked key, not other keys in the same list", async () => {
    const { result } = await renderHook(() => useLongPressGuard<string>());

    result.current.markLongPress("row-1");

    // A different row's tap is unaffected.
    expect(result.current.consumeLongPress("row-2")).toBe(false);
    // The marked row's follow-up press is still absorbed afterwards.
    expect(result.current.consumeLongPress("row-1")).toBe(true);
  });

  it("supports the single-boolean-key pattern used by one-off Pressables (e.g. a lightbox)", async () => {
    const { result } = await renderHook(() => useLongPressGuard());

    result.current.markLongPress(true);
    expect(result.current.consumeLongPress(true)).toBe(true);
    expect(result.current.consumeLongPress(true)).toBe(false);
  });
});
