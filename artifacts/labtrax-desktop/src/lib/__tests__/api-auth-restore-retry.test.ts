import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadApiWithKeychain(getTokensStatus: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("window", {
    electronAPI: {
      auth: {
        getTokensStatus,
        setTokens: vi.fn(async () => true),
        clearTokens: vi.fn(async () => true),
      },
    },
  });
  const api = await import("../api");
  await api.waitForTokenHydration();
  return api;
}

describe("saved desktop sign-in retry", () => {
  it("restores tokens through the existing bridge after keychain access returns without logging them", async () => {
    const savedTokens = {
      accessToken: "private-access",
      refreshToken: "private-refresh",
    };
    const getTokensStatus = vi.fn()
      .mockResolvedValueOnce({ status: "keychain-unavailable" })
      .mockResolvedValueOnce({ status: "ok", tokens: savedTokens });
    const api = await loadApiWithKeychain(getTokensStatus);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(api.getAuthRestoreStatus()).toBe("keychain-unavailable");
      await expect(api.retrySavedAuthRestore()).resolves.toBe("ok");
      expect(api.getAccessToken()).toBe(savedTokens.accessToken);
      expect(api.getAuthRestoreStatus()).toBe("ok");
      expect(getTokensStatus).toHaveBeenCalledTimes(2);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("does not replace a manual sign-in that completes during a pending keychain retry", async () => {
    let releaseStatus!: (value: {
      status: "ok";
      tokens: { accessToken: string; refreshToken: string };
    }) => void;
    const pendingStatus = new Promise<{
      status: "ok";
      tokens: { accessToken: string; refreshToken: string };
    }>((resolve) => {
      releaseStatus = resolve;
    });
    const getTokensStatus = vi.fn()
      .mockResolvedValueOnce({ status: "keychain-unavailable" })
      .mockImplementationOnce(() => pendingStatus);
    const api = await loadApiWithKeychain(getTokensStatus);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          accessToken: "manual-access",
          refreshToken: "manual-refresh",
          user: { id: "manual-user", username: "labuser" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const retry = api.retrySavedAuthRestore();
    await api.login("labuser", "password");
    releaseStatus({
      status: "ok",
      tokens: { accessToken: "old-access", refreshToken: "old-refresh" },
    });

    await expect(retry).resolves.toBe("keychain-unavailable");
    expect(api.getAccessToken()).toBe("manual-access");
  });
});
