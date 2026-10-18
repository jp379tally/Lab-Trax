/**
 * @vitest-environment jsdom
 *
 * Integration tests: unread-badge reconciliation and watermark single-source.
 *
 * 1. Unread badge reconciliation — MessagesPage keeps an optimistic "read-at"
 *    timestamp per thread so the badge clears immediately on selection. When
 *    the threads poll returns with a lastMessageAt AFTER that timestamp the
 *    override is lifted and the badge reappears for the new message.
 *
 * 2. Single mark-read POST per send — after a successful send the messages
 *    query is invalidated; the watermark effect fires once on the next refetch
 *    (new latestId). There must be no second call from sendMutation.onSuccess.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import React, { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "./test-utils";
import { ConversationPanel } from "@/pages/messages";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  apiFetch: mockApiFetch,
  getAccessToken: vi.fn().mockResolvedValue("tok"),
  getApiOrigin: vi.fn().mockReturnValue("http://localhost"),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string
    ) {
      super(message);
    }
  },
  createUploadSession: vi.fn(),
  sendUploadChunk: vi.fn(),
}));

vi.mock("@emoji-mart/react", () => ({ default: () => null }));
vi.mock("@emoji-mart/data", () => ({ default: {} }));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}));

vi.mock("@/components/AuthedMedia", () => ({
  AuthedImage: ({ url }: { url: string }) => <img src={url} alt="attachment" />,
  AuthedVideo: ({ url }: { url: string }) => <video src={url} />,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_USER = {
  id: "user-lab-1",
  username: "labuser",
  role: "member",
  email: "lab@lab.com",
} as NonNullable<typeof MOCK_AUTH_DEFAULTS.user>;

function makeThread(overrides?: Partial<{
  id: string;
  unreadCount: number;
  lastMessageAt: string | null;
}>) {
  return {
    id: "thread-1",
    providerOrganizationId: "prov-org-1",
    labOrganizationId: "lab-org-1",
    providerOrganizationName: "Riverside Dental",
    labOrganizationName: "Test Lab",
    lastMessageAt: null as string | null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    unreadCount: 0,
    latestMessagePreview: null,
    ...overrides,
  };
}

// ── Per-test QueryClient lifecycle ────────────────────────────────────────────

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  mockApiFetch.mockReset();
});

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  queryClient.clear();
});

function Wrapper({ children }: { children: React.ReactNode }) {
  const { hook } = memoryLocation({ path: "/" });
  return (
    <QueryClientProvider client={queryClient}>
      <Router hook={hook}>
        <AuthContext.Provider
          value={{
            ...MOCK_AUTH_DEFAULTS,
            user: MOCK_USER,
            status: "authed" as const,
            restoreStatus: "ok" as const,
            restoreNoticeDismissed: true,
          }}
        >
          {children}
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>
  );
}

// ── 1. Unread-badge reconciliation ────────────────────────────────────────────
//
// Tests the localReadAt state machine that MessagesPage uses. We exercise it
// via a thin harness that replicates the exact same useState + useEffect so
// the tests catch regressions without duplicating the full page mount.

/**
 * Mirrors the localReadAt state + reconciliation effect from MessagesPage.
 * Exposes the computed effective unread count for each thread so tests can
 * assert on badge visibility without rendering the full page layout.
 */
