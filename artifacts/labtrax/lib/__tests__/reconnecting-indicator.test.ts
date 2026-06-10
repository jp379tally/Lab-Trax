// Tests for the "Reconnecting…" indicator — task #1435.
//
// Two layers are tested independently:
//   1. The listener mechanism in query-client (does it fire true/false?)
//   2. The 400ms delay timer via createReconnectingTracker (is the banner
//      suppressed for fast refreshes?)
//
// The real query-client module is required (vi.unmock) so refresh calls
// exercise the actual _reconnectingListener wiring.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setMockFetchHandler, resetMockFetchHandler } from "../../vitest.setup";

vi.unmock("@/lib/query-client");
import {
  setReconnectingListener,
  createReconnectingTracker,
  saveTokens,
  clearTokens,
  resilientFetch,
} from "@/lib/query-client";
import * as SecureStore from "expo-secure-store";

function tokenBlob(accessToken: string | null, refreshToken: string): string {
  return JSON.stringify({ accessToken, refreshToken });
}
function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  await clearTokens();
  setReconnectingListener(null);
  vi.mocked(SecureStore.getItemAsync).mockReset();
  vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  vi.mocked(SecureStore.setItemAsync).mockReset();
  vi.mocked(SecureStore.setItemAsync).mockResolvedValue(undefined);
  vi.mocked(SecureStore.deleteItemAsync).mockReset();
  vi.mocked(SecureStore.deleteItemAsync).mockResolvedValue(undefined);
});

afterEach(() => {
  resetMockFetchHandler();
  setReconnectingListener(null);
});

// ── Listener mechanism (query-client level) ───────────────────────────────

describe("reconnecting listener in query-client", () => {
  it("fires (true) when a refresh starts and (false) when it succeeds", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob(null, "refresh-token"),
    );
    setMockFetchHandler((url) => {
      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ data: { accessToken: "new-access", refreshToken: "new-refresh" } });
      }
      return jsonOk({ user: { id: "1" } });
    });

    const calls: boolean[] = [];
    setReconnectingListener((active) => calls.push(active));

    await resilientFetch("/api/auth/me");

    expect(calls).toEqual([true, false]);
  });

  it("fires (true) then (false) when the refresh request fails", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob(null, "bad-refresh"),
    );
    setMockFetchHandler((url) => {
      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ error: "invalid_token" }, 401);
      }
      return jsonOk({});
    });

    const calls: boolean[] = [];
    setReconnectingListener((active) => calls.push(active));

    // clearTokens is called internally on a failed refresh, so the next
    // resilientFetch has no bearer and throws "Not authenticated".
    try { await resilientFetch("/api/auth/me"); } catch { /* expected */ }

    // Regardless of how the auth path resolves, the listener must clear.
    expect(calls[0]).toBe(true);
    expect(calls.at(-1)).toBe(false);
  });

  it("fires the listener exactly once for concurrent callers (deduplication)", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob(null, "refresh-token"),
    );
    setMockFetchHandler((url) => {
      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ data: { accessToken: "new-access", refreshToken: "new-refresh" } });
      }
      return jsonOk({ user: { id: "1" } });
    });

    const calls: boolean[] = [];
    setReconnectingListener((active) => calls.push(active));

    await Promise.all([
      resilientFetch("/api/auth/me"),
      resilientFetch("/api/auth/me"),
      resilientFetch("/api/auth/me"),
    ]);

    // Three concurrent callers share one refresh promise — listener fires once.
    expect(calls.filter((v) => v === true)).toHaveLength(1);
    expect(calls.filter((v) => v === false)).toHaveLength(1);
  });

  it("does not fire the listener for requests that don't need a refresh", async () => {
    await saveTokens("valid-access", "valid-refresh");
    setMockFetchHandler(() => jsonOk({ user: { id: "1" } }));

    const calls: boolean[] = [];
    setReconnectingListener((active) => calls.push(active));

    await resilientFetch("/api/auth/me");

    expect(calls).toHaveLength(0);
  });

  it("keeps working after listener is replaced mid-session", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob(null, "refresh-token"),
    );
    setMockFetchHandler((url) => {
      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ data: { accessToken: "new-access", refreshToken: "new-refresh" } });
      }
      return jsonOk({ user: { id: "1" } });
    });

    const first: boolean[] = [];
    setReconnectingListener((active) => first.push(active));

    await resilientFetch("/api/auth/me");
    expect(first).toEqual([true, false]);

    // Replace listener; subsequent refreshes should use the new one.
    await clearTokens();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob(null, "refresh-token-2"),
    );

    const second: boolean[] = [];
    setReconnectingListener((active) => second.push(active));

    await resilientFetch("/api/auth/me");
    expect(second).toEqual([true, false]);
    expect(first).toHaveLength(2); // first listener untouched after replacement
  });
});

// ── Delay timer logic (createReconnectingTracker) ─────────────────────────

describe("createReconnectingTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not signal reconnecting for fast refreshes (< 400ms)", () => {
    vi.useFakeTimers();
    const setState = vi.fn();
    const tracker = createReconnectingTracker(setState);

    tracker.start();
    vi.advanceTimersByTime(300); // under threshold
    tracker.end();

    expect(setState).not.toHaveBeenCalledWith(true);
    expect(setState).toHaveBeenCalledWith(false);
  });

  it("signals reconnecting for slow refreshes (>= 400ms)", () => {
    vi.useFakeTimers();
    const setState = vi.fn();
    const tracker = createReconnectingTracker(setState);

    tracker.start();
    vi.advanceTimersByTime(400); // threshold fires

    expect(setState).toHaveBeenCalledWith(true);

    tracker.end();
    expect(setState).toHaveBeenLastCalledWith(false);
  });

  it("clears the indicator after a successful refresh", () => {
    vi.useFakeTimers();
    const setState = vi.fn();
    const tracker = createReconnectingTracker(setState);

    tracker.start();
    vi.advanceTimersByTime(500); // indicator shown
    expect(setState).toHaveBeenCalledWith(true);

    tracker.end(); // success clears it
    expect(setState).toHaveBeenLastCalledWith(false);
  });

  it("clears the indicator after a failed refresh", () => {
    vi.useFakeTimers();
    const setState = vi.fn();
    const tracker = createReconnectingTracker(setState);

    tracker.start();
    vi.advanceTimersByTime(500); // indicator shown

    tracker.end(); // failure path also calls end()
    expect(setState).toHaveBeenLastCalledWith(false);
  });

  it("cancels the pending timer when end() is called before 400ms", () => {
    vi.useFakeTimers();
    const setState = vi.fn();
    const tracker = createReconnectingTracker(setState);

    tracker.start();
    vi.advanceTimersByTime(300);
    tracker.end(); // cancel before the threshold fires

    vi.advanceTimersByTime(200); // would have fired — timer must be cleared

    expect(setState).not.toHaveBeenCalledWith(true);
    expect(setState).toHaveBeenCalledWith(false);
  });
});

// ── Protected requests still honour hydration with a listener registered ──

describe("resilientFetch hydration with reconnecting listener active", () => {
  it("awaits a token refresh and succeeds when a listener is registered", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob(null, "valid-refresh"),
    );
    setMockFetchHandler((url) => {
      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ data: { accessToken: "fresh-token", refreshToken: "new-refresh" } });
      }
      return jsonOk({ user: { id: "42" } });
    });

    setReconnectingListener(() => {}); // listener must not break the fetch

    const res = await resilientFetch("/api/auth/me");
    expect(res.ok).toBe(true);
  });
});
