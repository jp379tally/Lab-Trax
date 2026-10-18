// Mobile provider portal → Message My Lab.
//
// Covers the outcomes this section owns, mirroring the desktop
// ProviderMessageLab / ProviderSentNotes pair: the lab picker only appears
// when there is a choice to make, a lone lab is auto-selected, Chat and Sent
// are separate views of the selected lab, a message and a file both reach the
// lab and show up without a manual reload, switching labs rebuilds the
// conversation against the new lab, and the navigation's unread badge clears
// when the provider opens the section.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Alert } from "react-native";
import { act, cleanup, fireEvent, render } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockFetchHandler,
} from "../../vitest.setup";

// ── Local mocks ────────────────────────────────────────────────────────────
// The global setup swaps `useQuery`/`useQueryClient` for static stubs. This
// section is built on genuine cache behaviour (a send invalidates its list and
// the refetched list is what appears on screen), so React Query runs for real.
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
}));

// The global setup signs in as a lab user; this is a provider surface.
const authState = vi.hoisted(() => ({
  currentUser: "dr.smith",
  currentUserId: "user-provider",
  userType: "provider",
  isAuthenticated: true,
  logout: vi.fn(),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }: React.PropsWithChildren<unknown>) => children ?? null,
}));

const meState = vi.hoisted(() => ({
  data: {
    user: { firstName: "Ada", username: "dr.smith" },
    memberships: [
      {
        organizationId: "prac-north",
        role: "user",
        status: "active",
        organization: { id: "prac-north", type: "provider", name: "North Dental" },
      },
    ],
  } as unknown,
  isError: false,
}));
vi.mock("@/lib/auth-me", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-me")>();
  return { ...actual, useMe: () => meState };
});

// Opening a protected file goes through the shared attachment opener; the
// tests assert which URL it is handed rather than exercising expo-sharing.
const openAttachment = vi.hoisted(() =>
  vi.fn(async (_options: { url: string; fileName?: string; fileType?: string }): Promise<"opened" | "error"> => "opened"),
);
vi.mock("@/lib/open-attachment", () => ({
  openAttachment: (...args: Parameters<typeof openAttachment>) => openAttachment(...args),
}));

vi.mock("@/lib/in-app-notifications", () => ({
  IN_APP_NOTIFICATIONS_QUERY_KEY: ["in-app-notifications"],
  useInAppNotifications: () => ({ items: [], unreadCount: 0, isLoading: false }),
  useNotificationActions: () => ({
    markRead: vi.fn(async () => undefined),
    markAllRead: vi.fn(async () => undefined),
  }),
}));

import { ProviderMessagesSection } from "@/components/provider-portal/sections/ProviderMessagesSection";
import { ProviderPortalShell } from "@/components/provider-portal/ProviderPortalShell";
import { ProviderPracticeProvider } from "@/lib/provider-practice";
import { UNREAD_COUNT_QUERY_KEY } from "@/lib/messenger";

// ── Server fixture ─────────────────────────────────────────────────────────
interface FixtureMessage {
  id: string;
  body: string;
  senderUserId: string;
  createdAt: string;
}
interface FixtureSentItem {
  id: string;
  labOrganizationId: string;
  note: string | null;
  originalFilename: string | null;
}

const fixture: {
  messagesByThread: Record<string, FixtureMessage[]>;
  sentItems: FixtureSentItem[];
  unreadTotal: number;
} = { messagesByThread: {}, sentItems: [], unreadTotal: 0 };

let requests: Array<{ url: string; method: string }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function labIdOf(url: string): string {
  return new URL(url, "http://localhost").searchParams.get("labOrganizationId") ?? "";
}

