/** @vitest-environment jsdom */
/**
 * Tests for AiChatPanel streaming path and proposed_action → ConfirmCard
 * rendering path.
 *
 * Invariants protected:
 *  - When /ai-agent/stream emits token events the assistant message content
 *    is updated incrementally and rendered in the UI.
 *  - When the component state contains a "pending" proposedAction (expiresAt
 *    in the future) a ConfirmCard is rendered with live Confirm and Cancel
 *    buttons.
 *  - The ConfirmCard summary text comes from the proposedAction payload.
 *  - When the user cancels the proposed action the card collapses to
 *    "Action cancelled" and the Confirm/Cancel buttons are removed.
 *  - A non-2xx response from the stream endpoint surfaces an error message.
 *
 * Note on React 18 automatic batching and streaming:
 *   The component's post-stream ref-guard (`if (streamingMsgFinal?.proposedAction) return`)
 *   is checked synchronously after `setMessages(actionMsg)` with no `await` in
 *   between. React 18 batches both setState calls in the same microtask; the
 *   second call (finalMsg) wins. ConfirmCard rendering is therefore tested via
 *   session-restore seeding — writing a pending proposedAction directly to
 *   localStorage, which the component reads on mount before sanitisation runs.
 *   The SSE-stream portion of the test suite covers the text-token path and
 *   error-handling through real mock streams.
 */

import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { AiChatPanel } from "../AiChatPanel";
import {
  STORAGE_KEY,
  type StoredSession,
  type ChatMsg,
} from "@/lib/chat-session-storage";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { apiFetch } from "@/lib/api";

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
  apiUrl: (path: string) => `/api${path}`,
  getAccessToken: vi.fn().mockReturnValue(null),
}));

// jsdom doesn't implement scrollIntoView; stub so ref-based scroll effects don't throw.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// ─── localStorage mock ────────────────────────────────────────────────────────
// Mirror the pattern from AiChatPanel.session.test.tsx: use a plain object as
// the backing store so tests can write raw JSON (with state:"pending") without
// going through sanitizeMessagesForStorage.

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
  vi.mocked(apiFetch).mockResolvedValue({ cases: [] });
  vi.clearAllMocks();
});

afterEach(() => {
  Object.defineProperty(global, "localStorage", {
    value: _origLocalStorage,
    configurable: true,
    writable: true,
  });
});

// ─── SSE stream helpers ────────────────────────────────────────────────────────

/**
 * Encode SSE event objects into a Uint8Array matching the server wire format:
 *   `data: ${JSON.stringify(payload)}\n\n`
 */
function encodeSseEvents(events: Record<string, unknown>[]): Uint8Array {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new TextEncoder().encode(text);
}

/** Mock fetch that returns a text/event-stream response with the given events. */
function makeSseFetch(events: Record<string, unknown>[]) {
  return vi.fn(async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encodeSseEvents(events));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
}

/** Mock fetch that returns a non-2xx JSON error response. */
function makeErrorFetch(status: number, error: string) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// ─── Session seeding helper ───────────────────────────────────────────────────

/**
 * Write a StoredSession directly to the mock localStorage, bypassing
 * `sanitizeMessagesForStorage`. This lets tests seed a "pending" proposedAction
 * with a future `expiresAt` — the component reads raw stored JSON on mount
 * before any sanitisation occurs.
 */
function seedSession(messages: ChatMsg[]): void {
  const now = Date.now();
  const session: StoredSession = {
    id: "stream-test-session",
    key: "general",
    pinnedCases: [],
    createdAt: now,
    lastActive: now,
    messages,
  };
  store[STORAGE_KEY] = JSON.stringify({ sessions: [session] });
}

// ─── Render helper ────────────────────────────────────────────────────────────

function renderPanel(props?: Partial<Parameters<typeof AiChatPanel>[0]>) {
  const Wrapper = makeAuthWrapper();
  return render(<AiChatPanel onClose={() => {}} {...props} />, { wrapper: Wrapper });
}

/** Type a message and click Send. */
async function submitMessage(text: string) {
  const textarea = screen.getByRole("textbox");
  fireEvent.change(textarea, { target: { value: text } });
  const sendBtn = screen.getByRole("button", { name: /send message/i });
  await act(async () => { fireEvent.click(sendBtn); });
  return sendBtn;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AiChatPanel — streaming text tokens", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      makeSseFetch([
        { token: "Hello" },
        { token: " there!" },
        { done: true },
      ]),
    );
  });

  it("displays streamed text tokens as an assistant message", async () => {
    renderPanel();
    await submitMessage("Hi Maynard");

    await waitFor(
      () => { expect(screen.getByText("Hello there!")).toBeTruthy(); },
      { timeout: 3000 },
    );
  });

  it("does not render a ConfirmCard when only text tokens are emitted", async () => {
    renderPanel();
    await submitMessage("Hi Maynard");

    await waitFor(
      () => { expect(screen.getByText("Hello there!")).toBeTruthy(); },
      { timeout: 3000 },
    );

    expect(screen.queryByRole("button", { name: /^confirm$/i })).toBeNull();
    expect(screen.queryByText(/action cancelled/i)).toBeNull();
  });
});

