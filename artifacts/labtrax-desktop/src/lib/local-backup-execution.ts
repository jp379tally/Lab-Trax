import { getDesktopBackupHistoryByDownloadRunId, withApiRequestTimeout } from "./api";

export const DESKTOP_BACKUP_HISTORY_REPORT_TIMEOUT_MS = 30_000;
export const BACKUP_HISTORY_UNCONFIRMED_MESSAGE =
  "The backup file was saved, but LabTrax could not confirm it in backup history. Check Backup history before starting another backup.";

const SAFE_BACKUP_STAGES = new Set([
  "recovery capture",
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
  "OneDrive verification",
  "Google Drive transfer",
  "Google Drive verification",
  "SFTP transfer",
  "SFTP verification",
  "local file verification",
]);

export class BackupHistoryUnconfirmedError extends Error {
  constructor() {
    super(BACKUP_HISTORY_UNCONFIRMED_MESSAGE);
    this.name = "BackupHistoryUnconfirmedError";
  }
}

export interface LocalBackupSaved {
  fileName: string;
  path: string;
  sizeBytes: number;
  downloadRunId?: string;
  archiveKind?: string;
  missingFileCount?: number;
  partialFailure?: boolean;
  warnings?: string | null;
}

export interface BrowserBackupSaveHandle {
  name?: string;
  createWritable: () => Promise<WritableStream<Uint8Array>>;
}
export interface LocalBackupLiveStatus {
  runId: string;
  state: "running" | "awaiting_verification" | "finalizing" | "completed" | "failed" | "cancelled" | "stale";
  phase: string;
  startedAt?: string;
  overallProgress?: number;
  elapsedMs: number;
  metrics: Record<string, number>;
  error?: string;
  result?: {
    size?: number;
    completedAt?: string;
    fileName?: string;
    archiveKind?: string | null;
    partialFailure?: boolean;
    warnings?: string | null;
  };
  delivery?: {
    fileName: string;
    size: number;
    archiveKind: string;
    sourceEnvironment: "production" | "non-production";
    expiresAt: string;
  };
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
      if (status.state === "completed" || status.state === "failed" ||
          status.state === "cancelled" || status.state === "stale") {
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
  sourceHeaders?: Record<string, string>;
  apiFetch: <T = unknown>(endpoint: string, init?: {
    method?: string;
    body?: string;
    signal?: AbortSignal;
  }) => Promise<T>;
  apiFetchArrayBuffer: (endpoint: string, init?: { method?: string }) => Promise<{ buffer: ArrayBuffer; headers: Headers }>;
  saveBackupToFolder?: (buffer: Uint8Array, fileName: string, folder: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  downloadBackupToFolder?: (
    folder: string,
    source?: "manual" | "scheduler",
    sourceHeaders?: Record<string, string>,
    runId?: string,
    archiveKind?: "full" | "database-only",
  ) => Promise<LocalBackupSaved>;
  onDownloadRunId?: (listener: (runId: string) => void) => () => void;
  runId?: string;
  getLiveStatus?: (runId: string) => Promise<LocalBackupLiveStatus>;
  onLiveStatus?: (status: LocalBackupLiveStatus) => void;
  now?: () => number;
  onPhase?: (phase: string) => void;
  log?: (message: string, metrics?: unknown) => void;
}

export function verifyStreamedBackup(buffer: ArrayBuffer, headers: Headers): void {
  const bytes = new Uint8Array(buffer);
  verifyBackupEnvelope(
    bytes.subarray(0, 4),
    bytes.subarray(-12),
    bytes.byteLength,
    headers,
  );
}

function verifyBackupEnvelope(
  header: Uint8Array,
  footer: Uint8Array,
  byteLength: number,
  headers: Headers,
): void {
  const decoder = new TextDecoder();
  if (byteLength < 44 || decoder.decode(header) !== "LTR2") {
    throw new Error("The downloaded archive is truncated or has an invalid encryption header.");
  }
  const footerOffset = byteLength - 12;
  if (footer.byteLength !== 12 || decoder.decode(footer.subarray(0, 4)) !== "LTF1") {
    throw new Error("The downloaded archive is incomplete or missing a valid integrity footer.");
  }
  const declaredBytes = new DataView(footer.buffer, footer.byteOffset, footer.byteLength)
    .getBigUint64(4, false);
  if (declaredBytes !== BigInt(footerOffset)) {
    throw new Error("The downloaded archive is incomplete or missing a valid integrity footer.");
  }
  const contentLength = headers.get("content-length");
  if (contentLength !== null &&
      (!/^\d+$/.test(contentLength) || BigInt(contentLength) !== BigInt(byteLength))) {
    throw new Error(`The downloaded archive is incomplete (${byteLength} bytes received; Content-Length was ${contentLength}).`);
  }
}
export function verifyCompleteBackupHeaders(headers: Headers): void {
  const archiveKind = headers.get("x-backup-archive-kind");
  const coverageVersion = headers.get("x-backup-coverage-version");
  const mediaFileCount = Number(headers.get("x-backup-media-file-count"));
  const attachmentRowCount = Number(headers.get("x-backup-attachment-row-count"));
  if (
    !["complete-production", "complete-non-production"].includes(archiveKind ?? "") ||
    (headers.has("x-backup-missing-file-count") && headers.get("x-backup-missing-file-count") !== "0") ||
    !["1", "2"].includes(coverageVersion ?? "") ||
    !Number.isSafeInteger(mediaFileCount) || mediaFileCount < 0 ||
    !Number.isSafeInteger(attachmentRowCount) || attachmentRowCount < 0
  ) {
    throw new Error("The server did not confirm complete database-and-files recovery evidence.");
  }
}

/** Database-only is accepted only when explicitly requested, never as fallback. */
export function verifyRequestedBackupHeaders(headers: Headers, kind: "full" | "database-only"): void {
  if (kind === "full") {
    const archiveKind = headers.get("x-backup-archive-kind");
    if (archiveKind === "partial-production" || archiveKind === "partial-non-production") {
      const count = Number(headers.get("x-backup-missing-file-count"));
      if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Partial backup missing-file count is invalid.");
      const evidence = new Headers(headers);
      evidence.set("x-backup-archive-kind", archiveKind.replace("partial-", "complete-"));
      evidence.set("x-backup-missing-file-count", "0");
      return verifyCompleteBackupHeaders(evidence);
    }
    return verifyCompleteBackupHeaders(headers);
  }
  if (headers.get("x-backup-archive-kind") !== "database-only" ||
      headers.get("x-backup-coverage-version") !== "0" ||
      headers.get("x-backup-media-file-count") !== "0") {
    throw new Error("The server did not confirm the explicitly requested database-only backup.");
  }
}

/** One owner records the outcome only after the desktop verifies its disk write. */
export async function executeLocalBackup(
  deps: LocalBackupExecutionDeps,
  folder: string,
  source: "manual" | "scheduler" = "scheduler",
  archiveKind: "full" | "database-only" = "full",
): Promise<LocalBackupSaved & { completedAt: string }> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let phase = "generation and download";
  let fileName = `labtrax-backup-${new Date(now()).toISOString().replace(/[:.]/g, "-")}.zip`;
  let reportConfirmed = false;
  let successReportAttempted = false;
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
    transition(archiveKind === "database-only"
      ? "Generating, downloading and writing a database-only archive; media excluded"
      : "Generating, downloading and writing the full archive");
    if (deps.downloadBackupToFolder) {
      saved = deps.runId || archiveKind === "database-only"
        ? await deps.downloadBackupToFolder(folder, source, deps.sourceHeaders, deps.runId, archiveKind)
        : deps.sourceHeaders
          ? await deps.downloadBackupToFolder(folder, source, deps.sourceHeaders)
          : await deps.downloadBackupToFolder(folder, source);
      fileName = saved.fileName;
    } else {
      if (!deps.saveBackupToFolder) throw new Error("Open LabTrax Desktop to write backups to a folder.");
      const { buffer, headers } = await deps.apiFetchArrayBuffer(
        `/admin/backup/generate?deferRecord=1${source === "manual" ? "&source=manual" : ""}${archiveKind === "database-only" ? "&archiveKind=database-only" : ""}${deps.runId ? `&runId=${encodeURIComponent(deps.runId)}` : ""}`,
        { method: "POST", ...(deps.sourceHeaders ? { headers: deps.sourceHeaders } : {}) },
      );
      const headerRunId = headers.get("x-backup-run-id");
      if (headerRunId) observeRunId(headerRunId);
      verifyRequestedBackupHeaders(headers, archiveKind);
      const missingFileCount = Number(headers.get("x-backup-missing-file-count") ?? 0);
      verifyStreamedBackup(buffer, headers);
      fileName = /filename="?([^";]+)"?/i.exec(headers.get("Content-Disposition") ?? "")?.[1] ?? fileName;
      transition("Writing the backup to the local folder");
      const result = await deps.saveBackupToFolder(new Uint8Array(buffer), fileName, folder);
      if (!result.ok) throw new Error(result.error ?? "Could not write the backup file to the chosen folder.");
      saved = { fileName, path: result.path ?? folder, sizeBytes: buffer.byteLength, downloadRunId: headerRunId ?? undefined,
        missingFileCount, partialFailure: missingFileCount > 0,
        warnings: missingFileCount > 0 ? `${missingFileCount} original files unavailable; see missing-files.json. Not a complete recovery point.` : null };
    }
    downloadRunId = saved.downloadRunId ?? downloadRunId;
    transition("Verifying the saved backup");
    transition("Recording the verified local backup");
    const savedBackup = saved;
    if (!savedBackup) throw new Error("The backup file was not saved.");
    successReportAttempted = true;
    const report = await withApiRequestTimeout(
      (signal) => deps.apiFetch<{ rejected?: boolean; warning?: string; completedAt?: string }>(
        "/admin/backup/desktop-run-report", {
          method: "POST",
          body: JSON.stringify({
            status: "success", fileName, path: savedBackup.path, sizeBytes: savedBackup.sizeBytes,
            downloadRunId,
            ...(source === "manual" ? { source } : {}),
          }),
          signal,
        },
      ),
      DESKTOP_BACKUP_HISTORY_REPORT_TIMEOUT_MS,
      "Timed out while confirming the backup history entry.",
    );
    reportConfirmed = true;
    if (report.rejected) throw new Error(report.warning ?? "The server rejected this backup as unusable.");
    deps.log?.("[local-backup] complete", { elapsedMs: now() - startedAt, sizeBytes: savedBackup.sizeBytes });
    return { ...savedBackup, completedAt: report.completedAt ?? new Date(now()).toISOString() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.log?.("[local-backup] failed", {
      phase,
      elapsedMs: now() - startedAt,
      sizeBytes: saved?.sizeBytes ?? 0,
      diagnostic: detail,
    });
    const historyUnconfirmed = Boolean(saved && successReportAttempted && !reportConfirmed);
    const message = saved && !reportConfirmed
      ? BACKUP_HISTORY_UNCONFIRMED_MESSAGE
      : "The backup did not complete, so no new complete recovery point was created. Check the destination and failure details before deciding what to do next.";
    if (historyUnconfirmed && downloadRunId) {
      try {
        const history = await withApiRequestTimeout(
          (signal) => getDesktopBackupHistoryByDownloadRunId(
            downloadRunId!,
            (endpoint, options) => deps.apiFetch(endpoint, { ...options, signal }),
          ),
          DESKTOP_BACKUP_HISTORY_REPORT_TIMEOUT_MS,
          "Timed out while checking the backup history entry.",
        );
        const run = history?.run;
        if (
          history?.ok === true &&
          run?.downloadRunId === downloadRunId &&
          run.status === "success" &&
          typeof run.completedAt === "string" &&
          Number.isFinite(Date.parse(run.completedAt))
        ) {
          reportConfirmed = true;
          deps.log?.("[local-backup] history confirmed after report timeout", {
            downloadRunId,
            completedAt: run.completedAt,
          });
          return { ...saved!, completedAt: run.completedAt };
        }
      } catch (reconcileError) {
        deps.log?.("[local-backup] history reconciliation unconfirmed", {
          downloadRunId,
          diagnostic: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
        });
      }
    }
    // Once a success POST has been sent, its outcome is ambiguous when its
    // response is missing. Do not send a second, contradictory history row.
    if (!reportConfirmed && !successReportAttempted) {
      try {
        await withApiRequestTimeout(
          (signal) => deps.apiFetch<{ errorReason?: string }>("/admin/backup/desktop-run-report", {
            method: "POST",
            body: JSON.stringify({
              status: "error", fileName, path: folder,
              error: `Backup failed during ${phase} after ${((now() - startedAt) / 1000).toFixed(1)}s: ${detail}`,
              downloadRunId: saved?.downloadRunId ?? downloadRunId ?? (error as { downloadRunId?: string })?.downloadRunId,
              ...(source === "manual" ? { source } : {}),
            }),
            signal,
          }),
          DESKTOP_BACKUP_HISTORY_REPORT_TIMEOUT_MS,
          "Timed out while recording the backup failure.",
        );
      } catch {
        deps.log?.("[local-backup] failure report unconfirmed", { phase, elapsedMs: now() - startedAt });
      }
    }
    if (historyUnconfirmed) throw new BackupHistoryUnconfirmedError();
    // Show a bounded diagnostic immediately, without exposing file paths,
    // provider bodies, account identities or credentials in the main panel.
    const stageName = /Stage: ([^\r\n.]{1,90})\./.exec(detail)?.[1]?.trim();
    const backendStage = stageName && SAFE_BACKUP_STAGES.has(stageName)
      ? `Stage: ${stageName}.`
      : "";
    const http = detail.match(/\bHTTP ([45]\d{2})\b/)?.[1];
    const code = detail.match(/\b(ENOSPC|EACCES|EPERM|EROFS|ENOENT|ETIMEDOUT|ECONNRESET|ECONNREFUSED)\b/)?.[1];
    const integrity = /truncated|invalid encryption header|integrity footer|incomplete|did not confirm/i.test(detail);
    const reason = http ? `Provider returned HTTP ${http}.`
      : code ? `System error: ${code}.`
      : integrity ? "The archive or saved-backup verification failed." : "";
    throw new Error(`${message} Stage: ${phase}.${backendStage ? ` ${backendStage}` : ""}${reason ? ` ${reason}` : ""}`);
  } finally {
    stopLiveWatch?.();
    stopListening?.();
  }
}

