import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  claim: vi.fn(), read: vi.fn(), log: vi.fn(), terminal: vi.fn(),
}));
vi.mock("./backup-live-status-store", () => ({
  claimManualBackupRun: mocks.claim,
  readBackupLiveStatus: mocks.read,
}));
vi.mock("./logger", () => ({ logger: { error: mocks.log } }));
vi.mock("./backup-phase", () => ({
  safeBackupError: () => "redacted phase failure",
  withBackupRun: async (work: () => Promise<unknown>, id: string) => {
    try { const result = await work(); mocks.terminal(id, "completed"); return result; }
    catch (error) { mocks.terminal(id, "failed"); throw error; }
  },
}));
import {
  cancelManualBackupJob,
  finishManualBackupJob,
  registerManualBackupCleanup,
  startManualBackupJob,
} from "./manual-backup-job";
const identity = { destination: "onedrive", archiveKind: "full", source: "development", actor: "synthetic" };
describe("manual cloud job acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue(true);
    mocks.read.mockResolvedValue({ state: "running" });
  });
  it("acknowledges persisted ownership while a long backup remains pending", async () => {
    let finish!: () => void;
    const work = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await startManualBackupJob("synthetic-run", identity, "test-user", "session-hash", work);
    expect(mocks.claim).toHaveBeenCalledBefore(work);
    expect(mocks.terminal).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(mocks.terminal).toHaveBeenCalledWith("synthetic-run", "completed"));
    finishManualBackupJob("synthetic-run");
  });
  it("does not start work when persistence fails", async () => {
    mocks.claim.mockRejectedValueOnce(new Error("shared status unavailable"));
    const work = vi.fn();
    await expect(startManualBackupJob("id", identity, "test-user", "session-hash", work)).rejects.toThrow("shared status unavailable");
    expect(work).not.toHaveBeenCalled();
  });
  it("starts duplicate runIds once and handles the detached rejection", async () => {
    mocks.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const work = vi.fn().mockRejectedValue(new Error("private signed URL"));
    await Promise.all([
      startManualBackupJob("id", identity, "test-user", "session-hash", work),
      startManualBackupJob("id", identity, "test-user", "session-hash", work),
    ]);
    await vi.waitFor(() => expect(mocks.log).toHaveBeenCalledTimes(1));
    expect(work).toHaveBeenCalledTimes(1);
    expect(mocks.terminal).toHaveBeenCalledExactlyOnceWith("id", "failed");
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("private signed URL");
    finishManualBackupJob("id");
  });

  it("aborts the active destination signal and cleans registered partial output once", async () => {
    let observedSignal: AbortSignal | undefined;
    const cleanup = vi.fn(async () => {});
    const work = vi.fn((signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    await startManualBackupJob("cancel-id", identity, "test-user", "session-hash", work);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    registerManualBackupCleanup("cancel-id", cleanup);

    cancelManualBackupJob("cancel-id");
    cancelManualBackupJob("cancel-id");

    expect(observedSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    finishManualBackupJob("cancel-id");
  });

  it("propagates a cancellation written by another API worker through shared status", async () => {
    let observedSignal: AbortSignal | undefined;
    const work = vi.fn((signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<void>(() => {});
    });
    await startManualBackupJob("remote-cancel-id", identity, "test-user", "session-hash", work);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    mocks.read.mockResolvedValue({ state: "cancelled" });
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true), { timeout: 3_000 });
  });
});