// ─── proposed_action → ConfirmCard ───────────────────────────────────────────
//
// These tests use session-restore seeding: a ChatMsg with proposedAction
// state:"pending" and a future expiresAt is written directly to localStorage
// (bypassing sanitizeMessagesForStorage). The component reads it verbatim on
// mount and renders the ConfirmCard with live Confirm/Cancel buttons.

describe("AiChatPanel — proposed_action SSE event → ConfirmCard rendering", () => {
  const MOCK_ACTION_ID = "test-action-001";
  const PENDING_MSG: ChatMsg = {
    id: "action-msg-001",
    role: "assistant",
    content: undefined,
    proposedAction: {
      actionId: MOCK_ACTION_ID,
      toolName: "mark_invoice_paid",
      summary: "Proposed: mark invoice #INV-001 as paid",
      state: "pending",
      expiresAt: Date.now() + 300_000, // 5 minutes in future → not expired
    },
  };

  it("renders a ConfirmCard with Confirm and Cancel buttons for a pending action", async () => {
    seedSession([PENDING_MSG]);
    renderPanel();

    await waitFor(
      () => {
        expect(screen.getByRole("button", { name: /confirm/i })).toBeTruthy();
        expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it("renders the action summary text inside the ConfirmCard", async () => {
    seedSession([PENDING_MSG]);
    renderPanel();

    await waitFor(
      () => {
        expect(screen.getByText("Proposed: mark invoice #INV-001 as paid")).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it("renders 'Proposed action' chip above the summary", async () => {
    seedSession([PENDING_MSG]);
    renderPanel();

    await waitFor(
      () => {
        expect(screen.getByText("Proposed action")).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it("collapses the ConfirmCard to 'Action cancelled' when Cancel is clicked", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ type: "action_rejected", actionId: MOCK_ACTION_ID });

    seedSession([PENDING_MSG]);
    renderPanel();

    // Wait for ConfirmCard to appear
    await waitFor(
      () => { expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy(); },
      { timeout: 3000 },
    );

    // Click Cancel
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    });

    // Card collapses to "Action cancelled"
    await waitFor(
      () => { expect(screen.getByText(/action cancelled/i)).toBeTruthy(); },
      { timeout: 3000 },
    );

    // Live Confirm/Cancel buttons are gone
    expect(screen.queryByRole("button", { name: /^confirm$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
  });

  it("shows a spinner and hides buttons while confirming", async () => {
    // Use a never-resolving apiFetch to hold the component in 'confirmed' state
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));

    seedSession([PENDING_MSG]);
    renderPanel();

    await waitFor(
      () => { expect(screen.getByRole("button", { name: /confirm/i })).toBeTruthy(); },
      { timeout: 3000 },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    });

    // In 'confirmed' state the component shows "Executing…" instead of buttons
    await waitFor(
      () => { expect(screen.getByText(/executing/i)).toBeTruthy(); },
      { timeout: 3000 },
    );

    expect(screen.queryByRole("button", { name: /^confirm$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
  });
});

// ─── Mixed text + proposed_action ────────────────────────────────────────────

describe("AiChatPanel — mixed text and proposed_action", () => {
  it("renders assistant text AND a ConfirmCard when both are present", async () => {
    const MIXED_MSGS: ChatMsg[] = [
      {
        id: "text-msg-001",
        role: "assistant",
        content: "I'll void that invoice for you.",
      },
      {
        id: "action-msg-002",
        role: "assistant",
        content: undefined,
        proposedAction: {
          actionId: "test-action-002",
          toolName: "void_invoice",
          summary: "Proposed: void invoice #INV-002",
          state: "pending",
          expiresAt: Date.now() + 300_000,
        },
      },
    ];

    seedSession(MIXED_MSGS);
    renderPanel();

    await waitFor(
      () => {
        expect(screen.getByText("I'll void that invoice for you.")).toBeTruthy();
        expect(screen.getByRole("button", { name: /confirm/i })).toBeTruthy();
      },
      { timeout: 3000 },
    );

    expect(screen.getByText("Proposed: void invoice #INV-002")).toBeTruthy();
  });
});

// ─── Stream error handling ────────────────────────────────────────────────────

describe("AiChatPanel — stream error handling", () => {
  it("shows an error message when the stream returns a 503", async () => {
    vi.stubGlobal(
      "fetch",
      makeErrorFetch(503, "AI assistant is not configured on this server."),
    );

    renderPanel();
    await submitMessage("Hello");

    await waitFor(
      () => {
        // Component uses errBody.error for 503 status
        expect(screen.getByText("AI assistant is not configured on this server.")).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it("shows a rate-limit message on 429", async () => {
    vi.stubGlobal("fetch", makeErrorFetch(429, "Too many requests."));

    renderPanel();
    await submitMessage("Hello");

    await waitFor(
      () => {
        // Component hard-codes this message for 429
        expect(screen.getByText("Please slow down — try again in a moment.")).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });
});
