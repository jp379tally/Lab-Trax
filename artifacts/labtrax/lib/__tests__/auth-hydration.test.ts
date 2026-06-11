// Tests for the singleton auth-hydration guard in `lib/query-client.ts`.
//
// The global vitest.setup.ts mocks `@/lib/query-client` so screen smoke tests
// don't hit the network. These tests need the REAL implementation so we
// `vi.unmock` it here (hoisted above the import). SecureStore and
// AsyncStorage stay mocked via the global setup; expo/fetch is routed
// through the setup's fetchHandler.
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
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
  getIsHydrated,
  waitForHydration,
  resilientFetch,
} from "@/lib/query-client";
import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "@labtrax_tokens";

function tokenBlob(accessToken: string | null, refreshToken: string): string {
  return JSON.stringify({ accessToken, refreshToken });
}

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  // Reset module-level token + hydration state between tests.
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

// ── Scenario 1: valid stored token ──────────────────────────────────────────
describe("startup with a valid stored token", () => {
  it("hydrates access token from SecureStore and marks isHydrated", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob("valid-access", "valid-refresh"),
    );

    await loadTokens();

    expect(getAccessToken()).toBe("valid-access");
    expect(getIsHydrated()).toBe(true);
  });

  it("does not emit a bearer-token error for a protected request", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob("valid-access", "valid-refresh"),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setMockFetchHandler(() => jsonOk({ user: { id: "1" } }));

    const res = await resilientFetch("/api/auth/me");

    expect(res.ok).toBe(true);
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("[resilientFetch] No bearer token"),
      expect.anything(),
      expect.anything(),
    );
    consoleSpy.mockRestore();
  });
});

// ── Scenario 2: expired access token + valid refresh token ─────────────────
describe("startup with expired access token and a valid refresh token", () => {
  it("refreshes before the first protected request and uses the new token", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob(null, "old-refresh"),
    );

    setMockFetchHandler((url) => {
      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ data: { accessToken: "fresh-access", refreshToken: "new-refresh" } });
      }
      return jsonOk({ user: { id: "1" } });
    });

    const res = await resilientFetch("/api/auth/me");

    expect(res.ok).toBe(true);
    expect(getAccessToken()).toBe("fresh-access");
  });
});

// ── Scenario 3: expired access + failed refresh ─────────────────────────────
describe("startup with expired access token and a failed refresh", () => {
  it("throws cleanly on a protected request when refresh fails", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob(null, "bad-refresh"),
    );
    setMockFetchHandler((url) => {
      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ error: "invalid_token" }, 401);
      }
      return jsonOk({ user: { id: "1" } });
    });

    await expect(resilientFetch("/api/auth/me")).rejects.toThrow(
      "Not authenticated: no bearer token available.",
    );
    expect(getAccessToken()).toBeNull();
  });

  it("allows public (unauthenticated) paths through even when no token exists", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    setMockFetchHandler((url) => {
      if (url.includes("/api/auth/login")) return jsonOk({ success: true });
      return jsonOk({});
    });

    const res = await resilientFetch("/api/auth/login");
    expect(res.ok).toBe(true);
  });
});

// ── Scenario 4: concurrent protected requests before hydration ──────────────
describe("concurrent protected requests before hydration completes", () => {
  it("deduplicates SecureStore reads — only one getItemAsync call regardless of concurrency", async () => {
    let resolveStore!: (v: string | null) => void;
    const storePromise = new Promise<string | null>((res) => {
      resolveStore = res;
    });
    vi.mocked(SecureStore.getItemAsync).mockReturnValue(storePromise);

    setMockFetchHandler(() => jsonOk({ user: { id: "1" } }));

    // Fire five concurrent requests before the store resolves.
    const pending = [
      resilientFetch("/api/auth/me"),
      resilientFetch("/api/auth/me"),
      resilientFetch("/api/auth/me"),
      resilientFetch("/api/auth/me"),
      resilientFetch("/api/auth/me"),
    ];

    // Now unblock the store with a valid token.
    resolveStore(tokenBlob("concurrent-token", "refresh-token"));

    const results = await Promise.all(pending);

    // All five requests should succeed.
    expect(results.every((r) => r.ok)).toBe(true);
    // SecureStore was only read once despite five concurrent callers.
    expect(vi.mocked(SecureStore.getItemAsync).mock.calls.filter(
      ([key]) => key === TOKEN_KEY,
    ).length).toBe(1);
  });

  it("waitForHydration resolves to the same promise on repeated calls", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob("tok", "ref"),
    );

    const p1 = waitForHydration();
    const p2 = waitForHydration();
    const p3 = loadTokens();

    // All three must be the exact same Promise object.
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    await p1;
    expect(getIsHydrated()).toBe(true);
  });
});

