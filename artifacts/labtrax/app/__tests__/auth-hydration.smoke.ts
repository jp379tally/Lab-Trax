// Phase 1 smoke test: Mobile Rebuild Auth Foundation Stable
//
// Proves that the three foundational Phase 1 guarantees hold before any
// screen-level rebuild begins:
//
//   1. SecureStore hydration — tokens load from secure storage on startup.
//   2. X-LabTrax-Client: mobile/2 header — present on EVERY outbound request,
//      including protected requests, retried requests, and refresh calls.
//   3. 401 → transparent refresh + retry — a mid-session token rejection
//      triggers a refresh, the original request is retried with the new token,
//      and the caller receives the successful response transparently.
//
// This file uses the REAL `@/lib/query-client` (not the global smoke-test
// mock) so it exercises the production networking path end-to-end.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setMockFetchHandler,
  resetMockFetchHandler,
} from "../../vitest.setup";

vi.unmock("@/lib/query-client");
import {
  loadTokens,
  saveTokens,
  clearTokens,
  getAccessToken,
} from "@/lib/query-client";

// Import resilientFetch via a dynamic re-import after vi.unmock so the real
// implementation is resolved (not the global mock).
let resilientFetch: (path: string, options?: RequestInit) => Promise<Response>;
vi.mock("@/lib/query-client", async (importOriginal) => {
  return importOriginal();
});

import * as qc from "@/lib/query-client";
resilientFetch = qc.resilientFetch;

import * as SecureStore from "expo-secure-store";

function tokenBlob(accessToken: string | null, refreshToken: string): string {
  return JSON.stringify({ accessToken, refreshToken });
}

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Normalizes both `Headers` instances (from injectAuthHeaders) and plain
// `Record<string, string>` objects (from refreshAccessToken's raw fetch call).
function getHeaderValue(
  headers: RequestInit["headers"] | null | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const plain = headers as Record<string, string>;
  const lower = name.toLowerCase();
  return plain[name] ?? plain[lower] ?? null;
}

beforeEach(async () => {
  await clearTokens();
  vi.mocked(SecureStore.getItemAsync).mockReset();
  vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  vi.mocked(SecureStore.setItemAsync).mockReset();
  vi.mocked(SecureStore.setItemAsync).mockResolvedValue(undefined);
  vi.mocked(SecureStore.deleteItemAsync).mockReset();
  vi.mocked(SecureStore.deleteItemAsync).mockResolvedValue(undefined);
});

afterEach(() => {
  resetMockFetchHandler();
});

// ── Phase 1 criteria 1: SecureStore hydration ────────────────────────────────

describe("Phase 1 — auth hydration from SecureStore", () => {
  it("loads tokens from SecureStore on app start and makes them available for requests", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob("startup-access", "startup-refresh"),
    );

    setMockFetchHandler(() => jsonOk({ user: { id: "u-1" } }));

    const res = await resilientFetch("/api/auth/me");

    expect(res.ok).toBe(true);
    expect(getAccessToken()).toBe("startup-access");
  });
});

// ── Phase 1 criteria 2: X-LabTrax-Client: mobile/2 on every request ──────────

describe("Phase 1 — X-LabTrax-Client: mobile/2 header on all outbound requests", () => {
  it("sends x-labtrax-client: mobile/2 on protected API requests", async () => {
    await saveTokens("access-tok", "refresh-tok");

    let captured: Headers | null = null;
    setMockFetchHandler((_url, init) => {
      captured = (init?.headers as Headers) ?? null;
      return jsonOk({ ok: true });
    });

    await resilientFetch("/api/cases");

    expect(captured).not.toBeNull();
    expect(captured!.get("x-labtrax-client")).toBe("mobile/2");
  });

  it("sends x-labtrax-client: mobile/2 on the token refresh request", async () => {
    // Prime only a refresh token (no access token) to force a refresh call at startup.
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob(null, "refresh-for-header-test"),
    );

    const capturedByUrl: Record<string, RequestInit["headers"]> = {};
    setMockFetchHandler((url, init) => {
      const h = init?.headers;
      if (h) {
        const key = url.includes("/api/auth/refresh") ? "refresh" : "other";
        capturedByUrl[key] = h;
      }
      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ data: { accessToken: "fresh-tok", refreshToken: "fresh-ref" } });
      }
      return jsonOk({ user: { id: "u-2" } });
    });

    await resilientFetch("/api/auth/me");

    // The /api/auth/refresh call must also carry the mobile/2 header.
    expect(capturedByUrl["refresh"]).toBeDefined();
    expect(getHeaderValue(capturedByUrl["refresh"], "x-labtrax-client")).toBe("mobile/2");
  });

  it("sends x-labtrax-client: mobile/2 on the retried request after a mid-session 401", async () => {
    await saveTokens("old-tok", "ref-tok");

    let attempt = 0;
    const capturedMeHeaders: Headers[] = [];

    setMockFetchHandler((url, init) => {
      const h = init?.headers as Headers | undefined;
      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ data: { accessToken: "new-tok", refreshToken: "new-ref" } });
      }
      if (h) capturedMeHeaders.push(h);
      attempt++;
      return attempt === 1
        ? new Response(null, { status: 401 })
        : jsonOk({ user: { id: "u-3" } });
    });

    const res = await resilientFetch("/api/auth/me");

    expect(res.ok).toBe(true);
    // Both the initial request and the retry must carry mobile/2.
    expect(capturedMeHeaders.length).toBeGreaterThanOrEqual(2);
    for (const h of capturedMeHeaders) {
      expect(h.get("x-labtrax-client")).toBe("mobile/2");
    }
  });
});

// ── Phase 1 criteria 3: 401 → transparent refresh + retry ────────────────────

describe("Phase 1 — mid-session 401 triggers transparent token refresh and retry", () => {
  it("caller receives the successful retried response after a mid-session 401", async () => {
    await saveTokens("live-tok", "live-ref");

    let calls = 0;
    setMockFetchHandler((url) => {
      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ data: { accessToken: "rotated-tok", refreshToken: "rotated-ref" } });
      }
      calls++;
      return calls === 1
        ? new Response(null, { status: 401 })
        : jsonOk({ caseId: "c-100" });
    });

    const res = await resilientFetch("/api/cases/c-100");

    expect(res.ok).toBe(true);
    // In-memory token is the rotated value.
    expect(getAccessToken()).toBe("rotated-tok");
    // Two calls to the protected endpoint: initial attempt + retry.
    expect(calls).toBe(2);
  });

  it("loads fresh tokens on the next request after a successful mid-session refresh", async () => {
    await saveTokens("pre-refresh-tok", "pre-refresh-ref");

    let calls = 0;
    setMockFetchHandler((url) => {
      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ data: { accessToken: "post-refresh-tok", refreshToken: "post-refresh-ref" } });
      }
      calls++;
      if (calls === 1) return new Response(null, { status: 401 });
      return jsonOk({ ok: true });
    });

    // First request triggers 401 → refresh → retry.
    await resilientFetch("/api/cases");
    expect(getAccessToken()).toBe("post-refresh-tok");

    // Second independent request goes out with the updated token immediately.
    let authHeader: string | null = null;
    setMockFetchHandler((_url, init) => {
      authHeader = (init?.headers as Headers)?.get("authorization") ?? null;
      return jsonOk({ ok: true });
    });
    await resilientFetch("/api/invoices");
    expect(authHeader).toBe("Bearer post-refresh-tok");
  });
});
