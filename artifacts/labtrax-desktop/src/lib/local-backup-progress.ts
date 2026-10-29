import type { LocalBackupLiveStatus } from "./local-backup-execution";

export interface ScheduledLocalBackupProgress {
  startedAt: number;
  phase: string;
  liveStatus: LocalBackupLiveStatus | null;
}

export type ScheduledLocalBackupSession = symbol;

interface ProgressSnapshot {
  session: ScheduledLocalBackupSession | null;
  progress: ScheduledLocalBackupProgress;
}

let activeSession: ScheduledLocalBackupSession | null = null;
let scheduledProgress: ProgressSnapshot | null = null;
const listeners = new Set<() => void>();

export function getScheduledLocalBackupProgress(): ScheduledLocalBackupProgress | null {
  if (!scheduledProgress) return null;
  return scheduledProgress.session === activeSession ? scheduledProgress.progress : null;
}

export function subscribeScheduledLocalBackupProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyProgressChanged(): void {
  for (const listener of listeners) listener();
}

export function activateScheduledLocalBackupSession(session: ScheduledLocalBackupSession): void {
  if (activeSession === session) return;
  activeSession = session;
  if (scheduledProgress?.session !== session) {
    scheduledProgress = null;
    notifyProgressChanged();
  }
}

export function deactivateScheduledLocalBackupSession(session: ScheduledLocalBackupSession): void {
  if (activeSession !== session) return;
  activeSession = null;
  if (scheduledProgress?.session === session) {
    scheduledProgress = null;
    notifyProgressChanged();
  }
}

export function setScheduledLocalBackupProgress(
  progress: ScheduledLocalBackupProgress | null,
  session?: ScheduledLocalBackupSession,
): void {
  if (session !== undefined) {
    // A disposed scheduler may finish its disk write and report, but it can no
    // longer publish into the progress store owned by a newer account session.
    if (activeSession !== session) return;
    if (progress) {
      scheduledProgress = { session, progress };
    } else if (scheduledProgress?.session === session) {
      scheduledProgress = null;
    } else {
      return;
    }
  } else {
    // Preserve the unscoped test/preview API when no authenticated scheduler
    // session is active. While one is active, all writes must identify it.
    if (activeSession !== null) return;
    scheduledProgress = progress ? { session: null, progress } : null;
  }
  notifyProgressChanged();
}

export function formatBackupSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function backupLivePhaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    "starting backup": "Starting server backup",
    "database dump": "Creating database dump",
    "database manifest counts": "Counting records for verification",
    "case-media inventory and reference validation": "Checking database and files",
    "case-media storage inventory": "Listing stored files",
    "case-media transfer into archive": "Adding case media to archive",
    "archive assembly/encryption": "Building and encrypting archive",
    "archive assembly/encryption and local transfer": "Building, encrypting, and sending archive",
    "private cloud staging setup": "Preparing private upload staging",
    "local download": "Downloading complete backup",
    "OneDrive transfer": "Uploading encrypted archive",
    "OneDrive verification": "Verifying uploaded archive",
    "SFTP transfer": "Uploading encrypted archive to SFTP",
    "SFTP verification": "Verifying SFTP archive",
    "local file verification": "Verifying saved file",
    "desktop verification": "Verifying saved file",
    "backup complete": "Backup complete",
    "backup failed": "Backup failed",
  };
  return labels[phase] ?? "Processing backup";
}

export function backupLiveMediaText(status: LocalBackupLiveStatus): string | null {
  const { completedFiles, fileCount, mediaFileCount, mediaBytesPerSecond } = status.metrics ?? {};
  let summary: string | null = null;
  if (Number.isFinite(fileCount)) {
    const completed = Number.isFinite(completedFiles) ? completedFiles : 0;
    summary = `${completed} of ${fileCount} media files`;
  } else if (Number.isFinite(mediaFileCount)) {
    summary = `${mediaFileCount} media files`;
  }
  const throughput = Number.isFinite(mediaBytesPerSecond) && mediaBytesPerSecond > 0
    ? `${formatBackupSize(mediaBytesPerSecond)}/s`
    : null;
  return [summary, throughput].filter(Boolean).join(" · ") || null;
}

export function backupLiveProgressText(status: LocalBackupLiveStatus): string | null {
  const metrics = status.metrics ?? {};
  const throughput = Number.isFinite(metrics.throughputBytesPerSecond) &&
    metrics.throughputBytesPerSecond > 0
    ? ` · ${formatBackupSize(metrics.throughputBytesPerSecond)}/s`
    : "";
  if (Number.isFinite(metrics.tablesCompleted) && Number.isFinite(metrics.tableCount)) {
    const rate = Number.isFinite(metrics.rowsPerSecond) && metrics.rowsPerSecond > 0
      ? ` · ${Math.round(metrics.rowsPerSecond).toLocaleString()} rows/s`
      : "";
    return `${metrics.tablesCompleted} of ${metrics.tableCount} database tables checked${rate}`;
  }
  if (Number.isFinite(metrics.transferredBytes)) {
    const downloaded = formatBackupSize(metrics.transferredBytes);
    return Number.isFinite(metrics.transferTotalBytes)
      ? `${downloaded} of ${formatBackupSize(metrics.transferTotalBytes)} downloaded${throughput}`
      : `${downloaded} downloaded${throughput}`;
  }
  if (Number.isFinite(metrics.uploadedBytes)) {
    const sent = formatBackupSize(metrics.uploadedBytes);
    return Number.isFinite(metrics.uploadTotalBytes)
      ? `${sent} of ${formatBackupSize(metrics.uploadTotalBytes)} uploaded${throughput}`
      : `${sent} uploaded${throughput}`;
  }
  if (Number.isFinite(metrics.completedBytes)) {
    const done = formatBackupSize(metrics.completedBytes);
    return Number.isFinite(metrics.totalBytes)
      ? `${done} of ${formatBackupSize(metrics.totalBytes)} of case media added`
      : `${done} of case media added`;
  }
  if (Number.isFinite(metrics.dumpBytes)) return `${formatBackupSize(metrics.dumpBytes)} of database data read${throughput}`;
  if (Number.isFinite(metrics.archiveBytes)) return `${formatBackupSize(metrics.archiveBytes)} sent${throughput}`;
  return null;
}
