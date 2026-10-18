import type { LocalBackupLiveStatus } from "./local-backup-execution";

export interface ScheduledLocalBackupProgress {
  startedAt: number;
  phase: string;
  liveStatus: LocalBackupLiveStatus | null;
}

let scheduledProgress: ScheduledLocalBackupProgress | null = null;
const listeners = new Set<() => void>();

export function getScheduledLocalBackupProgress(): ScheduledLocalBackupProgress | null {
  return scheduledProgress;
}

export function subscribeScheduledLocalBackupProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setScheduledLocalBackupProgress(progress: ScheduledLocalBackupProgress | null): void {
  scheduledProgress = progress;
  for (const listener of listeners) listener();
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
  const { completedFiles, fileCount, mediaFileCount } = status.metrics;
  if (Number.isFinite(fileCount)) {
    const completed = Number.isFinite(completedFiles) ? completedFiles : 0;
    return `${completed} of ${fileCount} media files`;
  }
  if (Number.isFinite(mediaFileCount)) return `${mediaFileCount} media files`;
  return null;
}

export function backupLiveProgressText(status: LocalBackupLiveStatus): string | null {
  const metrics = status.metrics;
  if (Number.isFinite(metrics.tablesCompleted) && Number.isFinite(metrics.tableCount)) {
    return `${metrics.tablesCompleted} of ${metrics.tableCount} database tables checked`;
  }
  if (Number.isFinite(metrics.transferredBytes)) {
    const downloaded = formatBackupSize(metrics.transferredBytes);
    return Number.isFinite(metrics.transferTotalBytes)
      ? `${downloaded} of ${formatBackupSize(metrics.transferTotalBytes)} downloaded`
      : `${downloaded} downloaded`;
  }
  if (Number.isFinite(metrics.uploadedBytes)) {
    const sent = formatBackupSize(metrics.uploadedBytes);
    return Number.isFinite(metrics.uploadTotalBytes)
      ? `${sent} of ${formatBackupSize(metrics.uploadTotalBytes)} uploaded`
      : `${sent} uploaded`;
  }
  if (Number.isFinite(metrics.completedBytes)) {
    const done = formatBackupSize(metrics.completedBytes);
    return Number.isFinite(metrics.totalBytes)
      ? `${done} of ${formatBackupSize(metrics.totalBytes)} of case media added`
      : `${done} of case media added`;
  }
  if (Number.isFinite(metrics.dumpBytes)) return `${formatBackupSize(metrics.dumpBytes)} of database data read`;
  if (Number.isFinite(metrics.archiveBytes)) return `${formatBackupSize(metrics.archiveBytes)} sent`;
  return null;
}
