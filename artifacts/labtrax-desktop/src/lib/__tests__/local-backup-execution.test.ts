import { describe, expect, it, vi } from "vitest";
import {
  executeLocalBackup,
  watchBackupLiveStatus,
  type LocalBackupExecutionDeps,
  type LocalBackupLiveStatus,
} from "../local-backup-execution";

function deps(overrides: Partial<LocalBackupExecutionDeps> = {}): LocalBackupExecutionDeps {
  return {
    apiFetch: vi.fn(async () => ({ completedAt: "2026-10-13T18:00:00Z" })) as LocalBackupExecutionDeps["apiFetch"],
    apiFetchArrayBuffer: vi.fn(),
    downloadBackupToFolder: vi.fn(async () => ({ fileName: "full.zip", path: "/backups/full.zip", sizeBytes: 33_000_000_000 })),
    ...overrides,
  };
}

describe("local backup write/report ownership", () => {
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