function installHandler(): void {
  setMockFetchHandler((url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ url, method });

    if (url.includes("/api/provider/organizations")) {
      return json({ ok: true, data: [{ id: "prac-north", name: "North Dental", accountNumber: "ACCT-1" }] });
    }
    if (url.includes("/api/provider/selection")) {
      return json({ ok: true, data: { ok: true } });
    }
    if (url.includes("/api/provider-messenger/unread-count")) {
      return json({ ok: true, data: { total: fixture.unreadTotal } });
    }
    if (url.includes("/api/provider-messenger/thread/") && url.endsWith("/read")) {
      return json({ ok: true, data: null });
    }
    const messagesMatch = url.match(/\/api\/provider-messenger\/thread\/([^/]+)\/messages/);
    if (messagesMatch) {
      // The endpoint answers newest-first; the screen reverses for display.
      const rows = [...(fixture.messagesByThread[messagesMatch[1]!] ?? [])].reverse();
      return json({
        ok: true,
        data: rows.map((m) => ({
          ...m,
          threadId: messagesMatch[1],
          formattingJson: null,
          mediaKey: null,
          mimeType: null,
        })),
      });
    }
    if (url.includes("/api/provider-messenger/thread?")) {
      const labId = labIdOf(url);
      return json({
        ok: true,
        data: {
          id: `thread-${labId}`,
          providerOrganizationId: "prac-north",
          labOrganizationId: labId,
          lastMessageAt: null,
        },
      });
    }
    if (url.includes("/api/lab-inbox/provider-sent")) {
      const labId = labIdOf(url);
      return json({
        ok: true,
        data: fixture.sentItems
          .filter((item) => item.labOrganizationId === labId)
          .map((item) => ({
            id: item.id,
            note: item.note,
            originalFilename: item.originalFilename,
            mimeType: item.originalFilename ? "application/pdf" : null,
            sizeBytes: item.originalFilename ? 1024 : null,
            linkedCaseIds: null,
            createdAt: "2026-02-01T10:00:00.000Z",
          })),
      });
    }
    return json({ ok: true, data: null });
  });
}

// ── XHR stub ───────────────────────────────────────────────────────────────
// Multipart sends (a chat message, a note/file to the lab inbox) go through
// XMLHttpRequest, which the Node test environment does not provide.
class MockXHR {
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  withCredentials = false;
  url = "";
  headers: Record<string, string> = {};
  body: FormData | null = null;

  open(method: string, url: string) {
    this.url = url;
    MockXHR.method = method;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body?: unknown) {
    this.body = (body as FormData) ?? null;
    MockXHR.instances.push(this);
    MockXHR.onSend?.(this);
    setTimeout(() => {
      this.status = 200;
      this.responseText = JSON.stringify({
        data: {
          id: "msg-new",
          threadId: "thread-lab-a",
          senderUserId: "user-provider",
          body: "",
          formattingJson: null,
          mediaKey: null,
          mimeType: null,
          createdAt: "2026-02-01T12:00:00.000Z",
        },
      });
      this.onload?.();
    }, 0);
  }

  static instances: MockXHR[] = [];
  static method = "";
  static onSend: ((xhr: MockXHR) => void) | null = null;
  static reset() {
    MockXHR.instances = [];
    MockXHR.onSend = null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return await render(
    <QueryClientProvider client={client}>
      <ProviderMessagesSection />
    </QueryClientProvider>,
  );
}

async function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <ProviderPracticeProvider>
        <ProviderPortalShell />
      </ProviderPracticeProvider>
    </QueryClientProvider>,
  );
  return { view, client };
}

/** Let queued promises, timers, and the state updates they cause settle. */
async function flush(ticks = 4): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });
  }
}

async function press(element: Parameters<typeof fireEvent.press>[0]): Promise<void> {
  await act(async () => {
    await fireEvent.press(element);
  });
  await flush();
}

/** Make the unread-count query fetch again, standing in for its poll tick. */
async function pollUnreadCount(client: QueryClient): Promise<void> {
  await act(async () => {
    await client.invalidateQueries({ queryKey: UNREAD_COUNT_QUERY_KEY });
  });
  await flush();
}

