/**
 * @vitest-environment jsdom
 *
 * Task 3746 — per-message read receipts ("Seen" indicator).
 *
 * 1. MessengerBubble — renders "Seen" only for the sender's own, non-pending
 *    bubble when the `seen` prop is true; never for the other party's bubble
 *    or a still-sending optimistic one.
 * 2. ConversationPanel (lab side) — polls the provider's read-watermark and
 *    shows "Seen" under the lab's last message once the provider has read
 *    up to (or past) it; omits the label when no provider has read yet.
 * 3. ProviderMessengerChat (provider side) — symmetric: shows "Seen" under
 *    the provider's last message once a lab user has read it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "./test-utils";
import { MessengerBubble, type MessengerMessage } from "@/components/messenger/MessengerBubble";
import { ConversationPanel } from "@/pages/messages";
import { ProviderMessengerChat } from "@/components/messenger/ProviderMessengerChat";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  apiFetch: mockApiFetch,
  apiUrl: (path: string) => `http://localhost${path}`,
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

function makeThread() {
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
  };
}

function makeMessage(overrides: Partial<MessengerMessage>): MessengerMessage {
  return {
    id: "msg-1",
    threadId: "thread-1",
    senderUserId: "other-user",
    body: "Hello",
    formattingJson: null,
    mediaKey: null,
    mimeType: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

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

// ── 1. MessengerBubble ────────────────────────────────────────────────────────

describe("MessengerBubble — Seen indicator", () => {
  it("shows 'Seen' for the sender's own delivered message when seen=true", () => {
    render(
      <MessengerBubble message={makeMessage({ senderUserId: "me" })} isMine seen />
    );
    expect(screen.getByTestId("messenger-seen-indicator")).toHaveTextContent(
      "Seen"
    );
  });

  it("omits 'Seen' when seen is false", () => {
    render(
      <MessengerBubble
        message={makeMessage({ senderUserId: "me" })}
        isMine
        seen={false}
      />
    );
    expect(screen.queryByTestId("messenger-seen-indicator")).toBeNull();
  });

  it("omits 'Seen' for the other party's bubble even if seen=true is passed", () => {
    render(
      <MessengerBubble
        message={makeMessage({ senderUserId: "other-user" })}
        isMine={false}
        seen
      />
    );
    expect(screen.queryByTestId("messenger-seen-indicator")).toBeNull();
  });

  it("omits 'Seen' while the message is still a pending optimistic send", () => {
    render(
      <MessengerBubble
        message={makeMessage({ senderUserId: "me", id: "opt-1" })}
        isMine
        isPending
        seen
      />
    );
    expect(screen.queryByTestId("messenger-seen-indicator")).toBeNull();
  });
});

// ── 2. ConversationPanel (lab side) ───────────────────────────────────────────

describe("ConversationPanel — Seen indicator (lab's message read by provider)", () => {
  it("shows 'Seen' under the lab's last message once the provider's watermark passes it", async () => {
    const labMsg = makeMessage({
      id: "msg-lab",
      senderUserId: "user-lab-1",
      body: "Your case is ready",
      createdAt: new Date(Date.now() - 10_000).toISOString(),
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes("/read-watermark")) {
        return Promise.resolve({
          lastReadMessageId: "msg-lab",
          // Provider read strictly after the lab message was sent
          lastReadMessageCreatedAt: new Date().toISOString(),
        });
      }
      if (url.includes("/messages")) return Promise.resolve([labMsg]);
      if (url.endsWith("/read")) return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

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

    await waitFor(() =>
      expect(screen.getByTestId("messenger-seen-indicator")).toHaveTextContent(
        "Seen"
      )
    );
  });

  it("omits 'Seen' when no provider user has read the thread yet", async () => {
    const labMsg = makeMessage({
      id: "msg-lab",
      senderUserId: "user-lab-1",
      body: "Your case is ready",
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes("/read-watermark")) {
        return Promise.resolve({
          lastReadMessageId: null,
          lastReadMessageCreatedAt: null,
        });
      }
      if (url.includes("/messages")) return Promise.resolve([labMsg]);
      if (url.endsWith("/read")) return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

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

    // Give the queries a chance to settle, then assert no indicator appeared.
    await screen.findByText("Your case is ready");
    expect(screen.queryByTestId("messenger-seen-indicator")).toBeNull();
  });

  it("omits 'Seen' when the provider's watermark predates the lab's latest message (not yet read)", async () => {
    const olderMsg = makeMessage({
      id: "msg-old",
      senderUserId: "prov-user-1",
      body: "Older provider message",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const newLabMsg = makeMessage({
      id: "msg-lab-new",
      senderUserId: "user-lab-1",
      body: "Brand new lab reply",
      createdAt: new Date().toISOString(),
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes("/read-watermark")) {
        return Promise.resolve({
          lastReadMessageId: "msg-old",
          lastReadMessageCreatedAt: olderMsg.createdAt,
        });
      }
      if (url.includes("/messages")) {
        return Promise.resolve([newLabMsg, olderMsg]);
      }
      if (url.endsWith("/read")) return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

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

    await screen.findByText("Brand new lab reply");
    expect(screen.queryByTestId("messenger-seen-indicator")).toBeNull();
  });
});

// ── 3. ProviderMessengerChat (provider side, symmetric) ───────────────────────

describe("ProviderMessengerChat — Seen indicator (provider's message read by lab)", () => {
  it("shows 'Seen' under the provider's last message once a lab user has read it", async () => {
    const providerUser = {
      ...MOCK_AUTH_DEFAULTS.user,
      id: "user-lab-1", // ProviderMessengerChat compares senderUserId to user.id
    } as NonNullable<typeof MOCK_AUTH_DEFAULTS.user>;

    const providerMsg = makeMessage({
      id: "msg-prov",
      senderUserId: "user-lab-1",
      body: "Here's the update",
      createdAt: new Date(Date.now() - 10_000).toISOString(),
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes("/read-watermark")) {
        return Promise.resolve({
          lastReadMessageId: "msg-prov",
          lastReadMessageCreatedAt: new Date().toISOString(),
        });
      }
      if (url.includes("/thread?")) return Promise.resolve(makeThread());
      if (url.includes("/messages")) return Promise.resolve([providerMsg]);
      if (url.endsWith("/read")) return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider
          value={{
            ...MOCK_AUTH_DEFAULTS,
            user: providerUser,
            status: "authed" as const,
            restoreStatus: "ok" as const,
            restoreNoticeDismissed: true,
          }}
        >
          <ProviderMessengerChat labOrganizationId="lab-org-1" labName="Test Lab" />
        </AuthContext.Provider>
      </QueryClientProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId("messenger-seen-indicator")).toHaveTextContent(
        "Seen"
      )
    );
  });
});
