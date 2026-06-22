/** @vitest-environment jsdom */
/**
 * Integration tests for AiChatPanel's "Load earlier messages" pagination.
 *
 * Invariants protected:
 *  - On mount the panel records the oldest server message id as the paging
 *    cursor and shows the "Load earlier messages" affordance when the server
 *    reports `hasMore: true`.
 *  - Clicking the button fetches the page immediately older than the cursor
 *    (`/ai-chat/history?before=<cursor>&limit=50`) and PREPENDS those messages
 *    above the ones already shown, keeping the welcome message pinned at the top.
 *  - Older rows are de-duplicated by id: a row already on screen (e.g. the cursor
 *    row echoed back) is never rendered twice.
 *  - The affordance disappears once the server reports `hasMore: false`.
 */

import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { AiChatPanel } from "../AiChatPanel";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// ─── Module mocks ─────────────────────────────────────────────────────────────
// apiFetch is the only network surface AiChatPanel uses for history. The handler
// branches on the request url so the mount load and the "load earlier" load
// return different pages.
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock("@/lib/api", () => ({
  apiFetch: apiFetchMock,
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

// jsdom doesn't implement scrollIntoView; stub it so ref effects don't throw.
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

interface SrvMsg {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

function srv(id: string, role: "user" | "assistant", content: string, t: number): SrvMsg {
  return { id, role, content, createdAt: new Date(t).toISOString() };
}

function renderPanel() {
  const Wrapper = makeAuthWrapper();
  return render(<AiChatPanel onClose={() => {}} />, { wrapper: Wrapper });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AiChatPanel — load earlier messages", () => {
  it("prepends the older page above existing messages and keeps welcome on top", async () => {
    // Mount load: newest page (oldest-first), still more older rows available.
    const latestPage = {
      messages: [
        srv("m3", "user", "newest question", 3000),
        srv("m4", "assistant", "newest answer", 4000),
      ],
      hasMore: true,
    };
    // Older page returned when paging before the oldest held id (m3).
    const olderPage = {
      messages: [
        srv("m1", "user", "older question", 1000),
        srv("m2", "assistant", "older answer", 2000),
      ],
      hasMore: false,
    };

    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("before=")) return olderPage;
      return latestPage;
    });

    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // The newest page is shown and the affordance appears.
    await waitFor(() => {
      expect(screen.getByText("newest question")).toBeTruthy();
      expect(screen.getByText("Load earlier messages")).toBeTruthy();
    });

    // Click "Load earlier messages".
    fireEvent.click(screen.getByText("Load earlier messages"));

    // Older messages are now visible, prepended above the newest ones.
    await waitFor(() => {
      expect(screen.getByText("older question")).toBeTruthy();
      expect(screen.getByText("older answer")).toBeTruthy();
    });

    // The cursor request carried the oldest-held id (m3) as `before`.
    const beforeCall = apiFetchMock.mock.calls.find(([u]: [string]) =>
      String(u).includes("before="),
    );
    expect(beforeCall).toBeDefined();
    expect(String(beforeCall![0])).toContain(`before=${encodeURIComponent("m3")}`);

    // hasMore=false on the older page hides the affordance.
    await waitFor(() => {
      expect(screen.queryByText("Load earlier messages")).toBeNull();
    });

    // Welcome message stays pinned at the very top (rendered before older rows).
    const welcomeNode = screen.getAllByText(/Maynard/i)[0]!;
    const olderNode = screen.getByText("older question");
    expect(
      welcomeNode.compareDocumentPosition(olderNode) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("de-duplicates older rows by id so an echoed cursor row is not shown twice", async () => {
    const latestPage = {
      messages: [
        srv("dup", "user", "shared boundary message", 2000),
        srv("m3", "assistant", "newest answer", 3000),
      ],
      hasMore: true,
    };
    // The older page re-includes "dup" (the boundary row) plus one genuinely
    // older row. The component must keep only one copy of "dup".
    const olderPage = {
      messages: [
        srv("m1", "user", "genuinely older", 1000),
        srv("dup", "user", "shared boundary message", 2000),
      ],
      hasMore: false,
    };

    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("before=")) return olderPage;
      return latestPage;
    });

    renderPanel();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    await waitFor(() => {
      expect(screen.getByText("Load earlier messages")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Load earlier messages"));

    await waitFor(() => {
      expect(screen.getByText("genuinely older")).toBeTruthy();
    });

    // The boundary message must appear exactly once despite being in both pages.
    expect(screen.getAllByText("shared boundary message")).toHaveLength(1);
  });
});
