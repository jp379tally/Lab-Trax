import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiFetch,
  getAuthRestoreStatus,
  login,
  notifySessionCleared,
} from "../api";

afterEach(() => {
  vi.unstubAllGlobals();
  notifySessionCleared();
});

describe("desktop login API contract", () => {
  it("submits the trimmed username through the supported desktop username/password flow", async () => {
    const user = { id: "user-1", username: "JPP" };
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          accessToken: "access-token",
          refreshToken: "refresh-token",
          user,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(login("JPP", "correct-password", false)).resolves.toEqual(user);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(JSON.parse(String(init.body))).toEqual({
      username: "JPP",
      password: "correct-password",
      deviceName: "LabTrax Desktop",
      clientType: "desktop",
    });
  });

  it("preserves the generic authentication rejection from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ success: false, message: "Invalid username or password." }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const rejection = login("unknown-user", "wrong-password");
    await expect(rejection).rejects.toBeInstanceOf(ApiError);
    await expect(rejection).rejects.toMatchObject({
      status: 401,
      message: "Invalid username or password.",
    });
  });

  it("explains an expired restored session after the server rejects its refresh token without logging tokens", async () => {
    const accessToken = "private-access-token";
    const refreshToken = "private-refresh-token";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            accessToken,
            refreshToken,
            user: { id: "user-1", username: "JPP" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Unauthorized." }), { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Session expired." }), { status: 401 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await login("JPP", "password", false);
      await expect(apiFetch("/auth/me")).rejects.toMatchObject({ status: 401 });

      expect(getAuthRestoreStatus()).toBe("session-expired");
      expect(JSON.stringify({ status: getAuthRestoreStatus() })).not.toContain(accessToken);
      expect(JSON.stringify({ status: getAuthRestoreStatus() })).not.toContain(refreshToken);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("does not mislabel a network failure during refresh as an expired session", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            accessToken: "access-token",
            refreshToken: "refresh-token",
            user: { id: "user-1", username: "JPP" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Unauthorized." }), { status: 401 }),
      )
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await login("JPP", "password", false);
    await expect(apiFetch("/auth/me")).rejects.toMatchObject({ status: 401 });

    expect(getAuthRestoreStatus()).toBe("ok");
  });
});