const ONE_LAB = [{ labOrganizationId: "lab-a", labName: "Acme Dental" }];
const TWO_LABS = [
  { labOrganizationId: "lab-a", labName: "Acme Dental" },
  { labOrganizationId: "lab-b", labName: "Bay Dental" },
];

let realXHR: typeof globalThis.XMLHttpRequest;

beforeEach(async () => {
  resetMockAppState();
  resetMockFetchHandler();
  MockXHR.reset();
  realXHR = globalThis.XMLHttpRequest;
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = MockXHR;
  requests = [];
  fixture.messagesByThread = {};
  fixture.sentItems = [];
  fixture.unreadTotal = 0;
  installHandler();
  await AsyncStorage.clear();
});

afterEach(() => {
  cleanup();
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = realXHR;
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("provider portal → Message My Lab: lab picker", () => {
  it("auto-selects the lab and hides the picker when only one lab is linked", async () => {
    setMockAppState({ providerCases: ONE_LAB });
    const view = await renderSection();
    await flush();

    expect(view.queryByTestId("provider-messages-lab-picker")).toBeNull();
    expect(view.getByTestId("provider-messages-chat")).toBeTruthy();
    expect(
      requests.some((r) => r.url.includes("/api/provider-messenger/thread?labOrganizationId=lab-a")),
    ).toBe(true);
  });

  it("offers a picker and waits for a choice when several labs are linked", async () => {
    setMockAppState({ providerCases: TWO_LABS });
    const view = await renderSection();
    await flush();

    expect(view.getByTestId("provider-messages-lab-picker")).toBeTruthy();
    expect(view.getByTestId("provider-messages-lab-option-lab-a")).toBeTruthy();
    expect(view.getByTestId("provider-messages-lab-option-lab-b")).toBeTruthy();
    expect(view.getByText("Select a lab to start chatting.")).toBeTruthy();
    expect(view.queryByTestId("provider-messages-chat")).toBeNull();
  });

  it("shows the no-lab-linked state when the provider has no labs", async () => {
    const view = await renderSection();
    await flush();

    expect(view.getByTestId("provider-messages-no-labs")).toBeTruthy();
    expect(view.getByText("No lab linked yet")).toBeTruthy();
    expect(view.getByText("Contact your lab to get connected.")).toBeTruthy();
    expect(view.queryByTestId("provider-messages-lab-picker")).toBeNull();
  });
});

describe("provider portal → Message My Lab: Chat and Sent", () => {
  it("switches between the Chat and Sent views of the selected lab", async () => {
    setMockAppState({ providerCases: ONE_LAB });
    fixture.messagesByThread["thread-lab-a"] = [
      { id: "m1", body: "Impression received", senderUserId: "lab-user", createdAt: "2026-02-01T09:00:00.000Z" },
    ];
    const view = await renderSection();
    await flush();

    expect(view.getByTestId("provider-messages-chat")).toBeTruthy();
    expect(view.getByText("Impression received")).toBeTruthy();

    await press(view.getByTestId("provider-messages-tab-sent"));
    expect(view.getByTestId("provider-messages-sent")).toBeTruthy();
    expect(view.queryByTestId("provider-messages-chat")).toBeNull();
    expect(view.getByText("Send a note or file to Acme Dental")).toBeTruthy();

    await press(view.getByTestId("provider-messages-tab-chat"));
    expect(view.getByTestId("provider-messages-chat")).toBeTruthy();
  });

  it("sends a chat message to the selected lab and shows it without a manual reload", async () => {
    setMockAppState({ providerCases: ONE_LAB });
    fixture.messagesByThread["thread-lab-a"] = [];
    // The send is committed server-side; the fixture grows the way the real
    // thread would, so the assertion proves the view refreshed itself.
    MockXHR.onSend = () => {
      fixture.messagesByThread["thread-lab-a"] = [
        { id: "m-new", body: "Shade is A2", senderUserId: "user-provider", createdAt: "2026-02-01T12:00:00.000Z" },
      ];
    };

    const view = await renderSection();
    await flush();
    expect(view.getByTestId("provider-chat-empty")).toBeTruthy();

    await act(async () => {
      await fireEvent.changeText(view.getByTestId("provider-chat-input"), "Shade is A2");
    });
    await press(view.getByTestId("provider-chat-send"));

    expect(MockXHR.instances).toHaveLength(1);
    expect(MockXHR.instances[0]!.url).toContain(
      "/api/provider-messenger/thread/thread-lab-a/messages",
    );
    expect(view.getByText("Shade is A2")).toBeTruthy();
  });

  it("attaches a file, sends it to the selected lab, and lists it without a manual reload", async () => {
    setMockAppState({ providerCases: ONE_LAB });
    const pickDocument = DocumentPicker.getDocumentAsync as unknown as ReturnType<typeof vi.fn>;
    pickDocument.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///tmp/rx.pdf", name: "rx.pdf", mimeType: "application/pdf", size: 2048 }],
    });
    MockXHR.onSend = () => {
      fixture.sentItems = [
        { id: "sent-1", labOrganizationId: "lab-a", note: "New Rx attached", originalFilename: "rx.pdf" },
      ];
    };

    const view = await renderSection();
    await flush();
    await press(view.getByTestId("provider-messages-tab-sent"));
    expect(view.getByTestId("provider-sent-empty")).toBeTruthy();

    await act(async () => {
      await fireEvent.changeText(view.getByTestId("provider-sent-note-input"), "New Rx attached");
    });
    await press(view.getByTestId("provider-sent-attach"));
    expect(view.getByTestId("provider-sent-attachment")).toBeTruthy();
    expect(view.getByText("rx.pdf")).toBeTruthy();

    await press(view.getByTestId("provider-sent-send"));

    expect(MockXHR.instances).toHaveLength(1);
    const sent = MockXHR.instances[0]!;
    expect(sent.url).toContain("/api/lab-inbox/provider-upload?labOrganizationId=lab-a");
    expect(sent.body?.get("note")).toBe("New Rx attached");
    expect(sent.body?.has("file")).toBe(true);
    expect(view.getByTestId("provider-sent-item-sent-1")).toBeTruthy();
  });

  it("resets the conversation to the newly selected lab", async () => {
    setMockAppState({ providerCases: TWO_LABS });
    fixture.messagesByThread["thread-lab-a"] = [
      { id: "a1", body: "From Acme", senderUserId: "lab-user", createdAt: "2026-02-01T09:00:00.000Z" },
    ];
    fixture.messagesByThread["thread-lab-b"] = [
      { id: "b1", body: "From Bay", senderUserId: "lab-user", createdAt: "2026-02-01T09:30:00.000Z" },
    ];

    const view = await renderSection();
    await flush();
    await press(view.getByTestId("provider-messages-lab-option-lab-a"));
    expect(view.getByText("From Acme")).toBeTruthy();

    await press(view.getByTestId("provider-messages-lab-option-lab-b"));
    expect(view.queryByText("From Acme")).toBeNull();
    expect(view.getByText("From Bay")).toBeTruthy();
    expect(
      requests.some((r) => r.url.includes("/api/provider-messenger/thread?labOrganizationId=lab-b")),
    ).toBe(true);
  });
});