// ── Scenario 5: X-LabTrax-Client header and Authorization header injection ──
describe("request header injection", () => {
  it("sends X-LabTrax-Client: mobile/2 on every API request (native path)", async () => {
    await saveTokens("header-test-access", "header-test-refresh");

    const capturedHeaders: Headers[] = [];
    setMockFetchHandler((_url, init) => {
      if (init?.headers) {
        capturedHeaders.push(init.headers as Headers);
      }
      return jsonOk({ user: { id: "1" } });
    });

    await resilientFetch("/api/auth/me");

    expect(capturedHeaders.length).toBeGreaterThan(0);
    // Every outbound request must carry the mobile client identifier header.
    for (const headers of capturedHeaders) {
      expect(headers.get("x-labtrax-client")).toBe("mobile/2");
    }
  });

  it("includes Authorization: Bearer <token> on protected requests when a token is available", async () => {
    await saveTokens("my-access-token", "my-refresh-token");

    let capturedAuth: string | null = null;
    setMockFetchHandler((_url, init) => {
      const h = init?.headers as Headers | undefined;
      capturedAuth = h?.get("authorization") ?? null;
      return jsonOk({ user: { id: "1" } });
    });

    await resilientFetch("/api/auth/me");

    expect(capturedAuth).toBe("Bearer my-access-token");
  });

  it("sends X-LabTrax-Client: mobile/2 on retried requests after a mid-session 401", async () => {
    await saveTokens("old-access", "valid-refresh");

    const capturedHeaders: Array<{ url: string; headers: Headers }> = [];
    setMockFetchHandler((url, init) => {
      const h = init?.headers as Headers | undefined;
      if (h) capturedHeaders.push({ url, headers: h });

      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ data: { accessToken: "refreshed-access", refreshToken: "new-refresh" } });
      }
      // First call to /api/auth/me returns 401 (simulate token rejection by server).
      // Retry (after refresh) returns 200.
      const isFirstProtectedCall =
        url.includes("/api/auth/me") &&
        capturedHeaders.filter((e) => e.url.includes("/api/auth/me")).length === 1;
      if (isFirstProtectedCall) {
        return new Response(null, { status: 401 });
      }
      return jsonOk({ user: { id: "1" } });
    });

    const res = await resilientFetch("/api/auth/me");

    expect(res.ok).toBe(true);
    // Verify the retry request also carried the mobile/2 header.
    const meRequests = capturedHeaders.filter((e) => e.url.includes("/api/auth/me"));
    expect(meRequests.length).toBeGreaterThan(1);
    for (const entry of meRequests) {
      expect(entry.headers.get("x-labtrax-client")).toBe("mobile/2");
    }
  });
});

// ── Scenario 6: mid-session 401 → token refresh → transparent retry ─────────
describe("mid-session 401 triggers transparent token refresh and retry", () => {
  it("refreshes and retries transparently when the server rejects a previously valid token", async () => {
    // Token is valid in-memory (simulates an in-flight session).
    await saveTokens("live-access-token", "live-refresh-token");

    let requestCount = 0;
    let refreshWasCalled = false;
    setMockFetchHandler((url, _init) => {
      if (url.includes("/api/auth/refresh")) {
        refreshWasCalled = true;
        return jsonOk({ data: { accessToken: "new-access-token", refreshToken: "new-refresh-token" } });
      }
      requestCount++;
      // First attempt: server-side token rejection (e.g. token rotated on server).
      if (requestCount === 1) {
        return new Response(null, { status: 401 });
      }
      // Retry after refresh: success.
      return jsonOk({ caseId: "c-001" });
    });

    const res = await resilientFetch("/api/cases");

    expect(res.ok).toBe(true);
    expect(refreshWasCalled).toBe(true);
    // requestCount is 2 — initial attempt + retry after refresh.
    expect(requestCount).toBe(2);
    // In-memory token is updated to the refreshed value.
    expect(getAccessToken()).toBe("new-access-token");
  });

  it("surfaces the 401 response when refresh token is absent (no retry possible)", async () => {
    // Only an access token, no refresh token — simulates a degraded session.
    await saveTokens("access-only-token", "");

    setMockFetchHandler((url) => {
      if (url.includes("/api/auth/refresh")) {
        return jsonOk({ error: "no_refresh_token" }, 401);
      }
      return new Response(null, { status: 401 });
    });

    const res = await resilientFetch("/api/cases");

    // With no refresh token resilientFetch cannot retry — the 401 is returned.
    expect(res.status).toBe(401);
  });
});

// ── Scenario 7: logout sequence ──────────────────────────────────────────────

