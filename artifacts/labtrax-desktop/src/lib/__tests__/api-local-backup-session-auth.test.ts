import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalBackupApiSession,
  getAccessToken,
  login,
  notifySessionCleared,
} from "../api";

afterEach(() => {
  vi.unstubAllGlobals();
  notifySessionCleared();
});

describe("local backup API session authentication", () => {
  it("keeps late status and report requests on the initiating account without refreshing", async () => {
    const credentialsByUsername = {
      accountA: { accessToken: "account-a-access", refreshToken: "account-a-refresh" },
      accountB: { accessToken: "account-b-access", refreshToken: "account-b-refresh" },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/login") {
        const { username } = JSON.parse(String(init?.body)) as { username: keyof typeof credentialsByUsername };
        return new Response(JSON.stringify({
          success: true,
          ...credentialsByUsername[username],
          user: { id: username, username },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "Unauthorized." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await login("accountA", "password", false);
    const backupSession = createLocalBackupApiSession();
    await login("accountB", "password", false);
    expect(getAccessToken()).toBe("account-b-access");

    await expect(
      backupSession.apiFetch("/admin/backup/status/run-1"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      backupSession.apiFetch("/admin/backup/desktop-run-report", {
        method: "POST",
        body: JSON.stringify({ status: "success" }),
      }),
    ).rejects.toMatchObject({ status: 401 });

    const requests = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      authorization: new Headers(init?.headers).get("Authorization"),
    }));
    expect(requests).toEqual([
      { url: "/api/auth/login", authorization: null },
      { url: "/api/auth/login", authorization: null },
      { url: "/api/admin/backup/status/run-1", authorization: "Bearer account-a-access" },
      { url: "/api/admin/backup/desktop-run-report", authorization: "Bearer account-a-access" },
    ]);
    expect(requests.some(({ url }) => url === "/api/auth/refresh")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
