/**
 * Local-folder scheduled backups, executed by the desktop app.
 *
 * The server cannot reach the admin's local disk, so when the saved backup
 * schedule targets a local folder / USB path the server silently skips it and
 * this scheduler runs it instead — while the desktop app is open:
 *
 *   1. Poll the saved schedule (every SCHEDULE_REFRESH_MS).
 *   2. When a local-folder schedule is enabled and a run is due, download a
 *      fresh backup from POST /admin/backup/generate.
 *   3. Write it to the configured folder via the Electron bridge.
 *   4. Report the outcome to POST /admin/backup/desktop-run-report so the run
 *      lands in backup history and feeds the staleness watermark.
 *
 * If the app is closed when a run is due, the backup fires on the next tick
 * after the app reopens (last-run time is persisted in localStorage).
 * All dependencies are injectable for tests.
 */

import {
  executeLocalBackup,
  type LocalBackupLiveStatus,
  type LocalBackupSaved,
} from "./local-backup-execution";
import type { ScheduledLocalBackupProgress } from "./local-backup-progress";

export const LOCAL_BACKUP_LAST_RUN_KEY = "labtrax_local_backup_last_run_v1";

export const TICK_MS = 60_000;
export const SCHEDULE_REFRESH_MS = 5 * 60_000;
/** After a 403 (not platform admin), back off before re-checking. */
export const FORBIDDEN_BACKOFF_MS = 30 * 60_000;

interface ScheduleData {
  interval: number | null;
  unit: "minutes" | "hours" | null;
  destination: string | null;
  path: string | null;
  enabled: boolean;
}

export interface LocalBackupSchedulerDeps {
  apiFetch: <T = unknown>(endpoint: string, init?: { method?: string; body?: string }) => Promise<T>;
  apiFetchArrayBuffer: (
    endpoint: string,
    init?: { method?: string },
  ) => Promise<{ buffer: ArrayBuffer; headers: Headers }>;
  /** Electron bridge writer; undefined when running in a plain browser. */
  saveBackupToFolder:
    | ((buffer: Uint8Array, fileName: string, folderPath: string) => Promise<{ ok: boolean; path?: string; error?: string }>)
    | undefined;
  downloadBackupToFolder?: (folder: string, source?: "manual" | "scheduler") => Promise<LocalBackupSaved>;
  onDownloadRunId?: (listener: (runId: string) => void) => () => void;
  getLiveStatus?: (runId: string) => Promise<LocalBackupLiveStatus>;
  onProgress?: (progress: ScheduledLocalBackupProgress | null) => void;
  storage: Pick<Storage, "getItem" | "setItem">;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  log?: (msg: string, detail?: unknown) => void;
}

function isForbiddenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b403\b|forbidden|admin access required/i.test(msg);
}

export function intervalToMs(interval: number | null, unit: "minutes" | "hours" | null): number | null {
  if (!interval || !unit) return null;
  if (interval <= 0) return null;
  return unit === "minutes" ? interval * 60_000 : interval * 60 * 60_000;
}

/**
 * Start the local-backup scheduler loop. Returns a stop() function.
 * Safe to call in any environment: it no-ops each tick unless the Electron
 * save bridge exists and the saved schedule targets a local folder.
 */
export function startLocalBackupScheduler(deps: LocalBackupSchedulerDeps): () => void {
  const now = deps.now ?? Date.now;
  const setIv = deps.setInterval ?? globalThis.setInterval.bind(globalThis);
  const clearIv = deps.clearInterval ?? globalThis.clearInterval.bind(globalThis);
  const log = deps.log ?? (() => undefined);

  let schedule: ScheduleData | null = null;
  let scheduleFetchedAt = 0;
  let forbiddenUntil = 0;
  let running = false;
  let stopped = false;

  async function refreshScheduleIfStale(): Promise<void> {
    if (now() - scheduleFetchedAt < SCHEDULE_REFRESH_MS && schedule !== null) return;
    const data = await deps.apiFetch<ScheduleData>("/admin/backup/schedule");
    schedule = data;
    scheduleFetchedAt = now();
  }

  function lastRunAt(): number {
    const raw = deps.storage.getItem(LOCAL_BACKUP_LAST_RUN_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? n : 0;
  }

  async function runDueBackup(sched: ScheduleData): Promise<void> {
    const folder = (sched.path ?? "").trim();
    const saveToFolder = deps.saveBackupToFolder;
    if (!folder || (!saveToFolder && !deps.downloadBackupToFolder)) return;

    // IMPORTANT: do NOT write the last-run key here.  Writing it before the
    // download/write/report means a hard crash (app killed mid-download)
    // silently advances the watermark without producing any history entry.
    // Instead the key is written in two places below:
    //   • after a confirmed desktop-run-report success
    //   • in the catch block so a *caught* failure still prevents a
    //     per-tick retry storm (only a hard crash leaves the key unset,
    //     which is intentional — the next tick will correctly re-fire).

    try {
      // deferRecord=1: the server must NOT record this download as a
      // successful backup — the run only counts once the folder write
      // succeeds, which we report below via desktop-run-report. Otherwise a
      // failed disk write would still advance the staleness watermark.
      const startedAt = now();
      let phase = "Starting scheduled Desktop backup";
      let liveStatus: LocalBackupLiveStatus | null = null;
      const publishProgress = () => {
        deps.onProgress?.({ startedAt, phase, liveStatus });
      };
      publishProgress();
      try {
        await executeLocalBackup({
          ...deps,
          now,
          log,
          onPhase: (nextPhase) => {
            phase = nextPhase;
            publishProgress();
          },
          onLiveStatus: (status) => {
            liveStatus = status;
            publishProgress();
          },
        }, folder);
      } finally {
        deps.onProgress?.(null);
      }
      // Advance the watermark only after the history entry is confirmed.
      deps.storage.setItem(LOCAL_BACKUP_LAST_RUN_KEY, String(now()));
      log("[local-backup] scheduled backup saved");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log("[local-backup] scheduled backup failed", { message });
      // Advance the watermark on a caught failure so the next tick does not
      // immediately retry (retry storm prevention).  A hard crash before
      // this line means the key is never written, allowing the next tick to
      // correctly re-fire once the app restarts.
      deps.storage.setItem(LOCAL_BACKUP_LAST_RUN_KEY, String(now()));
    }
  }

  async function tick(): Promise<void> {
    if (running || stopped) return;
    if (now() < forbiddenUntil) return;
    if (!deps.saveBackupToFolder && !deps.downloadBackupToFolder) return; // browser: desktop-only feature
    running = true;
    try {
      await refreshScheduleIfStale();
      const sched = schedule;
      if (!sched || !sched.enabled || sched.destination !== "local") return;
      const intervalMs = intervalToMs(sched.interval, sched.unit);
      if (!intervalMs || !(sched.path ?? "").trim()) return;
      if (now() - lastRunAt() < intervalMs) return;
      await runDueBackup(sched);
    } catch (err: unknown) {
      if (isForbiddenError(err)) {
        // Not a platform admin on this login — stop hammering the endpoint.
        forbiddenUntil = now() + FORBIDDEN_BACKOFF_MS;
        schedule = null;
        scheduleFetchedAt = 0;
        log("[local-backup] not authorized; backing off", { forbiddenUntil });
      } else {
        log("[local-backup] tick failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      running = false;
    }
  }

  const timer = setIv(() => {
    void tick();
  }, TICK_MS);
  // First check shortly after startup (next tick keeps startup fast).
  void tick();

  return () => {
    stopped = true;
    clearIv(timer);
  };
}