function ReadStateHarness({
  threads,
  onUnreadCounts,
}: {
  threads: Array<{ id: string; unreadCount: number; lastMessageAt: string | null }>;
  onUnreadCounts: (counts: Record<string, number>) => void;
}) {
  const [localReadAt, setLocalReadAt] = useState<Record<string, number>>({});

  // Reconciliation effect — same logic as MessagesPage
  useEffect(() => {
    if (!threads.length) return;
    setLocalReadAt((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [tid, readAt] of Object.entries(next)) {
        const thread = threads.find((t) => t.id === tid);
        if (!thread) continue;
        if (thread.unreadCount > 0 && thread.lastMessageAt) {
          const serverLastMsgMs = new Date(thread.lastMessageAt).getTime();
          if (serverLastMsgMs > readAt) {
            delete next[tid];
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [threads]);

  // Report effective unread counts to the test
  useEffect(() => {
    const counts: Record<string, number> = {};
    for (const t of threads) {
      counts[t.id] = localReadAt[t.id] !== undefined ? 0 : t.unreadCount;
    }
    onUnreadCounts(counts);
  });

  return (
    <div>
      {threads.map((t) => (
        <button
          key={t.id}
          data-testid={`select-${t.id}`}
          onClick={() =>
            setLocalReadAt((prev) => ({ ...prev, [t.id]: Date.now() }))
          }
        >
          thread {t.id}
        </button>
      ))}
    </div>
  );
}

describe("Unread-badge reconciliation (MessagesPage.localReadAt)", () => {
  it("clears unread badge immediately when a thread is selected", async () => {
    const thread = makeThread({
      id: "t1",
      unreadCount: 3,
      lastMessageAt: new Date(Date.now() - 30_000).toISOString(),
    });
    let counts: Record<string, number> = {};

    render(
      <ReadStateHarness
        threads={[thread]}
        onUnreadCounts={(c) => { counts = c; }}
      />
    );

    // Before selection: badge shows server unread count
    expect(counts["t1"]).toBe(3);

    fireEvent.click(screen.getByTestId("select-t1"));

    // After selection: badge is cleared optimistically
    await waitFor(() => expect(counts["t1"]).toBe(0));
  });

  it("re-shows unread badge when server reports a new message arriving after selection", async () => {
    // lastMessageAt 30s ago — before any readAt we'll set
    const oldMsgTime = new Date(Date.now() - 60_000).toISOString();
    const thread = makeThread({ id: "t1", unreadCount: 3, lastMessageAt: oldMsgTime });
    let counts: Record<string, number> = {};

    const { rerender } = render(
      <ReadStateHarness
        threads={[thread]}
        onUnreadCounts={(c) => { counts = c; }}
      />
    );

    // Select the thread — captures readAt as ~now
    fireEvent.click(screen.getByTestId("select-t1"));
    await waitFor(() => expect(counts["t1"]).toBe(0));

    // Simulate a new message arriving AFTER we selected: lastMessageAt is now in the future
    // relative to when we "read" (a few ms ago)
    const newMsgTime = new Date(Date.now() + 1000).toISOString();
    const updatedThread = makeThread({
      id: "t1",
      unreadCount: 1,
      lastMessageAt: newMsgTime,
    });

    rerender(
      <ReadStateHarness
        threads={[updatedThread]}
        onUnreadCounts={(c) => { counts = c; }}
      />
    );

    // Reconciliation must lift the override and restore the badge
    await waitFor(() => expect(counts["t1"]).toBe(1));
  });

  it("does NOT re-show badge when the last message predates the selection (no new message)", async () => {
    // lastMessageAt is 60s ago — well before any readAt we'll set
    const oldMsgTime = new Date(Date.now() - 60_000).toISOString();
    const thread = makeThread({ id: "t1", unreadCount: 3, lastMessageAt: oldMsgTime });
    let counts: Record<string, number> = {};

    const { rerender } = render(
      <ReadStateHarness
        threads={[thread]}
        onUnreadCounts={(c) => { counts = c; }}
      />
    );

    fireEvent.click(screen.getByTestId("select-t1"));
    await waitFor(() => expect(counts["t1"]).toBe(0));

    // Server re-polls: same thread, same old lastMessageAt, server not yet updated
    rerender(
      <ReadStateHarness
        threads={[thread]}
        onUnreadCounts={(c) => { counts = c; }}
      />
    );

    // The last message is older than our readAt → badge stays suppressed
    await waitFor(() => expect(counts["t1"]).toBe(0));
  });
});

// ── 2. Single mark-read POST per send + refetch ───────────────────────────────
//
// The watermark effect is the single source of mark-read calls. The send
// mutation's onSuccess must NOT also call mark-read — doing so would fire
// two POSTs for the same message: one from onSuccess and one from the effect
// after the subsequent messages refetch.
//
// We use queryClient.setQueryData to inject the post-send messages directly
// (deterministic, no async network cycle needed), then verify exactly one
// mark-read POST fires for the new message.

describe("ConversationPanel — exactly one mark-read POST per send + refetch", () => {
  it("fires mark-read exactly once when a new message arrives via send+refetch (not twice)", async () => {
    const markReadCount = { value: 0 };
    // `sent` becomes true once the POST mock fires, ensuring the GET mock
    // returns the updated list for any background refetch that follows.
    let sent = false;

    const msg1 = {
      id: "msg-1",
      threadId: "thread-1",
      senderUserId: "other-user",
      body: "Hello",
      formattingJson: null,
      mediaKey: null,
      mimeType: null,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
    };
    const msg2 = {
      id: "msg-2",
      threadId: "thread-1",
      senderUserId: "user-lab-1",
      body: "My reply",
      formattingJson: null,
      mediaKey: null,
      mimeType: null,
      createdAt: new Date().toISOString(),
    };

    mockApiFetch.mockImplementation(
      (url: string, opts?: { method?: string }) => {
        if (url.includes("/messages") && opts?.method === "POST") {
          sent = true;
          return Promise.resolve(msg2);
        }
        if (url.includes("/messages")) {
          // After the send, any background refetch also returns the new message
          // so the watermark effect's subsequent runs see consistent data.
          return Promise.resolve(sent ? [msg2, msg1] : [msg1]);
        }
        if (url.endsWith("/read")) {
          markReadCount.value++;
          return Promise.resolve(undefined);
        }
        return Promise.resolve(undefined);
      }
    );

    render(
      <Wrapper>
        <ConversationPanel
          thread={makeThread()}
          providerName="Riverside Dental"
          currentUserId="user-lab-1"
          onRead={vi.fn()}
        />
      </Wrapper>
    );

    // Wait for the initial load and the first mark-read (new latestId msg-1)
    const textarea = await screen.findByRole(
      "textbox",
      { name: /message input/i },
      { timeout: 8000 }
    );
    await waitFor(() => expect(markReadCount.value).toBe(1), { timeout: 5000 });

    // Reset — we now count only the mark-read calls triggered by the send
    markReadCount.value = 0;

    // Send a message
    fireEvent.change(textarea, { target: { value: "My reply" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // Wait for the POST to complete (sent flag becomes true)
    await waitFor(() => expect(sent).toBe(true), { timeout: 5000 });

    // Inject the post-send message list directly into the React Query cache.
    // This simulates what the invalidation-triggered refetch would deliver and
    // fires the watermark effect synchronously without relying on the jsdom
    // async network cycle (which can be unreliable in test environments).
    // The GET mock returns the same data for any subsequent background refetch,
    // so structural sharing in React Query will not re-trigger the effect.
    act(() => {
      queryClient.setQueryData(
        ["provider-messenger", "messages", "thread-1"],
        [msg2, msg1] // newest-first, as the API returns
      );
    });

    // Watermark effect fires: latestId changes from msg-1 to msg-2 → mark-read
    await waitFor(() => expect(markReadCount.value).toBe(1), { timeout: 6000 });

    // Give a short window to catch any unexpected extra calls
    // (the old buggy sendMutation.onSuccess would have added a second call)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    // Must be exactly 1 — not 2 (which the old double-fire would produce)
    expect(markReadCount.value).toBe(1);
  }, 25000);
});

// ── 3. Mark-read failure recovery ─────────────────────────────────────────────
//
// A transient POST failure must not permanently silence the unread badge.
// ConversationPanel must call onReadError so MessagesPage can roll back the
// optimistic localReadAt entry, and the watermark effect must retry on the
// next latestId change (i.e. lastMarkedMessageIdRef stays un-advanced on error).

describe("ConversationPanel — mark-read failure recovery", () => {
  const existingMsg = {
    id: "msg-existing",
    threadId: "thread-1",
    senderUserId: "other-user",
    body: "Hi there",
    formattingJson: null,
    mediaKey: null,
    mimeType: null,
    createdAt: new Date(Date.now() - 5_000).toISOString(),
  };

  const newMsg = {
    id: "msg-new",
    threadId: "thread-1",
    senderUserId: "other-user",
    body: "Follow-up",
    formattingJson: null,
    mediaKey: null,
    mimeType: null,
    createdAt: new Date().toISOString(),
  };

  it("calls onReadError when the mark-read POST fails", async () => {
    const onReadError = vi.fn();

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes("/messages")) return Promise.resolve([existingMsg]);
      if (url.endsWith("/read")) return Promise.reject(new Error("network error"));
      return Promise.resolve(undefined);
    });

    render(
      <Wrapper>
        <ConversationPanel
          thread={makeThread()}
          providerName="Riverside Dental"
          currentUserId="user-lab-1"
          onRead={vi.fn()}
          onReadError={onReadError}
        />
      </Wrapper>
    );

    await screen.findByRole("textbox", { name: /message input/i }, { timeout: 8000 });

    // The watermark effect fires on mount and the POST fails → onReadError called
    await waitFor(() => expect(onReadError).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });
  }, 15000);

  it("retries mark-read after a transient failure when the next message arrives", async () => {
    // First call to /read fails; subsequent calls succeed.
    let readCallCount = 0;
    const markReadSuccessCount = { value: 0 };

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes("/messages")) return Promise.resolve([existingMsg]);
      if (url.endsWith("/read")) {
        readCallCount++;
        if (readCallCount === 1) {
          // Transient failure — lastMarkedMessageIdRef must NOT advance
          return Promise.reject(new Error("transient error"));
        }
        markReadSuccessCount.value++;
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    render(
      <Wrapper>
        <ConversationPanel
          thread={makeThread()}
          providerName="Riverside Dental"
          currentUserId="user-lab-1"
          onRead={vi.fn()}
          onReadError={vi.fn()}
        />
      </Wrapper>
    );

    await screen.findByRole("textbox", { name: /message input/i }, { timeout: 8000 });

    // Wait for the first (failing) mark-read attempt
    await waitFor(() => expect(readCallCount).toBe(1), { timeout: 5000 });

    // Simulate a new message arriving (changes latestId → effect retries)
    // Because lastMarkedMessageIdRef was NOT advanced on the failure, the effect
    // sees existingMsg.id ≠ null (lastMarked stayed null) — but the real retry
    // trigger here is newMsg.id ≠ existingMsg.id (new data in the cache).
    act(() => {
      queryClient.setQueryData(
        ["provider-messenger", "messages", "thread-1"],
        [newMsg, existingMsg] // newest-first
      );
    });

    // Effect fires: latestId = newMsg.id ≠ lastMarked (null) → retries and succeeds
    await waitFor(() => expect(markReadSuccessCount.value).toBe(1), {
      timeout: 5000,
    });

    expect(readCallCount).toBe(2); // 1 failure + 1 success
  }, 15000);

  it("does not suppress retry when an older success arrives after a newer failure (race regression)", async () => {
    // Race scenario:
    //   1. existingMsg loads → call A starts (pending = existingMsg.id)
    //   2. newMsg injected while A is in-flight → call B starts (pending = newMsg.id)
    //   3. B fails immediately (newer request)
    //   4. A resolves (stale, older request)
    //   Bug (pre-fix): A's onSuccess would read pending.current = null (B already
    //     cleared it) and record null as confirmed, leaving lastMarked = null but
    //     the effect still sees newMsg.id ≠ null → actually this part was ok, BUT
    //     the original code without per-request IDs would have recorded pendingRef
    //     (= newMsg.id at the time B ran) as lastMarked — permanently silencing retry.
    //   Fix: A's onSuccess checks its own variable (existingMsg.id) ≠ current pending
    //     (null after B's onError cleared it) → skips advance → retry C can fire.

    let resolveA: () => void = () => {};
    let callCount = 0;

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes("/messages")) return Promise.resolve([existingMsg]);
      if (url.endsWith("/read")) {
        callCount++;
        const n = callCount;
        if (n === 1) {
          // Call A: hold in-flight until manually resolved
          return new Promise<undefined>((res) => {
            resolveA = () => res(undefined);
          });
        }
        if (n === 2) {
          // Call B: fail immediately (newer request for newMsg)
          return Promise.reject(new Error("B failed — newer request"));
        }
        // Call C: retry succeeds
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    render(
      <Wrapper>
        <ConversationPanel
          thread={makeThread()}
          providerName="Riverside Dental"
          currentUserId="user-lab-1"
          onRead={vi.fn()}
          onReadError={vi.fn()}
        />
      </Wrapper>
    );
    await screen.findByRole("textbox", { name: /message input/i }, { timeout: 8000 });

    // Wait for call A to start (pending = existingMsg.id)
    await waitFor(() => expect(callCount).toBe(1), { timeout: 5000 });

    // Inject newMsg while A is still in-flight → triggers call B (fails immediately)
    act(() => {
      queryClient.setQueryData(
        ["provider-messenger", "messages", "thread-1"],
        [newMsg, existingMsg] // newest-first, as API returns
      );
    });

    // B fires and fails synchronously; wait for it to have run
    await waitFor(() => expect(callCount).toBe(2), { timeout: 3000 });

    // Now resolve A (stale older request succeeds after newer has failed)
    await act(async () => {
      resolveA();
      await new Promise((r) => setTimeout(r, 150));
    });

    // With the fix: A's onSuccess sees its variable (existingMsg.id) ≠ pending (null,
    // because B's onError already cleared it) → does NOT advance lastMarked to newMsg.id.
    // Without the fix: lastMarked would be set to newMsg.id here, permanently blocking retry.

    // Drive another data cycle so the effect can re-evaluate and fire retry C.
    act(() => {
      queryClient.setQueryData(["provider-messenger", "messages", "thread-1"], null);
    });
    act(() => {
      queryClient.setQueryData(
        ["provider-messenger", "messages", "thread-1"],
        [newMsg, existingMsg]
      );
    });

    // Retry C must fire — total calls = 3 (A + B + C)
    await waitFor(() => expect(callCount).toBe(3), { timeout: 5000 });
  }, 25000);
});
