import type { LocalBackupLiveStatus } from "./local-backup-execution";

export interface ManualBackupResult {
  size: number;
  completedAt: string;
  fileName: string;
  savedTo: string | null;
  viaBrowser: boolean;
  partialFailure?: boolean;
  warnings?: string | null;
  warningMessage?: string | null;
  databaseOnly?: boolean;
}

export interface ManualBackupProgress {
  state: "idle" | "running" | "completed" | "failed" | "cancelled" | "stale";
  runId: string | null;
  startedAt: number;
  phase: string;
  liveStatus: LocalBackupLiveStatus | null;
  result: ManualBackupResult | null;
  error: string | null;
}

export interface ManualBackupIdentity {
  runId: string;
  destination: "local" | "network" | "onedrive" | "google-drive";
  archiveKind: "full" | "database-only";
  path: string;
  startedAt: number;
}

function storageKey(userId: string): string {
  return `labtrax:manual-backup:${userId}`;
}

export function saveManualBackupIdentity(userId: string, identity: ManualBackupIdentity): void {
  try { window.localStorage.setItem(storageKey(userId), JSON.stringify(identity)); } catch { /* storage may be unavailable */ }
}

export function clearManualBackupIdentity(userId: string): void {
  try { window.localStorage.removeItem(storageKey(userId)); } catch { /* storage may be unavailable */ }
}

/** Clear only this browser's obsolete job marker after the server confirms absence. */
export function clearUnavailableManualBackup(userId: string): void {
  clearManualBackupIdentity(userId);
  resetManualBackupProgress("", "");
  updateManualBackupProgress({ error:
    "The previous backup run is no longer available on the server. Its old status was cleared; no completed backup is confirmed. Check Recent Backups, then start a new backup." });
}

export function loadManualBackupIdentity(userId: string): ManualBackupIdentity | null {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ManualBackupIdentity>;
    if (typeof value.runId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.runId) ||
        !["local", "network", "onedrive", "google-drive"].includes(String(value.destination)) ||
        !["full", "database-only"].includes(String(value.archiveKind)) ||
        typeof value.path !== "string" || !Number.isFinite(value.startedAt)) return null;
    return value as ManualBackupIdentity;
  } catch {
    return null;
  }
}

const initialProgress: ManualBackupProgress = {
  state: "idle",
  runId: null,
  startedAt: 0,
  phase: "",
  liveStatus: null,
  result: null,
  error: null,
};

let progress = initialProgress;
const listeners = new Set<() => void>();

export function getManualBackupProgress(): ManualBackupProgress {
  return progress;
}

export function subscribeManualBackupProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateManualBackupProgress(update: Partial<ManualBackupProgress>): void {
  progress = { ...progress, ...update };
  for (const listener of listeners) listener();
}

export function resetManualBackupProgress(runId: string, phase: string, startedAt = Date.now()): void {
  if (!runId) {
    progress = initialProgress;
    for (const listener of listeners) listener();
    return;
  }
  progress = {
    state: "running",
    runId,
    startedAt,
    phase,
    liveStatus: null,
    result: null,
    error: null,
  };
  for (const listener of listeners) listener();
}

export function applyManualBackupLiveStatus(status: LocalBackupLiveStatus): void {
  const state = status.state === "completed" || status.state === "failed" ||
    status.state === "cancelled" || status.state === "stale"
    ? status.state : "running";
  const result = status.result &&
    typeof status.result.size === "number" &&
    typeof status.result.completedAt === "string" &&
    typeof status.result.fileName === "string" ? {
    size: status.result.size,
    completedAt: status.result.completedAt,
    fileName: status.result.fileName,
    savedTo: progress.result?.savedTo ?? null,
    viaBrowser: false,
    partialFailure: status.result.partialFailure,
    warnings: status.result.warnings,
    databaseOnly: status.result.archiveKind === "database-only",
  } : progress.result;
  updateManualBackupProgress({
    state,
    runId: status.runId,
    phase: status.phase,
    liveStatus: status,
    result,
    error: state === "failed" || state === "stale" || state === "cancelled"
      ? status.error ?? (state === "cancelled"
        ? "Backup cancelled. Incomplete output was discarded."
        : "The backup did not complete. Check its history before starting another backup.")
      : null,
  });
}
