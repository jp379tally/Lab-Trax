export type BackupErrorContext = "backup" | "restore" | "status";

/**
 * Short copy for the main UI message. Keep the original error separately for
 * backup history, logs, and diagnostic details.
 */
export function backupErrorMessage(
  detail: unknown,
  context: BackupErrorContext = "backup",
): string {
  const source = detail instanceof Error ? detail.message : String(detail ?? "");
  const normalized = source.toLowerCase();

  if (context === "restore") {
    if (/already in progress/.test(normalized)) {
      return "A restore is already running. Wait for it to finish and check its status before starting another.";
    }
    if (/invalid backup|manifest|schema version|decrypt|corrupt|authentication tag/.test(normalized)) {
      return "This file could not be validated as a usable LabTrax backup. Choose a verified backup file and review the failure details.";
    }
    return "The restore did not complete. Check the restore status and failure details before starting another restore.";
  }

  if (context === "status") {
    return "Backup status could not be checked. Check your connection and open Backup settings again.";
  }

  if (/previous scheduled backup is still running|already in progress/.test(normalized)) {
    return "This backup was skipped because another backup is still running. No new complete recovery point was created. Check Backup history for the active run.";
  }
  if (/local-folder schedule|desktop app.*not from the server|only sftp and onedrive/.test(normalized)) {
    return "No new complete recovery point was created. Open LabTrax Desktop to run this local-folder schedule, or use Back up now to create a backup there.";
  }
  if (/unreachable from the server|server cannot reach|destination.*not.*reachable/.test(normalized)) {
    return "The server cannot reach this folder, so no backup was created. Use LabTrax Desktop for a folder on your computer, or choose a destination the server can reach.";
  }
  if (/onedrive.*not available|microsoft rejected|onedrive credentials|onedrive.*connection/.test(normalized)) {
    return "LabTrax could not connect to OneDrive, so no new complete recovery point was created. Reconnect the OneDrive account in Backup settings and check backup history before deciding what to do next.";
  }
  if (/too small to be a real backup|placeholder.*not a restorable/.test(normalized)) {
    return "The saved file is too small to be a usable backup. No new complete recovery point was created. Check the destination and failure details before deciding whether to try again.";
  }

  return "The backup did not complete, so no new complete recovery point was created. Check the destination and failure details before deciding what to do next.";
}

export function backupStatusErrorMessage(): string {
  return "LabTrax could not check the OneDrive backup folder, so a complete recovery point could not be confirmed. Check the OneDrive connection and review the details below.";
}

export function backupDownloadErrorMessage(): string {
  return "LabTrax could not download this backup from OneDrive. Check the OneDrive connection and backup history before choosing another restore file.";
}

export function backupSettingsErrorMessage(action: "load" | "save" | "disable" | "history"): string {
  switch (action) {
    case "load":
      return "LabTrax could not load these backup settings. Check your connection and open Backup settings again.";
    case "save":
      return "LabTrax could not save these backup settings. Check the values and review the failure details before trying again.";
    case "disable":
      return "LabTrax could not change the backup schedule. Check the failure details before changing it again.";
    case "history":
      return "LabTrax could not load backup history. Check your connection and try opening Backup settings again.";
  }
}

export function partialBackupMessage(): string {
  return "The backup finished, but some content was left out. This is not a complete recovery point, and restoring it will not recover the missing content.";
}
