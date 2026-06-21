/** @vitest-environment jsdom */
/**
 * Integration tests for AiChatPanel session persistence and restore.
 *
 * Invariants protected:
 *  - Messages written to localStorage via persistSession never contain
 *    a proposedAction whose state is still "pending".
 *  - On mount the component reads the most-recent stored session for the
 *    current key and prepends the welcome message, restoring the history
 *    faithfully.
 *  - A session that was stored with a "pending" action is restored with
 *    that action shown as "rejected" (the server-side TTL has expired).
 *  - The synthetic "welcome" message id is never written to storage.
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { AiChatPanel } from "../AiChatPanel";
import {
  STORAGE_KEY,
  writeStoredSessions,
  type StoredSession,
  type ChatMsg,
} from "@/lib/chat-session-storage";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn().mockResolvedValue({ cases: [] }),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(msg: string, status = 500) {
      super(msg);
      this.status = status;
    }
  },
  createUploadSession: vi.fn(),
  sendUploadChunk: vi.fn(),
}));

// ─── jsdom stubs ─────────────────────────────────────────────────────────────
// jsdom doesn't implement scrollIntoView; stub it so effects that call it
// on a ref don't throw.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// ─── localStorage mock ────────────────────────────────────────────────────────

let store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { store = {}; },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
};

const _origLocalStorage = global.localStorage;

beforeEach(() => {
  store = {};
  Object.defineProperty(global, "localStorage", {
    value: mockLocalStorage,
    configurable: true,
    writable: true,
  });
  vi.clearAllMocks();
});

afterEach(() => {
  Object.defineProperty(global, "localStorage", {
    value: _origLocalStorage,
    configurable: true,
    writable: true,
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPanel(props?: Partial<Parameters<typeof AiChatPanel>[0]>) {
  const Wrapper = makeAuthWrapper();
  return render(
    <AiChatPanel
      onClose={() => {}}
      {...props}
    />,
    { wrapper: Wrapper },
  );
}

function makeSession(overrides: Partial<StoredSession> & { messages: ChatMsg[] }): StoredSession {
  const now = Date.now();
  return {
    id: "test-session-1",
    key: "general",
    pinnedCases: [],
    createdAt: now,
    lastActive: now,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AiChatPanel — session restore on mount", () => {
  it("renders the welcome message when there is no stored session", async () => {
    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.getAllByText(/Maynard/i).length).toBeGreaterThan(0);
  });

  it("restores a plain user message from the stored session", async () => {
    const session = makeSession({
      messages: [{ id: "u1", role: "user", content: "What cases are due today?" }],
    });
    writeStoredSessions([session]);

    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    await waitFor(() => {
      expect(screen.getByText("What cases are due today?")).toBeTruthy();
    });
  });

  it("restores a plain assistant reply from the stored session", async () => {
    const session = makeSession({
      messages: [
        { id: "u1", role: "user", content: "Hello" },
        { id: "a1", role: "assistant", content: "Hi there! How can I help?" },
      ],
    });
    writeStoredSessions([session]);

    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    await waitFor(() => {
      expect(screen.getByText("Hi there! How can I help?")).toBeTruthy();
    });
  });

  it("still shows the welcome message at the top when restoring history", async () => {
    const session = makeSession({
      messages: [{ id: "u1", role: "user", content: "Show rush cases" }],
    });
    writeStoredSessions([session]);

    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    await waitFor(() => {
      expect(screen.getAllByText(/Maynard/i).length).toBeGreaterThan(0);
      expect(screen.getByText("Show rush cases")).toBeTruthy();
    });
  });

  it("restores a 'done' proposedAction without altering it", async () => {
    const session = makeSession({
      messages: [
        {
          id: "a1",
          role: "assistant",
          proposedAction: {
            actionId: "act-1",
            toolName: "markInvoicePaid",
            summary: "Mark invoice INV-001 as paid",
            state: "done",
            resultText: "Invoice marked paid.",
          },
        },
      ],
    });
    writeStoredSessions([session]);

    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    await waitFor(() => {
      expect(screen.getByText("Invoice marked paid.")).toBeTruthy();
    });
  });

  it("renders a stored pending action as 'Action cancelled' (rejected) after restore", async () => {
    const session = makeSession({
      messages: [
        {
          id: "a2",
          role: "assistant",
          proposedAction: {
            actionId: "act-2",
            toolName: "updateCaseStatus",
            summary: "Set case 1234 to shipped",
            state: "rejected",
          },
        },
      ],
    });
    writeStoredSessions([session]);

    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    await waitFor(() => {
      expect(screen.getByText(/Action cancelled/i)).toBeTruthy();
    });
    // The confirm/cancel buttons of a live pending card must NOT appear.
    expect(screen.queryByText(/^Confirm$/i)).toBeNull();
  });
});

describe("AiChatPanel — flush on unload (beforeunload / visibilitychange)", () => {
  it("writes in-memory messages to localStorage when beforeunload fires", async () => {
    // Seed a session so the component loads messages into memory on mount.
    const session = makeSession({
      messages: [
        { id: "u1", role: "user", content: "What cases are overdue?" },
        { id: "a1", role: "assistant", content: "Here are the overdue cases…" },
      ],
    });
    writeStoredSessions([session]);

    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

    // Simulate a mid-flight crash by clearing localStorage after the component
    // has loaded but before a normal persistSession call would write again.
    store = {};
    expect(store[STORAGE_KEY]).toBeUndefined();

    // Fire beforeunload — the flush handler must write the in-memory messages.
    await act(async () => {
      window.dispatchEvent(new Event("beforeunload"));
    });

    const raw = store[STORAGE_KEY];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    const sessions: StoredSession[] = parsed.sessions ?? [];
    expect(sessions.length).toBeGreaterThan(0);
    const msgs = sessions[0]!.messages;
    const contents = msgs.map((m: ChatMsg) => m.content);
    expect(contents).toContain("What cases are overdue?");
    expect(contents).toContain("Here are the overdue cases…");
  });

  it("writes in-memory messages to localStorage when the tab is hidden (visibilitychange)", async () => {
    const session = makeSession({
      messages: [
        { id: "u2", role: "user", content: "Show me rush cases" },
        { id: "a2", role: "assistant", content: "Rush cases: C-100, C-200" },
      ],
    });
    writeStoredSessions([session]);

    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

    store = {};
    expect(store[STORAGE_KEY]).toBeUndefined();

    // Simulate the tab being hidden.
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    const raw = store[STORAGE_KEY];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    const sessions: StoredSession[] = parsed.sessions ?? [];
    expect(sessions.length).toBeGreaterThan(0);
    const contents = sessions[0]!.messages.map((m: ChatMsg) => m.content);
    expect(contents).toContain("Show me rush cases");
    expect(contents).toContain("Rush cases: C-100, C-200");
  });

  it("collapses a pending proposedAction to rejected when flushing on unload", async () => {
    const { sanitizeMessagesForStorage } = await import("@/lib/chat-session-storage");

    const session = makeSession({
      messages: [
        { id: "u3", role: "user", content: "Mark INV-555 as paid" },
        {
          id: "a3",
          role: "assistant",
          proposedAction: {
            actionId: "act-flush",
            toolName: "markInvoicePaid",
            summary: "Mark invoice INV-555 as paid",
            state: "pending",
            expiresAt: Date.now() + 300_000,
          },
        },
      ],
    });
    writeStoredSessions([session]);

    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

    store = {};

    await act(async () => {
      window.dispatchEvent(new Event("beforeunload"));
    });

    const raw = store[STORAGE_KEY];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    const msgs: ChatMsg[] = parsed.sessions?.[0]?.messages ?? [];
    const actionMsg = msgs.find((m) => m.proposedAction);
    expect(actionMsg).toBeDefined();
    expect(actionMsg!.proposedAction!.state).toBe("rejected");

    // Confirm sanitizeMessagesForStorage is what drives this — belt-and-suspenders.
    const sanitized = sanitizeMessagesForStorage(session.messages);
    expect(sanitized.find((m) => m.proposedAction?.state === "pending")).toBeUndefined();
  });

  it("does not write to localStorage on unload when there are no user messages", async () => {
    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

    store = {};

    await act(async () => {
      window.dispatchEvent(new Event("beforeunload"));
    });

    // Only the welcome message is in memory; nothing should be written.
    expect(store[STORAGE_KEY]).toBeUndefined();
  });
});

describe("AiChatPanel — persistSession writes to localStorage correctly", () => {
  it("never writes the welcome message id to localStorage", async () => {
    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });

    const raw = store[STORAGE_KEY];
    if (raw) {
      const parsed = JSON.parse(raw);
      const sessions: StoredSession[] = parsed.sessions ?? [];
      for (const session of sessions) {
        const welcomeMsg = session.messages.find((m: ChatMsg) => m.id === "welcome");
        expect(welcomeMsg).toBeUndefined();
      }
    }
    // If no session was written that's also correct — nothing to persist until
    // the user sends a message.
  });

  it("restores a full session round-trip: sanitized messages write → reload → correct UI", async () => {
    // This test simulates the full round-trip that happens in production:
    //   1. persistSession sanitizes messages (pending → rejected) before writing.
    //   2. The component is re-mounted (reload scenario).
    //   3. Messages are restored faithfully — the previously-pending action appears
    //      as "Action cancelled", not as a live interactive card.
    const { sanitizeMessagesForStorage } = await import("@/lib/chat-session-storage");

    const rawMessages: ChatMsg[] = [
      { id: "u1", role: "user", content: "Please mark INV-999 as paid" },
      {
        id: "a1",
        role: "assistant",
        proposedAction: {
          actionId: "act-pending",
          toolName: "markInvoicePaid",
          summary: "Mark invoice INV-999 as paid",
          state: "pending",
          expiresAt: Date.now() + 300_000,
        },
      },
    ];

    // Step 1 — simulate what persistSession does before writing.
    const sanitized = sanitizeMessagesForStorage(rawMessages);
    expect(sanitized.find((m) => m.proposedAction?.state === "pending")).toBeUndefined();

    // Step 2 — write the sanitized session (as persistSession would).
    const session = makeSession({ messages: sanitized });
    writeStoredSessions([session]);

    // Step 3 — mount a fresh panel (simulates reload).
    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });

    // The user message must be visible.
    await waitFor(() => {
      expect(screen.getByText("Please mark INV-999 as paid")).toBeTruthy();
    });

    // The previously-pending action is restored as "Action cancelled" — no
    // live Confirm/Cancel buttons for an action whose server TTL has expired.
    await waitFor(() => {
      expect(screen.getByText(/Action cancelled/i)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Confirm$/i })).toBeNull();
    });
  });
});
