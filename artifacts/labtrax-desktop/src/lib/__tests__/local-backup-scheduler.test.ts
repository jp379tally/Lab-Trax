/**
 * Local-backup scheduler — the desktop-side executor for local-folder backup
 * schedules. All dependencies (API, Electron save bridge, storage, timers)
 * are injected, so these tests run without any Electron or network access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORBIDDEN_BACKOFF_MS,
  LOCAL_BACKUP_LAST_RUN_KEY,
  TICK_MS,
  intervalToMs,
  startLocalBackupScheduler,
  type LocalBackupSchedulerDeps,
} from "../local-backup-scheduler";
import type { LocalBackupLiveStatus } from "../local-backup-execution";

interface ScheduleShape {
  interval: number | null;
  unit: "minutes" | "hours" | null;
  destination: string | null;
  path: string | null;
  enabled: boolean;
}

function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

function makeVerifiedArchive(): ArrayBuffer {
  const bytes = new Uint8Array(44);
  bytes.set(new TextEncoder().encode("LTR2"), 0);
  bytes.set(new TextEncoder().encode("LTF1"), 32);
  new DataView(bytes.buffer).setBigUint64(36, 32n, false);
  return bytes.buffer;
}

const LOCAL_SCHEDULE: ScheduleShape = {
  interval: 1,
  unit: "hours",
  destination: "local",
  path: "D:\\LabTraxBackups",
  enabled: true,
};

function makeDeps(overrides: Partial<LocalBackupSchedulerDeps> & { schedule?: ScheduleShape } = {}) {
  const schedule = overrides.schedule ?? LOCAL_SCHEDULE;
  const storage = makeStorage();
  const reports: unknown[] = [];
  const apiFetch = vi.fn(async (endpoint: string, init?: { method?: string; body?: string }) => {
    if (endpoint === "/admin/backup/schedule") return schedule as unknown;
    if (endpoint === "/admin/backup/desktop-run-report") {
      reports.push(JSON.parse(init?.body ?? "{}"));
      return { ok: true } as unknown;
    }
    throw new Error(`unexpected apiFetch: ${endpoint}`);
  });
  const apiFetchArrayBuffer = vi.fn(async () => ({
    buffer: makeVerifiedArchive(),
    headers: new Headers({
      "Content-Disposition": 'attachment; filename="labtrax-backup-test.zip"',
      "Content-Length": "44",
      "X-Backup-Archive-Kind": "complete-non-production",
      "X-Backup-Coverage-Version": "1",
      "X-Backup-Media-File-Count": "2",
      "X-Backup-Attachment-Row-Count": "2",
    }),
  }));
  const saveBackupToFolder = vi.fn(async () => ({
    ok: true,
    path: "D:\\LabTraxBackups\\labtrax-backup-test.zip",
  }));
  const deps: LocalBackupSchedulerDeps = {
    apiFetch: apiFetch as LocalBackupSchedulerDeps["apiFetch"],
    apiFetchArrayBuffer,
    saveBackupToFolder,
    storage,
    ...overrides,
  };
  return { deps, apiFetch, apiFetchArrayBuffer, saveBackupToFolder, storage, reports };
}

/** Let the scheduler's immediate startup tick (and its promise chain) settle. */
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("intervalToMs", () => {
  it("converts minutes and hours", () => {
    expect(intervalToMs(15, "minutes")).toBe(15 * 60_000);
    expect(intervalToMs(2, "hours")).toBe(2 * 60 * 60_000);
  });

  it("returns null for missing or invalid values", () => {
    expect(intervalToMs(null, "minutes")).toBeNull();
    expect(intervalToMs(1, null)).toBeNull();
    expect(intervalToMs(0, "hours")).toBeNull();
  });
});

