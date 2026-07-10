/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const refreshSpy = vi.fn(async () => true);

vi.mock("@/lib/api", () => ({
  getAccessToken: () => "token-abc",
  getApiOrigin: () => "http://localhost",
  refreshAccessTokenNow: () => refreshSpy(),
}));

const instances: MockWebSocket[] = [];

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = MockWebSocket;

// Big enough to fire whichever reconnect timer is currently pending (post-refresh
// 300ms, or exponential backoff capped at 30s). Only one timer is ever pending.
const FLUSH_MS = 60_000;

async function useMessengerSocketHook() {
  return await import("@/hooks/useMessengerSocket");
}

describe("useMessengerSocket auth-failure handling", () => {
  beforeEach(() => {
    instances.length = 0;
    refreshSpy.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("refreshes the token once, then backs off and finally stops reconnecting", async () => {
    const { useMessengerSocket } = await useMessengerSocketHook();
    const { unmount } = renderHook(() => useMessengerSocket(() => {}, true));

    expect(instances.length).toBe(1);

    // Close #1 without ever opening → auth-suspect: refresh once, then reconnect.
    instances[instances.length - 1].simulateClose();
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(instances.length).toBe(2);

    // Closes #2..#6 keep failing without opening → exponential backoff, but the
    // token is NOT refreshed again for the same streak.
    for (let i = 0; i < 5; i++) {
      instances[instances.length - 1].simulateClose();
      await vi.advanceTimersByTimeAsync(FLUSH_MS);
    }
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(instances.length).toBe(7);

    // Close #7 exceeds the cap → give up, no further reconnect.
    instances[instances.length - 1].simulateClose();
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(instances.length).toBe(7);

    unmount();
  });

  it("reconnects indefinitely on transient drops after a healthy open (no give-up)", async () => {
    const { useMessengerSocket } = await useMessengerSocketHook();
    const { unmount } = renderHook(() => useMessengerSocket(() => {}, true));

    // Many healthy open→drop cycles, well past the auth-failure cap, must never
    // stop reconnecting and must never trigger a token refresh.
    for (let i = 0; i < 10; i++) {
      const ws = instances[instances.length - 1];
      ws.simulateOpen();
      ws.simulateClose();
      await vi.advanceTimersByTimeAsync(FLUSH_MS);
    }

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(instances.length).toBe(11);

    unmount();
  });

  it("recovers after the give-up cap when the network comes back online", async () => {
    const { useMessengerSocket } = await useMessengerSocketHook();
    const { unmount } = renderHook(() => useMessengerSocket(() => {}, true));

    // Drive a run of never-opened closes (transient outage) past the cap so the
    // hook gives up reconnecting.
    for (let i = 0; i < 8; i++) {
      instances[instances.length - 1].simulateClose();
      await vi.advanceTimersByTimeAsync(FLUSH_MS);
    }
    const countAtGiveUp = instances.length;
    // Confirm it has stopped: another close produces no further reconnect.
    instances[instances.length - 1].simulateClose();
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(instances.length).toBe(countAtGiveUp);

    // Network returns → the browser fires "online" → reconnect immediately.
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(instances.length).toBe(countAtGiveUp + 1);

    unmount();
  });
});
