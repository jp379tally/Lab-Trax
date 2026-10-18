import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import {
  pruneBackupLiveStatuses,
  readBackupLiveStatus,
  saveBackupLiveStatus,
} from "./backup-live-status-store";

const runContext = new AsyncLocalStorage<string>();
type Metrics = Record<string, number>;

export type BackupLiveRunState = "running" | "awaiting_verification" | "completed" | "failed" | "stale";
export interface BackupLiveStatus {
  runId: string;
  state: BackupLiveRunState;
  phase: string;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  metrics: Metrics;
  archiveEvidence?: {
    archiveKind: "complete-production" | "complete-non-production";
    coverageVersion: number;
    mediaFileCount: number;
    attachmentRowCount: number;
  };
}

const LIVE_STATUS_TTL_MS = 30 * 60_000;
const STALE_RUN_MS = 2 * 60 * 60_000;
const MAX_LIVE_RUNS = 200;
const liveRuns = new Map<string, BackupLiveStatus>();
const pendingStatusWrites = new Map<string, BackupLiveStatus>();
const statusWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const statusWriteInFlight = new Map<string, Promise<void>>();
const STATUS_WRITE_COALESCE_MS = 200;
const SAFE_PHASES = new Set([
  "starting backup",
  "database dump",
  "database manifest counts",
  "case-media inventory and reference validation",
  "case-media storage inventory",
  "case-media transfer into archive",
  "archive assembly/encryption",
  "archive assembly/encryption and local transfer",
  "private cloud staging setup",
  "local download",
  "OneDrive transfer",
  "SFTP transfer",
  "SFTP verification",
  "OneDrive verification",
  "Google Drive transfer",
  "Google Drive verification",
  "local file verification",
  "desktop verification",
  "backup complete",
  "backup failed",
]);
const SAFE_METRICS = new Set([
  "dumpBytes",
  "archiveBytes",
  "mediaBytes",
  "mediaFileCount",
  "completedFiles",
  "completedBytes",
  "totalBytes",
  "uploadedBytes",
  "uploadTotalBytes",
  "fileCount",
  "attachmentRowCount",
  "tablesCompleted",
  "tableCount",
  "rowsScanned",
  "transferredBytes",
  "transferTotalBytes",
]);

function pruneLiveRuns(now = Date.now()): void {
  for (const [runId, status] of liveRuns) {
    const updatedAt = Date.parse(status.updatedAt);
    if (status.state === "running" && now - updatedAt > STALE_RUN_MS) {
      liveRuns.set(runId, {
        ...status,
        state: "stale",
        phase: "backup failed",
        updatedAt: new Date(now).toISOString(),
      });
    } else if (status.state !== "running" && status.state !== "awaiting_verification" &&
      now - updatedAt > LIVE_STATUS_TTL_MS) {
      liveRuns.delete(runId);
    } else if (status.state === "awaiting_verification" && now - updatedAt > STALE_RUN_MS) {
      liveRuns.set(runId, {
        ...status,
        state: "stale",
        phase: "backup failed",
        updatedAt: new Date(now).toISOString(),
      });
    }
  }
  while (liveRuns.size > MAX_LIVE_RUNS) {
    const oldest = liveRuns.keys().next().value as string | undefined;
    if (!oldest) break;
    liveRuns.delete(oldest);
  }
}

function safePhase(phase: string): string {
  return SAFE_PHASES.has(phase) ? phase : "starting backup";
}

function safeMetrics(metrics: Metrics): Metrics {
  const result: Metrics = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (SAFE_METRICS.has(key) && Number.isFinite(value)) {
      result[key] = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)));
    }
  }
  return result;
}

function cloneStatus(status: BackupLiveStatus): BackupLiveStatus {
  return { ...status, metrics: { ...status.metrics } };
}

function scheduleStatusWrite(status: BackupLiveStatus): void {
  pendingStatusWrites.set(status.runId, cloneStatus(status));
  if (statusWriteTimers.has(status.runId) || statusWriteInFlight.has(status.runId)) return;
  const timer = setTimeout(() => {
    statusWriteTimers.delete(status.runId);
    void flushStatusWrites(status.runId);
  }, STATUS_WRITE_COALESCE_MS);
  timer.unref?.();
  statusWriteTimers.set(status.runId, timer);
}

