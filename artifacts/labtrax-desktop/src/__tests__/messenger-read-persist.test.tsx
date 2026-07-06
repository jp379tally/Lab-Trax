/**
 * @vitest-environment jsdom
 *
 * Regression guard: the Messenger unread badge must not re-appear after a
 * message has been read. The unread count is computed server-side from each
 * viewer's conversation_participants.lastReadAt, so the badge only clears
 * permanently when the read state is *durably* persisted on the server.
 *
 * These tests lock in the three client-side gaps that previously left the
 * server unread while the local badge optimistically cleared:
 *
 *   1. Opening a conversation must ALWAYS fire the read POST, even when local
 *      unreadCount is already 0 (it may have been zeroed by an earlier failed
 *      attempt — skipping would strand the server as unread forever).
 *   2. A read POST that fails transiently must be retried, not swallowed.
 *   3. On refresh, a conversation the user already viewed this session that the
 *      server still reports as unread must be reconciled (re-fire read + clear
 *      the badge) — but ONLY when the latest message is the one the user saw,
 *      so a genuinely new message that arrived after the last view stays unread.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

const mockApiFetch = vi.hoisted(() => vi.fn());
const mockSocketSend = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  apiFetch: mockApiFetch,
}));

vi.mock("@/hooks/useMessengerSocket", () => ({
  useMessengerSocket: () => ({ send: mockSocketSend }),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "me", username: "me" } }),
}));

import { MessengerProvider, useMessenger } from "@/context/MessengerContext";

// ── Mutable conversation fixture the apiFetch mock serves ────────────────────

type Conv = {
  id: string;
  lastMessage: { id: string; body: string; senderId: string; createdAt: string } | null;
  unreadCount: number;
  otherUser: { id: string; username: string; initials: string; displayName: string } | null;
};

let convData: Conv[] = [];
let readCalls: string[] = [];
let readBodies: Array<{ conversationId: string; lastMessageId?: string }> = [];
let failReadOnce = false;

function makeConv(overrides: Partial<Conv> = {}): Conv {
  return {
    id: "c1",
    lastMessage: {
      id: "m1",
      body: "hi",
      senderId: "other",
      createdAt: "2024-01-01T00:00:00.000Z",
    },
    unreadCount: 0,
    otherUser: { id: "other", username: "other", initials: "OT", displayName: "Other" },
    ...overrides,
  };
}

function installApiMock() {
  mockApiFetch.mockImplementation(async (endpoint: string, options?: RequestInit) => {
    const method = (options?.method ?? "GET").toUpperCase();
    if (endpoint === "/messenger/conversations" && method === "GET") {
      return convData.map((c) => ({ ...c }));
    }
    const m = endpoint.match(/^\/messenger\/conversations\/(.+)\/read$/);
    if (m && method === "POST") {
      readCalls.push(m[1]!);
      let lastMessageId: string | undefined;
      if (typeof options?.body === "string") {
        try {
          lastMessageId = JSON.parse(options.body).lastMessageId;
        } catch {
          // ignore malformed body
        }
      }
      readBodies.push({ conversationId: m[1]!, lastMessageId });
      if (failReadOnce) {
        failReadOnce = false;
        throw new Error("transient read failure");
      }
      return { ok: true };
    }
    return {};
  });
}

// ── Test harness ─────────────────────────────────────────────────────────────

function Consumer() {
  const { conversations, totalUnread, openConversation, refreshConversations } =
    useMessenger();
  return (
    <div>
      <span data-testid="total">{totalUnread}</span>
      <span data-testid="count">{conversations.length}</span>
      <button data-testid="open" onClick={() => openConversation("c1")}>
        open
      </button>
      <button
        data-testid="refresh"
        onClick={() => {
          void refreshConversations();
        }}
      >
        refresh
      </button>
    </div>
  );
}

function renderHarness() {
  return render(
    React.createElement(
      MessengerProvider,
      null,
      React.createElement(Consumer, null)
    )
  );
}

describe("Messenger read-persist (badge does not re-appear)", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockSocketSend.mockReset();
    convData = [makeConv()];
    readCalls = [];
    readBodies = [];
    failReadOnce = false;
    installApiMock();
  });

  it("sends the viewed lastMessageId in the read POST body on open", async () => {
    convData = [makeConv({ unreadCount: 1 })];
    const { getByTestId } = renderHarness();
    await waitFor(() => expect(getByTestId("count").textContent).toBe("1"));

    fireEvent.click(getByTestId("open"));

    // The durable read must carry the message the user actually saw (m1) so the
    // server never advances last_read_at past a newer, unseen message.
    await waitFor(() =>
      expect(
        readBodies.some((b) => b.conversationId === "c1" && b.lastMessageId === "m1")
      ).toBe(true)
    );
  });

  it("fires the read POST on open even when local unreadCount is already 0", async () => {
    convData = [makeConv({ unreadCount: 0 })];
    const { getByTestId } = renderHarness();

    // Wait for the initial conversations load to populate the context.
    await waitFor(() => expect(getByTestId("count").textContent).toBe("1"));

    fireEvent.click(getByTestId("open"));

    await waitFor(() => expect(readCalls).toContain("c1"));
  });

  it("retries a transient read failure instead of swallowing it", async () => {
    convData = [makeConv({ unreadCount: 1 })];
    failReadOnce = true; // first read POST throws, then succeeds
    const { getByTestId } = renderHarness();

    await waitFor(() => expect(getByTestId("count").textContent).toBe("1"));

    fireEvent.click(getByTestId("open"));

    // First attempt fired and failed; the backoff retry (1s) must fire again.
    await waitFor(
      () => expect(readCalls.filter((id) => id === "c1").length).toBeGreaterThanOrEqual(2),
      { timeout: 4000 }
    );
  }, 8000);

  it("reconciles a server-still-unread conversation the user already viewed", async () => {
    convData = [makeConv({ unreadCount: 0 })];
    const { getByTestId } = renderHarness();
    await waitFor(() => expect(getByTestId("count").textContent).toBe("1"));

    // View it (records viewed lastMessage = m1) and let the open read settle.
    fireEvent.click(getByTestId("open"));
    await waitFor(() => expect(readCalls).toContain("c1"));
    const afterOpen = readCalls.length;

    // Server now wrongly reports it unread again, SAME latest message (m1).
    convData = [makeConv({ unreadCount: 3 })];
    fireEvent.click(getByTestId("refresh"));

    // It re-fires read and optimistically clears the badge.
    await waitFor(() => expect(readCalls.length).toBeGreaterThan(afterOpen));
    await waitFor(() => expect(getByTestId("total").textContent).toBe("0"));
  });

  it("does NOT reconcile (keeps unread) when a newer message arrived after the last view", async () => {
    convData = [makeConv({ unreadCount: 0 })];
    const { getByTestId } = renderHarness();
    await waitFor(() => expect(getByTestId("count").textContent).toBe("1"));

    fireEvent.click(getByTestId("open"));
    await waitFor(() => expect(readCalls).toContain("c1"));
    const afterOpen = readCalls.length;

    // A genuinely new message (m2) arrived; server reports unread with a
    // different latest message id than what the user saw (m1).
    convData = [
      makeConv({
        unreadCount: 1,
        lastMessage: {
          id: "m2",
          body: "new",
          senderId: "other",
          createdAt: "2024-01-02T00:00:00.000Z",
        },
      }),
    ];
    fireEvent.click(getByTestId("refresh"));

    // Badge reflects the genuinely-new unread and no extra read POST fires.
    await waitFor(() => expect(getByTestId("total").textContent).toBe("1"));
    // Give any erroneous reconcile a tick to fire (it must not). The reconcile
    // decision is made synchronously inside refreshConversations, so once the
    // badge shows 1 the decision has already been taken.
    await new Promise((r) => setTimeout(r, 50));
    expect(readCalls.length).toBe(afterOpen);
  });
});
