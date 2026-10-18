export interface LocalBackupSaved {
  fileName: string;
  path: string;
  sizeBytes: number;
  downloadRunId?: string;
}

export interface LocalBackupLiveStatus {
  runId: string;
  state: "running" | "awaiting_verification" | "completed" | "failed" | "stale";
  phase: string;
  elapsedMs: number;
  metrics: Record<string, number>;
}

export function watchBackupLiveStatus(
  runId: string,
  getLiveStatus: (runId: string) => Promise<LocalBackupLiveStatus>,
  onLiveStatus: (status: LocalBackupLiveStatus) => void,
  intervalMs = 1200,
): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  const poll = async () => {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      const status = await getLiveStatus(runId);
      if (!active) return;
      onLiveStatus(status);
      if (status.state === "completed" || status.state === "failed" || status.state === "stale") {
        active = false;
        return;
      }
    } catch {
      // Status is advisory; transient API errors must not fail the backup.
    } finally {
      inFlight = false;
      if (active) timer = setTimeout(() => void poll(), intervalMs);
    }
  };
  void poll();
  return () => {
    active = false;
    if (timer) clearTimeout(timer);
  };
}

export interface LocalBackupExecutionDeps {
  apiFetch: <T = unknown>(endpoint: string, init?: { method?: string; body?: string }) => Promise<T>;
  apiFetchArrayBuffer: (endpoint: string, init?: { method?: string }) => Promise<{ buffer: ArrayBuffer; headers: Headers }>;
  saveBackupToFolder?: (buffer: Uint8Array, fileName: string, folder: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  downloadBackupToFolder?: (folder: string, source?: "manual" | "scheduler") => Promise<LocalBackupSaved>;
  onDownloadRunId?: (listener: (runId: string) => void) => () => void;
  getLiveStatus?: (runId: string) => Promise<LocalBackupLiveStatus>;
  onLiveStatus?: (status: LocalBackupLiveStatus) => void;
  now?: () => number;
  onPhase?: (phase: string) => void;
  log?: (message: string, metrics?: unknown) => void;
}

export function verifyStreamedBackup(buffer: ArrayBuffer, headers: Headers): void {
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  if (bytes.byteLength < 44 || decoder.decode(bytes.subarray(0, 4)) !== "LTR2") {
    throw new Error("The downloaded archive is truncated or has an invalid encryption header.");
  }
  const footerOffset = bytes.byteLength - 12;
  if (decoder.decode(bytes.subarray(footerOffset, footerOffset + 4)) !== "LTF1") {
    throw new Error("The downloaded archive is incomplete or missing a valid integrity footer.");
  }
  const declaredBytes = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getBigUint64(footerOffset + 4, false);
  if (declaredBytes !== BigInt(footerOffset)) {
    throw new Error("The downloaded archive is incomplete or missing a valid integrity footer.");
  }
  const contentLength = headers.get("content-length");
  if (contentLength !== null &&
      (!/^\d+$/.test(contentLength) || BigInt(contentLength) !== BigInt(bytes.byteLength))) {
    throw new Error(`The downloaded archive is incomplete (${bytes.byteLength} bytes received; Content-Length was ${contentLength}).`);
  }
}

export function verifyCompleteBackupHeaders(headers: Headers): void {
  const archiveKind = headers.get("x-backup-archive-kind");
  const coverageVersion = headers.get("x-backup-coverage-version");
  const mediaFileCount = Number(headers.get("x-backup-media-file-count"));
  const attachmentRowCount = Number(headers.get("x-backup-attachment-row-count"));
  if (
    !["complete-production", "complete-non-production"].includes(archiveKind ?? "") ||
    coverageVersion !== "1" ||
    !Number.isSafeInteger(mediaFileCount) || mediaFileCount < 0 ||
    !Number.isSafeInteger(attachmentRowCount) || attachmentRowCount < 0
  ) {
    throw new Error("The server did not confirm complete database-and-files recovery evidence.");
  }
}

/** One owner records the outcome only after the desktop verifies its disk write. */
export async function executeLocalBackup(
  deps: LocalBackupExecutionDeps,
  folder: string,
  source: "manual" | "scheduler" = "scheduler",
): Promise<LocalBackupSaved & { completedAt: string }> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let phase = "generation and download";
  let fileName = `labtrax-backup-${new Date(now()).toISOString().replace(/[:.]/g, "-")}.zip`;
  let reportConfirmed = false;
  let saved: LocalBackupSaved | undefined;
  let downloadRunId: string | undefined;
  let stopLiveWatch: (() => void) | undefined;
  const observeRunId = (runId: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return;
    downloadRunId = runId;
    stopLiveWatch?.();
    if (deps.getLiveStatus && deps.onLiveStatus) {
      stopLiveWatch = watchBackupLiveStatus(runId, deps.getLiveStatus, deps.onLiveStatus);
    }
  };
  const stopListening = deps.onDownloadRunId?.(observeRunId);
  const transition = (next: string) => {
    deps.log?.("[local-backup] phase", { phase, elapsedMs: now() - startedAt, sizeBytes: saved?.sizeBytes ?? 0 });
    phase = next;
    deps.onPhase?.(next);
  };
  try {
    transition("Generating, downloading and writing the full archive");
    if (deps.downloadBackupToFolder) {
      saved = await deps.downloadBackupToFolder(folder, source);
      fileName = saved.fileName;
    } else {
      if (!deps.saveBackupToFolder) throw new Error("Open LabTrax Desktop to write backups to a folder.");
      const { buffer, headers } = await deps.apiFetchArrayBuffer(
        `/admin/backup/generate?deferRecord=1${source === "manual" ? "&source=manual" : ""}`,
        { method: "POST" },
      );
      const headerRunId = headers.get("x-backup-run-id");
      if (headerRunId) observeRunId(headerRunId);
      verifyCompleteBackupHeaders(headers);
      verifyStreamedBackup(buffer, headers);
      fileName = /filename="?([^";]+)"?/i.exec(headers.get("Content-Disposition") ?? "")?.[1] ?? fileName;
      transition("Writing the backup to the local folder");
      const result = await deps.saveBackupToFolder(new Uint8Array(buffer), fileName, folder);
      if (!result.ok) throw new Error(result.error ?? "Could not write the backup file to the chosen folder.");
      saved = { fileName, path: result.path ?? folder, sizeBytes: buffer.byteLength, downloadRunId: headerRunId ?? undefined };
    }
    downloadRunId = saved.downloadRunId ?? downloadRunId;
    transition("Verifying the saved backup");
    transition("Recording the verified local backup");
    const report = await deps.apiFetch<{ rejected?: boolean; warning?: string; completedAt?: string }>(
      "/admin/backup/desktop-run-report", {
        method: "POST",
        body: JSON.stringify({
          status: "success", fileName, path: saved.path, sizeBytes: saved.sizeBytes,
          downloadRunId,
          ...(source === "manual" ? { source } : {}),
        }),
      },
    );
    reportConfirmed = true;
    if (report.rejected) throw new Error(report.warning ?? "The server rejected this backup as unusable.");
    deps.log?.("[local-backup] complete", { elapsedMs: now() - startedAt, sizeBytes: saved.sizeBytes });
    return { ...saved, completedAt: report.completedAt ?? new Date(now()).toISOString() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.log?.("[local-backup] failed", {
      phase,
      elapsedMs: now() - startedAt,
      sizeBytes: saved?.sizeBytes ?? 0,
      diagnostic: detail,
    });
    let message = saved && !reportConfirmed
      ? "The backup file was saved, but LabTrax could not confirm it in backup history. Check Backup history before starting another backup."
      : "The backup did not complete, so no new complete recovery point was created. Check the destination and failure details before deciding what to do next.";
    if (!reportConfirmed) {
      try {
        const report = await deps.apiFetch<{ errorReason?: string }>("/admin/backup/desktop-run-report", {
          method: "POST",
          body: JSON.stringify({
            status: "error", fileName, path: folder,
            error: `Backup failed during ${phase} after ${((now() - startedAt) / 1000).toFixed(1)}s: ${detail}`,
            downloadRunId: saved?.downloadRunId ?? downloadRunId ?? (error as { downloadRunId?: string })?.downloadRunId,
            ...(source === "manual" ? { source } : {}),
          }),
        });
      } catch {
        deps.log?.("[local-backup] failure report unconfirmed", { phase, elapsedMs: now() - startedAt });
      }
    }
    throw new Error(message);
  } finally {
    stopLiveWatch?.();
    stopListening?.();
  }
}
