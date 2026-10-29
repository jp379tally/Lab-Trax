import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyManualBackupLiveStatus,
  getManualBackupProgress,
  resetManualBackupProgress,
  subscribeManualBackupProgress,
} from "../manual-backup-progress";

describe("manual backup progress lifetime", () => {
  afterEach(() => {
    resetManualBackupProgress("", "");
  });

  it("retains the same active run and terminal result across subscriber teardown and reconnect", () => {
    const runId = "1ccda7a0-f02b-4e47-8792-969054f15f63";
    resetManualBackupProgress(runId, "Generating archive", 1234);
    const firstListener = vi.fn();
    const unsubscribe = subscribeManualBackupProgress(firstListener);
    unsubscribe();

    applyManualBackupLiveStatus({
      runId,
      state: "awaiting_verification",
      phase: "desktop verification",
      overallProgress: 97,
      elapsedMs: 3000,
      metrics: {},
    });
    const returningListener = vi.fn();
    const stopReturning = subscribeManualBackupProgress(returningListener);
    expect(getManualBackupProgress()).toMatchObject({
      state: "running",
      runId,
      phase: "desktop verification",
      liveStatus: { overallProgress: 97 },
    });
    stopReturning();

    applyManualBackupLiveStatus({
      runId,
      state: "completed",
      phase: "backup complete",
      overallProgress: 100,
      elapsedMs: 4000,
      metrics: {},
      result: {
        size: 4096,
        completedAt: "2026-10-21T12:00:00.000Z",
        fileName: "labtrax-backup.zip.enc",
        archiveKind: "complete-production",
      },
    });
    expect(getManualBackupProgress()).toMatchObject({
      state: "completed",
      runId,
      liveStatus: { overallProgress: 100 },
      result: { size: 4096, fileName: "labtrax-backup.zip.enc" },
    });
  });

  it("keeps failed or partial runs from becoming completed recovery points", () => {
    const runId = "edc74c71-ea9f-4ce5-94f8-d45460380e0f";
    resetManualBackupProgress(runId, "Uploading archive", 1234);
    applyManualBackupLiveStatus({
      runId,
      state: "failed",
      phase: "backup failed",
      overallProgress: 99,
      elapsedMs: 3000,
      metrics: {},
      error: "Destination verification failed.",
    });
    expect(getManualBackupProgress()).toMatchObject({
      state: "failed",
      error: "Destination verification failed.",
      liveStatus: { overallProgress: 99, state: "failed" },
    });
  });
});
