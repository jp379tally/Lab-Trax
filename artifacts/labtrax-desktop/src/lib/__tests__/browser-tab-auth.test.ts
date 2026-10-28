/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN_STORAGE_KEY = "labtrax_desktop_tokens_v1";
const TAB_TOKEN_STORAGE_KEY = "labtrax_desktop_tab_tokens_v1";
let removePagehideListener: (() => void) | null = null;

beforeEach(() => {
  removePagehideListener?.();
  removePagehideListener = null;
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  delete (window as Window & { electronAPI?: unknown }).electronAPI;
});

afterEach(() => {
  removePagehideListener?.();
  removePagehideListener = null;
  vi.unstubAllGlobals();
  delete (window as Window & { electronAPI?: unknown }).electronAPI;
});

function successfulLoginResponse() {
  return new Response(
    JSON.stringify({
      success: true,
      accessToken: "browser-access",
      refreshToken: "browser-refresh",
      user: { id: "browser-user", username: "browser" },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("browser tab authentication storage", () => {
  it.each([true, false])(
    "keeps browser credentials tab-scoped when Remember me is %s",
    async (rememberMe) => {
      const fetchMock = vi.fn(async () => successfulLoginResponse());
      vi.stubGlobal("fetch", fetchMock);
      const api = await import("../api");
      await api.waitForTokenHydration();

      await api.login("browser", "password", rememberMe);

      expect(api.getAccessToken()).toBe("browser-access");
      expect(sessionStorage.getItem(TAB_TOKEN_STORAGE_KEY)).toEqual(
        JSON.stringify({
          accessToken: "browser-access",
          refreshToken: "browser-refresh",
        }),
      );
      expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
      expect(api.getRememberMe()).toBe(false);
    },
  );

  it("ignores and removes a legacy persistent browser token", async () => {
    localStorage.setItem(
      TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken: "stale-access",
        refreshToken: "stale-refresh",
      }),
    );
    localStorage.setItem("labtrax_desktop_remember_me_v1", "true");

    const api = await import("../api");
    await api.waitForTokenHydration();

    expect(api.getAccessToken()).toBeNull();
    expect(api.getAuthRestoreStatus()).toBe("empty");
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(api.getRememberMe()).toBe(false);
  });

  it("requires a fresh sign-in after pagehide even if revocation fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(successfulLoginResponse())
      .mockRejectedValueOnce(new Error("shutdown request dropped"));
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("../api");
    await api.waitForTokenHydration();
    await api.login("browser", "password", true);

    removePagehideListener = api.installBrowserTabCloseSignOut();
    window.dispatchEvent(new Event("pagehide"));

    expect(api.getAccessToken()).toBeNull();
    expect(sessionStorage.getItem(TAB_TOKEN_STORAGE_KEY)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [logoutUrl, logoutInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(logoutUrl).toBe("/api/auth/logout");
    expect(logoutInit).toMatchObject({
      method: "POST",
      keepalive: true,
      headers: {
        Authorization: "Bearer browser-access",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    // A fresh renderer has no tab token to hydrate, even when the best-effort
    // server request was dropped during shutdown.
    vi.resetModules();
    const freshTabApi = await import("../api");
    await freshTabApi.waitForTokenHydration();
    expect(freshTabApi.getAccessToken()).toBeNull();
  });

  it("keeps Electron's encrypted remembered-token bridge unchanged", async () => {
    const setTokens = vi.fn(async () => undefined);
    const clearTokens = vi.fn(async () => undefined);
    const savedTokens = {
      accessToken: "keychain-access",
      refreshToken: "keychain-refresh",
    };
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        auth: {
          getTokens: vi.fn(async () => savedTokens),
          getTokensStatus: vi.fn(async () => ({ status: "ok", tokens: savedTokens })),
          setTokens,
          clearTokens,
        },
      },
    });
    localStorage.setItem("labtrax_desktop_remember_me_v1", "true");
    const fetchMock = vi.fn(async () => successfulLoginResponse());
    vi.stubGlobal("fetch", fetchMock);

    const api = await import("../api");
    await api.waitForTokenHydration();

    expect(api.isElectronRenderer()).toBe(true);
    expect(api.getAccessToken()).toBe("keychain-access");
    await api.login("browser", "password", true);
    expect(setTokens).toHaveBeenCalledWith({
      accessToken: "browser-access",
      refreshToken: "browser-refresh",
    });
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("does not install a tab-close logout handler in Electron", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { auth: { getTokens: vi.fn(async () => null), setTokens: vi.fn(), clearTokens: vi.fn() } },
    });
    const api = await import("../api");
    await api.waitForTokenHydration();

    const removeListener = api.installBrowserTabCloseSignOut();
    window.dispatchEvent(new Event("pagehide"));

    expect(fetchMock).not.toHaveBeenCalled();
    removeListener();
  });
});