async function flushStatusWrites(runId: string): Promise<void> {
  const timer = statusWriteTimers.get(runId);
  if (timer) clearTimeout(timer);
  statusWriteTimers.delete(runId);
  const activeWrite = statusWriteInFlight.get(runId);
  if (activeWrite) {
    await activeWrite.catch(() => undefined);
    if (pendingStatusWrites.has(runId)) return flushStatusWrites(runId);
    return;
  }

  while (pendingStatusWrites.has(runId)) {
    const status = pendingStatusWrites.get(runId)!;
    pendingStatusWrites.delete(runId);
    const write = saveBackupLiveStatus(status);
    statusWriteInFlight.set(runId, write);
    try {
      await write;
    } catch (error) {
      logger.warn({ runId, error }, "[backup] shared live status write failed");
    } finally {
      statusWriteInFlight.delete(runId);
    }
  }
}

function updateLocalLiveStatus(
  runId: string | undefined,
  update: Partial<BackupLiveStatus>,
  replaceMetrics = false,
): BackupLiveStatus | undefined {
  if (!runId) return;
  pruneLiveRuns();
  const existing = liveRuns.get(runId);
  if (!existing) return undefined;
  const updated = {
    ...existing,
    ...update,
    updatedAt: new Date().toISOString(),
    metrics: update.metrics
      ? replaceMetrics ? safeMetrics(update.metrics) : { ...existing.metrics, ...safeMetrics(update.metrics) }
      : existing.metrics,
  };
  liveRuns.set(runId, updated);
  scheduleStatusWrite(updated);
  return updated;
}

async function updateLiveStatus(
  runId: string | undefined,
  update: Partial<BackupLiveStatus>,
  replaceMetrics = false,
): Promise<void> {
  if (!runId) return;
  let existing = liveRuns.get(runId);
  if (!existing) {
    try {
      existing = await readBackupLiveStatus(runId);
    } catch (error) {
      logger.warn({ runId, error }, "[backup] shared live status read failed");
      return;
    }
    if (!existing) return;
    liveRuns.set(runId, existing);
  }
  const updated = updateLocalLiveStatus(runId, update, replaceMetrics);
  if (updated) await flushStatusWrites(runId);
}

function beginLiveRun(runId: string): void {
  pruneLiveRuns();
  const now = new Date().toISOString();
  const status: BackupLiveStatus = {
    runId,
    state: "running",
    phase: "starting backup",
    startedAt: now,
    updatedAt: now,
    elapsedMs: 0,
    metrics: {},
  };
  liveRuns.set(runId, status);
  scheduleStatusWrite(status);
  pruneLiveRuns();
}

export async function getBackupLiveStatus(runId: string): Promise<BackupLiveStatus | undefined> {
  pruneLiveRuns();
  try {
    await pruneBackupLiveStatuses(Date.now(), STALE_RUN_MS, LIVE_STATUS_TTL_MS, MAX_LIVE_RUNS);
    await flushStatusWrites(runId);
    const sharedStatus = await readBackupLiveStatus(runId);
    if (!sharedStatus) {
      liveRuns.delete(runId);
      return undefined;
    }
    const status: BackupLiveStatus = {
      ...sharedStatus,
      phase: safePhase(sharedStatus.phase),
      metrics: safeMetrics(sharedStatus.metrics),
    };
    liveRuns.set(runId, status);
    return cloneStatus(status);
  } catch (error) {
    logger.warn({ runId, error }, "[backup] shared live status read failed");
    const status = liveRuns.get(runId);
    return status ? cloneStatus(status) : undefined;
  }
}

export function setBackupLivePhase(phase: string, metrics: Metrics = {}): void {
  const status = runContext.getStore() ? liveRuns.get(runContext.getStore()!) : undefined;
  updateLocalLiveStatus(runContext.getStore(), {
    phase: safePhase(phase),
    elapsedMs: status ? Math.max(0, Date.now() - Date.parse(status.startedAt)) : 0,
    metrics: safeMetrics(metrics),
  }, true);
}

export function setBackupLiveProgress(metrics: Metrics): void {
  const runId = runContext.getStore();
  const status = runId ? liveRuns.get(runId) : undefined;
  updateLocalLiveStatus(runId, {
    elapsedMs: status ? Math.max(0, Date.now() - Date.parse(status.startedAt)) : 0,
    metrics: safeMetrics(metrics),
  });
}

