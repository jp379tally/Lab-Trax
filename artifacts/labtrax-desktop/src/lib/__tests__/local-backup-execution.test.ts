import { describe, expect, it, vi } from "vitest";
import {
  BACKUP_HISTORY_UNCONFIRMED_MESSAGE,
  DESKTOP_BACKUP_HISTORY_REPORT_TIMEOUT_MS,
  executeLocalBackup,
  watchBackupLiveStatus,
  type LocalBackupExecutionDeps,
  type LocalBackupLiveStatus,
} from "../local-backup-execution";
import { apiFetch as realApiFetch } from "../api";

function deps(overrides: Partial<LocalBackupExecutionDeps> = {}): LocalBackupExecutionDeps {
  return {
    apiFetch: vi.fn(async () => ({ completedAt: "2026-10-13T18:00:00Z" })) as LocalBackupExecutionDeps["apiFetch"],
    apiFetchArrayBuffer: vi.fn(),
    downloadBackupToFolder: vi.fn(async () => ({ fileName: "full.zip", path: "/backups/full.zip", sizeBytes: 33_000_000_000 })),
    ...overrides,
  };
}

describe("local backup write/report ownership", () => {
  it.each([
    ["ENOSPC /private/usb-path", "System error: ENOSPC."],
    ["Stage: recovery capture. Provider returned HTTP 503. https://private.invalid/token", "HTTP 503"],
    ["The backup has a missing integrity footer. /private/backup.zip.enc", "verification failed"],
  ])("shows the safe local failure stage and reason for %s", async (diagnostic, expected) => {
    const d = deps({ downloadBackupToFolder: vi.fn(async () => { throw new Error(diagnostic); }) });
    let message = "";
    try {
      await executeLocalBackup(d, "/synthetic-usb", "manual");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Stage:");
    expect(message).toContain(expected);
    expect(message).not.toContain("/private/");
    expect(message).not.toContain("private.invalid");
  });

  it("preserves streamed partial warnings and the selected source through desktop delivery", async () => {
    const sourceHeaders = { "X-LabTrax-Backup-Source": "production" };
    const d = deps({ sourceHeaders, downloadBackupToFolder: vi.fn(async () => ({
      fileName: "partial.zip.enc", path: "/synthetic-usb/partial.zip.enc", sizeBytes: 2_000_000,
      missingFileCount: 1, partialFailure: true, warnings: "One original missing; not a complete recovery point.",
    })) });
    const result = await executeLocalBackup(d, "/synthetic-usb", "manual");
    expect(d.downloadBackupToFolder).toHaveBeenCalledWith("/synthetic-usb", "manual", sourceHeaders);
    expect(result).toMatchObject({ partialFailure: true, missingFileCount: 1,
      warnings: "One original missing; not a complete recovery point." });
  });
  it("streams large manual backups to disk and reports the verified size without buffering", async () => {
    const d = deps();
    const result = await executeLocalBackup(d, "/backups", "manual");
    expect(d.apiFetchArrayBuffer).not.toHaveBeenCalled();
    expect(d.downloadBackupToFolder).toHaveBeenCalledWith("/backups", "manual");
    expect(result.sizeBytes).toBe(33_000_000_000);
    expect(JSON.parse((d.apiFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body)).toMatchObject({
      status: "success", source: "manual", sizeBytes: 33_000_000_000,
    });
  });

  it("refuses a rejected success report and never adds a second history row", async () => {
    const d = deps({ apiFetch: vi.fn(async () => ({ rejected: true, warning: "The archive was too small." })) as LocalBackupExecutionDeps["apiFetch"] });
    await expect(executeLocalBackup(d, "/backups")).rejects.toThrow(
      "The backup did not complete, so no new complete recovery point was created.",
    );
    expect(d.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("bounds a pending success report, aborts it, and does not send a contradictory failure report", async () => {
    vi.useFakeTimers();
    try {
      let resolveReport!: (value: { completedAt: string }) => void;
      let reportSignal: AbortSignal | undefined;
      const pendingReport = new Promise<{ completedAt: string }>((resolve) => {
        resolveReport = resolve;
      });
      const d = deps({
        apiFetch: vi.fn((_endpoint, init) => {
          reportSignal = init?.signal;
          return pendingReport;
        }) as LocalBackupExecutionDeps["apiFetch"],
      });
      const run = executeLocalBackup(d, "/backups", "manual");
      const rejected = expect(run).rejects.toThrow(BACKUP_HISTORY_UNCONFIRMED_MESSAGE);
      await Promise.resolve();
      await Promise.resolve();
      expect(d.downloadBackupToFolder).toHaveBeenCalledTimes(1);
      expect(d.apiFetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse((d.apiFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body))
        .toMatchObject({ status: "success" });

      await vi.advanceTimersByTimeAsync(DESKTOP_BACKUP_HISTORY_REPORT_TIMEOUT_MS);
      await rejected;
      expect(reportSignal?.aborted).toBe(true);
      expect(d.apiFetch).toHaveBeenCalledTimes(1);

      // A late response is ambiguous and must not convert this run into a
      // locally confirmed success after the progress deadline has ended.
      resolveReport({ completedAt: "2026-10-13T18:00:00Z" });
      await Promise.resolve();
      expect(d.apiFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the real apiFetch network request at the history deadline without retrying", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const d = deps({
        apiFetch: realApiFetch as LocalBackupExecutionDeps["apiFetch"],
      });
      const run = executeLocalBackup(d, "/backups", "manual");
      const rejected = expect(run).rejects.toThrow(BACKUP_HISTORY_UNCONFIRMED_MESSAGE);

      for (let i = 0; i < 8 && fetchMock.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(d.downloadBackupToFolder).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, request] = fetchMock.mock.calls[0]!;
      expect(url).toBe("/api/admin/backup/desktop-run-report");
      expect(request?.method).toBe("POST");
      expect(JSON.parse(String(request?.body))).toMatchObject({ status: "success" });
      expect(request?.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(DESKTOP_BACKUP_HISTORY_REPORT_TIMEOUT_MS);
      await rejected;

      expect(request?.signal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(d.downloadBackupToFolder).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("accepts a timed-out report only when history confirms the exact run succeeded", async () => {
    vi.useFakeTimers();
    try {
      const downloadRunId = "0ad043e2-854a-4507-bec4-f99750738096";
      const completedAt = "2026-10-13T18:00:00.000Z";
      const pendingReport = new Promise<{ completedAt: string }>(() => {});
      const d = deps({
        downloadBackupToFolder: vi.fn(async () => ({
          fileName: "full.zip",
          path: "/backups/full.zip",
          sizeBytes: 33_000_000_000,
          downloadRunId,
        })),
        apiFetch: vi.fn((endpoint) => {
          if (endpoint === "/admin/backup/desktop-run-report") return pendingReport;
          if (endpoint === `/admin/backup/history/by-download-run/${downloadRunId}`) {
            return Promise.resolve({ ok: true, run: { downloadRunId, status: "success", completedAt } });
          }
          throw new Error(`unexpected apiFetch: ${endpoint}`);
        }) as LocalBackupExecutionDeps["apiFetch"],
      });
      const run = executeLocalBackup(d, "/backups", "manual");
      const completed = expect(run).resolves.toMatchObject({ downloadRunId, completedAt });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(DESKTOP_BACKUP_HISTORY_REPORT_TIMEOUT_MS);
      await completed;

      const calls = (d.apiFetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.filter(([endpoint]) => endpoint === "/admin/backup/desktop-run-report")).toHaveLength(1);
      expect(calls.filter(([endpoint]) => endpoint === `/admin/backup/history/by-download-run/${downloadRunId}`)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["a recorded failure", { ok: true, run: { downloadRunId: "0ad043e2-854a-4507-bec4-f99750738096", status: "error", completedAt: "2026-10-13T18:00:00Z" } }],
    ["a missing run", { ok: true, run: null }],
    ["an ambiguous lookup", new Error("history endpoint unavailable")],
  ])("leaves a timed-out backup unconfirmed after %s without reporting it again", async (_label, lookup) => {
    vi.useFakeTimers();
    try {
      const downloadRunId = "0ad043e2-854a-4507-bec4-f99750738096";
      const pendingReport = new Promise<{ completedAt: string }>(() => {});
      const d = deps({
        downloadBackupToFolder: vi.fn(async () => ({
          fileName: "full.zip", path: "/backups/full.zip", sizeBytes: 33_000_000_000, downloadRunId,
        })),
        apiFetch: vi.fn((endpoint) => {
          if (endpoint === "/admin/backup/desktop-run-report") return pendingReport;
          if (endpoint === `/admin/backup/history/by-download-run/${downloadRunId}`) {
            return lookup instanceof Error ? Promise.reject(lookup) : Promise.resolve(lookup);
          }
          throw new Error(`unexpected apiFetch: ${endpoint}`);
        }) as LocalBackupExecutionDeps["apiFetch"],
      });
      const run = executeLocalBackup(d, "/backups", "manual");
      const rejected = expect(run).rejects.toThrow(BACKUP_HISTORY_UNCONFIRMED_MESSAGE);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(DESKTOP_BACKUP_HISTORY_REPORT_TIMEOUT_MS);
      await rejected;

      const calls = (d.apiFetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.filter(([endpoint]) => endpoint === "/admin/backup/desktop-run-report")).toHaveLength(1);
      expect(calls.filter(([endpoint]) => endpoint === `/admin/backup/history/by-download-run/${downloadRunId}`)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("also bounds a pending failure-history report", async () => {
    vi.useFakeTimers();
    try {
      const d = deps({
        downloadBackupToFolder: vi.fn(async () => { throw new Error("Disk write failed."); }),
        apiFetch: vi.fn(() => new Promise(() => {})) as LocalBackupExecutionDeps["apiFetch"],
      });
      const run = executeLocalBackup(d, "/backups");
      const rejected = expect(run).rejects.toThrow(
        "The backup did not complete, so no new complete recovery point was created.",
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(d.apiFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(DESKTOP_BACKUP_HISTORY_REPORT_TIMEOUT_MS);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a generation/write failure with its phase and does not claim success", async () => {
    const d = deps({ downloadBackupToFolder: vi.fn(async () => { throw new Error("App Storage stalled"); }) });
    await expect(executeLocalBackup(d, "/backups")).rejects.toThrow(
      "The backup did not complete, so no new complete recovery point was created.",
    );
    expect(JSON.parse((d.apiFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body)).toMatchObject({
      status: "error", error: expect.stringContaining("App Storage stalled"),
    });
  });

  it("reports a missing streamed-backup integrity footer as an error, never a success", async () => {
    const d = deps({
      downloadBackupToFolder: vi.fn(async () => {
        throw new Error("The downloaded archive is incomplete or missing a valid integrity footer.");
      }),
    });
    await expect(executeLocalBackup(d, "/backups")).rejects.toThrow(
      "The backup did not complete, so no new complete recovery point was created.",
    );
    const reports = (d.apiFetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([endpoint]) => endpoint === "/admin/backup/desktop-run-report");
    expect(reports).toHaveLength(1);
    expect(JSON.parse(reports[0]![1].body)).toMatchObject({
      status: "error",
      error: expect.stringContaining("integrity footer"),
    });
  });

  it("verifies the buffered fallback before writing or reporting success", async () => {
    const saveBackupToFolder = vi.fn(async () => ({ ok: true, path: "/backups/full.zip" }));
    const downloadRunId = "1b9fc541-9f38-4991-9a0c-5f8445016197";
    const apiFetchArrayBuffer = vi.fn(async () => ({
      buffer: new TextEncoder().encode("LTR2".padEnd(64, "x")).buffer,
      headers: new Headers({
        "x-backup-run-id": downloadRunId,
        "x-backup-archive-kind": "complete-non-production",
        "x-backup-coverage-version": "1",
        "x-backup-media-file-count": "1",
        "x-backup-attachment-row-count": "1",
      }),
    }));
    const d = deps({
      downloadBackupToFolder: undefined,
      apiFetchArrayBuffer,
      saveBackupToFolder,
    });
    await expect(executeLocalBackup(d, "/backups")).rejects.toThrow(
      "The backup did not complete, so no new complete recovery point was created.",
    );
    expect(saveBackupToFolder).not.toHaveBeenCalled();
    const report = JSON.parse((d.apiFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
    expect(report).toMatchObject({ status: "error", downloadRunId });
  });

  it("refuses a buffered archive the server does not mark as complete coverage", async () => {
    const saveBackupToFolder = vi.fn(async () => ({ ok: true, path: "/backups/full.zip" }));
    const archive = new Uint8Array(76);
    archive.set(new TextEncoder().encode("LTR2"), 0);
    archive.set(new TextEncoder().encode("LTF1"), 64);
    new DataView(archive.buffer).setBigUint64(68, 64n, false);
    const d = deps({
      downloadBackupToFolder: undefined,
      apiFetchArrayBuffer: vi.fn(async () => ({
        buffer: archive.buffer,
        headers: new Headers({
          "x-backup-archive-kind": "database-only",
          "x-backup-coverage-version": "1",
          "x-backup-media-file-count": "0",
          "x-backup-attachment-row-count": "0",
        }),
      })),
      saveBackupToFolder,
    });
    await expect(executeLocalBackup(d, "/backups", "manual"))
      .rejects.toThrow("The backup did not complete, so no new complete recovery point was created.");
    expect(saveBackupToFolder).not.toHaveBeenCalled();
    const reports = (d.apiFetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([endpoint]) => endpoint === "/admin/backup/desktop-run-report");
    expect(reports).toHaveLength(1);
    // The short copy is for the UI; history keeps the refusal reason.
    expect(JSON.parse(reports[0]![1].body)).toMatchObject({
      status: "error",
      source: "manual",
      error: expect.stringContaining("complete database-and-files recovery evidence"),
    });
  });

  it("recovers the precise server failure using the download correlation id", async () => {
    const downloadRunId = "0ad043e2-854a-4507-bec4-f99750738096";
    const d = deps({
      downloadBackupToFolder: vi.fn(async () => { throw Object.assign(new Error("Connection closed"), { downloadRunId }); }),
      apiFetch: vi.fn(async () => ({ errorReason: "Backup failed during case-media transfer into archive after 60s: Object transfer stalled." })) as LocalBackupExecutionDeps["apiFetch"],
    });
    await expect(executeLocalBackup(d, "/backups")).rejects.toThrow(
      "The backup did not complete, so no new complete recovery point was created.",
    );
    expect(JSON.parse((d.apiFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body)).toMatchObject({
      status: "error", downloadRunId,
      error: expect.stringContaining("Connection closed"),
    });
  });

  it("subscribes to server progress as soon as Electron receives the run UUID", async () => {
    const runId = "0ad043e2-854a-4507-bec4-f99750738096";
    let emitRunId: ((value: string) => void) | undefined;
    let resolveDownload!: (saved: { fileName: string; path: string; sizeBytes: number; downloadRunId: string }) => void;
    const liveStatus: LocalBackupLiveStatus = {
      runId,
      state: "running",
      phase: "database dump",
      elapsedMs: 1200,
      metrics: { dumpBytes: 1024 },
    };
    const onLiveStatus = vi.fn();
    const d = deps({
      downloadBackupToFolder: vi.fn(() => new Promise((resolve) => { resolveDownload = resolve; })),
      onDownloadRunId: vi.fn((listener) => { emitRunId = listener; return vi.fn(); }),
      getLiveStatus: vi.fn(async () => liveStatus),
      onLiveStatus,
    });
    const pending = executeLocalBackup(d, "/backups", "manual");
    emitRunId?.(runId);
    await vi.waitFor(() => expect(onLiveStatus).toHaveBeenCalledWith(liveStatus));
    resolveDownload({ fileName: "full.zip", path: "/backups/full.zip", sizeBytes: 1024, downloadRunId: runId });
    await pending;
    expect(JSON.parse((d.apiFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body)).toMatchObject({
      status: "success",
      downloadRunId: runId,
    });
  });

  it("stops polling when a terminal server status is received", async () => {
    const status: LocalBackupLiveStatus = {
      runId: "0ad043e2-854a-4507-bec4-f99750738096",
      state: "completed",
      phase: "backup complete",
      elapsedMs: 4200,
      metrics: { archiveBytes: 1000 },
    };
    const getLiveStatus = vi.fn(async () => status);
    const onLiveStatus = vi.fn();
    const stop = watchBackupLiveStatus(status.runId, getLiveStatus, onLiveStatus, 1);
    await vi.waitFor(() => expect(onLiveStatus).toHaveBeenCalledWith(status));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getLiveStatus).toHaveBeenCalledTimes(1);
    stop();
  });

  it("retries live status polling after a temporary disconnect", async () => {
    const status: LocalBackupLiveStatus = {
      runId: "0ad043e2-854a-4507-bec4-f99750738096",
      state: "running",
      phase: "OneDrive transfer",
      elapsedMs: 9000,
      metrics: { uploadedBytes: 2048, uploadTotalBytes: 4096 },
    };
    const getLiveStatus = vi.fn()
      .mockRejectedValueOnce(new Error("temporary network error"))
      .mockResolvedValueOnce(status);
    let stop = () => {};
    const onLiveStatus = vi.fn(() => stop());
    stop = watchBackupLiveStatus(status.runId, getLiveStatus, onLiveStatus, 1);
    await vi.waitFor(() => expect(onLiveStatus).toHaveBeenCalledWith(status));
    expect(getLiveStatus).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("backup progress polling reconnects after authorization failure", () => {
  it("reports the lost status connection without inventing a failed run, then resumes", async () => {
    vi.useFakeTimers();
    const denied = Object.assign(new Error("Sign in again"), { status: 401 });
    const status = { runId: "same-run", state: "running", phase: "case-media transfer into archive", elapsedMs: 1000, metrics: { completedBytes: 1024 } } as LocalBackupLiveStatus;
    const read = vi.fn().mockRejectedValueOnce(denied).mockResolvedValue(status);
    const update = vi.fn(); const disconnected = vi.fn();
    const stop = watchBackupLiveStatus("same-run", read, update, 1200, disconnected);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(disconnected).toHaveBeenCalledWith(denied);
      expect(update).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1200);
      expect(update).toHaveBeenCalledWith(status);
      expect(read).toHaveBeenCalledTimes(2);
    } finally { stop(); vi.useRealTimers(); }
  });
});
