export interface ManualBackupResult {
  runId?: string;
  size?: number;
  completedAt?: string;
  fileName?: string;
  archiveKind?: string | null;
  partialFailure?: boolean;
  warnings?: string | null;
}

export interface ManualBackupStatus {
  runId: string;
  state: string;
  phase: string;
  error?: string;
  result?: ManualBackupResult;
  elapsedMs?: number;
  metrics?: Record<string, number>;
  delivery?: {
    fileName: string;
    size: number;
    archiveKind: string;
    sourceEnvironment: "production" | "non-production";
    expiresAt: string;
  };
}

type VerifiedResult = ManualBackupResult & { size: number; completedAt: string; fileName: string };

/** Never repeat a POST after an ambiguous gateway response. Follow its UUID. */
export async function followManualBackup(
  runId: string,
  initiate: () => Promise<ManualBackupResult & { state?: string }>,
  readStatus: () => Promise<ManualBackupStatus>,
  onStatus: (status: ManualBackupStatus) => void = () => {},
  options: { pause?: () => Promise<void>; now?: () => number; timeoutMs?: number } = {},
): Promise<VerifiedResult> {
  const now = options.now ?? Date.now;
  const started = now();
  let lastSeenAt = started;
  const pause = options.pause ?? (() => new Promise(resolve => setTimeout(resolve, 1500)));
  let uncertain = false;
  try {
    const response = await initiate();
    if (response.state !== "running") {
      if (!response.size || !response.completedAt || !response.fileName) {
        throw new Error("The server did not confirm a saved backup.");
      }
      return { ...response, size: response.size, completedAt: response.completedAt, fileName: response.fileName };
    }
  } catch (error) {
    const status = (error as { status?: number; statusCode?: number })?.status
      ?? (error as { statusCode?: number })?.statusCode;
    if (![502, 503, 504].includes(status ?? 0) &&
        !(error instanceof TypeError) && !/\b50[234]\b/.test(String(error))) throw error;
    uncertain = true;
  }
  while (now() - started < (options.timeoutMs ?? (6 * 60 + 5) * 60_000)) {
    let status: ManualBackupStatus;
    try {
      status = await readStatus();
    } catch (error) {
      // Progress can briefly be absent or unreachable while the request is
      // being accepted. This is not evidence that the backup itself failed.
      if ([401, 403].includes((error as { status?: number })?.status ?? 0)) throw error;
      if (now() - lastSeenAt > 60_000) {
        throw new Error(`Cannot confirm backup ${runId}. Check its status/history before starting another backup.`);
      }
      await pause();
      continue;
    }
    if (status.runId !== runId) throw new Error("The server returned a different backup run.");
    lastSeenAt = now();
    onStatus(status);
    if (status.state === "completed") {
      if (status.result?.runId !== runId || !status.result.size ||
          !status.result.fileName || !status.result.completedAt) {
        throw new Error("Backup completion is missing its exact verified history result.");
      }
      return { ...status.result, size: status.result.size,
        completedAt: status.result.completedAt, fileName: status.result.fileName };
    }
    if (status.state === "failed" || status.state === "stale" || status.state === "cancelled") {
      if (status.state === "cancelled") throw new Error("Backup cancelled. Incomplete output was discarded.");
      throw new Error(status.error ?? `Backup failed during ${status.phase}. Check this run's history.`);
    }
    uncertain = false;
    await pause();
  }
  throw new Error(`${uncertain ? "Cannot confirm" : "Still waiting for"} backup ${runId}. Check its status/history; do not start a duplicate.`);
}
