// Tests for the chunked photo-upload retry + resume logic in
// `lib/query-client.ts` (chunkedUploadCaseMedia + sendChunkWithRetry).
//
// The global vitest.setup.ts mocks `@/lib/query-client` so screen smoke tests
// don't hit the network. These tests need the REAL implementation, so we
// `vi.unmock` it here (hoisted above the import). The module's dependencies
// stay mocked: expo/fetch is routed through the setup's fetchHandler (used for
// the session create POST + status GET via resilientFetch), expo-secure-store
// is a no-op, and XMLHttpRequest (used for the binary chunk PATCH) is replaced
// with a controllable stub installed below.
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import {
  setMockFetchHandler,
  resetMockFetchHandler,
} from "../../vitest.setup";

vi.unmock("@/lib/query-client");
import { chunkedUploadCaseMedia, saveTokens } from "@/lib/query-client";

// CHUNK_MAX_RETRIES in query-client.ts. One chunk that fails on every attempt
// is therefore sent CHUNK_MAX_RETRIES + 1 = 4 times before the upload throws.
const CHUNK_MAX_RETRIES = 3;
const OCTET = "application/octet-stream";

// ── Controllable XMLHttpRequest stub ───────────────────────────────────────
// sendBinaryPatch() opens a PATCH, sets an Upload-Offset header, registers
// onload/onerror, then calls send(buffer). Our stub resolves each send via a
// per-test `xhrResponder`, recording every attempt for assertions.
type PatchInfo = { method: string; url: string; offset: number };
type PatchOutcome = { status: number; body: string } | { networkError: true };
type XhrResponder = (info: PatchInfo, callIndex: number) => PatchOutcome;

let xhrResponder: XhrResponder = () => ({ status: 200, body: "{}" });
let xhrCalls: PatchInfo[] = [];

class MockXMLHttpRequest {
  method = "";
  url = "";
  headers: Record<string, string> = {};
  status = 0;
  responseText = "";
  withCredentials = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string): void {
    this.headers[key] = value;
  }
  send(_data: unknown): void {
    const offset = Number(this.headers["Upload-Offset"] ?? 0);
    const info: PatchInfo = { method: this.method, url: this.url, offset };
    const callIndex = xhrCalls.length;
    xhrCalls.push(info);
    // Resolve on a microtask so callers' Promise wrappers settle naturally.
    Promise.resolve().then(() => {
      const outcome = xhrResponder(info, callIndex);
      if ("networkError" in outcome) {
        this.onerror?.();
        return;
      }
      this.status = outcome.status;
      this.responseText = outcome.body;
      this.onload?.();
    });
  }
}

let originalXhr: unknown;

beforeAll(async () => {
  originalXhr = (globalThis as Record<string, unknown>).XMLHttpRequest;
  (globalThis as Record<string, unknown>).XMLHttpRequest = MockXMLHttpRequest;
  // Native (Platform.OS === "ios" in the test stub) requires an in-memory
  // bearer token; otherwise resilientFetch + the upload guard throw before
  // any session work. saveTokens() populates the module's in-memory token.
  await saveTokens("test-access-token", "test-refresh-token");
});

afterAll(() => {
  (globalThis as Record<string, unknown>).XMLHttpRequest = originalXhr;
});

beforeEach(() => {
  xhrCalls = [];
  xhrResponder = () => ({ status: 200, body: "{}" });
});

afterEach(() => {
  resetMockFetchHandler();
  vi.useRealTimers();
});

// Builds a `data:` URI of exactly `size` bytes so chunkedUploadCaseMedia can
// derive fileSize without touching expo-file-system.
function dataUri(size: number): string {
  const b64 = Buffer.alloc(size).toString("base64");
  return `data:${OCTET};base64,${b64}`;
}