describe("logout sequence", () => {
  it("clearTokens resets the hydration singleton so the next loadTokens re-reads the store", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(
      tokenBlob("initial-access", "initial-refresh"),
    );
    await loadTokens();
    expect(getAccessToken()).toBe("initial-access");
    expect(getIsHydrated()).toBe(true);

    // Simulate logout: tokens wiped from store.
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await clearTokens();

    expect(getAccessToken()).toBeNull();
    expect(getIsHydrated()).toBe(false);

    // After clearTokens, loadTokens starts a fresh read.
    await loadTokens();
    expect(getAccessToken()).toBeNull();
    expect(getIsHydrated()).toBe(true);
  });

  it("token is still in memory during the logout requests (before clearTokens)", async () => {
    // Prime in-memory token.
    await saveTokens("live-token", "live-refresh");
    expect(getAccessToken()).toBe("live-token");

    const callLog: string[] = [];
    setMockFetchHandler((url) => {
      if (url.includes("/api/auth/logout")) {
        // Record the token state at the time this request fires.
        callLog.push(`logout:${getAccessToken()}`);
        return jsonOk({ success: true });
      }
      return jsonOk({});
    });

    // Simulate what auth-context.logout() does: fire the server call,
    // THEN clear tokens.
    await Promise.allSettled([
      resilientFetch("/api/auth/logout", { method: "POST" }),
    ]);
    // Token is still live until we explicitly clear it.
    expect(getAccessToken()).toBe("live-token");
    expect(callLog).toEqual(["logout:live-token"]);

    await clearTokens();
    expect(getAccessToken()).toBeNull();
  });
});

// ── Scenario 8: setAuthRefresher / setAuthTokenGetter registration contract ──
//
// The module-level side-effects in query-client.ts (lines 929–947) call
// setAuthRefresher() and setAuthTokenGetter() from @workspace/api-client-react
// immediately when the module is loaded — before any React Query hook mounts or
// fires its first request.
//
// vitest.setup.ts replaces @workspace/api-client-react with a vi.mock() factory
// that provides fresh vi.fn() stubs per test file. When this test file does
// vi.unmock("@/lib/query-client") and imports the real implementation, those
// module-level calls fire against the stubs, leaving a call record we can
// inspect to confirm the registration happened before any test body ran.
describe("module-init wiring: setAuthRefresher and setAuthTokenGetter registration", () => {
  it("registers a callable refresher via setAuthRefresher before any protected fetch", async () => {
    const { setAuthRefresher } = await import("@workspace/api-client-react");
    const mock = vi.mocked(setAuthRefresher);

    // Must have been called at least once — at module load time.
    expect(mock).toHaveBeenCalled();

    // The most-recent registration must be a callable function (not undefined or null).
    const registeredFn = mock.mock.calls[mock.mock.calls.length - 1]?.[0];
    expect(typeof registeredFn).toBe("function");
  });

  it("registers a callable token getter via setAuthTokenGetter before any protected fetch", async () => {
    const { setAuthTokenGetter } = await import("@workspace/api-client-react");
    const mock = vi.mocked(setAuthTokenGetter);

    expect(mock).toHaveBeenCalled();

    const registeredFn = mock.mock.calls[mock.mock.calls.length - 1]?.[0];
    expect(typeof registeredFn).toBe("function");
  });
});

// ── Scenario 9: no legacy /api/legacy routing ────────────────────────────────
//
// All case mutations must route to the canonical /api/cases endpoint.
// resilientFetch must never construct or forward a URL containing /api/legacy/
// for case create/update requests. This is the regression guard for the
// dual-path routing that was removed in Phase 1.
describe("no legacy routing: resilientFetch targets /api/cases for case mutations", () => {
  it("POST to /api/cases goes to the canonical endpoint (no /legacy/ in URL)", async () => {
    await saveTokens("no-legacy-access", "no-legacy-refresh");

    const capturedUrls: string[] = [];
    setMockFetchHandler((url) => {
      capturedUrls.push(url);
      return jsonOk({ ok: true, data: { id: "c-001" } });
    });

    const res = await resilientFetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseNumber: "TEST001", labOrganizationId: "org-1" }),
    });

    expect(res.ok).toBe(true);
    // At least one request must have targeted /api/cases.
    expect(capturedUrls.some((u) => u.includes("/api/cases"))).toBe(true);
    // No request — including auth retries — may contain a legacy path segment.
    for (const url of capturedUrls) {
      expect(url).not.toContain("/legacy/");
    }
  });

  it("PATCH to /api/cases/:id goes to the canonical endpoint (no /legacy/ in URL)", async () => {
    await saveTokens("no-legacy-patch-access", "no-legacy-patch-refresh");

    const capturedUrls: string[] = [];
    setMockFetchHandler((url) => {
      capturedUrls.push(url);
      return jsonOk({ ok: true, data: { id: "c-001" } });
    });

    const res = await resilientFetch("/api/cases/c-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });

    expect(res.ok).toBe(true);
    for (const url of capturedUrls) {
      expect(url).not.toContain("/legacy/");
    }
  });
});
