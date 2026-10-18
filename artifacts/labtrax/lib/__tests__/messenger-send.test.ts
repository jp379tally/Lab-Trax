// Regression test for the messenger send path (Task 3718 completion review):
// `sendMessengerMessage` originally built a raw XHR that skipped the
// established cross-platform upload contract (see uploadCaseMedia in
// query-client.ts) — on web it neither sent credentials/the CSRF
// double-submit header nor materialized a real Blob for the image part, so
// text and image sends both failed against the server's CSRF guard / silently
// dropped the attachment in a browser. These tests pin the fixed contract:
//   - web: xhr.withCredentials=true, x-csrf-token header present, and the
//     image part is a real Blob (fetched from the picked uri), not the RN
//     `{uri,name,type}` descriptor.
//   - native: no credentials/CSRF header (there is no cookie jar to defend
//     against), bearer Authorization header present, and a 401 triggers
//     exactly one refresh-and-retry.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Platform } from "react-native";

const mockState = vi.hoisted(() => {
  let accessToken: string | null = "initial-token";
  let refreshedToken: string | null = "refreshed-token";
  let csrfToken: string | null = "csrf-abc";
  return {
    getAccessTokenMock: vi.fn(() => accessToken),
    loadTokensMock: vi.fn(async () => undefined),
    refreshAndGetAccessTokenMock: vi.fn(async () => refreshedToken),
    getCsrfTokenMock: vi.fn(() => csrfToken),
    setAccessToken(v: string | null) {
      accessToken = v;
    },
    setRefreshedToken(v: string | null) {
      refreshedToken = v;
    },
    setCsrfToken(v: string | null) {
      csrfToken = v;
    },
  };
});

vi.mock("@/lib/query-client", () => ({
  getApiUrl: () => "http://localhost/",
  getAccessToken: mockState.getAccessTokenMock,
  loadTokens: mockState.loadTokensMock,
  refreshAndGetAccessToken: mockState.refreshAndGetAccessTokenMock,
  getCsrfToken: mockState.getCsrfTokenMock,
  // A send is tenant-scoped like every other provider request; with no active
  // practice (a lab user) the header is simply omitted.
  getProviderOrganizationId: vi.fn(() => null),
  resilientFetch: vi.fn(),
}));

// --- XHR mock -------------------------------------------------------------
// Records every open/setRequestHeader/withCredentials/send call so tests can
// assert on the exact request the fixed implementation builds, and lets each
// test script a specific status code (to exercise the 401-retry path).
class MockXHR {
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  withCredentials = false;
  calls: { open?: [string, string]; headers: Record<string, string>; sentBody?: unknown } = {
    headers: {},
  };

  open(method: string, url: string) {
    this.calls.open = [method, url];
  }
  setRequestHeader(name: string, value: string) {
    this.calls.headers[name] = value;
  }
  send(body?: unknown) {
    this.calls.sentBody = body;
    MockXHR.instances.push(this);
    const status = MockXHR.nextStatuses.shift() ?? 200;
    setTimeout(() => {
      this.status = status;
      this.responseText =
        status < 300
          ? JSON.stringify({ data: { id: "msg-1", threadId: "thread-1", senderUserId: "u1", body: "hi", formattingJson: null, mediaKey: null, mimeType: null, createdAt: "2026-01-01T00:00:00Z" } })
          : JSON.stringify({ error: "denied" });
      this.onload?.();
    }, 0);
  }

  static instances: MockXHR[] = [];
  static nextStatuses: number[] = [];
  static reset() {
    MockXHR.instances = [];
    MockXHR.nextStatuses = [];
  }
}

describe("sendMessengerMessage", () => {
  let realXHR: typeof globalThis.XMLHttpRequest;
  let realFetch: typeof globalThis.fetch;
  const originalPlatformOS = Platform.OS;

  beforeEach(() => {
    MockXHR.reset();
    realXHR = globalThis.XMLHttpRequest;
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = MockXHR;
    realFetch = globalThis.fetch;
    mockState.setAccessToken("initial-token");
    mockState.setRefreshedToken("refreshed-token");
    mockState.setCsrfToken("csrf-abc");
  });

  afterEach(() => {
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = realXHR;
    globalThis.fetch = realFetch;
    (Platform as { OS: string }).OS = originalPlatformOS;
    vi.clearAllMocks();
  });

  it("on web: sends credentials and the CSRF double-submit header for a text-only message", async () => {
    (Platform as { OS: string }).OS = "web";
    const { sendMessengerMessage } = await import("@/lib/messenger");

    await sendMessengerMessage({ threadId: "thread-1", text: "hello lab" });

    expect(MockXHR.instances).toHaveLength(1);
    const xhr = MockXHR.instances[0];
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.calls.headers["x-csrf-token"]).toBe("csrf-abc");
    expect(xhr.calls.headers["Authorization"]).toBe("Bearer initial-token");
  });

  it("on web: materializes the picked image into a real Blob instead of the RN file descriptor", async () => {
    (Platform as { OS: string }).OS = "web";
    const fakeBlob = new Blob(["fake-image-bytes"], { type: "image/jpeg" });
    const fetchMock = vi.fn(async () => ({ blob: async () => fakeBlob }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { sendMessengerMessage } = await import("@/lib/messenger");

    await sendMessengerMessage({
      threadId: "thread-1",
      text: "",
      imageUri: "blob:http://localhost/abc-123",
      imageName: "photo.jpg",
      imageMimeType: "image/jpeg",
    });

    // The web branch must fetch() the blob: URI to get a real Blob rather
    // than pass the RN {uri,name,type} descriptor straight into FormData.
    expect(fetchMock).toHaveBeenCalledWith("blob:http://localhost/abc-123");
    expect(MockXHR.instances).toHaveLength(1);
    const sentForm = MockXHR.instances[0].calls.sentBody as FormData;
    expect(sentForm).toBeInstanceOf(FormData);
  });

  it("on native: omits credentials/CSRF header and sends the bearer Authorization header", async () => {
    (Platform as { OS: string }).OS = "ios";
    const { sendMessengerMessage } = await import("@/lib/messenger");

    await sendMessengerMessage({ threadId: "thread-1", text: "hello lab" });

    expect(MockXHR.instances).toHaveLength(1);
    const xhr = MockXHR.instances[0];
    expect(xhr.withCredentials).toBe(false);
    expect(xhr.calls.headers["x-csrf-token"]).toBeUndefined();
    expect(xhr.calls.headers["Authorization"]).toBe("Bearer initial-token");
  });

  it("on native: retries exactly once with a refreshed token after a 401", async () => {
    (Platform as { OS: string }).OS = "ios";
    MockXHR.nextStatuses = [401, 200];
    const { sendMessengerMessage } = await import("@/lib/messenger");

    const result = await sendMessengerMessage({ threadId: "thread-1", text: "hello lab" });

    expect(result.id).toBe("msg-1");
    expect(MockXHR.instances).toHaveLength(2);
    expect(MockXHR.instances[0].calls.headers["Authorization"]).toBe("Bearer initial-token");
    expect(MockXHR.instances[1].calls.headers["Authorization"]).toBe("Bearer refreshed-token");
    expect(mockState.refreshAndGetAccessTokenMock).toHaveBeenCalledTimes(1);
  });
});
