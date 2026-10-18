/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

describe("desktop platform-admin request credentials", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    window.localStorage.clear();
    (window as Window & { electronAPI?: unknown }).electronAPI = undefined;
  });

  it("prefers a human-entered PIN over the Electron automation secret", async () => {
    (window as Window & { electronAPI?: unknown }).electronAPI = {
      platformAdmin: {
        getSecret: vi.fn().mockResolvedValue("automation-secret"),
        onChanged: vi.fn(),
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const session = await import("@/lib/platform-admin-session");
    session.setSessionSecret("1234");
    const { apiFetch } = await import("@/lib/api");
    await apiFetch("/admin/provider-subscriptions?limit=1");

    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
    expect(headers.get("X-Platform-Admin-Pin")).toBe("1234");
    expect(headers.has("X-Platform-Admin-Secret")).toBe(false);
  });
});