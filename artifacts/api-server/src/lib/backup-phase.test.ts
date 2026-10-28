import { afterEach, describe, expect, it, vi } from "vitest";
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const persistence = vi.hoisted(() => ({ rows: new Map<string, any>() }));
vi.mock("./logger", () => ({ logger: logs }));
vi.mock("./backup-live-status-store", () => ({
  saveBackupLiveStatus: vi.fn(async (status) => {
    persistence.rows.set(status.runId, { ...status, metrics: { ...status.metrics } });
  }),
  readBackupLiveStatus: vi.fn(async (runId) => {
    const status = persistence.rows.get(runId);
    return status ? { ...status, metrics: { ...status.metrics } } : undefined;
  }),
  pruneBackupLiveStatuses: vi.fn(async (now, staleRunMs, liveStatusTtlMs, maxLiveRuns) => {
    for (const [runId, status] of persistence.rows) {
      const updatedAt = Date.parse(status.updatedAt);
      if ((status.state === "running" || status.state === "awaiting_verification") &&
          now - updatedAt > staleRunMs) {
        persistence.rows.set(runId, {
          ...status,
          state: "stale",
          phase: "backup failed",
          updatedAt: new Date(now).toISOString(),
        });
      } else if (status.state !== "running" && status.state !== "awaiting_verification" &&
          now - updatedAt > liveStatusTtlMs) {
        persistence.rows.delete(runId);
      }
    }
    while (persistence.rows.size > maxLiveRuns) {
      const oldest = persistence.rows.keys().next().value;
      if (!oldest) break;
      persistence.rows.delete(oldest);
    }
  }),
}));
import {
  abortableBackupOperation,
  finishBackupLiveRun,
  getBackupLiveStatus,
  getBackupRunId,
  markBackupLiveAwaitingVerification,
  measureBackupPhase,
  overallBackupProgress,
  setBackupLiveArchiveEvidence,
  setBackupLiveProgress,
  setBackupLivePhase,
  withBackupRun,
} from "./backup-phase";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  persistence.rows.clear();
});
describe("backup phase timing and failure feedback", () => {
  it("reports conservative whole-run progress and reserves 100 for confirmed success", () => {
    expect(overallBackupProgress({
      state: "running",
      phase: "case-media transfer into archive",
      metrics: { completedBytes: 5, totalBytes: 10 },
    })).toBe(51);
    expect(overallBackupProgress({
      state: "awaiting_verification",
      phase: "desktop verification",
      metrics: {},
    })).toBe(97);
    expect(overallBackupProgress({
      state: "failed",
      phase: "backup complete",
      metrics: {},
    })).toBe(99);
    expect(overallBackupProgress({
      state: "completed",
      phase: "backup complete",
      metrics: {},
    })).toBe(100);
  });
  it("logs bounded sizes, elapsed time, heartbeat and a common run identity", async () => {
    vi.useFakeTimers();
    await withBackupRun(async () => {
      const pending = measureBackupPhase("database dump", async () => {
        await new Promise((resolve) => setTimeout(resolve, 31_000));
        return Buffer.alloc(100);
      }, () => ({ fileCount: 2 }), (buffer) => ({ dumpBytes: buffer.length }));
      await vi.advanceTimersByTimeAsync(31_000);
      await pending;
      await measureBackupPhase("archive assembly/encryption", async () => 1);
    });
    const records = logs.info.mock.calls.map(([record]) => record);
    expect(records[1]).toMatchObject({ phase: "database dump", elapsedMs: 30_000, fileCount: 2 });
    expect(records[2]).toMatchObject({ dumpBytes: 100, elapsedMs: 31_000 });
    expect(new Set(records.map((record) => record.runId)).size).toBe(1);
    expect(records[0].runId).toBeTruthy();
  });

  it("records completed media phase throughput alongside the captured byte totals", async () => {
    vi.useFakeTimers();
    const pending = measureBackupPhase(
      "case-media transfer into archive",
      async () => {
        await new Promise(resolve => setTimeout(resolve, 2_000));
        return 12_000;
      },
      () => ({ completedBytes: 12_000, totalBytes: 12_000, mediaBytesPerSecond: 6_000 }),
      bytes => ({ completedBytes: bytes, totalBytes: bytes, mediaBytesPerSecond: 6_000 }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    const completion = logs.info.mock.calls
      .map(([record, message]) => ({ record, message }))
      .find(({ record, message }) => record.phase === "case-media transfer into archive" &&
        message === "[backup] phase completed");
    expect(completion?.record).toMatchObject({
      elapsedMs: 2_000,
      completedBytes: 12_000,
      totalBytes: 12_000,
      mediaBytesPerSecond: 6_000,
      throughputBytesPerSecond: 6_000,
    });
  });

  it("returns a useful phase-specific reason without logging credentials or signed URLs", async () => {
    await expect(measureBackupPhase("OneDrive transfer", async () => {
      throw new Error("HTTP 503 https://user:password@storage.example/file?token=signed token=abc");
    })).rejects.toThrow("Backup failed during OneDrive transfer");
    const logged = JSON.stringify(logs.error.mock.calls);
    expect(logged).toContain("HTTP 503");
    expect(logged).not.toContain("signed");
    expect(logged).not.toContain("password");
    expect(logged).not.toContain("abc");
  });

  it("bounds an inventory/verification call that never settles", async () => {
    const controller = new AbortController();
    const pending = abortableBackupOperation(new Promise<void>(() => {}), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("aborted during this phase");
  });

  it("keeps only allowlisted numeric progress and retains deferred runs through desktop verification", async () => {
    let runId = "";
    await withBackupRun(async () => {
      runId = getBackupRunId()!;
      setBackupLivePhase("database dump", {
        dumpBytes: 1234,
        fileCount: Number.POSITIVE_INFINITY,
      } as Record<string, number>);
      await markBackupLiveAwaitingVerification(runId);
    });
    expect(await getBackupLiveStatus(runId)).toMatchObject({
      runId,
      state: "awaiting_verification",
      phase: "desktop verification",
      metrics: { dumpBytes: 1234 },
    });
    expect(JSON.stringify(await getBackupLiveStatus(runId))).not.toMatch(/path|objectName/);
    await finishBackupLiveRun(runId, "completed");
    expect((await getBackupLiveStatus(runId))?.state).toBe("completed");
  });

  it("exposes measured inventory counters and only server-bound complete archive evidence", async () => {
    let runId = "";
    await withBackupRun(async () => {
      runId = getBackupRunId()!;
      setBackupLivePhase("case-media inventory and reference validation", { tableCount: 4 });
      setBackupLiveProgress({
        tablesCompleted: 2, tableCount: 4, rowsScanned: 512, rowsPerSecond: 42, secretLabel: 7,
      });
      setBackupLiveArchiveEvidence({
        archiveKind: "complete-non-production",
        coverageVersion: 1,
        mediaFileCount: 8,
        attachmentRowCount: 12,
      });
      // A status poll replaces the local record with the shared one; the
      // evidence must survive that round trip, not only the final write.
      await getBackupLiveStatus(runId);
    });
    const expected = {
      state: "completed",
      phase: "backup complete",
      metrics: { tablesCompleted: 2, tableCount: 4, rowsScanned: 512, rowsPerSecond: 42 },
      archiveEvidence: {
        archiveKind: "complete-non-production",
        coverageVersion: 1,
        mediaFileCount: 8,
        attachmentRowCount: 12,
      },
    };
    expect(await getBackupLiveStatus(runId)).toMatchObject(expected);
    expect(JSON.stringify(await getBackupLiveStatus(runId))).not.toContain("secretLabel");
    vi.resetModules();
    const restartedInstance = await import("./backup-phase");
    expect(await restartedInstance.getBackupLiveStatus(runId)).toMatchObject(expected);
  });

  it("marks failed server runs terminal for clients that reconnect", async () => {
    let runId = "";
    await expect(withBackupRun(async () => {
      runId = getBackupRunId()!;
      throw new Error("database dump failed");
    })).rejects.toThrow("database dump failed");
    expect(await getBackupLiveStatus(runId)).toMatchObject({
      state: "failed",
      phase: "backup failed",
    });
  });

  it("marks abandoned progress stale and removes terminal status after its retention window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
    let runId = "";
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => { started = resolve; });
    let resolveRun!: () => void;
    const pending = withBackupRun(async () => {
      runId = getBackupRunId()!;
      started();
      await new Promise<void>((resolve) => { resolveRun = resolve; });
    });
    await runStarted;
    vi.setSystemTime(new Date("2026-10-13T14:01:00.000Z"));
    expect((await getBackupLiveStatus(runId))?.state).toBe("stale");
    resolveRun();
    await pending;
    vi.setSystemTime(new Date("2026-10-13T14:32:00.000Z"));
    expect(await getBackupLiveStatus(runId)).toBeUndefined();
  });

  it("keeps progress readable by a fresh API process using the shared store", async () => {
    let runId = "";
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const running = withBackupRun(async () => {
      runId = getBackupRunId()!;
      setBackupLivePhase("OneDrive transfer", {
        uploadedBytes: 4096,
        uploadTotalBytes: 8192,
        signedUrl: 1,
      } as Record<string, number>);
      started();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    try {
      await runStarted;
      // The first instance flushes its latest coalesced snapshot to the shared
      // store before the independent module instance reads it.
      await getBackupLiveStatus(runId);
      vi.resetModules();
      const restartedInstance = await import("./backup-phase");
      expect(await restartedInstance.getBackupLiveStatus(runId)).toMatchObject({
        runId,
        state: "running",
        phase: "OneDrive transfer",
        metrics: { uploadedBytes: 4096, uploadTotalBytes: 8192 },
      });
      expect(JSON.stringify(await restartedInstance.getBackupLiveStatus(runId))).not.toContain("signedUrl");
    } finally {
      release();
      await running;
    }
  });
});