// Routes the session create (POST) and status (GET) calls that go through
// resilientFetch → expo/fetch. PATCH chunk uploads bypass this (they use XHR).
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("chunkedUploadCaseMedia — chunk retry (back-off)", () => {
  it("retries a 5xx chunk up to CHUNK_MAX_RETRIES, then fails", async () => {
    const postCalls: string[] = [];
    setMockFetchHandler((url, init) => {
      if (init?.method === "POST" && url.includes("/api/media/upload-session")) {
        postCalls.push(url);
        return jsonResponse({ sessionId: "sess-5xx", uploadedBytes: 0 });
      }
      return jsonResponse({ data: null });
    });
    // Every chunk PATCH returns a transient 500.
    xhrResponder = () => ({ status: 500, body: "server error" });

    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const promise = chunkedUploadCaseMedia(
      dataUri(64),
      "retry-5xx.bin",
      OCTET,
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(false);
    // Single chunk attempted 1 + CHUNK_MAX_RETRIES times before giving up.
    expect(xhrCalls.length).toBe(CHUNK_MAX_RETRIES + 1);
    expect(postCalls.length).toBe(1);
    // Back-off is exponential: the three retries wait 1s, 2s, 4s
    // (chunkBackoffDelayMs = min(1000 * 2 ** (attempt - 1), 8000)).
    const backoffDelays = setTimeoutSpy.mock.calls
      .map((c) => c[1])
      .filter((d): d is number => d === 1000 || d === 2000 || d === 4000);
    expect(backoffDelays).toEqual([1000, 2000, 4000]);
    setTimeoutSpy.mockRestore();
  });

  it("retries a network-failed chunk with back-off, then fails", async () => {
    setMockFetchHandler((url, init) => {
      if (init?.method === "POST" && url.includes("/api/media/upload-session")) {
        return jsonResponse({ sessionId: "sess-neterr", uploadedBytes: 0 });
      }
      return jsonResponse({ data: null });
    });
    // Every chunk PATCH triggers xhr.onerror (network drop).
    xhrResponder = () => ({ networkError: true });

    vi.useFakeTimers();
    const promise = chunkedUploadCaseMedia(
      dataUri(64),
      "retry-net.bin",
      OCTET,
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(xhrCalls.length).toBe(CHUNK_MAX_RETRIES + 1);
  });

  it("succeeds when a transient 5xx recovers within the retry budget", async () => {
    setMockFetchHandler((url, init) => {
      if (init?.method === "POST" && url.includes("/api/media/upload-session")) {
        return jsonResponse({ sessionId: "sess-recover", uploadedBytes: 0 });
      }
      return jsonResponse({ data: null });
    });
    // First attempt 500, second attempt completes.
    xhrResponder = (_info, callIndex) =>
      callIndex === 0
        ? { status: 500, body: "server error" }
        : { status: 200, body: JSON.stringify({ complete: true, url: "/u/ok.bin" }) };

    vi.useFakeTimers();
    const promise = chunkedUploadCaseMedia(
      dataUri(64),
      "recover.bin",
      OCTET,
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: true, url: "/u/ok.bin" });
    expect(xhrCalls.length).toBe(2);
  });
});

describe("chunkedUploadCaseMedia — session resume", () => {
  it("resumes an existing session from the server offset instead of creating a new one", async () => {
    const SIZE = 100;
    const SERVER_OFFSET = 40;
    const uri = dataUri(SIZE);
    const postCalls: string[] = [];
    const getCalls: string[] = [];

    // ── First upload: create a session, then permanently fail the chunk with
    // a definitive 400 so the session id stays cached for a resume. ──────────
    setMockFetchHandler((url, init) => {
      if (init?.method === "POST" && url.includes("/api/media/upload-session")) {
        postCalls.push(url);
        return jsonResponse({ sessionId: "sess-resume", uploadedBytes: 0 });
      }
      return jsonResponse({ data: null });
    });
    xhrResponder = () => ({ status: 400, body: "bad request" });

    const first = await chunkedUploadCaseMedia(uri, "resume-1.bin", OCTET);
    expect(first.ok).toBe(false);
    expect(postCalls.length).toBe(1);

    // ── Second upload (same uri + size): must reuse the cached session via a
    // GET status check and resume from the server's reported offset. ─────────
    postCalls.length = 0;
    xhrCalls = [];
    setMockFetchHandler((url, init) => {
      if (init?.method === "POST" && url.includes("/api/media/upload-session")) {
        postCalls.push(url);
        return jsonResponse({ sessionId: "sess-new-should-not-happen", uploadedBytes: 0 });
      }
      if (
        (!init?.method || init.method === "GET") &&
        url.includes("/api/media/upload-session/sess-resume")
      ) {
        getCalls.push(url);
        return jsonResponse({ fileSize: SIZE, uploadedBytes: SERVER_OFFSET });
      }
      return jsonResponse({ data: null });
    });
    xhrResponder = () => ({
      status: 200,
      body: JSON.stringify({ complete: true, url: "/u/resumed.bin" }),
    });

    const second = await chunkedUploadCaseMedia(uri, "resume-2.bin", OCTET);

    expect(second).toEqual({ ok: true, url: "/u/resumed.bin" });
    // Reused the session: status GET happened, no new session POST.
    expect(getCalls.length).toBe(1);
    expect(postCalls.length).toBe(0);
    // The resumed PATCH started at the server's offset, not byte 0.
    expect(xhrCalls[0].offset).toBe(SERVER_OFFSET);
  });
});

describe("chunkedUploadCaseMedia — 409 offset mismatch", () => {
  it("treats a 409 as a resync (not a failure) and continues from the server offset", async () => {
    const SIZE = 100;
    const RESYNC_OFFSET = 60;
    setMockFetchHandler((url, init) => {
      if (init?.method === "POST" && url.includes("/api/media/upload-session")) {
        return jsonResponse({ sessionId: "sess-409", uploadedBytes: 0 });
      }
      return jsonResponse({ data: null });
    });
    // First chunk PATCH at offset 0 → 409 with the server's true offset.
    // After resync the next PATCH (offset 60) completes the upload.
    xhrResponder = (_info, callIndex) =>
      callIndex === 0
        ? { status: 409, body: JSON.stringify({ uploadedBytes: RESYNC_OFFSET }) }
        : { status: 200, body: JSON.stringify({ complete: true, url: "/u/409.bin" }) };

    const result = await chunkedUploadCaseMedia(dataUri(SIZE), "mismatch.bin", OCTET);

    expect(result).toEqual({ ok: true, url: "/u/409.bin" });
    expect(xhrCalls.length).toBe(2);
    expect(xhrCalls[0].offset).toBe(0);
    expect(xhrCalls[1].offset).toBe(RESYNC_OFFSET);
  });
});
