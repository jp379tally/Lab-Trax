import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../api", () => ({ apiUrl: (path: string) => "https://synthetic.invalid/api" + path }));
import { createBackupContinuation, getBackupContinuation } from "../backup-continuation";
afterEach(() => vi.unstubAllGlobals());
describe("backup transport independent of the login session", () => {
  it("polls, downloads and finalizes only its own run without cookies or general auth", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const run = createBackupContinuation("my-run", "synthetic-token", { "X-LabTrax-Backup-Source": "production" });
    await run.status(); await run.download(); await run.report({ status: "success", source: "interval", downloadRunId: "other-run" });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      "https://synthetic.invalid/api/admin/backup/status/my-run",
      "https://synthetic.invalid/api/admin/backup/download/my-run",
      "https://synthetic.invalid/api/admin/backup/desktop-run-report",
    ]);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).not.toContain("synthetic-token"); expect(options.credentials).toBe("omit");
      expect(options.headers["X-LabTrax-Backup-Continuation"]).toBe("synthetic-token");
      expect(options.headers.Authorization).toBeUndefined(); expect(options.headers["X-Platform-Admin-Pin"]).toBeUndefined();
    }
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({ source: "manual", downloadRunId: "my-run" });
  });
  it("makes the in-memory transport available only to its initiating owner/run", () => {
    const run = createBackupContinuation("owner-run", "synthetic-token", {}, "owner-a");
    expect(getBackupContinuation("owner-run", "owner-a")).toBe(run);
    expect(getBackupContinuation("owner-run", "owner-b")).toBeUndefined();
    expect(getBackupContinuation("different-run", "owner-a")).toBeUndefined();
    expect(getBackupContinuation("owner-run")).toBeUndefined();
  });
  it("does not refresh or switch user accounts on a failed continuation", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 401 })); vi.stubGlobal("fetch", fetcher);
    const run = createBackupContinuation("old-run", "synthetic-token", {});
    await expect(run.status()).rejects.toMatchObject({ status: 401 }); expect(fetcher).toHaveBeenCalledOnce();
  });
});
