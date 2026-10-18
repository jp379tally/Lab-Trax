// Provider requests must say which practice they belong to.
//
// A provider linked to more than one practice is rejected by the server unless
// the request carries the active practice. Mobile reaches the API by three
// different paths — the generated hooks' customFetch, resilientFetch, and
// hand-built multipart XHRs — and a provider surface is only as scoped as its
// least-scoped path, so the two that bypass resilientFetch are covered here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  customFetch,
  setRequestHeadersProvider,
} from "../../../../lib/api-client-react/src/custom-fetch";
import { sendMessengerMessage, PROVIDER_LINKED_LABS_QUERY_KEY } from "../messenger";
import { PRACTICE_SCOPED_QUERY_PREFIXES } from "../provider-practice";
import { setProviderOrganizationId } from "../query-client";
import { resetMockFetchHandler, setMockFetchHandler } from "../../vitest.setup";
import { providerRequest, setProviderSelectionRequiredHandler } from "../provider-api";
import { providerStartupRequest } from "../provider-startup-request";

const PRACTICE_HEADER = "x-provider-organization-id";

// ── Generated-hook path (customFetch) ──────────────────────────────────────

describe("generated client: ambient practice header", () => {
  let realFetch: typeof globalThis.fetch;
  let sent: Array<{ headers: Headers }>;

  beforeEach(() => {
    sent = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      sent.push({ headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ data: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setRequestHeadersProvider(null);
  });

  it("stamps the registered ambient headers on every request", async () => {
    setRequestHeadersProvider(() => ({ [PRACTICE_HEADER]: "prac-north" }));

    await customFetch("http://localhost/api/cases/provider");

    expect(sent[0]!.headers.get(PRACTICE_HEADER)).toBe("prac-north");
  });

  it("reads the current cookie-auth CSRF value for each generated mutation without losing practice scope", async () => {
    let csrf = "first-session-csrf";
    setRequestHeadersProvider(() => ({ [PRACTICE_HEADER]: "prac-north", "x-csrf-token": csrf }));
    await customFetch("http://localhost/api/cases/synthetic", { method: "PATCH", body: "{}" });
    csrf = "refreshed-session-csrf";
    await customFetch("http://localhost/api/cases/synthetic", { method: "PATCH", body: "{}" });
    expect(sent.map(({ headers }) => headers.get("x-csrf-token"))).toEqual(["first-session-csrf", "refreshed-session-csrf"]);
    expect(sent.every(({ headers }) => headers.get(PRACTICE_HEADER) === "prac-north")).toBe(true);
  });

  it("lets an explicit per-request header win", async () => {
    setRequestHeadersProvider(() => ({ [PRACTICE_HEADER]: "prac-north" }));

    await customFetch("http://localhost/api/cases/provider", {
      headers: { [PRACTICE_HEADER]: "prac-south" },
    });

    expect(sent[0]!.headers.get(PRACTICE_HEADER)).toBe("prac-south");
  });

  it("sends no practice header when no practice is active", async () => {
    setRequestHeadersProvider(() => null);

    await customFetch("http://localhost/api/cases/provider");

    expect(sent[0]!.headers.has(PRACTICE_HEADER)).toBe(false);
  });
});

// ── Multipart path (messenger send) ────────────────────────────────────────

class MockXHR {
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  withCredentials = false;
  headers: Record<string, string> = {};

  open() {}
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send() {
    MockXHR.instances.push(this);
    setTimeout(() => {
      this.status = 200;
      this.responseText = JSON.stringify({ data: { id: "m1" } });
      this.onload?.();
    }, 0);
  }

  static instances: MockXHR[] = [];
}

describe("messenger send: practice header", () => {
  let realXHR: typeof globalThis.XMLHttpRequest;

  beforeEach(() => {
    MockXHR.instances = [];
    realXHR = globalThis.XMLHttpRequest;
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = MockXHR;
  });

  afterEach(() => {
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = realXHR;
    setProviderOrganizationId(null);
  });

  it("tells the server which practice a provider is sending as", async () => {
    setProviderOrganizationId("prac-north");

    await sendMessengerMessage({ threadId: "thread-1", text: "Shade is A2" });

    expect(MockXHR.instances[0]!.headers[PRACTICE_HEADER]).toBe("prac-north");
  });

  it("omits the header for a lab user, who has no practice", async () => {
    setProviderOrganizationId(null);

    await sendMessengerMessage({ threadId: "thread-1", text: "On its way" });

    expect(MockXHR.instances[0]!.headers[PRACTICE_HEADER]).toBeUndefined();
  });
});

// ── Practice switch ────────────────────────────────────────────────────────

describe("linked labs cache", () => {
  it("is dropped when the provider switches practice", async () => {
    // The portal purges practice-scoped caches by key prefix on a switch, so
    // the lab list is only reset if its key sits under one of those prefixes.
    expect(PRACTICE_SCOPED_QUERY_PREFIXES).toContain(PROVIDER_LINKED_LABS_QUERY_KEY[0]);
  });
});

describe("startup and delayed practice refusals", () => {
  const refusal = () => new Response(JSON.stringify({
    message: "Select a practice", details: { code: "PROVIDER_ORGANIZATION_REQUIRED" },
  }), { status: 409 });
  afterEach(() => {
    setProviderSelectionRequiredHandler(null);
    setProviderOrganizationId(null);
    resetMockFetchHandler();
    vi.useRealTimers();
  });
  it("ignores an outgoing practice's late selection-required response", async () => {
    let finish!: (response: Response) => void;
    setMockFetchHandler(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const reset = vi.fn();
    setProviderSelectionRequiredHandler(reset);
    setProviderOrganizationId("north");
    const pending = providerRequest("/api/cases/provider");
    setProviderOrganizationId("south");
    finish(refusal());
    await expect(pending).rejects.toThrow("Select a practice");
    expect(reset).not.toHaveBeenCalled();
  });
  it("still recovers current practice-scoped refusals, without invalidating bootstrap itself", async () => {
    setMockFetchHandler(() => refusal());
    const reset = vi.fn();
    setProviderSelectionRequiredHandler(reset);
    for (const path of ["/api/provider/organizations", "/api/provider/selection"]) {
      await expect(providerRequest(path)).rejects.toThrow("Select a practice");
    }
    expect(reset).not.toHaveBeenCalled();
    await expect(providerRequest("/api/cases/provider")).rejects.toThrow("Select a practice");
    expect(reset).toHaveBeenCalledOnce();
  });
  it("bounds a hung startup request and exposes a retryable timeout", async () => {
    vi.useFakeTimers();
    setMockFetchHandler((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
    }));
    const result = providerStartupRequest("/api/provider/organizations").catch((error) => error);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(((await result) as Error).message).toMatch(/timed out.*again/i);
  });
});