describe("startLocalBackupScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a due local backup: download → save → success report", async () => {
    const { deps, apiFetchArrayBuffer, saveBackupToFolder, storage, reports } = makeDeps();
    const stop = startLocalBackupScheduler(deps);
    await flush();

    // deferRecord=1 tells the server NOT to record this download as a
    // successful backup — the run is only recorded via desktop-run-report
    // after the folder write succeeds (or fails).
    expect(apiFetchArrayBuffer).toHaveBeenCalledWith("/admin/backup/generate?deferRecord=1", {
      method: "POST",
    });
    expect(saveBackupToFolder).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "labtrax-backup-test.zip",
      "D:\\LabTraxBackups",
    );
    expect(reports).toEqual([
      {
        status: "success",
        fileName: "labtrax-backup-test.zip",
        path: "D:\\LabTraxBackups\\labtrax-backup-test.zip",
        sizeBytes: 44,
      },
    ]);
    // Last-run watermark persisted so a restart doesn't immediately re-run.
    expect(storage.getItem(LOCAL_BACKUP_LAST_RUN_KEY)).toBe(String(Date.now()));
    stop();
  });

  it("publishes live scheduled backup progress and clears it after the run", async () => {
    const runId = "0ad043e2-854a-4507-bec4-f99750738096";
    const liveStatus: LocalBackupLiveStatus = {
      runId,
      state: "running",
      phase: "case-media transfer into archive",
      elapsedMs: 1200,
      metrics: { completedBytes: 2048, totalBytes: 4096 },
    };
    const progress: Array<{
      startedAt: number;
      phase: string;
      liveStatus: LocalBackupLiveStatus | null;
    } | null> = [];
    let emitRunId: ((value: string) => void) | undefined;
    let resolveDownload!: (saved: {
      fileName: string;
      path: string;
      sizeBytes: number;
      downloadRunId: string;
    }) => void;
    const { deps } = makeDeps({
      downloadBackupToFolder: vi.fn(() => new Promise((resolve) => {
        resolveDownload = resolve;
        emitRunId?.(runId);
      })),
      onDownloadRunId: vi.fn((listener) => {
        emitRunId = listener;
        return vi.fn();
      }),
      getLiveStatus: vi.fn(async () => liveStatus),
      onProgress: (update) => progress.push(update),
    });

    const stop = startLocalBackupScheduler(deps);
    await flush();
    expect(progress.some((update) => update?.liveStatus === liveStatus)).toBe(true);
    expect(progress.some((update) => update?.phase === "Generating, downloading and writing the full archive")).toBe(true);

    resolveDownload({
      fileName: "full.zip",
      path: "D:\\LabTraxBackups\\full.zip",
      sizeBytes: 4096,
      downloadRunId: runId,
    });
    await flush();
    expect(progress.at(-1)).toBeNull();
    stop();
  });

  it("does not run again until the configured interval has elapsed", async () => {
    const { deps, apiFetchArrayBuffer } = makeDeps();
    const stop = startLocalBackupScheduler(deps);
    await flush();
    expect(apiFetchArrayBuffer).toHaveBeenCalledTimes(1);

    // 30 minutes of ticks — still within the 1 h interval.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(apiFetchArrayBuffer).toHaveBeenCalledTimes(1);

    // Cross the 1 h mark — the next tick fires the second run.
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(apiFetchArrayBuffer).toHaveBeenCalledTimes(2);
    stop();
  });

  it("skips runs while a recent run is recorded in storage (app restart)", async () => {
    const { deps, apiFetchArrayBuffer, storage } = makeDeps();
    storage.setItem(LOCAL_BACKUP_LAST_RUN_KEY, String(Date.now() - 10 * 60_000)); // 10 min ago
    const stop = startLocalBackupScheduler(deps);
    await flush();
    expect(apiFetchArrayBuffer).not.toHaveBeenCalled();
    stop();
  });

  it("does nothing for non-local schedules", async () => {
    const { deps, apiFetchArrayBuffer } = makeDeps({
      schedule: { ...LOCAL_SCHEDULE, destination: "onedrive", path: null },
    });
    const stop = startLocalBackupScheduler(deps);
    await flush();
    expect(apiFetchArrayBuffer).not.toHaveBeenCalled();
    stop();
  });

  it("does nothing when the schedule is disabled", async () => {
    const { deps, apiFetchArrayBuffer } = makeDeps({
      schedule: { ...LOCAL_SCHEDULE, enabled: false },
    });
    const stop = startLocalBackupScheduler(deps);
    await flush();
    expect(apiFetchArrayBuffer).not.toHaveBeenCalled();
    stop();
  });

  it("does nothing without the Electron save bridge (plain browser)", async () => {
    const { deps, apiFetch } = makeDeps({ saveBackupToFolder: undefined });
    const stop = startLocalBackupScheduler(deps);
    await flush();
    await vi.advanceTimersByTimeAsync(TICK_MS * 3);
    expect(apiFetch).not.toHaveBeenCalled();
    stop();
  });

  it("reports an error (and does not throw) when the folder write fails", async () => {
    const { deps, reports } = makeDeps();
    (deps.saveBackupToFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "Folder is not writable.",
    });
    const stop = startLocalBackupScheduler(deps);
    await flush();
    expect(reports).toEqual([
      expect.objectContaining({ status: "error", error: expect.stringContaining("Writing the backup to the local folder") }),
    ]);
    stop();
  });

  it("advances the watermark only after desktop-run-report succeeds, not before", async () => {
    // Regression guard: the watermark must NOT be written before the backup
    // attempt begins.  If it were, a hard crash mid-download would silently
    // advance the staleness clock with no history entry.
    const { deps, apiFetch, storage } = makeDeps();
    let watermarkDuringReport: string | null = "NOT_CHECKED";
    (apiFetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (endpoint: string, _init?: { method?: string; body?: string }) => {
        if (endpoint === "/admin/backup/schedule") return LOCAL_SCHEDULE;
        if (endpoint === "/admin/backup/desktop-run-report") {
          // Capture the watermark value at the moment the report fires.
          // It must still be null — setItem has not been called yet.
          watermarkDuringReport = storage.getItem(LOCAL_BACKUP_LAST_RUN_KEY);
          return { ok: true };
        }
        throw new Error(`unexpected apiFetch: ${endpoint}`);
      },
    );
    const stop = startLocalBackupScheduler(deps);
    await flush();
    // Watermark was null when the report call started (not set early).
    expect(watermarkDuringReport).toBeNull();
    // Watermark IS set after the full run completes.
    expect(storage.getItem(LOCAL_BACKUP_LAST_RUN_KEY)).toBe(String(Date.now()));
    stop();
  });

  it("advances the watermark in the catch block on failure (no per-tick retry storm)", async () => {
    // A *caught* failure (network error, folder write error) still writes the
    // watermark — from the catch block — so the next tick does not immediately
    // re-fire (retry storm prevention).  Only a hard crash before the catch
    // block's setItem would leave the key unset, which is intentional.
    const { deps, apiFetchArrayBuffer, storage } = makeDeps();
    apiFetchArrayBuffer.mockRejectedValue(new Error("network down"));
    const stop = startLocalBackupScheduler(deps);
    await flush();
    expect(storage.getItem(LOCAL_BACKUP_LAST_RUN_KEY)).toBe(String(Date.now()));
    await vi.advanceTimersByTimeAsync(TICK_MS * 5);
    // One attempt only — the failure is not retried every minute.
    expect(apiFetchArrayBuffer).toHaveBeenCalledTimes(1);
    stop();
  });

  it("backs off after a 403 instead of hammering the schedule endpoint", async () => {
    const apiFetch = vi.fn(async (endpoint: string) => {
      if (endpoint === "/admin/backup/schedule") {
        throw new Error("403: Admin access required.");
      }
      throw new Error(`unexpected apiFetch: ${endpoint}`);
    });
    const { deps } = makeDeps({ apiFetch: apiFetch as LocalBackupSchedulerDeps["apiFetch"] });
    const stop = startLocalBackupScheduler(deps);
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(1);

    // Ticks inside the backoff window never call the API.
    await vi.advanceTimersByTimeAsync(FORBIDDEN_BACKOFF_MS - TICK_MS);
    expect(apiFetch).toHaveBeenCalledTimes(1);

    // After the backoff expires it checks again.
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop() prevents any further ticks", async () => {
    const { deps, apiFetch } = makeDeps({
      schedule: { ...LOCAL_SCHEDULE, enabled: false },
    });
    const stop = startLocalBackupScheduler(deps);
    await flush();
    const callsAtStop = apiFetch.mock.calls.length;
    stop();
    await vi.advanceTimersByTimeAsync(TICK_MS * 10);
    expect(apiFetch.mock.calls.length).toBe(callsAtStop);
  });
});
