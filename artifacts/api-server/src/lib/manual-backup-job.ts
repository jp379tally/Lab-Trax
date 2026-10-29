import { createHash } from "node:crypto";
import { claimManualBackupRun, readBackupLiveStatus } from "./backup-live-status-store";
import { safeBackupError, withBackupRun } from "./backup-phase";
import { logger } from "./logger";

interface ManualBackupJob {
  controller: AbortController;
  timer: ReturnType<typeof setInterval>;
  cleanup?: () => Promise<void>;
}
const jobs = new Map<string, ManualBackupJob>();

/** Persist before acknowledgement; only the winning worker starts the job. */
export async function startManualBackupJob(
  runId: string,
  identity: { destination: string; archiveKind: string; source: string; actor: string },
  userId: string | null,
  sessionHash: string,
  work: (signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  if (!await claimManualBackupRun(runId, fingerprint, userId, sessionHash)) return;
  const controller = new AbortController();
  const timer = setInterval(() => {
    void readBackupLiveStatus(runId).then(status => {
      if (!status || status.state === "cancelled") {
        if (status?.state === "cancelled") cancelManualBackupJob(runId);
        else controller.abort();
      }
      if (!status || ["completed", "failed", "cancelled", "stale"].includes(status.state)) {
        clearInterval(timer);
        jobs.delete(runId);
      }
    }).catch(error => logger.warn({ runId, error: safeBackupError(error) },
      "[backup] Manual job cancellation monitor could not read shared status"));
  }, 1000);
  timer.unref?.();
  jobs.set(runId, { controller, timer });
  // withBackupRun owns terminal live state; runBackup owns its sole history row.
  void withBackupRun(() => work(controller.signal), runId).catch((error: unknown) => {
    logger.error({ runId, error: safeBackupError(error) }, "[backup] Manual job failed");
  });
}

export function cancelManualBackupJob(runId: string): void {
  const job = jobs.get(runId);
  job?.controller.abort();
  const cleanup = job?.cleanup;
  if (job) job.cleanup = undefined;
  if (cleanup) {
    void cleanup().catch(error => logger.warn({ runId, error: safeBackupError(error) },
      "[backup] Cancelled manual destination cleanup will be retried"));
  }
}

export function registerManualBackupCleanup(runId: string, cleanup: () => Promise<void>): void {
  const job = jobs.get(runId);
  if (!job) {
    void cleanup().catch(error => logger.warn({ runId, error: safeBackupError(error) },
      "[backup] Unclaimed manual destination cleanup will be retried"));
    return;
  }
  job.cleanup = cleanup;
  if (job.controller.signal.aborted) cancelManualBackupJob(runId);
}

export function getManualBackupJobSignal(runId: string): AbortSignal | undefined {
  return jobs.get(runId)?.controller.signal;
}

export function finishManualBackupJob(runId: string): void {
  const job = jobs.get(runId);
  if (!job) return;
  clearInterval(job.timer);
  jobs.delete(runId);
}
