export type BackupErrorContext = "backup" | "restore" | "status";

/**
 * Short copy for the main UI message. Keep the original error separately for
 * backup history, logs, and diagnostic details.
 */
function backupErrorSummary(
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
  if (/required file references have no readable recovery source|referenced case-media.*(?:absent|missing)/.test(normalized)) {
    const count = source.match(/(\d+)\s+required file references have no readable recovery source/i)?.[1];
    return `The backup stopped before upload because ${count ? `${count} required stored-file references` : "required stored-file references"} could not be read. Existing records and files were not changed. Restore storage access or recover the exact original files, then try again. No new complete recovery point was created.`;
  }
  if (/complete backup destination capacity failure/.test(normalized)) {
    return "The selected backup destination does not have enough free space. No new complete recovery point was created, and existing records and files were not changed. Review the required and available space in the failure details.";
  }
  if (/complete backup capacity failure|bytes of temporary capacity are required/.test(normalized)) {
    return "The backup server does not have enough temporary disk space. This is a server staging problem, not proof that the cloud destination is full. No new complete recovery point was created. Review the required and available space in the failure details.";
  }
  if (/onedrive.*not available|microsoft rejected|onedrive credentials|onedrive.*connection/.test(normalized)) {
    return "LabTrax could not connect to OneDrive, so no new complete recovery point was created. Reconnect the OneDrive account in Backup settings and check backup history before deciding what to do next.";
  }
  if (/too small to be a real backup|placeholder.*not a restorable/.test(normalized)) {
    return "The saved file is too small to be a usable backup. No new complete recovery point was created. Check the destination and failure details before deciding whether to try again.";
  }
  if (/desktop release identity|exact installer bytes/.test(normalized)) {
    return "Required Desktop release evidence is unavailable or invalid. A complete recovery point was not created.";
  }

  if (/content-version continuity|ciphertext differs from its authenticated sha-256/i.test(source)) {
    return "The destination could not confirm the same previously byte-verified object version. Recovery verification stopped; previous backups were preserved. Changed or missing version evidence requires authenticated byte read-back before reuse.";
  }
  if (/strong metadata-only media reuse is unavailable|provider-calculated sha-256/i.test(source)) {
    return "The destination did not provide the strong SHA-256 evidence required to reuse protected media without downloading it again. Routine reuse stopped; the previous recovery point was preserved. SHA-1, QuickXorHash, size and entity tags do not satisfy this requirement.";
  }
  if (/previous media baseline has no compatible strong metadata-only integrity proof/i.test(source)) {
    return "The previous media baseline is not compatible with strong metadata-only reuse. No whole-media reread or new recovery point was started; the previous backup remains available for full restore verification.";
  }
  if (/production media journal.*(?:gap|inconsistent)|journaled media mutation has no captured source|media and database journal checkpoints do not agree/i.test(source)) {
    return "The media change journal could not be reconciled with the captured database and file inventory. No new recovery point was committed; the previous backup was preserved.";
  }
  return "The backup did not complete, so no new complete recovery point was created. Check the destination and failure details before deciding what to do next.";
}

// Deliberately whitelist diagnostics. Never echo arbitrary provider bodies,
// filenames, account identities, signed URLs or database connection strings.
export function backupErrorMessage(detail: unknown, context: BackupErrorContext = "backup"): string {
  const message = backupErrorSummary(detail, context);
  if (context !== "backup") return message;
  const source = detail instanceof Error ? detail.message : String(detail ?? "");
  const allowedPhases = new Set([
    "recovery capture", "database dump", "database manifest counts",
    "case-media inventory and reference validation", "case-media storage inventory",
    "case-media transfer into archive", "archive assembly/encryption",
    "archive assembly/encryption and local transfer", "private cloud staging setup",
    "local download", "OneDrive transfer", "OneDrive verification",
    "Google Drive transfer", "Google Drive verification", "SFTP transfer",
    "SFTP verification", "local file verification",
  ]);
  const phases = [...source.matchAll(/Backup failed during ([^:]+?) after /g)]
    .map(match => match[1]).filter(phase => allowedPhases.has(phase!));
  const phase = phases.at(-1);
  const http = source.match(/\bHTTP\s+([45]\d{2})\b/i)?.[1];
  const code = source.match(/\b(ENOSPC|EACCES|EPERM|EROFS|ENOENT|ETIMEDOUT|ECONNRESET|ECONNREFUSED)\b/)?.[1];
  const verification = /\b(?:verification failed|size mismatch|integrity check failed|truncated|invalid encryption header|missing a valid integrity footer|identity or size is unconfirmed)\b/i.test(source);
  const timeout = /timed? ?out|timeout/i.test(source);
  const reason = http ? `Provider returned HTTP ${http}.`
    : code ? `System error: ${code}.`
    : verification ? "Archive identity, size or integrity verification failed."
    : timeout ? "The backup operation timed out."
    : /pg_dump.*(?:fail|exit)/i.test(source) ? "The database export failed." : "";
  return `${message}${phase ? ` Stage: ${phase}.` : ""}${reason ? ` ${reason}` : ""}`;
}

export function backupStatusErrorMessage(): string {
  return "LabTrax could not check the OneDrive backup folder, so a complete recovery point could not be confirmed. Check the OneDrive connection and review the details below.";
}

export function backupDownloadErrorMessage(): string {
  return "LabTrax could not download this backup from its cloud destination. Check the connection and backup history before choosing another restore file.";
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

export function partialBackupMessage(missingFileCount?: number): string {
  if (Number.isSafeInteger(missingFileCount) && missingFileCount! > 0) {
    return `Backup completed with warnings: ${missingFileCount} referenced file(s) were unavailable. The database and all readable files were included, but this is not a complete recovery point.`;
  }
  return "Backup completed with warnings: some content was unavailable. The database and all readable files were included, but this is not a complete recovery point.";
}