/** Stream to a browser-selected file without buffering the archive in memory. */
export async function streamVerifiedBackupToWritable(
  response: Response,
  writable: WritableStream<Uint8Array>,
  archiveKind: "full" | "database-only" = "full",
): Promise<number> {
  try {
    verifyRequestedBackupHeaders(response.headers, archiveKind);
    if (!response.headers.get("content-type")?.includes("application/octet-stream")) {
      throw new Error("The server did not return a valid encrypted backup download.");
    }
    if (!response.body) {
      throw new Error("The server returned an empty backup download.");
    }
  } catch (error) {
    await writable.abort(error).catch(() => {});
    throw error;
  }

  let header = new Uint8Array(0);
  let footer = new Uint8Array(0);
  let byteLength = 0;
  const verifier = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!Number.isSafeInteger(byteLength + chunk.byteLength)) {
        throw new Error("The downloaded archive is larger than this browser can verify.");
      }
      if (header.byteLength < 4) {
        const needed = 4 - header.byteLength;
        const prefix = chunk.subarray(0, needed);
        const nextHeader = new Uint8Array(header.byteLength + prefix.byteLength);
        nextHeader.set(header);
        nextHeader.set(prefix, header.byteLength);
        header = nextHeader;
      }
      byteLength += chunk.byteLength;
      const joinedTail = new Uint8Array(footer.byteLength + chunk.byteLength);
      joinedTail.set(footer);
      joinedTail.set(chunk, footer.byteLength);
      footer = joinedTail.slice(-12);
      controller.enqueue(chunk);
    },
    flush() {
      verifyBackupEnvelope(header, footer, byteLength, response.headers);
    },
  });

  await response.body.pipeThrough(verifier).pipeTo(writable);
  return byteLength;
}
