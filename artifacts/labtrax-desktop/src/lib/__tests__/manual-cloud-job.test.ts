import { describe, expect, it, vi } from "vitest";
import { followManualBackup } from "@workspace/api-client-react";
const id = "ecb66dc2-b930-4cb3-9e59-843c1b796243";
const result = { runId: id, size: 123, fileName: "synthetic.enc", completedAt: "2026-10-21T00:00:00Z" };
describe("manual cloud backup tracking", () => {
  it("recovers the same run after an ambiguous gateway 502, without a second POST", async () => {
    const initiate = vi.fn().mockRejectedValue(Object.assign(new Error("Request failed (502)"), { status: 502 }));
    const read = vi.fn().mockResolvedValue({ runId: id, state: "completed", phase: "backup complete", result });
    expect(await followManualBackup(id, initiate, read)).toEqual(result);
    expect(initiate).toHaveBeenCalledTimes(1);
  });
  it("does not show success until a delayed run's exact verified history arrives", async () => {
    let now = 0;
    const initiate = vi.fn().mockResolvedValue({ runId: id, state: "running" });
    const read = vi.fn().mockResolvedValueOnce({ runId: id, state: "running", phase: "upload" })
      .mockResolvedValueOnce({ runId: id, state: "completed", phase: "backup complete", result });
    expect(await followManualBackup(id, initiate, read, undefined, {
      now: () => now, pause: async () => { now += 180_000; },
    })).toEqual(result);
    expect(now).toBe(180_000);
  });
  it("reports a failed phase and rejects another run's result", async () => {
    await expect(followManualBackup(id, async () => ({ state: "running" }),
      async () => ({ runId: id, state: "failed", phase: "OneDrive upload", error: "Reconnect OneDrive (HTTP 401)." })))
      .rejects.toThrow("Reconnect OneDrive");
    await expect(followManualBackup(id, async () => ({ state: "running" }),
      async () => ({ runId: id, state: "completed", phase: "done", result: { ...result, runId: "other" } })))
      .rejects.toThrow("exact verified history");
  });
});