describe("provider portal → Message My Lab: re-opening a sent file", () => {
  beforeEach(() => {
    openAttachment.mockReset();
    openAttachment.mockImplementation(async () => "opened");
  });

  it("opens a file the provider already sent through the protected media path", async () => {
    setMockAppState({ providerCases: ONE_LAB });
    fixture.sentItems = [
      { id: "sent-1", labOrganizationId: "lab-a", note: "New Rx", originalFilename: "rx.pdf" },
    ];

    const view = await renderSection();
    await flush();
    await press(view.getByTestId("provider-messages-tab-sent"));

    await press(view.getByTestId("provider-sent-open-sent-1"));

    expect(openAttachment).toHaveBeenCalledTimes(1);
    expect(openAttachment.mock.calls[0]![0]).toMatchObject({
      url: "/api/lab-inbox/sent-1/file",
      fileName: "rx.pdf",
      fileType: "application/pdf",
    });
  });

  it("leaves a note-only entry as plain text with nothing to tap", async () => {
    setMockAppState({ providerCases: ONE_LAB });
    fixture.sentItems = [
      { id: "sent-note", labOrganizationId: "lab-a", note: "Just a note", originalFilename: null },
    ];

    const view = await renderSection();
    await flush();
    await press(view.getByTestId("provider-messages-tab-sent"));

    expect(view.getByTestId("provider-sent-item-sent-note")).toBeTruthy();
    expect(view.queryByTestId("provider-sent-open-sent-note")).toBeNull();
    expect(openAttachment).not.toHaveBeenCalled();
  });

  it("tells the provider when the file could not be opened", async () => {
    setMockAppState({ providerCases: ONE_LAB });
    fixture.sentItems = [
      { id: "sent-1", labOrganizationId: "lab-a", note: null, originalFilename: "rx.pdf" },
    ];
    openAttachment.mockImplementation(async () => "error");
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);

    try {
      const view = await renderSection();
      await flush();
      await press(view.getByTestId("provider-messages-tab-sent"));
      await press(view.getByTestId("provider-sent-open-sent-1"));

      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(String(alertSpy.mock.calls[0]![0])).toMatch(/could ?n.t open file/i);
    } finally {
      alertSpy.mockRestore();
    }
  });
});