/** Bind verified archive evidence to this run for deferred desktop reporting. */
export function setBackupLiveArchiveEvidence(
  evidence: BackupLiveStatus["archiveEvidence"],
): void {
  if (!evidence) return;
  updateLocalLiveStatus(runContext.getStore(), { archiveEvidence: { ...evidence } });
}

export function markBackupLiveAwaitingVerification(runId: string | undefined): Promise<void> {
  return updateLiveStatus(runId, { state: "awaiting_verification", phase: "desktop verification" });
}

export function finishBackupLiveRun(
  runId: string | undefined,
  state: "completed" | "failed",
): Promise<void> {
  const status = runId ? liveRuns.get(runId) : undefined;
  return updateLiveStatus(runId, {
    state,
    phase: state === "completed" ? "backup complete" : "backup failed",
    elapsedMs: status ? Math.max(0, Date.now() - Date.parse(status.startedAt)) : 0,
  });
}

/** Keep transport URLs (including signed URLs) and credentials out of history/logs. */
export function safeBackupError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(?:token|password|secret|authorization|signature)\s*[=:]\s*\S+/gi, "[redacted credential]")
    .slice(0, 1500);
}

export async function withBackupRun<T>(work: () => Promise<T>, requestedRunId?: string): Promise<T> {
  if (runContext.getStore()) return work();
  const runId = requestedRunId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedRunId)
    ? requestedRunId
    : randomUUID();
  beginLiveRun(runId);
  await flushStatusWrites(runId);
  void pruneBackupLiveStatuses(Date.now(), STALE_RUN_MS, LIVE_STATUS_TTL_MS, MAX_LIVE_RUNS)
    .catch((error) => logger.warn({ runId, error }, "[backup] shared live status cleanup failed"));
  return runContext.run(runId, async () => {
    try {
      const result = await work();
      const status = liveRuns.get(runId);
      if (status?.state === "running") await finishBackupLiveRun(runId, "completed");
      return result;
    } catch (error) {
      await finishBackupLiveRun(runId, "failed");
      throw error;
    }
  });
}
export function getBackupRunId(): string | undefined {
  return runContext.getStore();
}

/** Numeric-only context: never pass file names, object keys, SQL, or file contents. */
export async function measureBackupPhase<T>(
  phase: string,
  work: () => Promise<T>,
  metrics: () => Metrics = () => ({}),
  resultMetrics: (result: T) => Metrics = () => ({}),
): Promise<T> {
  const startedAt = Date.now();
  const context = () => ({
    runId: runContext.getStore(),
    phase,
    elapsedMs: Date.now() - startedAt,
    ...metrics(),
  });
  setBackupLivePhase(phase, metrics());
  const runId = runContext.getStore();
  if (runId) await flushStatusWrites(runId);
  logger.info(context(), "[backup] phase started");
  const timer = setInterval(() => {
    setBackupLivePhase(phase, metrics());
    if (runId) void flushStatusWrites(runId);
    logger.info(context(), "[backup] phase still running");
  }, 30_000);
  timer.unref?.();
  try {
    const result = await work();
    setBackupLivePhase(phase, { ...metrics(), ...resultMetrics(result) });
    if (runId) await flushStatusWrites(runId);
    logger.info({ ...context(), ...resultMetrics(result) }, "[backup] phase completed");
    return result;
  } catch (error) {
    setBackupLivePhase(phase, metrics());
    if (runId) await flushStatusWrites(runId);
    const detail = safeBackupError(error);
    const message = `Backup failed during ${phase} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${detail}`;
    logger.error({ ...context(), reason: detail }, "[backup] phase failed");
    // Preserve timeout/error classes used by the scheduler and fallback logic.
    const failure = error instanceof Error ? error : new Error(detail);
    try {
      Object.defineProperty(failure, "message", { value: message, writable: true, configurable: true });
    } catch {
      // Platform/frozen errors may not allow a message to be assigned.
      throw new Error(message);
    }
    throw failure;
  } finally {
    clearInterval(timer);
  }
}

/** Bound metadata waits as well as streams. Late results are never consumed. */
export function abortableBackupOperation<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(new Error("Backup was aborted during this phase."));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Backup was aborted during this phase."));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
