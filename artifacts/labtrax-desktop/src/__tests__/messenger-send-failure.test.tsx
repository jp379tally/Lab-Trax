/**
 * @vitest-environment jsdom
 *
 * Integration tests: send failure in real chat containers restores draft
 *
 * Exercises ProviderMessengerChat and ConversationPanel end-to-end through the
 * actual apiFetch → sendMutation → handleSend → onSend chain. A failed POST
 * must propagate through handleSend (via re-throw) so the composer restores
 * the captured draft text and surfaces an error banner — the user never loses
 * their in-progress message silently.
 *
 * Each test creates a dedicated QueryClient that is explicitly destroyed in
 * afterEach so React Query's refetchInterval timers cannot leak between tests
 * and cause flakes in unrelated test files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "./test-utils";
// Static imports — vi.mock is hoisted so mocks are active before these resolve
import { ProviderMessengerChat } from "@/components/messenger/ProviderMessengerChat";
import { ConversationPanel } from "@/pages/messages";

// ── Module-level mocks (hoisted before imports) ───────────────────────────────

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
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}));

vi.mock("@/components/AuthedMedia", () => ({
  AuthedImage: ({ url }: { url: string }) => <img src={url} alt="attachment" />,
  AuthedVideo: ({ url }: { url: string }) => <video src={url} />,
}));

// ── Shared fixtures ───────────────────────────────────────────────────────────

const MOCK_USER = {
  id: "user-1",
  username: "tester",
  role: "member",
  email: "tester@lab.com",
} as NonNullable<typeof MOCK_AUTH_DEFAULTS.user>;

const MOCK_THREAD = {
  id: "thread-1",
  providerOrganizationId: "provider-org-1",
  labOrganizationId: "lab-org-1",
  providerOrganizationName: "Riverside Dental",
  labOrganizationName: "Test Lab",
  lastMessageAt: null,
  createdAt: new Date().toISOString(),
  unreadCount: 0,
  latestMessagePreview: null,
};

// ── Per-test QueryClient lifecycle ────────────────────────────────────────────
// Each test gets a fresh QueryClient that is destroyed in afterEach so that
// React Query's refetchInterval timers are cancelled and never fire across test
// boundaries, which would otherwise make unrelated tests time out.

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
  cleanup(); // unmount all rendered components (removes React Query observers)
  await queryClient.cancelQueries(); // cancel any in-flight fetches
  queryClient.clear(); // evict cached data and deregister scheduled intervals
});

function Wrapper({ children }: { children: React.ReactNode }) {
  const { hook } = memoryLocation({ path: "/" });
  const authValue = {
    ...MOCK_AUTH_DEFAULTS,
    user: MOCK_USER,
    status: "authed" as const,
    restoreStatus: "ok" as const,
    restoreNoticeDismissed: true,
  };
  return (
    <QueryClientProvider client={queryClient}>
      <Router hook={hook}>
        <AuthContext.Provider value={authValue}>
          {children}
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>
  );
}

// ── ProviderMessengerChat ─────────────────────────────────────────────────────

describe("ProviderMessengerChat — draft restoration on send failure", () => {
  it("restores draft text when the server rejects the send", async () => {
    mockApiFetch.mockImplementation(
      (url: string, opts?: { method?: string }) => {
        if (url.includes("/provider-messenger/thread?")) {
          return Promise.resolve(MOCK_THREAD);
        }
        if (url.includes("/messages") && opts?.method === "POST") {
          return Promise.reject(new Error("Server error 500"));
        }
        if (url.includes("/messages")) return Promise.resolve([]);
        if (url.includes("/read")) return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      }
    );

    render(
      <Wrapper>
        <ProviderMessengerChat labOrganizationId="lab-org-1" labName="Test Lab" />
      </Wrapper>
    );

    const textarea = await screen.findByRole("textbox", { name: /message input/i }, { timeout: 8000 });
    fireEvent.change(textarea, { target: { value: "Message that will fail" } });
    expect(textarea).toHaveValue("Message that will fail");

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // After POST rejects, draft must be restored
    await waitFor(
      () => expect(textarea).toHaveValue("Message that will fail"),
      { timeout: 6000 }
    );

    // And an error banner must appear
    await waitFor(
      () => expect(screen.getByRole("alert")).toBeDefined(),
      { timeout: 6000 }
    );
    expect(screen.getByRole("alert").textContent).toMatch(/failed to send/i);
  }, 20000);

  it("clears the textarea only after a successful send", async () => {
    mockApiFetch.mockImplementation(
      (url: string, opts?: { method?: string }) => {
        if (url.includes("/provider-messenger/thread?")) {
          return Promise.resolve(MOCK_THREAD);
        }
        if (url.includes("/messages") && opts?.method === "POST") {
          return Promise.resolve({
            id: "msg-new",
            threadId: "thread-1",
            senderUserId: "user-1",
            body: "Success",
            formattingJson: null,
            mediaKey: null,
            mimeType: null,
            createdAt: new Date().toISOString(),
          });
        }
        if (url.includes("/messages")) return Promise.resolve([]);
        if (url.includes("/read")) return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      }
    );

    render(
      <Wrapper>
        <ProviderMessengerChat labOrganizationId="lab-org-1" labName="Test Lab" />
      </Wrapper>
    );

    const textarea = await screen.findByRole("textbox", { name: /message input/i }, { timeout: 8000 });
    fireEvent.change(textarea, { target: { value: "Success message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => expect(textarea).toHaveValue(""), { timeout: 6000 });
    expect(screen.queryByRole("alert")).toBeNull();
  }, 20000);
});

// ── ConversationPanel (lab inbox side) ───────────────────────────────────────

describe("ConversationPanel — draft restoration on send failure", () => {
  it("restores draft text when the server rejects the send", async () => {
    mockApiFetch.mockImplementation(
      (url: string, opts?: { method?: string }) => {
        if (url.includes("/messages") && opts?.method === "POST") {
          return Promise.reject(new Error("Server error 500"));
        }
        if (url.includes("/messages")) return Promise.resolve([]);
        if (url.includes("/read")) return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      }
    );

    render(
      <Wrapper>
        <ConversationPanel
          thread={MOCK_THREAD}
          providerName="Riverside Dental"
          currentUserId="user-1"
          onRead={vi.fn()}
        />
      </Wrapper>
    );

    const textarea = await screen.findByRole("textbox", { name: /message input/i }, { timeout: 8000 });
    fireEvent.change(textarea, { target: { value: "Lab reply that will fail" } });
    expect(textarea).toHaveValue("Lab reply that will fail");

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(
      () => expect(textarea).toHaveValue("Lab reply that will fail"),
      { timeout: 6000 }
    );
    await waitFor(
      () => expect(screen.getByRole("alert")).toBeDefined(),
      { timeout: 6000 }
    );
    expect(screen.getByRole("alert").textContent).toMatch(/failed to send/i);
  }, 15000);

  it("clears the textarea only after a successful send", async () => {
    mockApiFetch.mockImplementation(
      (url: string, opts?: { method?: string }) => {
        if (url.includes("/messages") && opts?.method === "POST") {
          return Promise.resolve({
            id: "msg-ok",
            threadId: "thread-1",
            senderUserId: "user-1",
            body: "Lab reply OK",
            formattingJson: null,
            mediaKey: null,
            mimeType: null,
            createdAt: new Date().toISOString(),
          });
        }
        if (url.includes("/messages")) return Promise.resolve([]);
        if (url.includes("/read")) return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      }
    );

    render(
      <Wrapper>
        <ConversationPanel
          thread={MOCK_THREAD}
          providerName="Riverside Dental"
          currentUserId="user-1"
          onRead={vi.fn()}
        />
      </Wrapper>
    );

    const textarea = await screen.findByRole("textbox", { name: /message input/i }, { timeout: 8000 });
    fireEvent.change(textarea, { target: { value: "Lab reply OK" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => expect(textarea).toHaveValue(""), { timeout: 6000 });
    expect(screen.queryByRole("alert")).toBeNull();
  }, 15000);
});