describe("provider portal navigation: unread badge", () => {
  it("shows the unread count and clears it when the provider opens Messages", async () => {
    setMockAppState({ providerCases: ONE_LAB });
    fixture.unreadTotal = 3;

    const { view } = await renderShell();
    await flush();

    await press(view.getByTestId("provider-portal-menu"));
    expect(view.getByTestId("provider-portal-drawer-messages-badge")).toBeTruthy();
    expect(view.getByText("3")).toBeTruthy();

    await press(view.getByTestId("provider-portal-drawer-messages"));

    await press(view.getByTestId("provider-portal-menu"));
    expect(view.queryByTestId("provider-portal-drawer-messages-badge")).toBeNull();
  });

  it("stays cleared for a count that arrives while the provider is reading", async () => {
    setMockAppState({ providerCases: ONE_LAB });
    fixture.unreadTotal = 3;

    const { view, client } = await renderShell();
    await flush();
    await press(view.getByTestId("provider-portal-menu"));
    expect(view.getByTestId("provider-portal-drawer-messages-badge")).toBeTruthy();

    await press(view.getByTestId("provider-portal-drawer-messages"));
    await press(view.getByTestId("provider-portal-menu"));
    expect(view.queryByTestId("provider-portal-drawer-messages-badge")).toBeNull();
    await press(view.getByTestId("provider-portal-drawer-close"));

    // The count keeps being polled behind the open conversation. The provider
    // is looking at the thread, so nothing the poll reports may re-badge it.
    fixture.unreadTotal = 5;
    await pollUnreadCount(client);
    await press(view.getByTestId("provider-portal-menu"));
    expect(view.queryByTestId("provider-portal-drawer-messages-badge")).toBeNull();

    // Nor may it come back on the way out: that count was already in front of
    // them while they were reading.
    await press(view.getByTestId("provider-portal-drawer-dashboard"));
    await press(view.getByTestId("provider-portal-menu"));
    expect(view.queryByTestId("provider-portal-drawer-messages-badge")).toBeNull();
    await press(view.getByTestId("provider-portal-drawer-close"));

    // Only a count fetched after they left is new mail.
    fixture.unreadTotal = 2;
    await pollUnreadCount(client);
    await press(view.getByTestId("provider-portal-menu"));
    expect(view.getByTestId("provider-portal-drawer-messages-badge")).toBeTruthy();
    expect(view.getByLabelText("Message My Lab, 2 unread")).toBeTruthy();
  });
});
