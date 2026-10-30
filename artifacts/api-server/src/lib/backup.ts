import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { prepareRecoveryZipFile, writeRecoveryEntry, type RecoveryZip } from "./recovery-zip";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import AdmZip from "adm-zip";
import { db, pool, caseAttachments, legacyCaseMedia, labCases } from "@workspace/db";
import {
  describeCaseOrganizationRows,
  inspectCaseOrganizationRows,
} from "@workspace/db/case-organization-integrity";
import { systemSettings, users, backupRuns, notifications } from "@workspace/db";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { filterEmailsByPref } from "./email-prefs";
import { logger } from "./logger";
import {
  describeBackupEmailFailures,
  sendBackupNotificationEmail,
  sendBackupStaleAlertEmail,
} from "./mail";
import {
  uploadBackupFileToOneDrive,
  uploadBackupSourceToOneDrive,
  pruneOneDriveBackups,
  getOneDriveFileByName,
  listOneDriveBackupFiles,
  oneDriveItemPath,
  isOneDriveConnectorAvailable,
  getOneDriveBackupFolder,
  isProductionDeployment,
  DEFAULT_ONEDRIVE_RETENTION_POLICY,
  selectOneDriveBackupsToPrune,
  type OneDriveRetentionPolicy,
  type OneDriveUploadResult,
} from "./onedrive";
import {
  deleteGoogleDriveBackupFile,
  getGoogleDriveBackupFolderId,
  getGoogleDriveFileById,
  getGoogleDriveStatus,
  isGoogleDriveConnectorAvailable,
  googleDriveItemPath,
  listGoogleDriveBackupFiles,
  uploadGoogleDriveBackupFile,
  uploadGoogleDriveBackupSource,
  verifyGoogleDriveBackup,
  type GoogleDriveUploadResult,
} from "./google-drive";
import { resolvePostgresTool } from "./pg-tools";
import { offsiteFirstTickDelayMs } from "./offsite-backup-timing";
import {
  extractMediaFileName,
  extractMediaFilenamesFromText,
} from "./case-media";
import {
  caseMediaObjectStorageAvailable,
  listCaseMediaBackupObjects,
} from "./case-media-object-storage";
import { planBackupMedia, type BackupMediaAppender } from "./backup-media-producer";
import {
  abortableBackupOperation,
  type BackupDeliveryStatus,
  BackupCancelledError,
  getBackupRunId,
  markBackupLiveAwaitingVerification,
  measureBackupPhase,
  safeBackupError,
  setBackupLiveDelivery,
  setBackupLiveArchiveEvidence,
  setBackupLiveProgress,
  withBackupRun,
} from "./backup-phase";
import { ensureBackupHistorySchema } from "./backup-history-schema";
import {
  runDatabaseProtectionJob, getDatabaseProtectionStatus, noteDatabaseProtectionBusy,
  hasPendingDatabaseProtectionCatchup,
  databaseProtectionVerificationError,
  type DatabaseProtectionStatus,
} from "./database-protection-job";
import { MAX_DATABASE_DUMP_BYTES, DatabaseProtectionError } from "./database-protection";
import { captureProductionMedia } from "./production-content-capture";
import { RECORD_DELTA_FORMAT, type RecordInventory } from "./postgres-record-delta";
import { readBackupLiveStatus } from "./backup-live-status-store";
import {
  createBackupCloudStage,
  openBackupCloudStage,
  MAX_BACKUP_RANGE_BYTES,
} from "./backup-cloud-staging";
import {
  captureCompleteBackup, validateCompleteRecovery, restoreCompleteFiles, restoreLocalRecoveryEntry, assertIsolatedCompleteRecovery,
  requireCompleteDestinationCapacity,
  COMPLETE_BACKUP_VERSION, COMPLETE_PRODUCTION_KIND, COMPLETE_DEVELOPMENT_KIND,
  type CompleteArchiveDestination, type CompleteBackupCaptured,
} from "./complete-backup";
import { ensureProductionMediaJournalSchema } from "./production-media-journal";
import { validateRecoveryMediaReceipts } from "./production-media-mutation";

export interface BackupCounts {
  users: number;
  labCases: number;
  organizations: number;
  cases: number;
  caseAttachments: number;
  invoices: number;
  bankTransactions: number;
  pricingTiers: number;
  pricingOverrides: number;
}

export interface UploadDirInfo {
  exists: boolean;
  fileCount: number;
  totalBytes: number;
}

export interface UploadDirsInspection {
  caseMedia: UploadDirInfo;
  profilePhotos: UploadDirInfo;
}

interface PreparedBackupMedia {
  mediaDir: string;
  uploadDirs: UploadDirsInspection;
  appendMedia?: BackupMediaAppender;
  cleanup(): void;
}

export interface BackupResult {
  fileName: string;
  size: number;
  webUrl: string;
  folder: string;
}

export interface BackupRunResult {
  size: number;
  completedAt: string;
  /** The name the destination actually stored, not the name requested. */
  fileName: string;
  /**
   * Destination-side identity of the stored cloud file (OneDrive or Google Drive).
   * Recorded so history rows and history downloads address the exact file the
   * run produced, even if the destination renamed it on conflict.
   */
  remoteItemId?: string | null;
  /** What the archive contains; defaults to a full archive. */
  archiveKind?: BackupArchiveKind;
  destination: BackupDestination;
  path?: string;
  mediaFileCount?: number;
  attachmentRowCount?: number;
  /**
   * True when the run still succeeded but had to drop a non-critical part of
   * the backup to get there (e.g. profile-photos were excluded after the
   * full OneDrive upload failed). Never true alongside a hard failure.
   */
  partialFailure?: boolean;
  /** Human-readable explanation of what was dropped, when partialFailure is true. */
  warnings?: string | null;
}

export type BackupDestination = "local" | "network" | "onedrive" | "google-drive";

export const SETTING_BACKUP_HOUR_UTC = "backup_hour_utc";
export const SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES = "backup_schedule_interval_minutes";
export const SETTING_BACKUP_SCHEDULE_DESTINATION = "backup_schedule_destination";
export const SETTING_BACKUP_SCHEDULE_ROUTING_VERSION = "backup_schedule_routing_version";
export const SETTING_BACKUP_SCHEDULE_PATH = "backup_schedule_path";
export const SETTING_BACKUP_SCHEDULE_ENABLED = "backup_schedule_enabled";
export const SETTING_BACKUP_LAST_SUCCESSFUL_AT = "backup_last_successful_at";
export const SETTING_BACKUP_HISTORY_RETENTION_DAYS = "backup_history_retention_days";
export const SETTING_BACKUP_HISTORY_MAX_ROWS = "backup_history_max_rows";
export const SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT = "backup_stale_alert_last_sent_at";
export const SETTING_BACKUP_STALE_ALERT_THRESHOLD_DAYS = "backup_stale_alert_threshold_days";
export const SETTING_BACKUP_STALE_ALERT_RATE_LIMIT_DAYS = "backup_stale_alert_rate_limit_days";
export const SETTING_BACKUP_STALE_DAYS = "backup_stale_days";
export const DEFAULT_BACKUP_STALE_DAYS = 7;
export const SETTING_ONEDRIVE_RETENTION_MAX_BACKUPS = "onedrive_backup_retention_max";

/**
 * Wall-clock slot the scheduler owes a run for, and the last time it tried.
 * Persisted because the interval timer only lives inside one process: without
 * these, every API restart reset the clock to a full interval from zero and a
 * server that restarts more often than the interval produced no backups at all
 * (and no error rows, because nothing ever ran).
 */
export const SETTING_BACKUP_SCHEDULE_NEXT_DUE_AT = "backup_schedule_next_due_at";
export const SETTING_BACKUP_SCHEDULE_LAST_ATTEMPT_AT = "backup_schedule_last_attempt_at";
export const DEFAULT_ONEDRIVE_RETENTION_MAX_BACKUPS =
  DEFAULT_ONEDRIVE_RETENTION_POLICY.maxFiles;

// ── Off-site (OneDrive) protection ──────────────────────────────────────────
// The lab's data protection requirement is a real off-site copy every fifteen
// minutes. That guarantee deliberately does NOT hang off the user-editable
// backup schedule: that schedule can be set to a local folder (which the
// server cannot write and silently skips), left at a long interval, or
// disabled — and when it was, eighteen days passed with no off-site archive
// and nothing on screen said so. Off-site protection therefore runs on its own
// timer with its own cadence, and the editable schedule can only make it run
// *more* often, never less.
export const SETTING_BACKUP_OFFSITE_ENABLED = "backup_offsite_enabled";
export const SETTING_BACKUP_OFFSITE_INTERVAL_MINUTES = "backup_offsite_interval_minutes";
export const SETTING_BACKUP_OFFSITE_ALERT_LAST_SENT_AT = "backup_offsite_alert_last_sent_at";
/**
 * Rate-limit clock owned by the out-of-process freshness check. Deliberately
 * a different row from the in-process watchdog's: a watchdog hosted by the
 * process it watches cannot report that process being dead, so the external
 * check must not be silenced by an alert the dying process claimed.
 */
export const SETTING_BACKUP_FRESHNESS_ALERT_LAST_SENT_AT =
  "backup_freshness_alert_last_sent_at";
/**
 * Bounded log of alert attempts and their outcomes. An alert that could not
 * be delivered is itself a failure an admin has to see — writing it only to
 * the server log puts it exactly where nobody was looking for eighteen days.
 */
export const SETTING_BACKUP_ALERT_DELIVERY_LOG = "backup_alert_delivery_log";

/** Required off-site cadence. */
export const DEFAULT_OFFSITE_INTERVAL_MINUTES = 15;
/** Floor/ceiling for the configured cadence (a full archive takes minutes). */
export const MIN_OFFSITE_INTERVAL_MINUTES = 5;
export const MAX_OFFSITE_INTERVAL_MINUTES = 1440;

/**
 * Smallest archive size that can plausibly be a real backup.
 *
 * The history that triggered this work contained 12,345-byte rows recorded as
 * successes. A backup of this database cannot be a few kilobytes — anything
 * that small is a placeholder, a truncated transfer, or an error page saved
 * under the backup's name, and recording it as a success advances the
 * staleness watermark and hides the fact that there is nothing to restore.
 */
export const DEFAULT_MIN_PLAUSIBLE_BACKUP_BYTES = 1024 * 1024;

/**
 * Read per call (not captured at import) so a test — or an operator with a
 * genuinely tiny database — can lower the floor via BACKUP_MIN_PLAUSIBLE_BYTES.
 */
export function minPlausibleBackupBytes(): number {
  const raw = parseInt(process.env.BACKUP_MIN_PLAUSIBLE_BYTES || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MIN_PLAUSIBLE_BACKUP_BYTES;
}

/**
 * Monotonically increasing integer that tracks breaking changes to the backup
 * format. Written into every manifest and checked on restore. If the major
 * version in the manifest differs from the running app's version, the restore
 * is aborted before any data is touched.
 */
export const BACKUP_SCHEMA_VERSION = "2";
export const ALL_SCHEDULE_SETTINGS = [
  SETTING_BACKUP_SCHEDULE_ROUTING_VERSION,
  SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES,
  SETTING_BACKUP_SCHEDULE_DESTINATION,
  SETTING_BACKUP_SCHEDULE_PATH,
  SETTING_BACKUP_SCHEDULE_ENABLED,
  SETTING_BACKUP_SCHEDULE_NEXT_DUE_AT,
  SETTING_BACKUP_SCHEDULE_LAST_ATTEMPT_AT,
] as const;

/** Raised when a backup run exceeds its overall wall-clock budget. */
export class BackupTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupTimeoutError";
  }
}
/**
 * Run pg_dump --format=custom against DATABASE_URL asynchronously.
 * Uses spawn (non-blocking) instead of spawnSync so the Node.js event loop
 * remains responsive to health-checks and API requests while pg_dump runs.
 * Throws if pg_dump exits non-zero or DATABASE_URL is not set.
 *
 * When a run deadline is supplied the child is killed as soon as it fires, so
 * a dump that hangs on a stuck connection cannot outlive the run's budget.
 */
async function buildPgDumpBuffer(deadline?: BackupDeadline, snapshot?: string, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
  let dumpBytes = 0;
  return measureBackupPhase("database dump", async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set — cannot run pg_dump.");
  deadline?.throwIfExpired("the database dump");
  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(resolvePostgresTool("pg_dump"), [
      "--format=custom",
      ...(snapshot ? [`--snapshot=${snapshot}`] : []),
      `--dbname=${dbUrl}`,
    ]);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let exceededSize = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      dumpBytes += chunk.length;
      if (dumpBytes > maxBytes) {
        exceededSize = true;
        proc.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(chunk);
      setBackupLiveProgress({ dumpBytes });
    });
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    let abortedByDeadline = false;
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("pg_dump timed out after 10 minutes."));
    }, 10 * 60 * 1000);

    const onDeadline = () => {
      abortedByDeadline = true;
      proc.kill("SIGTERM");
    };
    deadline?.signal.addEventListener("abort", onDeadline, { once: true });
    const settle = () => {
      clearTimeout(timer);
      deadline?.signal.removeEventListener("abort", onDeadline);
    };

    proc.on("close", (code: number | null) => {
      settle();
      if (exceededSize) {
        reject(new DatabaseProtectionError("Database export exceeds the bounded incremental-storage limit; use a streaming implementation for this database size."));
        return;
      }
      if (abortedByDeadline) {
        reject(deadline?.cancelled()
          ? new BackupCancelledError()
          : new BackupTimeoutError("Backup timed out during the database dump — pg_dump was stopped."));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8") || "unknown error";
        reject(new Error(`pg_dump failed (exit ${code}): ${stderr}`));
        return;
      }
      const result = Buffer.concat(stdoutChunks);
      if (result.length === 0) {
        reject(new Error("pg_dump produced empty output."));
        return;
      }
      resolve(result);
    });

    proc.on("error", (err: Error) => {
      settle();
      reject(err);
    });
  });
  }, () => ({ dumpBytes }), (dump) => ({ dumpBytes: dump.length }));
}

/**
 * Stream a custom-format pg_dump with bounded stdout/stderr buffering. The
 * caller must consume the iterator while its exported snapshot is still open.
 */
export async function* buildPgDumpStream(
  deadline?: BackupDeadline,
  snapshot?: string,
  maxBytes = MAX_DATABASE_DUMP_BYTES,
  schema?: "custom" | "plain",
): AsyncGenerator<Buffer> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set — cannot run pg_dump.");
  deadline?.throwIfExpired("the database dump");
  const proc = spawn(resolvePostgresTool("pg_dump"), [
    schema === "plain" ? "--format=plain" : "--format=custom",
    ...(schema ? ["--schema-only", "--no-owner", "--no-privileges", "--quote-all-identifiers"] : []),
    ...(snapshot ? [`--snapshot=${snapshot}`] : []),
    `--dbname=${dbUrl}`,
  ]);
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  let dumpBytes = 0;
  let abortedByDeadline = false;
  let timedOut = false;
  let childError: Error | null = null;
  proc.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= 64 * 1024) return;
    const remaining = 64 * 1024 - stderrBytes;
    const bounded = Buffer.from(chunk.subarray(0, remaining));
    stderrChunks.push(bounded);
    stderrBytes += bounded.length;
  });
  proc.once("error", error => { childError = error; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    proc.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
  }, 10 * 60 * 1000);
  const onDeadline = () => {
    abortedByDeadline = true;
    proc.kill("SIGTERM");
  };
  deadline?.signal.addEventListener("abort", onDeadline, { once: true });
  try {
    for await (const value of proc.stdout) {
      deadline?.throwIfExpired("the database dump");
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      dumpBytes += chunk.length;
      if (dumpBytes > maxBytes) {
        proc.kill("SIGTERM");
        throw new DatabaseProtectionError("Database export exceeds the recovery manifest capacity.");
      }
      setBackupLiveProgress({ dumpBytes });
      yield chunk;
    }
    const result = await exited;
    if (childError) throw childError;
    if (abortedByDeadline) {
      throw deadline?.cancelled()
        ? new BackupCancelledError()
        : new BackupTimeoutError("Backup timed out during the database dump — pg_dump was stopped.");
    }
    if (timedOut) throw new BackupTimeoutError("pg_dump timed out after 10 minutes.");
    if (result.code !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8") || "unknown error";
      throw new Error(`pg_dump failed (exit ${result.code}): ${stderr}`);
    }
    if (dumpBytes === 0) throw new Error("pg_dump produced empty output.");
  } finally {
    clearTimeout(timeout);
    deadline?.signal.removeEventListener("abort", onDeadline);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
    await exited;
  }
}

/**
 * Encrypt a buffer using AES-256-GCM.
 *
 * Output format (all big-endian):
 *   [4 bytes magic "LTRX"] [12 bytes IV] [16 bytes GCM auth-tag] [ciphertext]
 *
 * The encryption key is derived by SHA-256-hashing the BACKUP_ENCRYPTION_KEY
 * env var (preferred) or JWT_SECRET (fallback). Decryption requires the same
 * secret; document decrypt steps in the manifest inside the ZIP before encrypting.
 */
// Magic prefixes identifying the on-disk backup format.
//   "LTRX" — tag-in-middle: magic(4) | iv(12) | authTag(16) | ciphertext
//            Produced by the in-memory encryptBuffer (the auth tag is only
//            known after the whole plaintext is encrypted, so it can sit up
//            front once everything is buffered).
//   "LTR2" — tag-trailing: magic(4) | iv(12) | ciphertext | authTag(16)
//            Historical files end after the tag. New streamed downloads append
//            an LTF1 byte-count footer after the tag; keeping the same prefix
//            lets older desktop downloaders continue to recognize the archive.
const BACKUP_MAGIC_BUFFERED = "LTRX";
const BACKUP_MAGIC_STREAMED = "LTR2";
const BACKUP_STREAM_FOOTER_MAGIC = "LTF1";
const BACKUP_STREAM_FOOTER_BYTES = 12;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * Derive the 32-byte AES key from BACKUP_ENCRYPTION_KEY (preferred) or
 * JWT_SECRET (fallback). Throws a clear error if neither is set.
 */
function deriveBackupKey(): Buffer {
  const secret = process.env.BACKUP_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "Backup encryption requires BACKUP_ENCRYPTION_KEY (or JWT_SECRET) to be set. " +
      "Set one of these environment variables before running a backup.",
    );
  }
  return createHash("sha256").update(secret).digest(); // 32-byte key
}

export function encryptBuffer(plaintext: Buffer): Buffer {
  const key = deriveBackupKey();
  const iv = randomBytes(GCM_IV_BYTES); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes
  const magic = Buffer.from(BACKUP_MAGIC_BUFFERED);
  return Buffer.concat([magic, iv, authTag, ciphertext]);
}

/**
 * Decrypt a buffer produced by any supported backup writer.
 *
 * LTRX keeps the GCM tag before ciphertext. LTR2 keeps the tag at the end;
 * current streamed downloads add an LTF1 footer after the tag with the byte
 * count preceding that footer. Historical LTR2 files without the footer remain
 * readable.
 *
 * Throws if the magic bytes are wrong, the secret is missing, or decryption
 * fails (wrong key or corrupted ciphertext).
 */
export function decryptBuffer(encrypted: Buffer): Buffer {
  const headerLen = 4 + GCM_IV_BYTES + GCM_TAG_BYTES; // magic + iv + tag
  if (encrypted.length < headerLen) {
    throw new Error("File is too short to be a valid LabTrax backup.");
  }
  const magic = encrypted.slice(0, 4).toString("ascii");
  if (magic !== BACKUP_MAGIC_BUFFERED && magic !== BACKUP_MAGIC_STREAMED) {
    throw new Error(
      `Invalid backup file: expected magic bytes '${BACKUP_MAGIC_BUFFERED}' or ` +
      `'${BACKUP_MAGIC_STREAMED}', got '${magic}'. ` +
      "Make sure the file is a LabTrax .zip.enc backup.",
    );
  }
  const key = deriveBackupKey();
  const iv = encrypted.slice(4, 4 + GCM_IV_BYTES);

  // Tag position differs by format: buffered keeps it after the IV, streamed
  // appends it at the very end (it isn't known until the stream finishes).
  let authTag: Buffer;
  let ciphertext: Buffer;
  if (magic === BACKUP_MAGIC_BUFFERED) {
    authTag = encrypted.slice(4 + GCM_IV_BYTES, headerLen);
    ciphertext = encrypted.slice(headerLen);
  } else {
    const footerOffset = encrypted.length - BACKUP_STREAM_FOOTER_BYTES;
    const footer = footerOffset >= headerLen
      ? encrypted.subarray(footerOffset)
      : undefined;
    const hasFooterMarker = footer?.subarray(0, 4).toString("ascii") === BACKUP_STREAM_FOOTER_MAGIC;
    if (hasFooterMarker) {
      if (footer!.readBigUInt64BE(4) !== BigInt(footerOffset) ||
          footerOffset < 4 + GCM_IV_BYTES + GCM_TAG_BYTES) {
        throw new Error("The streamed backup completion footer is invalid or incomplete.");
      }
      authTag = encrypted.subarray(footerOffset - GCM_TAG_BYTES, footerOffset);
      ciphertext = encrypted.subarray(4 + GCM_IV_BYTES, footerOffset - GCM_TAG_BYTES);
    } else {
      // Historical LTR2 archives predate the footer and remain restorable.
      authTag = encrypted.slice(encrypted.length - GCM_TAG_BYTES);
      ciphertext = encrypted.slice(4 + GCM_IV_BYTES, encrypted.length - GCM_TAG_BYTES);
    }
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(
      "Backup decryption failed — the file may be corrupted or was encrypted " +
      "with a different key (BACKUP_ENCRYPTION_KEY / JWT_SECRET).",
    );
  }
}

export type RestorePhase =
  | "idle"
  | "uploading"
  | "validating"
  | "decrypting"
  | "restoring_db"
  | "clearing_sessions"
  | "restoring_media"
  | "done"
  | "error";

export interface RestoreState {
  phase: RestorePhase;
  message: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

let _restoreState: RestoreState = {
  phase: "idle",
  message: null,
  startedAt: null,
  completedAt: null,
};
let _restoreInProgress = false;
// Ordered record of every phase entered during the current/last restore.
// Appended synchronously in setRestorePhase so observers can read the full
// sequence deterministically after the restore settles, without polling
// getRestoreState() (a poll can miss a phase whose only await resolves fast).
let _restoreHistory: RestorePhase[] = [];

export function getRestoreState(): RestoreState {
  return { ..._restoreState };
}

/** Ordered list of phases entered during the current/last restore. */
export function getRestoreHistory(): RestorePhase[] {
  return [..._restoreHistory];
}

function setRestorePhase(phase: RestorePhase, message?: string) {
  _restoreState = {
    ..._restoreState,
    phase,
    message: message ?? null,
  };
  if (_restoreHistory[_restoreHistory.length - 1] !== phase) {
    _restoreHistory.push(phase);
  }
}

/** Query live row counts used to populate the backup manifest. */
async function buildManifestCounts(): Promise<{
  userCount: number;
  orgCount: number;
  caseCount: number;
  invoiceCount: number;
  tableCount: number;
  attachmentRowCount: number;
}> {
  try {
    const result = await pool.query<{
      user_count: string;
      org_count: string;
      case_count: string;
      invoice_count: string;
      table_count: string;
      attachment_row_count: string;
    }>(
      `SELECT
        (SELECT count(*) FROM users   WHERE deleted_at IS NULL)::text          AS user_count,
        (SELECT count(*) FROM organizations WHERE deleted_at IS NULL)::text    AS org_count,
        (SELECT count(*) FROM cases   WHERE deleted_at IS NULL)::text          AS case_count,
        (SELECT count(*) FROM invoices)::text                                  AS invoice_count,
        (SELECT count(*) FROM information_schema.tables
          WHERE table_schema = 'public')::text                                 AS table_count,
        (
          (SELECT count(*) FROM case_attachments WHERE deleted_at IS NULL) +
          (SELECT count(*) FROM legacy_case_media)
        )::text                                                                AS attachment_row_count`,
    );
    const row = result.rows[0];
    return {
      userCount:          parseInt(row.user_count,          10) || 0,
      orgCount:           parseInt(row.org_count,           10) || 0,
      caseCount:          parseInt(row.case_count,          10) || 0,
      invoiceCount:       parseInt(row.invoice_count,       10) || 0,
      tableCount:         parseInt(row.table_count,         10) || 0,
      attachmentRowCount: parseInt(row.attachment_row_count, 10) || 0,
    };
  } catch {
    return { userCount: 0, orgCount: 0, caseCount: 0, invoiceCount: 0, tableCount: 0, attachmentRowCount: 0 };
  }
}

/**
 * Count files (stat only, no content reads) in a single upload directory.
 * Recurses into subdirectories but skips `.restore-snapshots` (internal DB
 * snapshots) and `.trash` (soft-deleted files not relevant to the live count).
 * Logs the resolved path, existence, file count, and total bytes on every call.
 */
function inspectDir(dir: string, label: string): UploadDirInfo {
  if (!fs.existsSync(dir)) {
    logger.info({ dir, label, exists: false }, "[backup] upload dir absent");
    return { exists: false, fileCount: 0, totalBytes: 0 };
  }
  const SKIP = new Set([".trash", ".sessions", ".restore-snapshots"]);
  let fileCount = 0;
  let totalBytes = 0;
  function walk(d: string) {
    let entries: string[];
    try { entries = fs.readdirSync(d); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const full = path.join(d, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full);
      } else {
        fileCount++;
        totalBytes += stat.size;
      }
    }
  }
  walk(dir);
  logger.info({ dir, label, exists: true, fileCount, totalBytes }, "[backup] upload dir inspected");
  return { exists: true, fileCount, totalBytes };
}

/** Test seam: when set, inspectUploadDirs() returns this value instead of reading disk. */
let _uploadInspectionOverride: UploadDirsInspection | null = null;
export function _setUploadInspectionForTests(v: UploadDirsInspection | null): void {
  _uploadInspectionOverride = v;
}

let _uploadsRootOverrideForTests: string | null = null;
export function _setUploadsRootForTests(dir: string | null): void {
  _uploadsRootOverrideForTests = dir;
}

function getUploadsRoot(): string {
  return path.resolve(_uploadsRootOverrideForTests ?? path.join(process.cwd(), "uploads"));
}

/**
 * Inspect both upload directories and return file counts + byte totals.
 * Results are used for the manifest, the fail-fast guard, and backup_runs metrics.
 */
export function inspectUploadDirs(): UploadDirsInspection {
  if (_uploadInspectionOverride !== null) return _uploadInspectionOverride;
  const uploadsRoot = getUploadsRoot();
  const caseMediaDir = path.join(uploadsRoot, "case-media");
  const profilePhotosDir = path.join(uploadsRoot, "profile-photos");
  return {
    caseMedia:     inspectDir(caseMediaDir,    "case-media"),
    profilePhotos: inspectDir(profilePhotosDir, "profile-photos"),
  };
}

async function getRequiredCaseMediaFileNames(): Promise<Set<string>> {
  const [attachments, legacyMedia, liveLegacyCases] = await Promise.all([
    db
      .select({ storageKey: caseAttachments.storageKey })
      .from(caseAttachments)
      .where(isNull(caseAttachments.deletedAt)),
    db.select({ fileName: legacyCaseMedia.fileName }).from(legacyCaseMedia),
    db
      .select({ caseData: labCases.caseData })
      .from(labCases)
      .where(isNull(labCases.deletedAt)),
  ]);

  const required = new Set<string>();
  for (const row of attachments) {
    const fileName = extractMediaFileName(row.storageKey);
    if (fileName) required.add(fileName);
  }
  for (const row of legacyMedia) {
    const fileName = path.basename(row.fileName);
    if (fileName && fileName !== "." && fileName !== "..") required.add(fileName);
  }
  for (const row of liveLegacyCases) {
    for (const fileName of extractMediaFilenamesFromText(row.caseData ?? "")) {
      required.add(fileName);
    }
  }
  return required;
}

async function prepareBackupMedia(
  uploadDirs: UploadDirsInspection,
  attachmentRowCount: number,
  deadline?: BackupDeadline,
): Promise<PreparedBackupMedia> {
  const localMediaDir = path.join(getUploadsRoot(), "case-media");
  if (!isProductionDeployment()) {
    assertBackupMediaConsistency(attachmentRowCount, uploadDirs);
    return {
      mediaDir: localMediaDir,
      uploadDirs,
      cleanup: () => undefined,
    };
  }

  if (!caseMediaObjectStorageAvailable()) {
    throw new Error(
      "Backup aborted: App Storage is not configured for production case-media staging.",
    );
  }

  return measureBackupPhase("case-media inventory and reference validation", async () => {
    deadline?.throwIfExpired("case-media inventory");
    const [objects, requiredFileNames] = await Promise.all([
      listCaseMediaBackupObjects(deadline?.signal),
      abortableBackupOperation(getRequiredCaseMediaFileNames(), deadline?.signal),
    ]);
    const media = await planBackupMedia(localMediaDir, objects, deadline?.signal);
    deadline?.throwIfExpired("case-media reference validation");
    const missingFileCount = [...requiredFileNames].filter((fileName) => {
      if (!fileName || path.basename(fileName) !== fileName) return true;
      return !media.names.has(fileName);
    }).length;
    if (missingFileCount > 0) {
      throw new Error(
        `Backup aborted: ${missingFileCount} referenced case-media file(s) are absent from ` +
        "App Storage and the local media directory.",
      );
    }

    const stagedUploadDirs: UploadDirsInspection = {
      ...uploadDirs,
      caseMedia: { exists: media.fileCount > 0, fileCount: media.fileCount, totalBytes: media.totalBytes },
    };
    assertBackupMediaConsistency(attachmentRowCount, stagedUploadDirs);
    return {
      mediaDir: localMediaDir,
      uploadDirs: stagedUploadDirs,
      appendMedia: media.append,
      cleanup: () => undefined,
    };
  }, undefined, (result) => ({
    mediaFileCount: result.uploadDirs.caseMedia.fileCount,
    mediaBytes: result.uploadDirs.caseMedia.totalBytes,
    attachmentRowCount,
  }));
}

export interface PostRestoreValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Compatible v2 backups may predate the calendar-date migration. pg_restore
 * recreates the dumped physical schema, so normalize this one additive schema
 * evolution before application code reads the restored cases table.
 */
export async function ensureCaseReceivedCalendarDate(): Promise<boolean> {
  const before = await pool.query<{ data_type: string }>(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cases'
      AND column_name = 'received_at'
  `);
  const restoredType = before.rows[0]?.data_type;

  await pool.query(`
    DO $$
    DECLARE
      received_type text;
    BEGIN
      SELECT data_type INTO received_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'cases'
        AND column_name = 'received_at';

      IF received_type IS NULL THEN
        RAISE EXCEPTION 'cases.received_at is missing after restore';
      ELSIF received_type <> 'date' THEN
        ALTER TABLE cases
          ALTER COLUMN received_at DROP DEFAULT,
          ALTER COLUMN received_at TYPE date
            USING ((received_at AT TIME ZONE 'UTC')::date);
      END IF;

      ALTER TABLE cases
        ALTER COLUMN received_at SET DEFAULT
          make_date(
            extract(year from timezone('UTC', CURRENT_TIMESTAMP))::integer,
            extract(month from timezone('UTC', CURRENT_TIMESTAMP))::integer,
            extract(day from timezone('UTC', CURRENT_TIMESTAMP))::integer
          );
    END $$;
  `);
  return restoredType !== "date";
}

/**
 * Run a set of SQL assertions after pg_restore completes to verify the
 * restored database is self-consistent. Returns a { valid, errors } result
 * rather than throwing so callers can decide whether to surface warnings vs.
 * hard-fail. Checks:
 *   (a) users table has ≥ 1 row
 *   (b) organizations table is readable
 *   (c) cases count matches the manifest (if provided)
 *   (d) invoices count matches the manifest (if provided)
 *   (e) no orphaned lab_memberships rows (missing user or org FK)
 *   (f) no canonical cases (including deleted) with missing lab or practice
 *       references, regardless of whether FK constraints exist in the catalog
 */
export async function runPostRestoreValidation(options: {
  expectedCaseCount: number | null;
  expectedInvoiceCount: number | null;
}): Promise<PostRestoreValidationResult> {
  const errors: string[] = [];
  try {
    const usersResult = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users WHERE deleted_at IS NULL",
    );
    const userCount = parseInt(usersResult.rows[0]?.count ?? "0", 10);
    if (userCount < 1) {
      errors.push("users table is empty after restore — at least one user is required");
    }

    await pool.query("SELECT count(*) FROM organizations");

    const receivedDateType = await pool.query<{ data_type: string }>(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cases'
         AND column_name = 'received_at'`,
    );
    if (receivedDateType.rows[0]?.data_type !== "date") {
      errors.push("cases.received_at is not a calendar-date column after restore");
    }

    if (options.expectedCaseCount !== null) {
      const casesResult = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM cases WHERE deleted_at IS NULL",
      );
      const caseCount = parseInt(casesResult.rows[0]?.count ?? "0", 10);
      if (caseCount < options.expectedCaseCount) {
        errors.push(
          `Case count mismatch: manifest says ${options.expectedCaseCount}, found ${caseCount} — restore may have lost data`,
        );
      }
    }

    if (options.expectedInvoiceCount !== null) {
      const invoicesResult = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM invoices",
      );
      const invoiceCount = parseInt(invoicesResult.rows[0]?.count ?? "0", 10);
      if (invoiceCount < options.expectedInvoiceCount) {
        errors.push(
          `Invoice count mismatch: manifest says ${options.expectedInvoiceCount}, found ${invoiceCount} — restore may have lost data`,
        );
      }
    }

    const orphanResult = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM lab_memberships lm
       WHERE lm.deleted_at IS NULL
         AND (
           NOT EXISTS (SELECT 1 FROM users        u WHERE u.id = lm.user_id)
           OR NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = lm.lab_id)
         )`,
    );
    const orphanCount = parseInt(orphanResult.rows[0]?.count ?? "0", 10);
    if (orphanCount > 0) {
      errors.push(
        `Found ${orphanCount} orphaned lab_membership row(s) with missing user or organization references`,
      );
    }

    const caseRows = await inspectCaseOrganizationRows((querySql) => pool.query(querySql));
    if (caseRows.affectedTotal > 0) {
      errors.push(describeCaseOrganizationRows(caseRows));
    }
  } catch (err: unknown) {
    errors.push(
      `Validation query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Synchronously decrypt and parse the manifest from an encrypted backup
 * buffer, and validate that it is compatible with the running app.
 *
 * Throws an error (message starts with "Incompatible backup") if the
 * backup's major schema version differs from BACKUP_SCHEMA_VERSION, or an
 * "Invalid backup" error if the archive is corrupt.  Routes should call this
 * before accepting the file and returning 202 so the caller receives a 409
 * synchronously rather than discovering the mismatch via async status polling.
 */
/**
 * Read the archive kind out of a manifest. Archives written before the kind
 * existed are full archives (nothing else was ever produced).
 */
export function manifestArchiveKind(
  manifest: Record<string, unknown>,
): BackupArchiveKind {
  return manifest.archiveKind === "database-only" ? "database-only" : "full";
}
export function parseAndValidateBackupManifest(
  encryptedBuffer: Buffer,
): Record<string, unknown> {
  const zipBuffer = decryptBuffer(encryptedBuffer);
  const zip = new AdmZip(zipBuffer);
  const manifestEntry = zip.getEntry("manifest.json");
  if (!manifestEntry) {
    throw new Error("Invalid backup: manifest.json is missing from the archive.");
  }
  const manifest = JSON.parse(manifestEntry.getData().toString("utf8")) as Record<string, unknown>;
  const complete = validateCompleteRecovery(zip);
  if (complete) assertIsolatedCompleteRecovery(complete);
  if (manifest.appName !== "LabTrax") {
    throw new Error(
      `Invalid backup: manifest.json has appName '${manifest.appName}', expected 'LabTrax'.`,
    );
  }
  if (!zip.getEntry("db/database.pgdump")) {
    throw new Error("Invalid backup: db/database.pgdump is missing from the archive.");
  }
  assertRestorableArchiveKind(manifest);
  const manifestSchemaVersion = typeof manifest.schemaVersion === "string"
    ? manifest.schemaVersion : null;
  if (manifestSchemaVersion !== null) {
    const manifestMajor = parseInt(manifestSchemaVersion, 10);
    const appMajor = parseInt(BACKUP_SCHEMA_VERSION, 10);
    if (!isNaN(manifestMajor) && !isNaN(appMajor) && manifestMajor !== appMajor) {
      throw new Error(
        `Incompatible backup: this backup was created with schema version ${manifestMajor} ` +
        `but the running app uses schema version ${appMajor}. ` +
        `Restore across major schema versions is not supported.`,
      );
    }
  }
  return manifest;
}

/**
 * Restore a LabTrax backup from an encrypted buffer.
 *
 * Steps:
 *   1. Validate magic bytes / decrypt → ZIP buffer
 *   2. Parse manifest.json from ZIP
 *   3. Extract db/database.pgdump → temp file
 *   4. Run pg_restore --clean --if-exists
 *   5. Move current media to .trash/<timestamp>/, copy media/ from ZIP
 *   6. Record backup_runs row (trigger: restore:admin)
 *   7. Clean up temp directory
 *
 * Throws on any step before the live database is touched (steps 1–2 are
 * pre-flight; step 3 onwards touches live data). Concurrent restores are
 * rejected by the caller via _restoreInProgress.
 */
export async function executeRestoreFile(encryptedPath: string, triggeredBy: string) {
  const isolatedRoot = process.env.LABTRAX_ISOLATED_RESTORE_ROOT;
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (!isolatedRoot || !path.resolve(process.cwd()).startsWith(`${path.resolve(isolatedRoot)}${path.sep}`) ||
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Disk-backed recovery is restricted to an isolated workspace and disposable local database.");
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "labtrax-recovery-files-"));
  try {
    const zip = await prepareRecoveryZipFile(encryptedPath, deriveBackupKey(), staging);
    const complete = validateCompleteRecovery(zip);
    const destination = process.env.PRIVATE_OBJECT_DIR?.trim().replace(/^\/+|\/+$/g, "");
    if (complete?.storageNamespaceSha256 && destination &&
        complete.storageNamespaceSha256 === createHash("sha256").update(destination).digest("hex")) {
      throw new Error("Isolated recovery cannot write back into the source private object namespace.");
    }
    return await executeRestoreArchive(zip, triggeredBy);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function executeRestore(
  encryptedBuffer: Buffer, triggeredBy: string,
) {
  return executeRestoreArchive(encryptedBuffer, triggeredBy);
}

async function executeRestoreArchive(
  encryptedBuffer: Buffer | RecoveryZip,
  triggeredBy: string,
): Promise<{
  manifest: Record<string, unknown>;
  compatibilityUpgrades: string[];
}> {
  if (_restoreInProgress) {
    throw new Error("A restore is already in progress. Please wait for it to finish.");
  }
  _restoreInProgress = true;
  _restoreState = {
    phase: "validating",
    message: "Validating backup file…",
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  _restoreHistory = ["validating"];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "labtrax-restore-"));
  try {
    // ── Step 1: decrypt ──────────────────────────────────────────────────────
    setRestorePhase("decrypting", "Decrypting backup…");
    let zipBuffer: Buffer | null = null;
    try {
      if (Buffer.isBuffer(encryptedBuffer)) zipBuffer = decryptBuffer(encryptedBuffer);
    } catch (err: unknown) {
      throw err;
    }

    // ── Step 2: parse and validate manifest ──────────────────────────────────
    setRestorePhase("validating", "Validating manifest…");
    let zip: RecoveryZip;
    let manifest: Record<string, unknown>;
    try {
      zip = zipBuffer ? new AdmZip(zipBuffer) : encryptedBuffer as RecoveryZip;
      const manifestEntry = zip.getEntry("manifest.json");
      if (!manifestEntry) {
        throw new Error("Invalid backup: manifest.json is missing from the archive.");
      }
      const raw = manifestEntry.getData().toString("utf8");
      manifest = JSON.parse(raw) as Record<string, unknown>;
      const complete = validateCompleteRecovery(zip);
      if (complete) assertIsolatedCompleteRecovery(complete);
      if (complete?.files.some(file => file.generation || file.archivePath.startsWith("private-objects/")) &&
          !caseMediaObjectStorageAvailable()) {
        throw new Error("Complete recovery needs an explicitly configured private storage destination before restoring the database.");
      }
      if (manifest.appName !== "LabTrax") {
        throw new Error(
          `Invalid backup: manifest.json has appName '${manifest.appName}', expected 'LabTrax'.`,
        );
      }
      const dbEntry = zip.getEntry("db/database.pgdump");
      if (!dbEntry) {
        throw new Error("Invalid backup: db/database.pgdump is missing from the archive.");
      }
      // Pre-flight: a database-only archive has no media to restore, so
      // proceeding would wipe the media tree. Reject it here, before step 4
      // touches the live database.
      assertRestorableArchiveKind(manifest);
    } catch (err: unknown) {
      throw err;
    }

    // ── Step 2.5: schema version check ───────────────────────────────────────
    // Abort before any data is touched if the backup's major schema version
    // differs from the running app. This prevents silent data corruption when
    // restoring an older/newer-format backup onto an incompatible app version.
    const manifestSchemaVersion = typeof manifest.schemaVersion === "string"
      ? manifest.schemaVersion : null;
    if (manifestSchemaVersion !== null) {
      const manifestMajor = parseInt(manifestSchemaVersion, 10);
      const appMajor = parseInt(BACKUP_SCHEMA_VERSION, 10);
      if (!isNaN(manifestMajor) && !isNaN(appMajor) && manifestMajor !== appMajor) {
        throw new Error(
          `Incompatible backup: this backup was created with schema version ${manifestMajor} ` +
          `but the running app uses schema version ${appMajor}. ` +
          `Restore across major schema versions is not supported. ` +
          `Use a LabTrax version that matches the backup's schema version, or export a fresh backup.`,
        );
      }
    }

    // ── Step 3: extract pg dump to temp file ─────────────────────────────────
    const pgDumpPath = path.join(tmpDir, "database.pgdump");
    const dbEntry = zip.getEntry("db/database.pgdump")!;
    await writeRecoveryEntry(dbEntry, pgDumpPath);

    // ── Step 3.5: pre-restore safety snapshot ────────────────────────────────
    // Capture a pg_dump of the CURRENT live database before any data is changed.
    // Stored at uploads/.restore-snapshots/pre-restore-<ts>.pgdump so an admin
    // can manually recover if the restore is interrupted or produces bad data.
    const snapshotsDir = path.resolve(process.cwd(), "uploads", ".restore-snapshots");
    try {
      fs.mkdirSync(snapshotsDir, { recursive: true });
      const snapshotPath = path.join(snapshotsDir, `pre-restore-${Date.now()}.pgdump`);
      const snapshotBuffer = await buildPgDumpBuffer();
      fs.writeFileSync(snapshotPath, snapshotBuffer);
      logger.info({ snapshotPath }, "[restore] Pre-restore safety snapshot created");
    } catch (snapshotErr: unknown) {
      logger.warn(
        { err: snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr) },
        "[restore] Pre-restore snapshot failed — continuing. Manual recovery may be needed if restore fails.",
      );
    }

    // ── Step 4: run pg_restore ────────────────────────────────────────────────
    setRestorePhase("restoring_db", "Restoring database (this may take a moment)…");
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error("DATABASE_URL is not set — cannot restore database.");
    const completeEvidence = validateCompleteRecovery(zip);
    const isolatedRoot = process.env.LABTRAX_ISOLATED_RESTORE_ROOT;
    const isolatedRestore = !!isolatedRoot &&
      path.resolve(process.cwd()).startsWith(`${path.resolve(isolatedRoot)}${path.sep}`) &&
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(dbUrl).hostname);

    // ── Session preservation (gap-free approach) ────────────────────────────
    // Problem: pg_restore --clean drops user_sessions early (before users,
    // because user_sessions has a FK to users).  Concurrent authenticated
    // test workers create sessions that land in the gap between our pre-
    // capture SELECT and pg_restore's DROP, making those sessions unrecoverable.
    //
    // Solution: exclude user_sessions from pg_restore entirely by:
    //   1. Drop the FK constraint from user_sessions → users so that
    //      pg_restore can DROP TABLE users without cascading to user_sessions.
    //   2. Generate a filtered TOC that comments-out every user_sessions entry
    //      (DROP, CREATE TABLE, TABLE DATA, constraints, indexes).
    //   3. Run pg_restore with --use-list pointing at the filtered TOC.
    //      user_sessions is never touched — live sessions survive intact.
    //   4. Delete sessions whose user no longer exists after restore (orphans).
    //   5. Re-add the FK constraint.
    //
    // This eliminates the gap entirely: user_sessions is preserved unchanged
    // throughout the restore, so no session is ever lost.

    // Step 4a: drop the FK constraint user_sessions.user_id → users.id
    let userSessionsFkName: string | null = null;
    let userSessionsFkDef: string | null = null;
    try {
      const res = await pool.query<{ conname: string; condef: string }>(`
        SELECT c.conname,
               pg_get_constraintdef(c.oid, true) AS condef
        FROM   pg_constraint c
        JOIN   pg_class      t ON t.oid = c.conrelid
        JOIN   pg_namespace  n ON n.oid = t.relnamespace
        WHERE  t.relname = 'user_sessions'
          AND  n.nspname = 'public'
          AND  c.contype = 'f'
      `);
      if (res.rows.length > 0) {
        userSessionsFkName = res.rows[0].conname;
        userSessionsFkDef  = res.rows[0].condef;
        await pool.query(
          `ALTER TABLE user_sessions DROP CONSTRAINT "${userSessionsFkName}"`,
        );
      }
    } catch (fkErr: unknown) {
      logger.warn(
        { err: fkErr instanceof Error ? fkErr.message : String(fkErr) },
        "[restore] Could not drop user_sessions FK — falling back to TRUNCATE strategy",
      );
      // Fall back: if we cannot drop the FK, user_sessions will be wiped by
      // pg_restore as usual.  The session TRUNCATE + re-insert path is gone,
      // so sessions will simply be lost for this restore cycle.
    }

    // Step 4b: generate a filtered TOC that skips all user_sessions entries
    const tmpTocPath = path.join(
      os.tmpdir(),
      `labtrax-restore-toc-${Date.now()}-${process.pid}.list`,
    );
    let tocFilterOk = false;
    const archiveTables = new Set<string>();
    try {
      const tocOutput = await new Promise<string>((resolve, reject) => {
        const proc = spawn(resolvePostgresTool("pg_restore"), ["--list", pgDumpPath]);
        const chunks: Buffer[] = [];
        proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        const errChunks: Buffer[] = [];
        proc.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
        proc.on("close", (code: number | null) => {
          if (code !== null && code > 1) {
            reject(new Error(
              `pg_restore --list failed (exit ${code}): ` +
              Buffer.concat(errChunks).toString().slice(0, 200),
            ));
            return;
          }
          const output = Buffer.concat(chunks).toString("utf8");
          for (const line of output.split("\n")) {
            const tableEntry = line.match(/^\s*\d+;\s+\d+\s+\d+\s+TABLE\s+(\S+)\s+(\S+)\s/);
            if (tableEntry) archiveTables.add(`${tableEntry[1]}.${tableEntry[2]}`);
          }
          resolve(output);
        });
        proc.on("error", reject);
      });
      // Comment out every TOC line that mentions user_sessions.
      // Active entries start with a digit; prepend ';' to comment them out.
      const filtered = tocOutput
        .split("\n")
        .map((line) =>
          !isolatedRestore && /\buser_sessions\b/.test(line) && /^\d/.test(line.trimStart())
            ? `;${line}`
            : line,
        )
        .join("\n");
      fs.writeFileSync(tmpTocPath, filtered, "utf8");
      tocFilterOk = true;
    } catch (tocErr: unknown) {
      logger.warn(
        { err: tocErr instanceof Error ? tocErr.message : String(tocErr) },
        "[restore] TOC generation failed — running pg_restore without session filter",
      );
    }

    // Step 4c: run pg_restore (with filtered TOC if available)
    const pgRestoreArgs = [
      "--clean",
      "--if-exists",
      ...(tocFilterOk ? [`--use-list=${tmpTocPath}`] : []),
      `--dbname=${dbUrl}`,
      pgDumpPath,
    ];
    const crossVersionForeignKeys = archiveTables.size
      ? (await pool.query<{
          childSchema: string;
          childTable: string;
          constraintName: string;
          definition: string;
          validated: boolean;
        }>(
          `SELECT child_ns.nspname AS "childSchema",
             child.relname AS "childTable",
             c.conname AS "constraintName",
             pg_get_constraintdef(c.oid, true) AS definition,
             c.convalidated AS validated
           FROM pg_constraint c
           JOIN pg_class child ON child.oid = c.conrelid
           JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
           JOIN pg_class parent ON parent.oid = c.confrelid
           JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
           WHERE c.contype = 'f'
             AND (parent_ns.nspname || '.' || parent.relname) = ANY($1::text[])
             AND (child_ns.nspname || '.' || child.relname) <> ALL($1::text[])
           ORDER BY child_ns.nspname, child.relname, c.conname`,
          [[...archiveTables]],
        )).rows
      : [];
    const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const restoreCrossVersionForeignKeys = async (
      constraints: typeof crossVersionForeignKeys,
    ): Promise<string[]> => {
      const failures: string[] = [];
      for (const fk of constraints) {
        try {
          await pool.query(
            `ALTER TABLE ${quoteIdentifier(fk.childSchema)}.${quoteIdentifier(fk.childTable)} ` +
            `ADD CONSTRAINT ${quoteIdentifier(fk.constraintName)} ${fk.definition}` +
            (!fk.validated && !/\bNOT VALID\b/i.test(fk.definition) ? " NOT VALID" : ""),
          );
        } catch (error) {
          const validationError = error instanceof Error ? error.message : String(error);
          if (fk.validated && !/\bNOT VALID\b/i.test(fk.definition)) {
            try {
              await pool.query(
                `ALTER TABLE ${quoteIdentifier(fk.childSchema)}.${quoteIdentifier(fk.childTable)} ` +
                `ADD CONSTRAINT ${quoteIdentifier(fk.constraintName)} ${fk.definition} NOT VALID`,
              );
              failures.push(
                `${fk.childSchema}.${fk.childTable}.${fk.constraintName}: validation failed ` +
                `(${validationError}); the constraint was reinstated NOT VALID, so the restore is incomplete`,
              );
              continue;
            } catch (fallbackError) {
              failures.push(
                `${fk.childSchema}.${fk.childTable}.${fk.constraintName}: validation failed ` +
                `(${validationError}); NOT VALID reinstatement also failed ` +
                `(${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)})`,
              );
              continue;
            }
          }
          failures.push(
            `${fk.childSchema}.${fk.childTable}.${fk.constraintName}: ` +
            validationError,
          );
        }
      }
      return failures;
    };
    const droppedCrossVersionForeignKeys: typeof crossVersionForeignKeys = [];
    try {
      for (const fk of crossVersionForeignKeys) {
        await pool.query(
          `ALTER TABLE ${quoteIdentifier(fk.childSchema)}.${quoteIdentifier(fk.childTable)} ` +
          `DROP CONSTRAINT ${quoteIdentifier(fk.constraintName)}`,
        );
        droppedCrossVersionForeignKeys.push(fk);
      }
    } catch (error) {
      const readdFailures = await restoreCrossVersionForeignKeys(droppedCrossVersionForeignKeys);
      throw new Error(
        `Could not prepare the historical restore: ${error instanceof Error ? error.message : String(error)}` +
        (readdFailures.length ? `; could not reinstate prior constraints: ${readdFailures.join("; ")}` : ""),
      );
    }

    let pgRestoreError: unknown = null;
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(resolvePostgresTool("pg_restore"), pgRestoreArgs);
        const stderrChunks: Buffer[] = [];
        proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
        const timer = setTimeout(() => {
          proc.kill("SIGTERM");
          reject(new Error("pg_restore timed out after 20 minutes."));
        }, 20 * 60 * 1000);
        proc.on("close", (code: number | null) => {
          clearTimeout(timer);
          // pg_restore exits non-zero even for warnings; check stderr for real errors.
          // We accept exit code 1 (warnings) but reject code > 1 (real failures).
          if (code === null || code > 1 || (completeEvidence && code !== 0)) {
            const stderr = Buffer.concat(stderrChunks).toString("utf8");
            reject(new Error(`pg_restore failed (exit ${code}): ${stderr.slice(0, 500)}`));
            return;
          }
          resolve();
        });
        proc.on("error", (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } catch (error) {
      pgRestoreError = error;
    }

    // Older archives do not contain tables introduced by later releases. Keep
    // their data and relationships, but temporarily remove only FKs from those
    // newer tables that block replacement of a parent table in this archive.
    // Re-adding each original, validated definition makes an incompatible
    // restore fail closed rather than leaving the current schema unguarded.
    const fkRestoreFailures = await restoreCrossVersionForeignKeys(droppedCrossVersionForeignKeys);
    try { fs.unlinkSync(tmpTocPath); } catch { /* best-effort cleanup */ }
    if (fkRestoreFailures.length) {
      throw new Error(
        `Could not reinstate and validate cross-version foreign keys after restore: ${fkRestoreFailures.join("; ")}` +
        (pgRestoreError ? `; ${pgRestoreError instanceof Error ? pgRestoreError.message : String(pgRestoreError)}` : ""),
      );
    }
    if (pgRestoreError) throw pgRestoreError;

    // ── Step 4.5: session cleanup and FK restoration ──────────────────────────
    setRestorePhase("clearing_sessions", "Cleaning up sessions…");

    // Step 4d: delete orphan sessions (user no longer exists after restore).
    // This handles sessions for users created after the backup was taken —
    // those users are gone now, so their sessions are invalid.
    try {
      await pool.query(
        "DELETE FROM user_sessions WHERE user_id NOT IN (SELECT id FROM users)",
      );
    } catch {
      // Non-fatal: if user_sessions was wiped by pg_restore (FK drop failed),
      // this is a no-op.
    }

    // Step 4e: re-add the FK constraint.
    if (userSessionsFkName && userSessionsFkDef) {
      try {
        await pool.query(
          `ALTER TABLE user_sessions ADD CONSTRAINT "${userSessionsFkName}" ${userSessionsFkDef}`,
        );
      } catch (fkRestoreErr: unknown) {
        logger.error(
          { err: fkRestoreErr instanceof Error ? fkRestoreErr.message : String(fkRestoreErr) },
          "[restore] Failed to re-add user_sessions FK constraint — DB may need manual repair",
        );
      }
    }

    // ── Step 5: restore media files ───────────────────────────────────────────
    setRestorePhase("restoring_media", "Restoring case media files…");
    const mediaDir = path.resolve(process.cwd(), "uploads", "case-media");
    const profilePhotosDir = path.resolve(process.cwd(), "uploads", "profile-photos");
    // Coverage was authenticated before pg_restore. A partial archive may only
    // add absent files: do not trash or overwrite originals on the target.
    const preserveExistingMedia = completeEvidence?.recoveryCoverage === "partial";
    // Older dumps may lack the new durable writer protocol. Restore its schema
    // before any file mutation; never bulk-trash unrelated existing originals.
    await ensureProductionMediaJournalSchema(true);
    const receiptBaseline = Number((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM labtrax_production_media_write_intents",
    )).rows[0]?.count);
    const archivedReceipts = completeEvidence?.tables.find(t =>
      t.schema === "public" && t.name === "labtrax_production_media_write_intents");
    if (!Number.isSafeInteger(receiptBaseline) || (archivedReceipts && receiptBaseline !== archivedReceipts.rows)) {
      throw new Error("Restored media audit baseline does not match the recovery archive.");
    }
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.mkdirSync(profilePhotosDir, { recursive: true });

    // Extract media/ entries from ZIP into mediaDir.
    for (const entry of preserveExistingMedia || completeEvidence ? [] : zip.getEntries()) {
      const entryName = entry.entryName;
      if (!entryName.startsWith("media/")) continue;
      const relative = entryName.slice("media/".length);
      if (!relative) continue; // skip the directory entry itself
      const destPath = path.join(mediaDir, relative);
      if (!entry.isDirectory) {
        await restoreLocalRecoveryEntry(entry, destPath, `case-media/${relative}`);
      }
    }

    // Extract profile-photos/ entries from ZIP into profilePhotosDir.
    // Older backups that pre-date this feature simply have no profile-photos/ entries,
    // so this loop is a silent no-op for them.
    for (const entry of preserveExistingMedia || completeEvidence ? [] : zip.getEntries()) {
      const entryName = entry.entryName;
      if (!entryName.startsWith("profile-photos/")) continue;
      const relative = entryName.slice("profile-photos/".length);
      if (!relative) continue; // skip the directory entry itself
      const destPath = path.join(profilePhotosDir, relative);
      if (!entry.isDirectory) {
        await restoreLocalRecoveryEntry(entry, destPath, `local-uploads/profile-photos/${relative}`);
      }
    }

    const completeRecovery = completeEvidence;
    if (completeRecovery) {
      const fileResult = await restoreCompleteFiles(zip, completeRecovery, getUploadsRoot(), {
        caseMediaRoot: mediaDir,
      });
      manifest.preservedExistingFileCount = fileResult.preservedExistingFiles;
      await validateRecoveryMediaReceipts(fileResult.mediaWriteReceiptIds);
      const finalReceipts = Number((await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM labtrax_production_media_write_intents",
      )).rows[0]?.count);
      if (finalReceipts !== receiptBaseline + fileResult.mediaWriteReceiptIds.length) {
        throw new Error("Recovery media audit receipt count does not reconcile.");
      }
      // Every application table was dumped. Verify the restored coverage, not
      // just the historical four UI counts. Sessions are intentionally retained.
      for (const table of completeRecovery.tables) {
        if (!isolatedRestore && table.schema === "public" && table.name === "user_sessions") continue;
        const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
        const result = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${quote(table.schema)}.${quote(table.name)}`,
        );
        const derivedReceipts = table.schema === "public" && table.name === "labtrax_production_media_write_intents"
          ? fileResult.mediaWriteReceiptIds.length : 0;
        if (Number(result.rows[0]?.count) !== table.rows + derivedReceipts) {
          throw new Error(`Complete recovery row-count mismatch in ${table.schema}.${table.name}.`);
        }
      }
    }

    // Compatible backups can contain the pre-migration timestamptz column.
    // Convert its UTC day before validation or any restored case is read.
    const upgradedReceivedDate = await ensureCaseReceivedCalendarDate();
    await ensureBackupHistorySchema();
    // Historical full-schema archives predate optional implant annotations.
    // Restore their blank columns before case reads select the current schema.
    await pool.query(`
      ALTER TABLE public.case_restorations
        ADD COLUMN IF NOT EXISTS implant_retention text,
        ADD COLUMN IF NOT EXISTS implant_manufacturer text,
        ADD COLUMN IF NOT EXISTS implant_platform_notes text
    `);
    const compatibilityUpgrades = upgradedReceivedDate
      ? ["cases.received_at:timestamptz-to-date"]
      : [];

    // ── Step 5.5: post-restore validation ────────────────────────────────────
    // SQL checks verify the restored database is self-consistent. Hard-fail:
    // if validation finds orphaned rows or broken FKs the restore is considered
    // corrupt and phase is set to error so the admin knows to investigate or
    // roll back using the pre-restore safety snapshot.
    setRestorePhase("validating", "Validating restored data…");
    const expectedCaseCount = typeof manifest.caseCount === "number"
      ? manifest.caseCount : null;
    const expectedInvoiceCount = typeof manifest.invoiceCount === "number"
      ? manifest.invoiceCount : null;
    const validation = await runPostRestoreValidation({
      expectedCaseCount,
      expectedInvoiceCount,
    });
    if (!validation.valid) {
      throw new Error(
        `Post-restore validation failed: ${validation.errors.join("; ")}. ` +
        `A pre-restore safety snapshot was saved to uploads/.restore-snapshots/ for manual recovery.`,
      );
    }

    // ── Step 6: record restore run ────────────────────────────────────────────
    try {
      await db.insert(backupRuns).values({
        triggeredBy,
        destination: "local" as const,
        path: null,
        fileName: null,
        sizeBytes: Buffer.isBuffer(encryptedBuffer) ? encryptedBuffer.length : encryptedBuffer.encryptedSize ?? 0,
        status: "success",
        error: null,
        completedAt: new Date(),
      });
    } catch {
      // Non-fatal — DB is freshly restored, rows table is available but insert
      // failures should not block the restore result.
    }

    _restoreState = {
      phase: "done",
      message: manifest.recoveryCoverage === "partial"
        ? `Restore completed with warnings: ${manifest.missingFileCount} original files are missing. Database references were preserved; existing media was not removed.`
        : "Restore complete.",
      startedAt: _restoreState.startedAt,
      completedAt: new Date().toISOString(),
    };
    if (_restoreHistory[_restoreHistory.length - 1] !== "done") {
      _restoreHistory.push("done");
    }

    return { manifest, compatibilityUpgrades };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    _restoreState = {
      phase: "error",
      message: msg,
      startedAt: _restoreState.startedAt,
      completedAt: new Date().toISOString(),
    };
    if (_restoreHistory[_restoreHistory.length - 1] !== "error") {
      _restoreHistory.push("error");
    }
    throw err;
  } finally {
    _restoreInProgress = false;
    // Clean up temp directory.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Build a full LabTrax backup:
 *  1. Run pg_dump to capture the entire PostgreSQL database in custom format.
 *  2. Bundle the dump + case-media uploads into a ZIP archive.
 *  3. AES-256-GCM encrypt the ZIP buffer.
 *
 * The resulting `.zip.enc` file can be decrypted with the matching secret and
 * then restored with pg_restore (for the db dump) + extracting the media/ dir.
 */
/**
 * Unique name for one archive.
 *
 * The name carries the run's UTC timestamp to the second and the archive kind.
 * A date-only name collided on every run after the first of a day, and Graph's
 * "rename" conflict behaviour quietly stored `… 22.enc` while the database
 * recorded the un-suffixed name — so history pointed at a file that was not
 * the one that run produced.
 */
export function backupFileName(
  archiveKind: BackupArchiveKind = "full",
  at: Date = new Date(),
): string {
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "");
  const marker =
    archiveKind === "database-only"
      ? DATABASE_ONLY_FILENAME_MARKER
      : FULL_ARCHIVE_FILENAME_MARKER;
  return `labtrax-backup-${stamp}-${marker}.zip.enc`;
}

/** Build the manifest JSON embedded at the root of the inner ZIP. */
function buildBackupManifest(
  triggeredBy: string,
  counts?: {
    userCount: number;
    orgCount: number;
    caseCount: number;
    invoiceCount: number;
    tableCount: number;
    attachmentRowCount: number;
  },
  uploadDirs?: UploadDirsInspection,
  archiveKind: BackupArchiveKind = "full",
): Record<string, unknown> {
  const includesMedia = archiveKind === "full" ||
    archiveKind === "partial-production" || archiveKind === "partial-non-production" ||
    archiveKind === COMPLETE_PRODUCTION_KIND ||
    archiveKind === COMPLETE_DEVELOPMENT_KIND;
  return {
    version: "2.0",
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appName: "LabTrax",
    exportedAt: new Date().toISOString(),
    exportedBy: triggeredBy,
    dbFormat: "pg_dump:custom",
    // "database-only" archives deliberately carry no media. Restoring one as a
    // full backup would wipe the media tree, so the restore path rejects it.
    archiveKind,
    includesMedia,
    userCount:             counts?.userCount             ?? 0,
    orgCount:              counts?.orgCount              ?? 0,
    caseCount:             counts?.caseCount             ?? 0,
    invoiceCount:          counts?.invoiceCount          ?? 0,
    tableCount:            counts?.tableCount            ?? 0,
    attachmentRowCount:    counts?.attachmentRowCount    ?? 0,
    mediaFileCount:        uploadDirs?.caseMedia.fileCount    ?? 0,
    mediaBytes:            uploadDirs?.caseMedia.totalBytes   ?? 0,
    profilePhotoFileCount: uploadDirs?.profilePhotos.fileCount  ?? 0,
    profilePhotoBytes:     uploadDirs?.profilePhotos.totalBytes ?? 0,
    decryptNote:
      "This file is AES-256-GCM encrypted. Format: 4-byte magic " +
      `('${BACKUP_MAGIC_BUFFERED}' = tag after IV, or '${BACKUP_MAGIC_STREAMED}' = tag appended at end) ` +
      "+ 12-byte IV + 16-byte GCM auth-tag + ciphertext. " +
      "Set BACKUP_ENCRYPTION_KEY (or JWT_SECRET) to the same value used during backup, derive a 32-byte key via SHA-256, " +
      "then decrypt to get the inner ZIP. Restore the database with: pg_restore --clean --if-exists -d <dbname> db/database.pgdump",
    mediaNote:
      includesMedia
        ? "Case-media attachments are in the media/ directory of the inner ZIP. Profile photos are in profile-photos/."
        : "DATABASE-ONLY ARCHIVE: this backup contains the database dump only — no case media and no profile photos. " +
          "It cannot be used as a restore source; restore from a full archive instead.",
  };
}

/**
 * Create the ZIP archiver and queue the manifest, db dump, case-media dir, and
 * profile-photos dir. `uploads/.restore-snapshots/` is a sibling of both
 * upload dirs and is intentionally not included.
 */
function createBackupArchive(
  manifest: Record<string, unknown>,
  pgDump: Buffer,
  uploadDirs?: UploadDirsInspection,
  archiveKind: BackupArchiveKind = "full",
  mediaSourceDir?: string,
  mediaAppender?: BackupMediaAppender,
): archiver.Archiver {
  const mediaDir = mediaSourceDir ?? path.join(getUploadsRoot(), "case-media");
  const profilePhotosDir = path.join(getUploadsRoot(), "profile-photos");

  const includeMedia = archiveKind === "full" ||
    archiveKind === "partial-production" || archiveKind === "partial-non-production" ||
    archiveKind === COMPLETE_PRODUCTION_KIND ||
    archiveKind === COMPLETE_DEVELOPMENT_KIND;
  const mediaExists        = !includeMedia ? false : uploadDirs ? uploadDirs.caseMedia.exists    : fs.existsSync(mediaDir);
  const profilePhotosExists = !includeMedia ? false : uploadDirs ? uploadDirs.profilePhotos.exists : fs.existsSync(profilePhotosDir);

  // Same ZIP format and bytes; level 1 avoids spending the run budget
  // recompressing a multi-GB media library. The measured sample was >2x
  // faster for a <0.5% archive-size increase.
  const archive = archiver("zip", { zlib: { level: 1 } });
  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
  archive.append(pgDump, { name: "db/database.pgdump" });
  if (mediaExists && !mediaAppender) archive.directory(mediaDir, "media");
  if (profilePhotosExists) archive.directory(profilePhotosDir, "profile-photos");
  return archive;
}

async function finalizeBackupArchive(
  archive: archiver.Archiver,
  mediaAppender?: BackupMediaAppender,
): Promise<void> {
  if (mediaAppender) await mediaAppender(archive);
  await archive.finalize();
}

/**
 * Assemble, ZIP, and encrypt a backup from already-computed pg_dump/counts.
 * Split out of `buildBackupZipBuffer` so a caller that needs to retry the
 * archive step (e.g. dropping profile-photos after an upload failure) does
 * not have to re-run the expensive pg_dump.
 *
 * When `includeProfilePhotos` is false, the profile-photos directory is
 * omitted from both the manifest counts and the archive — this mirrors an
 * older backup that pre-dates the profile-photos feature, which the restore
 * path already handles gracefully.
 */
async function assembleAndEncryptBackup(
  triggeredBy: string,
  pgDump: Buffer,
  counts: Parameters<typeof buildBackupManifest>[1],
  uploadDirs: UploadDirsInspection,
  options: { includeProfilePhotos: boolean; mediaDir?: string; appendMedia?: BackupMediaAppender },
): Promise<{ buffer: Buffer; fileName: string }> {
  const effectiveUploadDirs: UploadDirsInspection = options.includeProfilePhotos
    ? uploadDirs
    : { ...uploadDirs, profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 } };

  const fileName = backupFileName();
  const manifest = buildBackupManifest(triggeredBy, counts, effectiveUploadDirs);

  const zipBuffer: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = createBackupArchive(
      manifest,
      pgDump,
      effectiveUploadDirs,
      "full",
      options.mediaDir,
      options.appendMedia,
    );
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    finalizeBackupArchive(archive, options.appendMedia).catch((error: Error) => {
      archive.destroy();
      reject(error);
    });
  });

  const buffer = encryptBuffer(zipBuffer);
  return { buffer, fileName };
}

/**
 * Shared pre-flight guard: if the DB has attachment rows but the media folder
 * is absent or empty, the backup would silently exclude all case media. Abort
 * before writing any bytes.
 */
function assertBackupMediaConsistency(
  attachmentRowCount: number,
  uploadDirs: UploadDirsInspection,
): void {
  if (attachmentRowCount > 0 && uploadDirs.caseMedia.fileCount === 0) {
    throw new Error(
      `Backup aborted: DB has ${attachmentRowCount} attachment row(s) but ` +
      "the prepared case-media source is missing or empty. " +
      "Resolve the missing media files before running a backup.",
    );
  }
}

/** Best-effort removal of a temp backup file and the mkdtemp dir holding it. */
function cleanupBackupTempFile(filePath: string): void {
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    // Temp cleanup must never mask the real backup outcome.
  }
}

interface PreparedBackupArchive {
  fileName: string;
  archiveKind: BackupArchiveKind;
  manifest: Record<string, unknown>;
  pgDump: Buffer;
  uploadDirs: UploadDirsInspection;
  mediaDir?: string;
  appendMedia?: BackupMediaAppender;
  completionFooter: boolean;
}

/**
 * Fix everything the archive depends on — file name, manifest, dump and file
 * plan — before the first byte is written.
 */
function prepareBackupArchive(
  triggeredBy: string,
  pgDump: Buffer,
  counts: Parameters<typeof buildBackupManifest>[1],
  uploadDirs: UploadDirsInspection,
  options: {
    includeProfilePhotos: boolean;
    archiveKind?: BackupArchiveKind;
    mediaDir?: string;
    appendMedia?: BackupMediaAppender;
    completeCoverage?: boolean;
    sourceEnvironment?: string;
    profilePhotoFileCount?: number;
    completionFooter?: boolean;
  },
): PreparedBackupArchive {
  const archiveKind: BackupArchiveKind = options.archiveKind ?? "full";
  const mediaFreeDirs: UploadDirsInspection = {
    caseMedia: { exists: false, fileCount: 0, totalBytes: 0 },
    profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 },
  };
  const effectiveUploadDirs: UploadDirsInspection =
    archiveKind === "database-only"
      ? mediaFreeDirs
      : options.includeProfilePhotos
        ? uploadDirs
        : { ...uploadDirs, profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 } };

  const fileName = backupFileName(archiveKind);
  const manifest = buildBackupManifest(triggeredBy, counts, effectiveUploadDirs, archiveKind);
  if (options.completeCoverage) {
    manifest.coverageVersion = COMPLETE_BACKUP_VERSION;
    manifest.sourceEnvironment = options.sourceEnvironment;
    manifest.recoveryEvidence = "complete-recovery.json";
    manifest.profilePhotoFileCount = options.profilePhotoFileCount ?? 0;
  }
  return {
    fileName,
    archiveKind,
    manifest,
    pgDump,
    uploadDirs: effectiveUploadDirs,
    mediaDir: options.mediaDir,
    appendMedia: options.appendMedia,
    completionFooter: options.completionFooter === true,
  };
}

/**
 * Write a prepared archive, encrypted, to `output` and resolve with the exact
 * number of bytes written, once the destination has accepted all of them.
 * Nothing is buffered beyond stream high-water marks, so a multi-GB archive
 * needs no local copy and server memory stays flat.
 *
 * Output uses the tag-trailing 'LTR2' container: magic + IV, AES-256-GCM
 * ciphertext, then the auth tag (only known once every plaintext byte has
 * been encrypted) and, for complete archives, the LTF1 footer recording the
 * exact byte count before it. `decryptBuffer` accepts 'LTRX' and 'LTR2'.
 *
 * Any failure destroys `output`; the caller discards the partial destination.
 */
async function writeEncryptedBackupArchive(
  prepared: PreparedBackupArchive,
  output: Writable,
  options: {
    deadline?: BackupDeadline;
    onProgress?: (archiveBytes: number) => void;
  } = {},
): Promise<number> {
  const key = deriveBackupKey(); // throws if no secret is configured
  options.deadline?.throwIfExpired("archive assembly");

  // Header frame: magic + IV. Ciphertext follows; the auth tag closes it.
  const iv = randomBytes(GCM_IV_BYTES);
  const header = Buffer.concat([Buffer.from(BACKUP_MAGIC_STREAMED), iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encryptedBytes = 0;
  let trailerBytes = 0;
  const encryptedCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      encryptedBytes += chunk.length;
      callback(null, chunk);
    },
  });
  const archive = createBackupArchive(
    prepared.manifest,
    prepared.pgDump,
    prepared.uploadDirs,
    prepared.archiveKind,
    prepared.mediaDir,
    prepared.appendMedia,
  );
  const reportProgress = () => {
    const archiveBytes = header.length + encryptedBytes + trailerBytes;
    setBackupLiveProgress({ archiveBytes });
    options.onProgress?.(archiveBytes);
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let onDeadline: (() => void) | null = null;
    const progressTimer = setInterval(reportProgress, 1000);
    progressTimer.unref?.();
    const detachDeadline = () => {
      if (onDeadline && options.deadline) {
        options.deadline.signal.removeEventListener("abort", onDeadline);
      }
      onDeadline = null;
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      detachDeadline();
      clearInterval(progressTimer);
      archive.destroy();
      cipher.destroy();
      output.destroy();
      reject(err);
    };

    if (options.deadline) {
      const deadline = options.deadline;
      // The run signal also fires when a download client disconnects; only an
      // exhausted budget is reported as a timeout.
      onDeadline = () =>
        fail(deadline.expired()
          ? new BackupTimeoutError(
            "Backup timed out while assembling the archive — the partial archive was discarded.",
          )
          : deadline.cancelled()
            ? new BackupCancelledError()
          : new Error(
            "Backup destination disconnected while the archive was being written — the partial archive was discarded.",
          ));
      if (deadline.signal.aborted) {
        onDeadline();
        return;
      }
      deadline.signal.addEventListener("abort", onDeadline, { once: true });
    }

    archive.on("error", fail);
    cipher.on("error", fail);
    encryptedCounter.on("error", fail);
    output.on("error", fail);

    // 'finish' fires once the destination has accepted every byte, including
    // the trailing auth tag and footer — the only success signal.
    output.on("finish", () => {
      if (settled) return;
      settled = true;
      detachDeadline();
      clearInterval(progressTimer);
      reportProgress();
      resolve();
    });

    // A destination can close without ever emitting 'error' or 'finish'
    // (client disconnect, fd revoked, remote channel closed). Without this
    // the promise would never settle and the run would hold its in-flight
    // guard forever. 'close' follows 'finish' on success, so the settled
    // guard makes this a no-op there.
    output.on("close", () => {
      if (settled) return;
      settled = true;
      detachDeadline();
      clearInterval(progressTimer);
      archive.destroy();
      cipher.destroy();
      reject(new Error("Backup destination stream closed before the archive finished writing."));
    });

    output.write(header);

    encryptedCounter.on("end", () => {
      if (settled) return;
      const tag = cipher.getAuthTag();
      let trailer = tag;
      if (prepared.completionFooter) {
        const precedingBytes = header.length + encryptedBytes + tag.length;
        const footer = Buffer.alloc(BACKUP_STREAM_FOOTER_BYTES);
        footer.write(BACKUP_STREAM_FOOTER_MAGIC, 0, "ascii");
        footer.writeBigUInt64BE(BigInt(precedingBytes), 4);
        trailer = Buffer.concat([tag, footer]);
      }
      trailerBytes = trailer.length;
      output.end(trailer);
    });

    archive.pipe(cipher);
    cipher.pipe(encryptedCounter);
    encryptedCounter.pipe(output, { end: false });
    finalizeBackupArchive(archive, prepared.appendMedia).catch(fail);
  });

  return header.length + encryptedBytes + trailerBytes;
}

/**
 * A destination that is opened by archive name and sealed once the exact
 * encrypted size is known: a temporary file, or a private cloud stage.
 */
interface BackupArchiveTarget {
  open(fileName: string): Writable;
  seal(size: number): Promise<void>;
}

/** Write a prepared archive to `target`, then seal it at its exact size. */
async function writeBackupArchiveToTarget(
  target: BackupArchiveTarget,
  prepared: PreparedBackupArchive,
  deadline?: BackupDeadline,
): Promise<{ fileName: string; size: number }> {
  let archiveBytes = 0;
  return measureBackupPhase("archive assembly/encryption", async () => {
    deadline?.throwIfExpired("archive assembly");
    const size = await writeEncryptedBackupArchive(prepared, target.open(prepared.fileName), {
      deadline,
      onProgress: (bytes) => { archiveBytes = bytes; },
    });
    await target.seal(size);
    return { fileName: prepared.fileName, size };
  }, () => ({
    archiveBytes,
    mediaFileCount: prepared.uploadDirs.caseMedia.fileCount,
    mediaBytes: prepared.uploadDirs.caseMedia.totalBytes,
  }),
  (result) => ({ archiveBytes: result.size }));
}

async function assembleAndEncryptBackupToTarget(
  target: BackupArchiveTarget,
  triggeredBy: string,
  pgDump: Buffer,
  counts: Parameters<typeof buildBackupManifest>[1],
  uploadDirs: UploadDirsInspection,
  options: Parameters<typeof prepareBackupArchive>[4] & { deadline?: BackupDeadline },
): Promise<{ fileName: string; size: number }> {
  options.deadline?.throwIfExpired("archive assembly");
  const prepared = prepareBackupArchive(triggeredBy, pgDump, counts, uploadDirs, options);
  return writeBackupArchiveToTarget(target, prepared, options.deadline);
}

/**
 * Streaming counterpart to `assembleAndEncryptBackup`: writes the encrypted
 * backup to a temp file on disk instead of assembling it in memory.
 *
 * The buffered version holds up to three full copies of the archive at once —
 * the `chunks` array, the `Buffer.concat` result, and the encrypted copy. In
 * production the heap is capped at 512 MB (`--max-old-space-size=512`), so a
 * media library of any real size (~135 MB and growing) OOM-kills the process.
 * A V8 heap OOM cannot be caught by try/catch: the whole server dies and stays
 * down until the platform restarts it, which is a multi-minute outage every
 * time the hourly scheduled backup fires.
 *
 * Callers own the returned temp file and MUST pass `filePath` to
 * `cleanupBackupTempFile` when done.
 */
async function assembleAndEncryptBackupToFile(
  ...args: Parameters<typeof assembleAndEncryptBackupToTarget> extends [unknown, ...infer Rest]
    ? Rest : never
): Promise<{ filePath: string; fileName: string; size: number }> {
  let filePath: string | undefined;
  try {
    const result = await assembleAndEncryptBackupToTarget({
      open(fileName) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "labtrax-backup-"));
        filePath = path.join(tmpDir, fileName);
        return fs.createWriteStream(filePath);
      },
      async seal(size) {
        const storedSize = filePath ? fs.statSync(filePath).size : 0;
        if (storedSize !== size) {
          throw new Error(`Backup archive verification failed: the temporary file has ${storedSize} bytes, expected ${size}.`);
        }
      },
    }, ...args);
    return { ...result, filePath: filePath! };
  } catch (error) {
    if (filePath) cleanupBackupTempFile(filePath);
    throw error;
  }
}

type CompleteArchiveKind = typeof COMPLETE_PRODUCTION_KIND | typeof COMPLETE_DEVELOPMENT_KIND | "partial-production" | "partial-non-production";

interface CompleteBackupArchive {
  prepared: PreparedBackupArchive;
  fileName: string;
  archiveKind: CompleteArchiveKind;
  sourceEnvironment: "production" | "non-production";
  uploadDirs: UploadDirsInspection;
  attachmentRowCount: number;
  mediaFileCount: number;
  /** Uncompressed bytes of every required file, the archive's size bound. */
  durableBytes: number;
  dumpBytes: number;
  missingFileCount: number;
  partialFailure: boolean;
  warnings: string | null;
}

/**
 * Capture one complete recovery point — database snapshot, counts and every
 * required file, validated — without writing the archive yet. Destinations
 * stream the encrypted archive straight to their final location (or a private
 * cloud stage), so the temporary filesystem reserves space for a whole
 * archive only when the archive itself will be written there.
 */
async function prepareCompleteBackupArchive(
  triggeredBy: string,
  deadline: BackupDeadline | undefined,
  archiveDestination: CompleteArchiveDestination,
  seed?: { snapshot: string; previousJournalPosition: string | null; previousRecords: RecordInventory | null;
    onMediaPinned: () => Promise<void>; captured?: CompleteBackupCaptured },
): Promise<CompleteBackupArchive> {
  deadline?.throwIfExpired("complete recovery capture");
  const captured = await measureBackupPhase("recovery capture", () => captureCompleteBackup(
    getUploadsRoot(),
    (snapshot) => buildPgDumpBuffer(deadline, snapshot),
    deadline?.signal,
    { archiveDestination, allowMissingReferences: true, productionDataOnly: true,
      ...(seed ? { snapshot: seed.snapshot, productionJournalAfterPosition: seed.previousJournalPosition,
        onMediaPinned: seed.onMediaPinned, recordsWithFullArchive: true,
        records: { previous: seed.previousRecords, schemaSql: async (snapshot: string) => {
          const parts: Buffer[] = [];
          for await (const bytes of buildPgDumpStream(deadline, snapshot, 64 * 1024 * 1024, "plain")) parts.push(bytes);
          return Buffer.concat(parts).toString("utf8");
        } },
      } : {}),
    },
  ));
  if (seed) seed.captured = captured;
  const missingFileCount = captured.manifest.missingReferences?.length ?? 0;
  const partialFailure = missingFileCount > 0;
  const warnings = partialFailure
    ? `${missingFileCount} original lab files are unavailable. Database records and references are preserved; readable files are included. See missing-files.json. This is not a complete recovery point.`
    : null;
  const archiveKind: CompleteArchiveKind = partialFailure
    ? `partial-${captured.manifest.sourceEnvironment}` : captured.manifest.sourceEnvironment === "production"
    ? COMPLETE_PRODUCTION_KIND
    : COMPLETE_DEVELOPMENT_KIND;
  const prepared = prepareBackupArchive(
    triggeredBy,
    captured.pgDump,
    captured.counts,
    captured.uploadDirs,
    {
      includeProfilePhotos: true,
      archiveKind,
      appendMedia: captured.append,
      completeCoverage: true,
      sourceEnvironment: captured.manifest.sourceEnvironment,
      profilePhotoFileCount: captured.profilePhotoFileCount,
      completionFooter: true,
    },
  );
  prepared.manifest.recoveryCoverage = partialFailure ? "partial" : "complete";
  prepared.manifest.missingFileCount = missingFileCount;
  const mediaFileCount = captured.uploadDirs.caseMedia.fileCount;
  const attachmentRowCount = captured.counts.attachmentRowCount;
  setBackupLiveArchiveEvidence({
    archiveKind,
    coverageVersion: COMPLETE_BACKUP_VERSION,
    mediaFileCount,
    attachmentRowCount,
    missingFileCount,
  });
  return {
    prepared,
    fileName: prepared.fileName,
    archiveKind,
    sourceEnvironment: captured.manifest.sourceEnvironment,
    uploadDirs: captured.uploadDirs,
    attachmentRowCount,
    mediaFileCount,
    durableBytes: captured.durableBytes,
    dumpBytes: captured.pgDump.length,
    missingFileCount, partialFailure, warnings,
  };
}

/**
 * File-based counterpart to `buildBackupZipBuffer`. Callers own the returned
 * temp file and MUST pass `filePath` to `cleanupBackupTempFile` when done.
 */
async function buildBackupZipFile(triggeredBy: string): Promise<{
  filePath: string;
  fileName: string;
  size: number;
  uploadDirs: UploadDirsInspection;
  attachmentRowCount: number;
}> {
  const deadline = createBackupDeadline(await getBackupRunTimeoutMs());
  try {
  const localUploadDirs = inspectUploadDirs();
  const [pgDump, counts] = await Promise.all([
    buildPgDumpBuffer(deadline),
    measureBackupPhase("database manifest counts", () => abortableBackupOperation(buildManifestCounts(), deadline.signal)),
  ]);
  const preparedMedia = await prepareBackupMedia(localUploadDirs, counts.attachmentRowCount, deadline);
  try {
    const { filePath, fileName, size } = await assembleAndEncryptBackupToFile(
      triggeredBy,
      pgDump,
      counts,
      preparedMedia.uploadDirs,
      { includeProfilePhotos: true, mediaDir: preparedMedia.mediaDir, appendMedia: preparedMedia.appendMedia, deadline },
    );
    return {
      filePath,
      fileName,
      size,
      uploadDirs: preparedMedia.uploadDirs,
      attachmentRowCount: counts.attachmentRowCount,
    };
  } finally {
    preparedMedia.cleanup();
  }
  } finally {
    deadline.dispose();
  }
}

export async function buildBackupZipBuffer(triggeredBy: string): Promise<{
  buffer: Buffer;
  fileName: string;
  uploadDirs: UploadDirsInspection;
  attachmentRowCount: number;
}> {
  const localUploadDirs = inspectUploadDirs();
  const [pgDump, counts] = await Promise.all([buildPgDumpBuffer(), buildManifestCounts()]);
  const preparedMedia = await prepareBackupMedia(localUploadDirs, counts.attachmentRowCount);
  try {
    const { buffer, fileName } = await assembleAndEncryptBackup(
      triggeredBy,
      pgDump,
      counts,
      preparedMedia.uploadDirs,
      { includeProfilePhotos: true, mediaDir: preparedMedia.mediaDir, appendMedia: preparedMedia.appendMedia },
    );
    return {
      buffer,
      fileName,
      uploadDirs: preparedMedia.uploadDirs,
      attachmentRowCount: counts.attachmentRowCount,
    };
  } finally {
    preparedMedia.cleanup();
  }
}

/**
 * Write an encrypted backup to a local filesystem path.
 * On Linux, UNC/SMB paths must be pre-mounted (e.g. via cifs-utils) so they
 * appear as a local directory — pass the mount point as targetPath.
 *
 * The archive streams straight into a hidden partial file in the destination
 * folder, is flushed and size-checked, and only then takes its final name. No
 * second full copy is ever held in temporary storage.
 */
export async function runLocalBackup(
  triggeredBy: string,
  targetPath: string,
  deadline?: BackupDeadline,
): Promise<BackupRunResult> {
  const resolvedDir = path.resolve(targetPath);
  fs.mkdirSync(resolvedDir, { recursive: true });
  // A destination on the temporary filesystem shares its capacity with
  // staging, so the capture reserves the whole archive there. Any other
  // destination must hold the archive itself.
  const sharesTemporaryStorage = fs.statSync(resolvedDir).dev === fs.statSync(os.tmpdir()).dev;
  const backup = await prepareCompleteBackupArchive(
    triggeredBy, deadline, sharesTemporaryStorage ? "local" : "direct",
  );
  if (!sharesTemporaryStorage) {
    const disk = fs.statfsSync(resolvedDir);
    requireCompleteDestinationCapacity(disk.bavail * disk.bsize, backup.durableBytes, backup.dumpBytes);
  }
  const destFile = path.join(resolvedDir, backup.fileName);
  const partialPath = path.join(resolvedDir, `.${backup.fileName}.${randomUUID()}.partial`);
  let size = 0;
  let writtenBytes = 0;
  try {
    // A path-owned stream fsyncs (flush) and closes itself after 'finish'.
    // A FileHandle stream with autoClose:false keeps a reference that makes
    // FileHandle.close() wait forever once the stream has finished.
    const output = fs.createWriteStream(partialPath, { flags: "wx", flush: true });
    let closeError: Error | undefined;
    const closed = new Promise<void>((resolve) => {
      output.once("close", () => resolve());
      output.on("error", (error) => { closeError ??= error; });
    });
    size = await measureBackupPhase("archive assembly/encryption", () =>
      writeEncryptedBackupArchive(backup.prepared, output, {
        deadline,
        onProgress: (bytes) => { writtenBytes = bytes; },
      }),
    () => ({ archiveBytes: writtenBytes }), (written) => ({ archiveBytes: written }));
    await measureBackupPhase("local file verification", async () => {
      await closed;
      if (closeError) throw closeError;
      const storedSize = (await fs.promises.stat(partialPath)).size;
      if (storedSize !== size) {
        throw new Error(`Local backup verification failed: destination has ${storedSize} bytes, expected ${size}.`);
      }
    }, () => ({ archiveBytes: size }));
    await fs.promises.rename(partialPath, destFile);
  } catch (error) {
    await fs.promises.rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    size,
    completedAt: new Date().toISOString(),
    fileName: backup.fileName,
    archiveKind: backup.archiveKind,
    destination: "local",
    path: destFile,
    mediaFileCount: backup.mediaFileCount,
    attachmentRowCount: backup.attachmentRowCount,
    partialFailure: backup.partialFailure,
    warnings: backup.warnings,
  };
}

/** Minimal interface covering the ssh2 API surface used by runSftpBackup. */
interface SshClient {
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  sftp(callback: (err: Error | undefined, sftp: SftpSession) => void): void;
  connect(opts: {
    host: string;
    port: number;
    username: string;
    password?: string;
    readyTimeout?: number;
    keepaliveInterval?: number;
  }): void;
  end(): void;
}
interface SftpSession {
  createWriteStream(path: string): Writable;
  stat(path: string, callback: (error: Error | undefined, stats?: { size: number }) => void): void;
  rename(source: string, destination: string, callback: (error?: Error | null) => void): void;
  unlink(path: string, callback: (error?: Error | null) => void): void;
}
interface Ssh2Module {
  Client: new () => SshClient;
}

/**
 * Write an encrypted backup to an SFTP server.
 * destPath must be an sftp:// URL in the form:
 *   sftp://user@host[:port]/remote/directory
 * Embedded passwords are rejected at the schedule-save layer; authenticate
 * via SSH key by configuring the server to accept the API process's key.
 * Requires the `ssh2` npm package installed in api-server.
 */
async function runSftpBackup(
  triggeredBy: string,
  sftpUrl: string,
  deadline?: BackupDeadline,
): Promise<BackupRunResult> {
  let parsed: URL;
  try {
    parsed = new URL(sftpUrl);
  } catch {
    throw new Error(`Invalid SFTP URL: ${sftpUrl}`);
  }
  if (parsed.protocol !== "sftp:") {
    throw new Error(`Expected sftp:// URL, got: ${parsed.protocol}`);
  }

  const backup = await prepareCompleteBackupArchive(triggeredBy, deadline, "direct");
  return sendBackupOverSftp({
    fileName: backup.fileName,
    archiveKind: backup.archiveKind,
    mediaFileCount: backup.mediaFileCount,
    attachmentRowCount: backup.attachmentRowCount,
    partialFailure: backup.partialFailure,
    warnings: backup.warnings,
    parsed,
    deadline,
    write: (destination, onProgress) =>
      writeEncryptedBackupArchive(backup.prepared, destination, { deadline, onProgress }),
  });
}

/**
 * Stream an archive to a hidden partial file on the SFTP server, confirm the
 * stored size equals every byte produced, then give it its final name. A
 * failed or unconfirmed transfer removes the partial file, so an incomplete
 * archive never appears under a backup name.
 */
export async function sendBackupOverSftp(args: {
  fileName: string;
  archiveKind: CompleteArchiveKind;
  mediaFileCount: number;
  attachmentRowCount: number;
  partialFailure?: boolean;
  warnings?: string | null;
  parsed: URL;
  deadline?: BackupDeadline;
  /** Writes the complete archive to `destination`; resolves with its byte count. */
  write: (destination: Writable, onProgress: (bytes: number) => void) => Promise<number>;
}, injectedSsh2?: Ssh2Module): Promise<BackupRunResult> {
  const { fileName, archiveKind, mediaFileCount, attachmentRowCount, parsed, deadline, write } = args;

  // Dynamically import ssh2 — optional runtime dep. Absence surfaces a clear install message.
  let Ssh2Client: new () => SshClient;
  if (injectedSsh2) {
    Ssh2Client = injectedSsh2.Client;
  } else {
    try {
      // @ts-expect-error — ssh2 is an optional runtime dep; the type is provided by SshClient above
      const ssh2 = (await import("ssh2")) as Ssh2Module;
      Ssh2Client = ssh2.Client;
    } catch {
      throw new Error(
        "SFTP backup requires the 'ssh2' package. " +
        "Run: pnpm --filter @workspace/api-server add ssh2",
      );
    }
  }

  const host = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : 22;
  const username = decodeURIComponent(parsed.username || "");
  const remoteDir = (parsed.pathname || "/").replace(/\/$/, "");
  const remoteFile = `${remoteDir}/${fileName}`;
  const remotePartial = `${remoteDir}/.${fileName}.partial`;
  const callSftp = (operation: (callback: (error?: Error | null) => void) => void) =>
    abortableBackupOperation(new Promise<void>((resolve, reject) => {
      operation((error) => (error ? reject(error) : resolve()));
    }), deadline?.signal);

  let conn: SshClient | undefined;
  let sftp: SftpSession | undefined;
  let size = 0;
  let transferredBytes = 0;
  let renamed = false;
  try {
    sftp = await abortableBackupOperation(new Promise<SftpSession>((resolve, reject) => {
      conn = new Ssh2Client();
      conn.on("ready", () => {
        conn!.sftp((err: Error | undefined, session: SftpSession) => (err ? reject(err) : resolve(session)));
      });
      conn.on("error", reject);
      conn.connect({ host, port, username, readyTimeout: 30_000, keepaliveInterval: 10_000 });
    }), deadline?.signal);
    const session = sftp;

    size = await measureBackupPhase("SFTP transfer", async () => {
      const writeStream = session.createWriteStream(remotePartial);
      // The remote handle closes after 'finish'; only a closed handle is
      // evidence that the server has committed the bytes.
      const closed = new Promise<void>((resolve, reject) => {
        writeStream.once("close", resolve);
        writeStream.once("error", reject);
      });
      closed.catch(() => undefined);
      const written = await write(writeStream, (bytes) => { transferredBytes = bytes; });
      await abortableBackupOperation(closed, deadline?.signal);
      return written;
    }, () => ({ archiveBytes: transferredBytes }), (written) => ({ archiveBytes: written }));

    await measureBackupPhase("SFTP verification", async () => {
      const stats = await abortableBackupOperation(new Promise<{ size: number } | undefined>((resolve, reject) => {
        session.stat(remotePartial, (statError, remoteStats) => {
          if (statError) return reject(new Error(`SFTP destination verification failed: ${statError.message}`));
          resolve(remoteStats);
        });
      }), deadline?.signal);
      if (!stats || stats.size !== size) {
        throw new Error(`SFTP destination verification failed: remote file size did not match ${size} bytes.`);
      }
      await callSftp((callback) => session.rename(remotePartial, remoteFile, callback)).catch((error: unknown) => {
        throw new Error(`SFTP destination verification failed: the verified archive could not be renamed (${safeBackupError(error)}).`);
      });
      renamed = true;
    }, () => ({ archiveBytes: size }));
  } catch (error) {
    if (sftp && !renamed) {
      // Cleanup runs even after the deadline fired, on its own short budget.
      const session = sftp;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        timer.unref?.();
        session.unlink(remotePartial, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    throw error;
  } finally {
    conn?.end();
  }

  return {
    size,
    completedAt: new Date().toISOString(),
    fileName,
    archiveKind,
    destination: "network",
    path: remoteFile,
    mediaFileCount,
    attachmentRowCount,
    partialFailure: args.partialFailure ?? false,
    warnings: args.warnings ?? null,
  };
}

/**
 * Read the maximum number of OneDrive backups to retain. Checks the
 * system_settings DB row first, then the ONEDRIVE_BACKUP_MAX_KEEP env var,
 * then falls back to DEFAULT_ONEDRIVE_RETENTION_MAX_BACKUPS (30).
 */
export async function getOneDriveRetentionMaxBackups(): Promise<number> {
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_ONEDRIVE_RETENTION_MAX_BACKUPS))
      .limit(1);
    const raw = rows[0]?.value ?? null;
    if (raw !== null) {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 1) return parsed;
    }
  } catch { /* ignore DB errors — fall through to defaults */ }
  const envRaw = process.env.ONEDRIVE_BACKUP_MAX_KEEP;
  if (envRaw) {
    const parsed = parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return DEFAULT_ONEDRIVE_RETENTION_MAX_BACKUPS;
}

export const SETTING_ONEDRIVE_RETENTION_RECENT_HOURS =
  "onedrive_backup_retention_recent_hours";

/**
 * The retention policy applied after each successful off-site upload: the
 * time tiers, with the admin-configurable file cap as the ceiling.
 *
 * The tier widths are settings rather than constants so the recovery window
 * can be widened without a deploy. `onedrive_backup_retention_max` stays the
 * ceiling it always was, but `selectOneDriveBackupsToPrune` clamps it up to
 * the retained-archive floor: a flat "newest 30" at a 15-minute cadence
 * leaves about 7 hours of recovery points, which is what this task exists
 * to fix.
 */
export async function getOneDriveRetentionPolicy(): Promise<OneDriveRetentionPolicy> {
  const readPositive = (raw: string | null | undefined, fallback: number): number => {
    if (raw === null || raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };

  let byKey: Record<string, string> = {};
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(
        sql`${systemSettings.key} in (${SETTING_ONEDRIVE_RETENTION_RECENT_HOURS}, ${SETTING_ONEDRIVE_RETENTION_HOURLY_FULL_DAYS}, ${SETTING_ONEDRIVE_RETENTION_DAILY_FULL_DAYS})`,
      );
    byKey = Object.fromEntries(
      rows
        .filter((r): r is typeof r & { value: string } => r.value !== null)
        .map((r) => [r.key, r.value]),
    );
  } catch {
    // fall through to defaults
  }

  const maxFiles = await getOneDriveRetentionMaxBackups();
  // Failure to read completeness evidence must stop pruning, not fall back to
  // filename guesses. Older full archives keep their existing retained floor.
  const complete = await db.select({ id: backupRuns.remoteItemId }).from(backupRuns).where(and(
    eq(backupRuns.destination, "onedrive"), eq(backupRuns.status, "success"),
    eq(backupRuns.partialFailure, false),
    eq(backupRuns.archiveKind, isProductionDeployment() ? COMPLETE_PRODUCTION_KIND : COMPLETE_DEVELOPMENT_KIND),
  ));
  return {
    completeItemIds: complete.flatMap(run => run.id ? [run.id] : []),
    ...DEFAULT_ONEDRIVE_RETENTION_POLICY,
    keepAllWithinHours: readPositive(
      byKey[SETTING_ONEDRIVE_RETENTION_RECENT_HOURS],
      DEFAULT_ONEDRIVE_RETENTION_POLICY.keepAllWithinHours,
    ),
    keepHourlyWithinDays: readPositive(
      byKey[SETTING_ONEDRIVE_RETENTION_HOURLY_FULL_DAYS],
      DEFAULT_ONEDRIVE_RETENTION_POLICY.keepHourlyWithinDays,
    ),
    keepDailyWithinDays: readPositive(
      byKey[SETTING_ONEDRIVE_RETENTION_DAILY_FULL_DAYS],
      DEFAULT_ONEDRIVE_RETENTION_POLICY.keepDailyWithinDays,
    ),
    maxFiles,
  };
}

/**
 * Upload an encrypted backup to the connected OneDrive account. Runs fully
 * server-side, so it works for scheduled backups 24/7 with no desktop open.
 *
 * After a successful upload, old backups beyond the configured retention
 * limit are pruned. Pruning failures are non-fatal: the backup is still
 * considered successful and the result is returned normally.
 */
/**
 * Confirm, from OneDrive itself, that the uploaded archive is present and
 * complete. Throws with a readable reason otherwise — the caller records that
 * as a failed run and alerts, which is the whole point: a backup nobody can
 * restore must never be reported as a backup that happened.
 *
 * A failed verification preserves the remote item for investigation. Never
 * delete a name-resolved item that might belong to an earlier collided run.
 */
export async function verifyOneDriveArchive(uploaded: OneDriveUploadResult, expectedSize: number, signal?: AbortSignal): Promise<void> {
  return measureBackupPhase("OneDrive verification", async () => {
  const { fileName, itemId, folder } = uploaded;
  const minBytes = minPlausibleBackupBytes();
  if (expectedSize < minBytes) {
    throw new Error(
      `Backup aborted: the archive built for OneDrive was only ${expectedSize} bytes, ` +
      `below the ${minBytes}-byte minimum for a real backup. ` +
      "Nothing restorable was produced, so this run is a failure, not a backup.",
    );
  }

  let remote: Awaited<ReturnType<typeof getOneDriveFileByName>>;
  try {
    remote = await abortableBackupOperation(getOneDriveFileByName(fileName, folder, itemId), signal);
  } catch (err: unknown) {
    throw new Error(
      `Backup upload could not be verified in OneDrive: ${err instanceof Error ? err.message : String(err)}. ` +
      "Treating the run as failed because the archive's presence off-site is unconfirmed.",
    );
  }

  if (remote === null) {
    throw new Error(
      `Backup upload reported success but "${fileName}" is not in OneDrive:/${getOneDriveBackupFolder()}. ` +
      "No off-site copy exists for this run.",
    );
  }

  if (remote.id !== itemId || remote.name !== fileName || remote.size !== expectedSize) {
    const detail =
      `OneDrive holds ${remote.size} bytes for "${remote.name}" but the archive was ${expectedSize} bytes.`;
    throw new Error(`Backup upload identity or size is unconfirmed — ${detail} The remote item was preserved.`);
  }

  logger.info(
    { fileName: remote.name, size: remote.size },
    "[backup] OneDrive upload verified against the backup folder",
  );
  }, () => ({ archiveBytes: expectedSize }));
}

/**
 * Upload an encrypted backup to the connected OneDrive account. Runs fully
 * server-side, so it works for scheduled backups 24/7 with no desktop open.
 *
 * After a successful upload, old backups beyond the configured retention
 * policy are pruned. Pruning failures are non-fatal: the backup is still
 * considered successful and the result is returned normally.
 */
/** A manual OneDrive archive and the scheduled baseline share one source snapshot
 * and one read of each original. Both outputs must verify before success. */
export async function runOneDriveBackupWithBaseline(triggeredBy: string, deadline: BackupDeadline): Promise<BackupRunResult> {
  let archive: CompleteBackupArchive | undefined;
  let captured: CompleteBackupCaptured | undefined;
  let result: BackupRunResult | undefined;
  const status = await runDatabaseProtectionJob({
    trigger: "manual", destination: "onedrive", intervalMinutes: 15,
    codec: { encrypt: encryptBuffer, decrypt: decryptBuffer }, signal: deadline.signal,
    capture: async (snapshot, previousJournalPosition, onMediaPinned, previousRecords) => {
      const seed = { snapshot, previousJournalPosition, previousRecords: previousRecords ?? null,
        onMediaPinned, captured: undefined as CompleteBackupCaptured | undefined };
      archive = await prepareCompleteBackupArchive(triggeredBy, deadline, "cloud", seed);
      captured = seed.captured;
      if (!captured?.recordCapture) throw new Error("Manual baseline record evidence is missing.");
      const schemaParts: Buffer[] = [];
      if (!captured.recordCapture.delta) {
        for await (const bytes of buildPgDumpStream(deadline, snapshot, 64 * 1024 * 1024, "custom")) schemaParts.push(bytes);
      }
      return { kind: RECORD_DELTA_FORMAT, records: captured.recordCapture,
        schemaDump: captured.recordCapture.delta ? null : Buffer.concat(schemaParts) };
    },
    captureMedia: async (write, selectPaths) => {
      if (!archive || !captured) throw new Error("Manual baseline snapshot is missing.");
      let evidence: Awaited<ReturnType<typeof captureProductionMedia>> | undefined;
      archive.prepared.appendMedia = async zip => {
        evidence = await captureProductionMedia(captured!, write, selectPaths, zip);
      };
      result = await runOneDriveBackup(triggeredBy, { deadline, preparedArchive: archive });
      if (!evidence) throw new Error("Manual baseline media evidence is missing.");
      return evidence;
    },
  });
  deadline.throwIfExpired("OneDrive baseline verification");
  if (!result || (status.state !== "verified" && status.state !== "partial")) {
    throw new Error(status.error ?? "The OneDrive incremental baseline did not verify; no successful backup was recorded.");
  }
  if (status.state === "partial") {
    result.partialFailure = true;
    result.warnings = [result.warnings, status.error,
      "The incremental point has coverage warnings; it is not a complete recovery point."].filter(Boolean).join(" ");
  }
  return result;
}

export async function runOneDriveBackup(
  triggeredBy: string,
  options: { archiveKind?: BackupArchiveKind; deadline?: BackupDeadline; preparedArchive?: CompleteBackupArchive } = {},
): Promise<BackupRunResult> {
  const archiveKind: BackupArchiveKind = options.archiveKind ?? "full";
  const ownDeadline = !options.deadline ? createBackupDeadline(await getBackupRunTimeoutMs(archiveKind)) : undefined;
  const deadline = options.deadline ?? ownDeadline!;
  try {
  if (isProductionDeployment() && archiveKind !== "database-only" && !options.preparedArchive) {
    return await runOneDriveBackupWithBaseline(triggeredBy, deadline);
  }
  if (archiveKind !== "database-only") {
    const lock = await pool.connect();
    let claimed = false;
    try {
    claimed = (await lock.query<{ claimed: boolean }>(
      "SELECT pg_try_advisory_lock(5109, 15) AS claimed",
    )).rows[0]?.claimed === true;
    if (!claimed) throw new Error("Missed complete recovery point: another server instance is already capturing a full backup. No database-only fallback was taken.");
    const archive = options.preparedArchive ?? await prepareCompleteBackupArchive(triggeredBy, deadline, "cloud");
    // Graph needs the exact final length before the first byte, and a whole
    // archive cannot be spooled locally (the media library exceeds temporary
    // storage). The archive is written once to a private App Storage stage,
    // sealed at its verified size, and uploaded from bounded ranges.
    const stage = await measureBackupPhase("private cloud staging setup", () => createBackupCloudStage(
      archive.sourceEnvironment, deadline.timeoutMs, deadline.signal,
    ));
    try {
      const staged = await writeBackupArchiveToTarget(stage, archive.prepared, deadline);
      // Ranges are read strictly in order, each only after the previous range
      // was accepted, so the latest read offset is the confirmed upload count.
      // The heartbeat reports it instead of replacing progress with the total.
      let confirmedBytes = 0;
      const uploaded = await measureBackupPhase("OneDrive transfer", () =>
        uploadBackupSourceToOneDrive({
          size: staged.size,
          readChunk: (offset, length) => {
            confirmedBytes = Math.max(confirmedBytes, offset);
            return stage.readChunk(offset, length);
          },
        }, staged.fileName, { signal: deadline.signal }),
        () => ({ archiveBytes: staged.size, uploadedBytes: confirmedBytes, uploadTotalBytes: staged.size }),
        () => ({ uploadedBytes: staged.size }));
      await verifyOneDriveArchive(uploaded, staged.size, deadline.signal);
      // Retention may run only after the complete recovery point is confirmed.
      try {
        const policy = await getOneDriveRetentionPolicy();
        if (!archive.partialFailure) await pruneOneDriveBackups({ ...policy, completeItemIds: [...(policy.completeItemIds ?? []), uploaded.itemId] });
      } catch (error) {
        logger.warn({ err: safeBackupError(error) }, "[backup] Retention failed; complete archive preserved");
      }
      return {
        size: staged.size, completedAt: new Date().toISOString(),
        fileName: uploaded.fileName, remoteItemId: uploaded.itemId,
        archiveKind: archive.archiveKind,
        destination: "onedrive", path: oneDriveItemPath(uploaded.itemId),
        mediaFileCount: archive.mediaFileCount,
        attachmentRowCount: archive.attachmentRowCount,
        partialFailure: archive.partialFailure, warnings: archive.warnings,
      };
    } finally {
      await stage.cleanup();
    }
    } finally {
      if (claimed) await lock.query("SELECT pg_advisory_unlock(5109, 15)");
      lock.release();
    }
  }
  const localUploadDirs = inspectUploadDirs();
  const [pgDump, counts] = await Promise.all([
    buildPgDumpBuffer(deadline),
    measureBackupPhase("database manifest counts", () => abortableBackupOperation(buildManifestCounts(), deadline?.signal)),
  ]);
  const preparedMedia: PreparedBackupMedia = {
    mediaDir: path.join(getUploadsRoot(), "case-media"),
    uploadDirs: localUploadDirs,
    cleanup: () => undefined,
  };
  const uploadDirs = preparedMedia.uploadDirs;

  try {
  // Fail fast: same guard as buildBackupZipBuffer — no bytes are assembled
  // if the DB has attachment rows but the case-media folder is empty.
  // A database-only archive carries no media by design, so the consistency
  // check (which exists to catch a vanished media tree) does not apply.
  // Assembled to a temp file, not a Buffer: a 512 MB heap cannot hold three
  // copies of a multi-hundred-MB archive, and the resulting OOM kills the
  // whole server rather than just failing the backup.
  const primary = await assembleAndEncryptBackupToFile(
    triggeredBy,
    pgDump,
    counts,
    uploadDirs,
    { includeProfilePhotos: true, archiveKind, deadline, mediaDir: preparedMedia.mediaDir, appendMedia: preparedMedia.appendMedia },
  );
  const fileName = primary.fileName;

  let uploaded: OneDriveUploadResult;
  let localSize = primary.size;
  let partialFailure = false;
  let warnings: string | null = null;

  try {
    deadline?.throwIfExpired("the OneDrive upload");
    uploaded = await measureBackupPhase("OneDrive transfer", () =>
      uploadBackupFileToOneDrive(primary.filePath, fileName, { signal: deadline?.signal }),
      () => ({ archiveBytes: primary.size }));
  } catch (fullUploadErr: unknown) {
    // A run that blew its deadline is a failed run, not a profile-photo
    // problem: retrying a smaller archive would extend a run that has
    // already been given up on.
    if (fullUploadErr instanceof BackupTimeoutError || deadline?.expired()) {
      cleanupBackupTempFile(primary.filePath);
      if (fullUploadErr instanceof BackupTimeoutError) throw fullUploadErr;
      throw new BackupTimeoutError(
        "Backup timed out during the OneDrive upload — the run was aborted.",
      );
    }
    // Free the failed archive immediately so a retry never keeps two full
    // backups on disk at once.
    cleanupBackupTempFile(primary.filePath);

    throw fullUploadErr;
  }

  // No-op when the catch path already removed it.
  cleanupBackupTempFile(primary.filePath);

  // Read the archive back from OneDrive before calling this a success. The
  // upload response is this process's account of what it sent; the folder
  // listing is the drive's account of what it has. Only the second one is
  // evidence that something restorable exists off-site, and only the second
  // one catches a transfer that ended early or landed as a stub.
  await verifyOneDriveArchive(uploaded, localSize, deadline?.signal);

  try {
    const policy = await getOneDriveRetentionPolicy();
    const pruned = await pruneOneDriveBackups(policy);
    if (pruned.length > 0) {
      logger.info(
        { prunedCount: pruned.length, pruned, policy },
        "[backup] OneDrive retention: pruned old backups after upload",
      );
    }
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] OneDrive retention prune failed (non-fatal — backup succeeded)",
    );
  }

  // Only a full archive resets the full-archive clock; a database-only run
  // must not postpone the next one that carries media.

  return {
    size: localSize,
    completedAt: new Date().toISOString(),
    fileName: uploaded.fileName,
    remoteItemId: uploaded.itemId,
    archiveKind,
    destination: "onedrive",
    path: oneDriveItemPath(uploaded.itemId),
    mediaFileCount: 0,
    attachmentRowCount: counts.attachmentRowCount,
    partialFailure,
    warnings,
  };
  } finally {
    preparedMedia.cleanup();
  }
  } finally {
    ownDeadline?.dispose();
  }
}

async function pruneGoogleDriveBackups(
  uploaded: GoogleDriveUploadResult,
  isCompleteArchive: boolean,
): Promise<string[]> {
  const policy = await getOneDriveRetentionPolicy();
  const complete = await db.select({ id: backupRuns.remoteItemId }).from(backupRuns).where(and(
    eq(backupRuns.destination, "google-drive"),
    eq(backupRuns.status, "success"),
    eq(backupRuns.partialFailure, false),
    eq(
      backupRuns.archiveKind,
      isProductionDeployment() ? COMPLETE_PRODUCTION_KIND : COMPLETE_DEVELOPMENT_KIND,
    ),
  ));
  const completeItemIds = complete.flatMap((run) => run.id ? [run.id] : []);
  if (isCompleteArchive) completeItemIds.push(uploaded.id);
  const files = await listGoogleDriveBackupFiles(uploaded.folderId);
  const toDelete = selectOneDriveBackupsToPrune(files, {
    ...policy,
    completeItemIds,
  });
  const pruned: string[] = [];
  for (const file of toDelete) {
    try {
      await deleteGoogleDriveBackupFile(file.id);
      pruned.push(file.name);
      logger.info(
        { fileName: file.name, fileId: file.id },
        "[backup] Google Drive retention: pruned old backup",
      );
    } catch (error: unknown) {
      logger.warn(
        { fileName: file.name, fileId: file.id, err: safeBackupError(error) },
        "[backup] Google Drive retention: failed to delete file (non-fatal)",
      );
    }
  }
  return pruned;
}
/**
 * Record a backup run executed by the LabTrax Desktop app (local-folder
 * schedule). The desktop downloads the backup, writes it to the chosen
 * folder, then reports the outcome here so the run lands in backup_runs and
 * a success updates the staleness watermark. Throws on DB failure so the
 * caller can surface a 500 (the desktop should know its report was lost).
 */
export async function recordDesktopReportedBackupRun(input: {
  triggeredBy: string;
  status: "success" | "error";
  fileName?: string | null;
  path?: string | null;
  sizeBytes?: number | null;
  error?: string | null;
  downloadRunId?: string;
  archiveEvidence?: {
    archiveKind: CompleteArchiveKind | "database-only";
    coverageVersion: number;
    mediaFileCount: number;
    attachmentRowCount: number;
    missingFileCount?: number;
  };
}): Promise<{ completedAt: string; rejected: boolean; rejectionReason: string | null; errorReason?: string | null }> {
  const completedAt = new Date();

  // A reported success is a claim, and the one piece of it the server can
  // check is the size. An archive of a few kilobytes is not a backup of this
  // database — it is a placeholder or a truncated write — so it is recorded as
  // the failure it is instead of advancing the staleness watermark and making
  // the history look healthy.
  const reportedSize = input.sizeBytes ?? null;
  const implausible =
    input.status === "success" &&
    reportedSize !== null &&
    reportedSize < minPlausibleBackupBytes();

  const databaseOnlyEvidence = input.downloadRunId && input.archiveEvidence?.archiveKind === "database-only" &&
    input.archiveEvidence.coverageVersion === 0 && input.archiveEvidence.mediaFileCount === 0 &&
    Number.isSafeInteger(input.archiveEvidence.attachmentRowCount) && input.archiveEvidence.attachmentRowCount >= 0;
  const partialEvidence = input.downloadRunId && input.archiveEvidence?.archiveKind.startsWith("partial-") &&
    Number.isSafeInteger(input.archiveEvidence.missingFileCount) && (input.archiveEvidence.missingFileCount ?? 0) > 0;
  const missingCompleteEvidence = input.status === "success" && !databaseOnlyEvidence && (
    input.archiveEvidence?.coverageVersion !== COMPLETE_BACKUP_VERSION ||
    (!partialEvidence && ![COMPLETE_PRODUCTION_KIND, COMPLETE_DEVELOPMENT_KIND].includes(input.archiveEvidence.archiveKind)) ||
    !Number.isSafeInteger(input.archiveEvidence.mediaFileCount) || input.archiveEvidence.mediaFileCount < 0 ||
    !Number.isSafeInteger(input.archiveEvidence.attachmentRowCount) || input.archiveEvidence.attachmentRowCount < 0
  );
  const rejectionReason = implausible
    ? `The reported backup file was only ${reportedSize} bytes — too small to be a real backup ` +
      `(minimum ${minPlausibleBackupBytes()} bytes). The file in the backup folder is a placeholder, ` +
      "not a restorable copy of your data."
    : missingCompleteEvidence
      ? "The server could not confirm complete database-and-files recovery evidence for this download. The run was not recorded as a successful backup."
    : null;
  const status = implausible || missingCompleteEvidence ? "error" : input.status;

  if (input.downloadRunId && status === "error") {
    // A transport failure can reach the desktop before the producer finishes
    // its bounded cleanup and records the precise server-side failure.
    for (let attempt = 0; attempt < 8; attempt++) {
      const [existing] = await db.select({ id: backupRuns.id }).from(backupRuns)
        .where(eq(backupRuns.downloadRunId, input.downloadRunId)).limit(1);
      if (existing) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  const values = {
    triggeredBy: input.triggeredBy,
    destination: "local",
    downloadRunId: input.downloadRunId,
    path: input.path ?? null,
    fileName: input.fileName ?? null,
    sizeBytes: reportedSize,
    archiveKind: status === "success" ? input.archiveEvidence?.archiveKind : undefined,
    mediaFileCount: status === "success" ? input.archiveEvidence?.mediaFileCount : undefined,
    attachmentRowCount: status === "success" ? input.archiveEvidence?.attachmentRowCount : undefined,
    partialFailure: status === "success" && !!partialEvidence,
    warnings: status === "success" && partialEvidence
      ? `${input.archiveEvidence!.missingFileCount} original files unavailable; see missing-files.json. Not a complete recovery point.` : null,
    status,
    error:
      status === "error"
        ? (rejectionReason ?? input.error ?? "Unknown desktop backup error")
        : null,
    completedAt,
  };
  let stored: typeof backupRuns.$inferSelect | undefined;
  let newlyRecorded = true;
  if (input.downloadRunId) {
    [stored] = await db.insert(backupRuns).values(values)
      .onConflictDoNothing({ target: backupRuns.downloadRunId }).returning();
    if (!stored) {
      newlyRecorded = false;
      [stored] = await db.select().from(backupRuns)
        .where(eq(backupRuns.downloadRunId, input.downloadRunId)).limit(1);
      if (!stored) throw new Error("The correlated backup history report could not be confirmed.");
    }
  } else {
    await db.insert(backupRuns).values(values);
  }
  await pruneBackupHistory();
  if (newlyRecorded && (stored?.status ?? status) === "success" && !databaseOnlyEvidence) {
    if (!partialEvidence) await recordSuccessfulBackup();
  }
  return {
    completedAt: (stored?.completedAt ?? completedAt).toISOString(),
    rejected: implausible || missingCompleteEvidence || (input.status === "success" && stored?.status === "error"),
    rejectionReason: stored?.error ?? rejectionReason,
    ...(input.downloadRunId ? { errorReason: stored?.error ?? null } : {}),
  };
}

async function recordSuccessfulBackup(): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db
      .insert(systemSettings)
      .values({ key: SETTING_BACKUP_LAST_SUCCESSFUL_AT, value: now })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: now, updatedAt: new Date() },
      });
  } catch {
    // Non-fatal — don't let a DB write failure prevent the backup result being returned.
  }
}

/** Upsert one system_settings row, swallowing DB errors (never fatal). */
async function writeSystemSetting(key: string, value: string): Promise<void> {
  try {
    await db
      .insert(systemSettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), key },
      "[backup] Failed to persist backup scheduler setting",
    );
  }
}
/**
 * Read the backup-history retention window from the DB, falling back to the
 * BACKUP_HISTORY_RETENTION_DAYS env var (default 90).
 */
export async function getBackupHistoryRetentionDays(): Promise<{
  retentionDays: number;
  dbRetentionDays: number | null;
  envRetentionDays: number;
  maxRows: number;
  dbMaxRows: number | null;
  envMaxRows: number;
}> {
  const envRetentionDays =
    Math.max(1, parseInt(process.env.BACKUP_HISTORY_RETENTION_DAYS || "90", 10) || 90);
  const envMaxRows =
    Math.max(1, parseInt(process.env.BACKUP_HISTORY_MAX_ROWS || "500", 10) || 500);
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(
        sql`${systemSettings.key} in (${SETTING_BACKUP_HISTORY_RETENTION_DAYS}, ${SETTING_BACKUP_HISTORY_MAX_ROWS})`,
      );
    const retentionRaw =
      rows.find((r) => r.key === SETTING_BACKUP_HISTORY_RETENTION_DAYS)?.value ?? null;
    const maxRowsRaw =
      rows.find((r) => r.key === SETTING_BACKUP_HISTORY_MAX_ROWS)?.value ?? null;
    const dbRetentionDays =
      retentionRaw !== null ? Math.max(1, parseInt(retentionRaw, 10) || 1) : null;
    const dbMaxRows =
      maxRowsRaw !== null ? Math.max(1, parseInt(maxRowsRaw, 10) || 1) : null;
    const retentionDays = dbRetentionDays !== null ? dbRetentionDays : envRetentionDays;
    const maxRows = dbMaxRows !== null ? dbMaxRows : envMaxRows;
    return { retentionDays, dbRetentionDays, envRetentionDays, maxRows, dbMaxRows, envMaxRows };
  } catch {
    return {
      retentionDays: envRetentionDays,
      dbRetentionDays: null,
      envRetentionDays,
      maxRows: envMaxRows,
      dbMaxRows: null,
      envMaxRows,
    };
  }
}

export async function getLastSuccessfulBackupAt(): Promise<string | null> {
  if (isProductionDeployment()) return getLastVerifiedOffsiteBackupAt();
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_BACKUP_LAST_SUCCESSFUL_AT));
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Return the ISO timestamp of the most recent successful desktop-reported
 * backup run from backup_runs (triggeredBy LIKE 'scheduler:desktop:%'), or
 * null if no such run exists.
 *
 * This is intentionally separate from getLastSuccessfulBackupAt() (the global
 * watermark) because the global watermark is also advanced by server-side
 * backup runs (OneDrive, SFTP, manual). For local-folder schedules — which
 * only run while the desktop app is open — staleness must be judged from
 * desktop-triggered runs exclusively, so a server-side backup cannot silently
 * mask a local schedule that has been skipped for days.
 */
export async function getLastDesktopBackupAt(): Promise<string | null> {
  try {
    const result = await pool.query<{ completed_at: Date | null }>(
      `SELECT completed_at FROM backup_runs
       WHERE status = 'success' AND triggered_by LIKE 'scheduler:desktop:%'
       ORDER BY completed_at DESC LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row || row.completed_at === null || row.completed_at === undefined) return null;
    return row.completed_at instanceof Date
      ? row.completed_at.toISOString()
      : String(row.completed_at);
  } catch {
    return null;
  }
}

/**
 * Prune old backup_runs rows to keep the table lean.
 * Applies both a day-based retention window and a maximum row-count cap.
 * Whichever constraint removes more rows wins.
 * Non-fatal: failures are logged as warnings and swallowed.
 */
async function pruneBackupHistory(): Promise<void> {
  try {
    const { retentionDays, maxRows } = await getBackupHistoryRetentionDays();

    // Days-based retention: delete rows older than the retention window.
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    await db.delete(backupRuns).where(lt(backupRuns.completedAt, cutoff));

    // Row-count cap: keep only the most recent N rows, oldest first out.
    // The tie-breaker on id ensures deterministic behaviour when timestamps match.
    await db.delete(backupRuns).where(
      sql`${backupRuns.id} NOT IN (
        SELECT id FROM ${backupRuns}
        ORDER BY ${backupRuns.completedAt} DESC, ${backupRuns.id} DESC
        LIMIT ${maxRows}
      )`,
    );
  } catch (trimErr: unknown) {
    logger.warn(
      { err: trimErr instanceof Error ? trimErr.message : String(trimErr) },
      "backup_runs history trim failed — old rows not pruned",
    );
  }
}

async function recordBackupRun(
  result: BackupRunResult & { triggeredBy: string; error?: string; downloadRunId?: string },
): Promise<void> {
  try {
    await db.insert(backupRuns).values({
      triggeredBy: result.triggeredBy,
      destination: result.destination,
      path: result.path ?? null,
      fileName: result.fileName,
      remoteItemId: result.remoteItemId ?? null,
      downloadRunId: result.downloadRunId,
      archiveKind: result.archiveKind ?? "full",
      sizeBytes: result.size,
      status: result.error ? "error" : "success",
      error: result.error ?? null,
      completedAt: new Date(result.completedAt),
      mediaFileCount: result.mediaFileCount ?? null,
      attachmentRowCount: result.attachmentRowCount ?? null,
      partialFailure: result.partialFailure ?? false,
      warnings: result.warnings ?? null,
    });
  } catch (err) {
    logger.warn({ err }, "Failed to record backup run in DB");
    if (result.archiveKind === COMPLETE_PRODUCTION_KIND || result.archiveKind === COMPLETE_DEVELOPMENT_KIND ||
        result.archiveKind?.startsWith("partial-")) throw err;
    return;
  }
  await pruneBackupHistory();
}

async function recordBackupError(
  triggeredBy: string,
  destination: BackupDestination,
  destPath: string | undefined,
  error: string,
  downloadRunId?: string,
): Promise<string> {
  const failedAt = new Date();
  try {
    await db.insert(backupRuns).values({
      triggeredBy,
      destination,
      downloadRunId,
      path: destPath ?? null,
      fileName: null,
      sizeBytes: null,
      status: "error",
      error,
      completedAt: failedAt,
    }).onConflictDoUpdate({
      target: backupRuns.downloadRunId,
      set: { status: "error", error, completedAt: failedAt },
    });
  } catch (err) {
    logger.warn({ err }, "Failed to record backup error in DB");
    return failedAt.toISOString();
  }
  await pruneBackupHistory();
  return failedAt.toISOString();
}

/**
 * Generate a backup in memory and record the run so history and stale-check
 * stay accurate. Used by the streaming download endpoint so the client saves
 * the file locally rather than the server writing to a (possibly nonexistent)
 * path on the Linux filesystem.
 */
export async function generateBackupForDownload(triggeredBy: string): Promise<{
  buffer: Buffer;
  fileName: string;
  size: number;
  completedAt: string;
}> {
  const { buffer, fileName, uploadDirs, attachmentRowCount } = await buildBackupZipBuffer(triggeredBy);
  const completedAt = new Date().toISOString();
  const result: BackupRunResult = {
    size: buffer.length,
    completedAt,
    fileName,
    destination: "local",
    path: undefined,
    mediaFileCount: uploadDirs.caseMedia.fileCount,
    attachmentRowCount,
  };
  if (result.archiveKind !== "database-only" && !result.partialFailure) await recordSuccessfulBackup();
  await recordBackupRun({ ...result, triggeredBy });
  return { buffer, fileName, size: buffer.length, completedAt };
}

/**
 * Stream an encrypted backup straight to the HTTP response.
 *
 * Unlike `generateBackupForDownload`, this never buffers the whole ZIP (or its
 * encrypted form) in memory: the ZIP archiver pipes through an AES-256-GCM
 * cipher and out to the client as chunked transfer-encoding, so bytes start
 * flowing within the first few hundred ms and server memory stays flat even for
 * multi-GB media libraries. This is the fix for "Failed to fetch" on large labs,
 * where the single-shot Content-Length response was dropped mid-transfer.
 *
 * Output uses the tag-trailing 'LTR2' format because the GCM auth tag is only
 * known after the entire plaintext is encrypted. Its final LTF1 footer records
 * the exact number of archive bytes before the footer, so clients can detect a
 * cleanly ended but truncated response even when Content-Length is absent.
 * `decryptBuffer` also continues to accept historical footerless 'LTR2' files.
 *
 * Pre-flight work (key derivation, pg_dump) runs BEFORE any header/byte is
 * written, so those failures still surface as a JSON 500 from the route. Once
 * streaming has begun the status is already 200 and errors can only abort the
 * connection.
 */
export async function streamBackupDownload(
  triggeredBy: string,
  res: import("express").Response,
  opts: { recordHistory?: boolean; runId?: string; archiveKind?: "full" | "database-only" } = {},
): Promise<void> {
  return withBackupRun(async () => {
    res.setHeader?.("X-Backup-Run-Id", getBackupRunId()!);
    const ownedDeadline = createBackupDeadline(await getBackupRunTimeoutMs(opts.archiveKind ?? "full"));
    const controller = new AbortController();
    const abort = () => controller.abort();
    const disconnected = () => { if (!res.writableFinished) abort(); };
    ownedDeadline.signal.addEventListener("abort", abort, { once: true });
    res.on("close", disconnected);
    if (res.destroyed || res.writableEnded) disconnected();
    const deadline: BackupDeadline = { ...ownedDeadline, signal: controller.signal };
    try {
      await measureBackupPhase("local download", () =>
        streamBackupDownloadWithinDeadline(triggeredBy, res, opts, deadline));
    } catch (error) {
      // Deferring *success* until a disk write must not discard the server's
      // true failure after HTTP headers have already been sent.
      await recordBackupError(triggeredBy, "local", undefined, safeBackupError(error), getBackupRunId());
      throw error;
    } finally {
      ownedDeadline.dispose();
      ownedDeadline.signal.removeEventListener("abort", abort);
      res.removeListener("close", disconnected);
    }
  }, opts.runId);
}

/**
 * Prepare a browser-delivered manual archive in private bounded object storage.
 * This decouples generation from the renderer and lets a later page request
 * stream the same sealed archive again without a local whole-archive spool.
 */
export async function generateManualBrowserBackupArchive(
  triggeredBy: string,
  runId: string,
  archiveKind: "full" | "database-only",
  cancellationSignal: AbortSignal,
  registerCleanup?: (cleanup: () => Promise<void>) => void,
): Promise<void> {
  const deadline = createBackupDeadline(
    await getBackupRunTimeoutMs(archiveKind),
    cancellationSignal,
  );
  let stage: Awaited<ReturnType<typeof createBackupCloudStage>> | undefined;
  try {
    const sourceEnvironment = isProductionDeployment() ? "production" : "non-production";
    let prepared: PreparedBackupArchive;
    let deliveryKind: BackupDeliveryStatus["archiveKind"];
    if (archiveKind === "database-only") {
      const [pgDump, counts] = await Promise.all([
        buildPgDumpBuffer(deadline),
        measureBackupPhase("database manifest counts",
          () => abortableBackupOperation(buildManifestCounts(), deadline.signal)),
      ]);
      const empty = { exists: false, fileCount: 0, totalBytes: 0 };
      prepared = prepareBackupArchive(triggeredBy, pgDump, counts, {
        caseMedia: empty,
        profilePhotos: empty,
      }, { includeProfilePhotos: false, archiveKind: "database-only", completionFooter: true });
      prepared.manifest.sourceEnvironment = sourceEnvironment;
      setBackupLiveArchiveEvidence({
        archiveKind: "database-only",
        coverageVersion: 0,
        mediaFileCount: 0,
        attachmentRowCount: counts.attachmentRowCount,
      });
      deliveryKind = "database-only";
    } else {
      const archive = await prepareCompleteBackupArchive(triggeredBy, deadline, "cloud");
      prepared = archive.prepared;
      deliveryKind = archive.archiveKind;
    }
    deadline.throwIfExpired("browser backup staging");
    stage = await measureBackupPhase("private cloud staging setup", () =>
      createBackupCloudStage(sourceEnvironment, deadline.timeoutMs, deadline.signal, runId));
    registerCleanup?.(() => stage!.cleanup());
    const result = await writeBackupArchiveToTarget(stage, prepared, deadline);
    deadline.throwIfExpired("browser backup staging");
    setBackupLiveDelivery({
      fileName: result.fileName,
      size: result.size,
      archiveKind: deliveryKind,
      sourceEnvironment,
      expiresAt: new Date(stage.expiresAt).toISOString(),
    });
    await markBackupLiveAwaitingVerification(getBackupRunId());
    deadline.throwIfExpired("browser backup staging");
  } catch (error) {
    await stage?.cleanup();
    if (deadline.cancelled()) throw new BackupCancelledError();
    try {
      await recordBackupError(triggeredBy, "local", undefined, safeBackupError(error), runId);
    } catch (recordError) {
      logger.warn({ runId, error: safeBackupError(recordError) },
        "[backup] Browser backup generation failure could not be added to history");
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

/** Stream a previously sealed browser archive in bounded App Storage ranges. */
export async function streamManualBrowserBackupArchive(
  runId: string,
  res: import("express").Response,
  cancellationSignal: AbortSignal,
  delivery: NonNullable<NonNullable<Awaited<ReturnType<typeof readBackupLiveStatus>>>["delivery"]>,
): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  cancellationSignal.addEventListener("abort", cancel, { once: true });
  const disconnected = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.on("close", disconnected);
  const stage = await openBackupCloudStage(delivery.sourceEnvironment, runId, controller.signal);
  if (stage.size !== delivery.size) {
    await stage.cleanup();
    throw new Error("The staged browser backup size no longer matches its verified run status.");
  }
  const status = await readBackupLiveStatus(runId);
  const evidence = status?.archiveEvidence;
  res.status(200);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${delivery.fileName}"`);
  res.setHeader("Content-Length", String(delivery.size));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Backup-Run-Id", runId);
  res.setHeader("X-Backup-Archive-Kind", delivery.archiveKind);
  res.setHeader("X-Backup-Coverage-Version", delivery.archiveKind === "database-only" ? "0" : String(COMPLETE_BACKUP_VERSION));
  res.setHeader("X-Backup-Source", delivery.sourceEnvironment === "production" ? "production" : "development");
  res.setHeader("X-Backup-Media-File-Count", String(evidence?.mediaFileCount ?? 0));
  res.setHeader("X-Backup-Attachment-Row-Count", String(evidence?.attachmentRowCount ?? 0));
  res.setHeader("X-Backup-Missing-File-Count", String(evidence?.missingFileCount ?? 0));
  const chunks = Readable.from((async function* () {
    for (let offset = 0; offset < stage.size; offset += MAX_BACKUP_RANGE_BYTES) {
      const length = Math.min(MAX_BACKUP_RANGE_BYTES, stage.size - offset);
      yield await stage.readChunk(offset, length);
    }
  })());
  try {
    await pipeline(chunks, res);
  } finally {
    res.removeListener("close", disconnected);
    cancellationSignal.removeEventListener("abort", cancel);
  }
}

export async function cleanupManualBrowserBackupArchive(
  runId: string,
  sourceEnvironment: "production" | "non-production",
): Promise<void> {
  const stage = await openBackupCloudStage(sourceEnvironment, runId, new AbortController().signal);
  await stage.cleanup();
}

async function streamBackupDownloadWithinDeadline(
  triggeredBy: string,
  res: import("express").Response,
  opts: { recordHistory?: boolean; archiveKind?: "full" | "database-only" },
  deadline: BackupDeadline,
): Promise<void> {
  // recordHistory=false is the desktop-scheduler path: a successful download
  // only proves the bytes reached the desktop app, NOT that the file was
  // written to the local folder/USB. The scheduler reports the real outcome
  // (saved or failed) to /admin/backup/desktop-run-report, which is the
  // single source of truth for the backup_runs row + staleness watermark on
  // that path. Recording here too would advance the watermark even when the
  // folder write fails. Manual "Back up now" keeps recordHistory=true: the
  // user watches the result directly and a browser download has no
  // post-download write step to wait for.
  const recordHistory = opts.recordHistory !== false;
  // An explicit database-only request preserves every database row/reference,
  // but neither reads media nor claims complete recovery coverage. Never fall
  // back to this mode after a failed complete capture.
  const databaseOnly = opts.archiveKind === "database-only";
  const backup = databaseOnly ? await (async () => {
    const pgDump = await buildPgDumpBuffer(deadline);
    const counts = await buildManifestCounts();
    const empty = { exists: false, fileCount: 0, totalBytes: 0 };
    const prepared = prepareBackupArchive(triggeredBy, pgDump, counts,
      { caseMedia: empty, profilePhotos: empty },
      { includeProfilePhotos: false, archiveKind: "database-only", completionFooter: true });
    prepared.manifest.sourceEnvironment = isProductionDeployment() ? "production" : "non-production";
    setBackupLiveArchiveEvidence({
      archiveKind: "database-only", coverageVersion: 0, mediaFileCount: 0,
      attachmentRowCount: counts.attachmentRowCount,
    });
    return { prepared, fileName: prepared.fileName, archiveKind: "database-only" as const,
      mediaFileCount: 0, attachmentRowCount: counts.attachmentRowCount,
      missingFileCount: 0, partialFailure: false, warnings: null };
  })() : await prepareCompleteBackupArchive(triggeredBy, deadline, "direct");
  const runId = getBackupRunId();
  res.status(200);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${backup.fileName}"`);
  // No Content-Length: the archive streams as it is produced. The final LTF1
  // footer records the exact byte count so the client detects truncation.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Backup-Archive-Kind", backup.archiveKind);
  res.setHeader("X-Backup-Coverage-Version", databaseOnly ? "0" : String(COMPLETE_BACKUP_VERSION));
  res.setHeader("X-Backup-Source", isProductionDeployment() ? "production" : "development");
  res.setHeader("X-Backup-Media-File-Count", String(backup.mediaFileCount));
  res.setHeader("X-Backup-Attachment-Row-Count", String(backup.attachmentRowCount));
  res.setHeader("X-Backup-Missing-File-Count", String(backup.missingFileCount));

  let transferredBytes = 0;
  const size = await measureBackupPhase(
    "archive assembly/encryption and local transfer",
    () => writeEncryptedBackupArchive(backup.prepared, res, {
      deadline,
      onProgress: (bytes) => { transferredBytes = bytes; },
    }),
    () => ({ transferredBytes }),
    (written) => ({ transferredBytes: written }),
  );

  if (recordHistory) {
    const completedAt = new Date().toISOString();
    if (!databaseOnly && !backup.partialFailure) await recordSuccessfulBackup();
    await recordBackupRun({
      size,
      completedAt,
      fileName: backup.fileName,
      archiveKind: backup.archiveKind,
      destination: "local",
      path: undefined,
      triggeredBy,
      mediaFileCount: backup.mediaFileCount,
      attachmentRowCount: backup.attachmentRowCount,
      partialFailure: backup.partialFailure,
      warnings: backup.warnings,
      downloadRunId: runId,
    });
  } else {
    await markBackupLiveAwaitingVerification(runId);
  }
}

export async function runBackup(
  triggeredBy: string,
  destination: BackupDestination,
  destPath?: string,
  options: { archiveKind?: BackupArchiveKind; deadline?: BackupDeadline; cancellationSignal?: AbortSignal } = {},
): Promise<BackupRunResult> {
  return withBackupRun(async () => {
  const ownedDeadline = options.deadline ? undefined : createBackupDeadline(
    await getBackupRunTimeoutMs(options.archiveKind ?? "full"),
    options.cancellationSignal,
  );
  options = { ...options, deadline: options.deadline ?? ownedDeadline };
  try {
  let result: BackupRunResult;
  try {
    if (destination === "onedrive") {
      result = await runOneDriveBackup(triggeredBy, options);
    } else if (destination === "google-drive") {
      result = await runGoogleDriveBackup(triggeredBy, options);
    } else if (destination === "local") {
      if (!destPath) throw new Error("A destination path is required for local backups.");
      result = await runLocalBackup(triggeredBy, destPath, options.deadline);
    } else if (destination === "network") {
      if (!destPath) throw new Error("A network path or sftp:// URL is required for network backups.");
      result = destPath.startsWith("sftp://")
        ? await runSftpBackup(triggeredBy, destPath, options.deadline)
        : await runLocalBackup(triggeredBy, destPath, options.deadline);
    } else {
      throw new Error(`Unknown backup destination: ${destination}`);
    }
  } catch (err: unknown) {
    if (options.deadline?.cancelled()) throw new BackupCancelledError();
    if (options.deadline?.expired() && !(err instanceof BackupTimeoutError)) {
      const phases = [...safeBackupError(err).matchAll(/Backup failed during ([^:]+?) after /g)];
      const phase = phases.at(-1)?.[1] ?? "backup generation";
      try { options.deadline.throwIfExpired(phase); } catch (timeout) { err = timeout; }
    }
    const errMsg = safeBackupError(err);
    const failedAt = await recordBackupError(
      triggeredBy,
      destination,
      destPath,
      errMsg,
      getBackupRunId(),
    );
    const outErr = err instanceof Error ? err : new Error(errMsg);
    (outErr as Error & { backupRunFailedAt?: string }).backupRunFailedAt = failedAt;
    throw outErr;
  }
  await recordBackupRun({ ...result, triggeredBy, downloadRunId: getBackupRunId() });
  if (result.archiveKind !== "database-only" && !result.partialFailure) await recordSuccessfulBackup();
  if (result.archiveKind === COMPLETE_PRODUCTION_KIND && !result.partialFailure) await recordLastFullArchiveAt(new Date());
  return result;
  } finally {
    ownedDeadline?.dispose();
  }
  });
}

/**
 * Key used in the system_settings table for the nightly backup hour (0–23 UTC).
 * When absent the env var BACKUP_HOUR_UTC is used (default 7).
 */

export async function getBackupHourUtc(): Promise<number> {
  const envHour = Math.max(
    0,
    Math.min(23, parseInt(process.env.BACKUP_HOUR_UTC || "7", 10) || 7),
  );
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_BACKUP_HOUR_UTC));
    const raw = rows[0]?.value ?? null;
    if (raw !== null) {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.min(23, parsed));
      }
    }
  } catch {
    // fall through to env default
  }
  return envHour;
}

export interface BackupScheduleConfig {
  intervalMinutes: number | null;
  destination: BackupDestination | null;
  path: string | null;
  enabled: boolean;
}

export async function getBackupScheduleConfig(): Promise<BackupScheduleConfig> {
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(
        sql`${systemSettings.key} in (${SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES}, ${SETTING_BACKUP_SCHEDULE_DESTINATION}, ${SETTING_BACKUP_SCHEDULE_PATH}, ${SETTING_BACKUP_SCHEDULE_ENABLED})`,
      );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const intervalRaw = byKey[SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES] ?? null;
    const intervalMinutes =
      intervalRaw !== null ? (parseInt(intervalRaw, 10) || null) : null;
    const destinationRaw = byKey[SETTING_BACKUP_SCHEDULE_DESTINATION] ?? null;
    const destination =
      destinationRaw === "local" ||
      destinationRaw === "network" ||
      destinationRaw === "onedrive" ||
      destinationRaw === "google-drive"
        ? destinationRaw
        : null;
    const schedulePath = byKey[SETTING_BACKUP_SCHEDULE_PATH] ?? null;
    const enabledRaw = byKey[SETTING_BACKUP_SCHEDULE_ENABLED] ?? null;
    const enabled = enabledRaw === "true";
    return { intervalMinutes, destination, path: schedulePath, enabled };
  } catch {
    return { intervalMinutes: null, destination: null, path: null, enabled: false };
  }
}

async function getAdminEmails(): Promise<string[]> {
  try {
    const admins = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.role, "admin"));
    const emails = Array.from(
      new Set(
        admins
          .map((u) => u.email?.trim().toLowerCase())
          .filter((e): e is string => Boolean(e)),
      ),
    );
    return filterEmailsByPref(emails, "backupAlerts");
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] Failed to load admin emails for notification; no notification will be sent",
    );
    return [];
  }
}

const DEFAULT_BACKUP_STALE_THRESHOLD_DAYS = 7;
const DEFAULT_BACKUP_STALE_ALERT_RATE_LIMIT_DAYS = 3;

export interface BackupStaleAlertSettings {
  thresholdDays: number;
  rateLimitDays: number;
}

export async function getBackupStaleAlertSettings(): Promise<BackupStaleAlertSettings> {
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(
        sql`${systemSettings.key} in (${SETTING_BACKUP_STALE_ALERT_THRESHOLD_DAYS}, ${SETTING_BACKUP_STALE_ALERT_RATE_LIMIT_DAYS})`,
      );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const thresholdRaw = byKey[SETTING_BACKUP_STALE_ALERT_THRESHOLD_DAYS] ?? null;
    const rateLimitRaw = byKey[SETTING_BACKUP_STALE_ALERT_RATE_LIMIT_DAYS] ?? null;
    const thresholdDays =
      thresholdRaw !== null && Number.isFinite(parseInt(thresholdRaw, 10))
        ? Math.max(1, Math.min(365, parseInt(thresholdRaw, 10)))
        : DEFAULT_BACKUP_STALE_THRESHOLD_DAYS;
    const rateLimitDays =
      rateLimitRaw !== null && Number.isFinite(parseInt(rateLimitRaw, 10))
        ? Math.max(1, Math.min(365, parseInt(rateLimitRaw, 10)))
        : DEFAULT_BACKUP_STALE_ALERT_RATE_LIMIT_DAYS;
    return { thresholdDays, rateLimitDays };
  } catch {
    return {
      thresholdDays: DEFAULT_BACKUP_STALE_THRESHOLD_DAYS,
      rateLimitDays: DEFAULT_BACKUP_STALE_ALERT_RATE_LIMIT_DAYS,
    };
  }
}

/**
 * Check whether the last successful backup is stale (null or older than the
 * configured threshold). If so, and if we haven't sent an alert within the
 * configured rate-limit window, send an alert email to all admin users and
 * record the send time in system_settings.
 *
 * Both thresholds are configurable via system_settings:
 *   backup_stale_alert_threshold_days  (default 7)
 *   backup_stale_alert_rate_limit_days (default 3)
 *
 * Local-destination schedules run only while the LabTrax Desktop app is open,
 * so they use a tighter effective threshold: 2× the configured backup interval
 * (minimum 48 h = 2 days).  The alert email also includes a note explaining
 * that the desktop app must be running for local backups to occur.
 */
export async function checkAndAlertBackupStaleness(): Promise<void> {
  try {
    const [lastSuccessfulAt, { thresholdDays, rateLimitDays }, scheduleConfig] =
      await Promise.all([
        getLastSuccessfulBackupAt(),
        getBackupStaleAlertSettings(),
        getBackupScheduleConfig(),
      ]);
    const now = Date.now();

    // For local-destination schedules use 2× the configured interval (min 48 h)
    // because the backup only runs while the desktop app is open.  An office PC
    // that was off all weekend would miss every scheduled slot, so a stricter
    // window surfaces the gap faster than the global 7-day threshold.
    const isLocalDestination = scheduleConfig.destination === "local";
    let effectiveThresholdDays = thresholdDays;
    // The timestamp we compare against: for local destinations use the most
    // recent desktop-reported run from backup_runs (NOT the global watermark,
    // which is also advanced by server-side backups like OneDrive/SFTP/manual).
    let effectiveLastAt: string | null = lastSuccessfulAt;

    if (isLocalDestination && scheduleConfig.enabled) {
      const intervalDays =
        scheduleConfig.intervalMinutes !== null
          ? scheduleConfig.intervalMinutes / (60 * 24)
          : 1; // fallback: treat as daily if unknown
      effectiveThresholdDays = Math.max(2 * intervalDays, 2);
      // Use desktop-triggered backup_runs rows as the authoritative source for
      // local schedules so a server-side run cannot silently mask a missed
      // local schedule.
      effectiveLastAt = await getLastDesktopBackupAt();
    }

    let daysSince: number;
    if (effectiveLastAt === null) {
      daysSince = Infinity;
    } else {
      const lastMs = new Date(effectiveLastAt).getTime();
      if (isNaN(lastMs)) {
        daysSince = Infinity;
      } else {
        daysSince = (now - lastMs) / (1000 * 60 * 60 * 24);
      }
    }

    if (daysSince < effectiveThresholdDays) {
      return;
    }

    const rateLimitRows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT));
    const lastSentRaw = rateLimitRows[0]?.value ?? null;

    if (lastSentRaw !== null) {
      const lastSentMs = new Date(lastSentRaw).getTime();
      if (!isNaN(lastSentMs)) {
        const daysSinceAlert = (now - lastSentMs) / (1000 * 60 * 60 * 24);
        if (daysSinceAlert < rateLimitDays) {
          logger.info(
            { daysSinceAlert: daysSinceAlert.toFixed(1), rateLimitDays },
            "[backup] Stale backup alert suppressed by rate limit",
          );
          return;
        }
      }
    }

    const adminEmails = await getAdminEmails();
    if (adminEmails.length === 0) {
      logger.warn("[backup] Stale backup detected but no admin emails found; skipping alert");
      return;
    }

    // Atomically claim the send slot before sending the email so that only one
    // server instance sends the alert when multiple instances run concurrently.
    // We do a conditional write that only succeeds when the stored value still
    // matches what we read earlier (compare-and-swap). If another instance
    // already claimed the slot, rowCount will be 0 and we bail out.
    const claimTime = new Date();
    const claimValue = claimTime.toISOString();
    let claimed = false;

    if (lastSentRaw === null) {
      // No row yet — INSERT and ignore if another instance races us to it.
      const insertResult = await db
        .insert(systemSettings)
        .values({ key: SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT, value: claimValue })
        .onConflictDoNothing();
      claimed = (insertResult.rowCount ?? 0) > 0;
    } else {
      // Row exists — UPDATE only when the stored value still equals lastSentRaw.
      const updateResult = await db
        .update(systemSettings)
        .set({ value: claimValue, updatedAt: claimTime })
        .where(
          sql`${systemSettings.key} = ${SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT} AND ${systemSettings.value} = ${lastSentRaw}`,
        );
      claimed = (updateResult.rowCount ?? 0) > 0;
    }

    if (!claimed) {
      logger.info(
        "[backup] Stale backup alert claim lost to a concurrent instance; skipping duplicate send",
      );
      return;
    }

    try {
      await sendBackupStaleAlertEmail({
        adminEmails,
        lastSuccessfulAt: effectiveLastAt,
        daysSinceBackup: isFinite(daysSince) ? daysSince : 0,
        isLocalDestination,
        thresholdDays: effectiveThresholdDays,
      });
    } catch (sendErr: unknown) {
      // Email delivery failed after we claimed the slot. Best-effort: roll back
      // the claim so the next scheduled invocation can retry rather than being
      // silenced for the full rate-limit window with no alert delivered.
      logger.error(
        { err: sendErr instanceof Error ? sendErr.message : String(sendErr) },
        "[backup] Stale backup alert email failed; rolling back claim",
      );
      try {
        if (lastSentRaw === null) {
          // We did an INSERT — delete the row to restore the "no prior alert" state.
          await db
            .delete(systemSettings)
            .where(
              sql`${systemSettings.key} = ${SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT} AND ${systemSettings.value} = ${claimValue}`,
            );
        } else {
          // We did an UPDATE — restore the previous value so the next invocation
          // can attempt to send again.
          await db
            .update(systemSettings)
            .set({ value: lastSentRaw, updatedAt: new Date() })
            .where(
              sql`${systemSettings.key} = ${SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT} AND ${systemSettings.value} = ${claimValue}`,
            );
        }
      } catch (rollbackErr: unknown) {
        logger.warn(
          { err: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr) },
          "[backup] Stale backup alert claim rollback failed; rate-limit window may be consumed without a delivery",
        );
      }
      throw sendErr;
    }

    logger.info(
      { adminEmailCount: adminEmails.length, daysSinceBackup: isFinite(daysSince) ? daysSince.toFixed(1) : "never" },
      "[backup] Stale backup alert sent",
    );
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] checkAndAlertBackupStaleness failed",
    );
  }
}

// ── Daily backup scheduler ───────────────────────────────────────────────────
// Runs once per day at the configured UTC hour (default 07:00 UTC ≈ 2-3am ET).
// Override with BACKUP_HOUR_UTC env var (0–23) or the backup_hour_utc system_settings row.

let scheduled = false;

function msUntilNext(hourUtc: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      0,
      0,
      0,
    ),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

// ── Dynamic recurring backup scheduler ──────────────────────────────────────
// Driven by system_settings rows written by PUT /api/admin/backup/schedule.
// The interval timer is replaced each time the schedule is updated.

let _scheduledIntervalTimer: ReturnType<typeof setTimeout> | null = null;

let _schedulerGeneration = 0;
let _scheduledBackupInFlight = false;
let _scheduledBackupStartedAtMs: number | null = null;

let _scheduledBackupDeadlineMs = 0;
let _scheduledBackupArchiveKind: BackupArchiveKind | null = null;
let _backupSlotToken = 0;

/**
 * How long a run may hold the slot before it is treated as dead.
 *
 * A plain boolean guard assumes every run eventually finishes. One that never
 * does — a socket that accepts bytes and answers nothing, a stream that never
 * closes — leaves the flag set forever, and from then on every tick logs
 * "still running" and returns. Backups stop without a single failure being
 * recorded. Graph calls now carry deadlines, so a wedge this long means the
 * run is lost rather than slow, and the next tick takes the slot and says so.
 */
const STUCK_BACKUP_GRACE_MS = 90 * 60 * 1000;

interface BackupSlot {
  token: number;
  /** Set when the slot was taken from a run that never finished. */
  stolenAfterMs: number | null;
}

function claimBackupSlot(label: string, archiveKind: BackupArchiveKind): BackupSlot | null {
  const startedAt = _scheduledBackupStartedAtMs;
  if (_scheduledBackupInFlight) {
    const runningForMs = startedAt === null ? 0 : Date.now() - startedAt;
    // Expire the guard against the running backup's own deadline when it set
    // one, so a wedged run frees the slot a grace period after it was given
    // up on rather than blocking every later run for a fixed 90 minutes.
    // Runs that set no deadline keep the original fixed grace.
    const effectiveDeadlineMs =
      _scheduledBackupDeadlineMs > 0 ? _scheduledBackupDeadlineMs : STUCK_BACKUP_GRACE_MS;
    if (
      startedAt === null ||
      scheduledBackupGuardBlocks(startedAt, effectiveDeadlineMs, Date.now())
    ) {
      return null;
    }
    logger.error(
      { label, runningForMinutes: Math.round(runningForMs / 60_000) },
      "[backup] Previous backup never finished; taking over the slot",
    );
    _backupSlotToken += 1;
    _scheduledBackupStartedAtMs = Date.now();
    _scheduledBackupArchiveKind = archiveKind;
    return { token: _backupSlotToken, stolenAfterMs: runningForMs };
  }
  _backupSlotToken += 1;
  _scheduledBackupInFlight = true;
  _scheduledBackupStartedAtMs = Date.now();
  _scheduledBackupArchiveKind = archiveKind;
  return { token: _backupSlotToken, stolenAfterMs: null };
}

/** Only the current holder may release the slot — a revived zombie may not. */
function releaseBackupSlot(slot: BackupSlot): void {
  if (slot.token !== _backupSlotToken) return;
  _scheduledBackupInFlight = false;
  _scheduledBackupStartedAtMs = null;
  _scheduledBackupDeadlineMs = 0;
  _scheduledBackupArchiveKind = null;
  schedulePendingProtectionCatchup();
}

function schedulePendingProtectionCatchup(): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test" || !isProductionDeployment()) return;
  setTimeout(() => {
    void hasPendingDatabaseProtectionCatchup()
      .then(pending => pending ? fireOffsiteBackup("catchup") : undefined)
      .catch(error => logger.warn(
        { err: safeBackupError(error) },
        "[backup] Could not check persisted production catch-up state",
      ));
  }, 0);
}

let _scheduledBackupRunnerForTests: typeof runBackup | null = null;
export async function fireScheduledBackup() {
  const config = await getBackupScheduleConfig();
  if (!config.enabled || !config.destination) return;
  if (isProductionDeployment() && (config.destination === "onedrive" || config.destination === "google-drive")) {
    // Both cloud destinations use the same serialized incremental capture.
    await fireOffsiteBackup("interval");
    return;
  }
  const label = `scheduler:interval`;

  // Local-folder schedules are executed by the LabTrax Desktop app while it is
  // open (it downloads the backup and writes it to the chosen folder, then
  // reports the run back to the server). The server itself cannot reach the
  // admin's local disk, so it silently skips these — no error run, no email.
  if (config.destination === "local") {
    logger.info(
      { destination: config.destination, path: config.path },
      "[backup] Local-folder schedule is executed by the desktop app; server skipping this interval",
    );
    return;
  }

  // UNC/SMB network paths exist on the admin's Windows machine, not the server,
  // so writes to those paths would silently fail or produce an unreachable
  // file. Only SFTP network destinations are reachable from the server.
  const isUnsupportedPath =
    config.destination === "network" && !!config.path && !config.path.startsWith("sftp://");

  if (isUnsupportedPath) {
    const errMsg =
      "Scheduled backups cannot write to UNC/SMB network paths because the backup " +
      "runs on the server (Linux), not on your Windows machine. The file would never reach you. " +
      "Switch the scheduled destination to an SFTP server (sftp://user@host/path), OneDrive, Google Drive, " +
      "or a local folder (written by the LabTrax Desktop app while it is open).";
    logger.warn(
      { destination: config.destination, path: config.path },
      "[backup] Scheduled backup skipped — UNC/SMB path is unreachable from the server",
    );
    await recordBackupError(label, config.destination, config.path ?? undefined, errMsg);
    try {
      const adminEmails = await getAdminEmails();
      await sendBackupNotificationEmail({
        adminEmails,
        triggeredBy: label,
        success: false,
        errorMessage: errMsg,
        failedAt: new Date().toISOString(),
        destination: config.destination,
      });
    } catch (mailErr: unknown) {
      logger.error(
        { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
        "[backup] Scheduled backup skip: notification email failed",
      );
    }
    return;
  }

  const archiveKind = await decideScheduledArchiveKind(
    config.destination,
    config.intervalMinutes,
  );
  const timeoutMs = await getBackupRunTimeoutMs(archiveKind);
  // A normal full run and the off-site timer share a primary slot. The
  // off-site timer has a database-only fallback for the case where that full
  // run outlasts a protection interval.
  const slot = claimBackupSlot(label, archiveKind);
  if (slot === null) {
    logger.warn(
      { destination: config.destination },
      "[backup] Previous scheduled backup is still running; skipping this interval",
    );
    await recordBackupError(label, config.destination, config.path ?? undefined,
      "Missed complete recovery point: the previous scheduled backup is still running. No database-only fallback was taken.");
    return;
  }

  const deadline = createBackupDeadline(timeoutMs);
  _scheduledBackupDeadlineMs = timeoutMs;
  await writeSystemSetting(
    SETTING_BACKUP_SCHEDULE_LAST_ATTEMPT_AT,
    new Date().toISOString(),
  );

  try {
    logger.info(
      {
        destination: config.destination,
        path: config.path,
        archiveKind,
        timeoutMs,
        recoveredStuckRunAfterMs: slot.stolenAfterMs,
      },
      "Scheduled interval backup starting",
    );
    const result = await runScheduledDestinationBackup(label, config.destination, config.path ?? undefined, {
      archiveKind,
      deadline,
    });
    logger.info(
      { size: result.size, fileName: result.fileName, archiveKind: result.archiveKind },
      "Scheduled interval backup OK",
    );
    // Routine success notices follow the full-archive cadence, not the fast
    // one. A success email per run was fine hourly; at 15 minutes it is 96
    // identical emails a day, which trains admins to ignore the one that
    // reports a failure. Failures below are still mailed on every run.
    if (result.archiveKind !== "database-only" && !result.partialFailure) {
      try {
        const adminEmails = await getAdminEmails();
        await sendBackupNotificationEmail({
          adminEmails,
          triggeredBy: "scheduler:interval",
          success: true,
          result: {
            destination: result.destination,
            fileName: result.fileName,
            size: result.size,
            completedAt: result.completedAt,
            path: result.path,
            partialFailure: result.partialFailure ?? false,
            warnings: result.warnings ?? null,
          },
        });
      } catch (mailErr: unknown) {
        logger.error(
          { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
          "Scheduled interval backup: success notification email failed",
        );
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failedAt =
      (err as Error & { backupRunFailedAt?: string }).backupRunFailedAt ??
      new Date().toISOString();
    logger.error(
      { err: errMsg, destination: config.destination, failedAt },
      "Scheduled interval backup FAILED",
    );
    try {
      const adminEmails = await getAdminEmails();
      await sendBackupNotificationEmail({
        adminEmails,
        triggeredBy: "scheduler:interval",
        success: false,
        errorMessage: errMsg,
        failedAt,
        destination: config.destination,
      });
    } catch (mailErr: unknown) {
      logger.error(
        { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
        "Scheduled interval backup: failure notification email failed",
      );
    }
  } finally {
    deadline.dispose();
    releaseBackupSlot(slot);
  }
}

/**
 * Immediately runs the configured scheduled backup once as an admin-triggered
 * test. Validates that the schedule is enabled and that the destination is
 * server-reachable (SFTP URL, OneDrive, or Google Drive). Local-folder schedules are executed
 * by the desktop app, so they cannot be fired from the server. Records the run
 * in backup_runs with triggeredBy "admin:manual-schedule-test".
 */
export async function runScheduledBackupNow(): Promise<BackupRunResult> {
  if (isProductionDeployment()) {
    throw new Error("Production schedules use asynchronous production records-and-media protection, not the legacy archive schedule runner.");
  }
  const config = await getBackupScheduleConfig();
  if (!config.enabled) {
    throw new Error("No schedule is currently enabled. Enable and save a schedule before running it.");
  }
  if (config.destination === "local") {
    throw new Error(
      "Local-folder schedules run from the LabTrax Desktop app while it is open, not from the server. " +
        "Open the desktop app to let the schedule run, or use \u201cBack up now\u201d to save a backup immediately.",
    );
  }
  if (config.destination === "onedrive" || config.destination === "google-drive") {
    // Same budget as a scheduled run: "Run now" verifies the scheduled path,
    // so it must not be able to hang indefinitely either.
    const deadline = createBackupDeadline(await getBackupRunTimeoutMs());
    try {
      return await runScheduledDestinationBackup(
        "admin:manual-schedule-test",
        config.destination,
        undefined,
        {
        deadline,
        },
      );
    } finally {
      deadline.dispose();
    }
  }
  if (
    !config.destination ||
    !config.path ||
    config.destination !== "network" ||
    !config.path.startsWith("sftp://")
  ) {
    throw new Error(
      "Only SFTP, OneDrive, and Google Drive scheduled destinations can be triggered from the server. " +
        "Set the scheduled destination to an SFTP URL (sftp://user@host/path), OneDrive, or Google Drive and save the schedule first.",
    );
  }
  return runScheduledDestinationBackup(
    "admin:manual-schedule-test",
    config.destination,
    config.path,
  );
}

/**
 * Should the scheduler run a missed slot as soon as it starts?
 *
 * On by default in the server. Test suites restart the scheduler as part of
 * exercising the settings routes and must not fire real backups, so under
 * Vitest the catch-up run is opt-in via LABTRAX_BACKUP_SCHEDULER_ALLOW_CATCHUP.
 */
function startupCatchUpAllowed(): boolean {
  if (process.env.LABTRAX_BACKUP_SCHEDULER_ALLOW_CATCHUP === "1") return true;
  return !process.env.VITEST;
}
/**
 * (Re)arm the recurring backup schedule.
 *
 * The due time lives in the database, not only in this process. Previously the
 * schedule was a bare setInterval armed at startup: every restart reset the
 * clock to a full interval from zero, so a server restarting more often than
 * the interval produced no backups at all — and no error rows, because nothing
 * ever ran. Now a missed slot is run at startup and each tick is anchored to a
 * wall-clock slot, so restarts cannot keep postponing the next run.
 *
 * A saved OneDrive schedule runs alongside off-site protection rather than
 * being suppressed by it. The admin's configured schedule stays observable (it
 * is their setting), and the two cannot collide: runs are serialized by
 * claimBackupSlot, so a tick that overlaps simply skips, and retention prunes
 * any extra archive the overlap produces.
 */
export async function restartScheduledBackupJob(): Promise<void> {
  // Off-site protection is bootstrapped here because this is the one backup
  // entry point the server calls at startup. It is NOT conditional on the
  // editable schedule below: whatever the admin has configured there, a
  // verified off-site copy every fifteen minutes is the floor.
  startOffsiteBackupProtection(true);

  if (_scheduledIntervalTimer !== null) {
    clearTimeout(_scheduledIntervalTimer);
    _scheduledIntervalTimer = null;
  }
  const generation = ++_schedulerGeneration;

  const config = await getBackupScheduleConfig();
  if (!config.enabled || !config.intervalMinutes || !config.destination) {
    logger.info("[backup] Recurring backup schedule is disabled or not configured.");
    return;
  }
  const intervalMinutes = config.intervalMinutes;

  const arm = (dueAtMs: number): void => {
    if (generation !== _schedulerGeneration) return;
    const delayMs = Math.max(0, dueAtMs - Date.now());
    const timer = setTimeout(() => {
      void tick();
    }, delayMs);
    timer.unref?.();
    _scheduledIntervalTimer = timer;
  };

  const tick = async (): Promise<void> => {
    if (generation !== _schedulerGeneration) return;
    try {
      await fireScheduledBackup();
    } catch (err: unknown) {
      // fireScheduledBackup already records and reports its own failures; this
      // only guards the timer chain itself.
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[backup] Scheduled backup tick threw; the schedule continues",
      );
    }
    if (generation !== _schedulerGeneration) return;
    const nextDueMs = nextScheduleSlotMs(Date.now(), intervalMinutes);
    await writeSystemSetting(
      SETTING_BACKUP_SCHEDULE_NEXT_DUE_AT,
      new Date(nextDueMs).toISOString(),
    );
    arm(nextDueMs);
  };

  const { nextDueAt } = await getBackupScheduleState();
  const nowMs = Date.now();
  const overdue = nextDueAt !== null && nextDueAt.getTime() <= nowMs;

  logger.info(
    {
      intervalMinutes,
      destination: config.destination,
      persistedNextDueAt: nextDueAt?.toISOString() ?? null,
      overdue,
    },
    "[backup] Recurring backup schedule started",
  );

  if (overdue && startupCatchUpAllowed()) {
    logger.warn(
      { persistedNextDueAt: nextDueAt?.toISOString() ?? null },
      "[backup] A scheduled backup slot was missed while the server was down; running it now",
    );
    // Deliberately not awaited: startup must not block on a multi-minute
    // backup, and the tick arms the next slot when it completes.
    void tick();
    return;
  }

  const dueAtMs =
    nextDueAt !== null && nextDueAt.getTime() > nowMs
      ? nextDueAt.getTime()
      : nextScheduleSlotMs(nowMs, intervalMinutes);
  await writeSystemSetting(
    SETTING_BACKUP_SCHEDULE_NEXT_DUE_AT,
    new Date(dueAtMs).toISOString(),
  );
  arm(dueAtMs);
}

// ── Off-site protection (OneDrive, every 15 minutes) ────────────────────────
// Independent of the user-editable schedule above, which can legitimately be
// disabled, pointed at a local folder, or set to a long interval. Off-site
// protection is the data-loss floor: a verified copy in OneDrive at least
// every fifteen minutes, and a visible alarm when that stops being true.

let _offsiteIntervalTimer: ReturnType<typeof setTimeout> | null = null;
let _offsiteMonitorTimer: ReturnType<typeof setInterval> | null = null;
let _offsiteCatchupTimer: ReturnType<typeof setInterval> | null = null;
let _offsiteTimerGeneration = 0;

/** How often the watchdog asks "is there a recent verified off-site copy?". */
const OFFSITE_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
/** Poll persisted coalesced work so another server instance can drain it after a lock release. */
const OFFSITE_CATCHUP_POLL_INTERVAL_MS = 30 * 1000;
/** Let the server finish booting before the catch-up run and first check. */
const OFFSITE_STARTUP_DELAY_MS = 2 * 60 * 1000;
/** Repeat alert emails at most this often while an outage continues. */
const OFFSITE_ALERT_EMAIL_RATE_LIMIT_MS = 6 * 60 * 60 * 1000;

export interface OffsiteBackupConfig {
  enabled: boolean;
  intervalMinutes: number;
  destination: BackupDestination;
}

/**
 * Effective off-site cadence. Defaults to every fifteen minutes and can only
 * be relaxed as far as hourly — the editable schedule may tighten it, never
 * loosen it, and only an explicit `backup_offsite_enabled = false` row turns
 * protection off.
 */
export async function getOffsiteBackupConfig(): Promise<OffsiteBackupConfig> {
  let enabled = true;
  let intervalMinutes = DEFAULT_OFFSITE_INTERVAL_MINUTES;
  let destination: BackupDestination = "onedrive";

  const envInterval = parseInt(process.env.OFFSITE_BACKUP_INTERVAL_MINUTES || "", 10);
  if (Number.isFinite(envInterval) && envInterval > 0) intervalMinutes = envInterval;
  if (process.env.LABTRAX_DISABLE_OFFSITE_BACKUP === "1") enabled = false;

  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(
        sql`${systemSettings.key} in (${SETTING_BACKUP_OFFSITE_ENABLED}, ${SETTING_BACKUP_OFFSITE_INTERVAL_MINUTES}, ${SETTING_BACKUP_SCHEDULE_ROUTING_VERSION}, ${SETTING_BACKUP_SCHEDULE_ENABLED}, ${SETTING_BACKUP_SCHEDULE_DESTINATION}, ${SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES})`,
      );
    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    if (isProductionDeployment()) {
      // Earlier deployments ignored these editable rows. Preserve their live
      // OneDrive protection until a new schedule is explicitly saved.
      if (byKey.get(SETTING_BACKUP_SCHEDULE_ROUTING_VERSION) !== "2") {
        return { enabled: true, intervalMinutes: DEFAULT_OFFSITE_INTERVAL_MINUTES, destination: "onedrive" };
      }
      enabled = byKey.get(SETTING_BACKUP_SCHEDULE_ENABLED) === "true";
      const savedDestination = byKey.get(SETTING_BACKUP_SCHEDULE_DESTINATION);
      if (["onedrive", "google-drive", "local", "network"].includes(String(savedDestination))) {
        destination = savedDestination as BackupDestination;
        enabled = byKey.get(SETTING_BACKUP_SCHEDULE_ENABLED) === "true";
        const savedInterval = Number(byKey.get(SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES));
        if ([5, 15, 20, 30, 60, 360, 1440].includes(savedInterval)) intervalMinutes = savedInterval;
      }
      return { enabled: enabled && (destination === "onedrive" || destination === "google-drive"), intervalMinutes, destination };
    }

    const enabledRaw = byKey.get(SETTING_BACKUP_OFFSITE_ENABLED);
    if (enabledRaw !== undefined && enabledRaw !== null) {
      enabled = String(enabledRaw).toLowerCase() !== "false";
    }

    const intervalRaw = byKey.get(SETTING_BACKUP_OFFSITE_INTERVAL_MINUTES);
    if (intervalRaw !== undefined && intervalRaw !== null) {
      const parsed = parseInt(String(intervalRaw), 10);
      if (Number.isFinite(parsed) && parsed > 0) intervalMinutes = parsed;
    }

    // A OneDrive schedule set to something faster wins; a slower one does not.
    if (
      String(byKey.get(SETTING_BACKUP_SCHEDULE_ENABLED) ?? "").toLowerCase() === "true" &&
      String(byKey.get(SETTING_BACKUP_SCHEDULE_DESTINATION) ?? "") === "onedrive"
    ) {
      const scheduleInterval = parseInt(
        String(byKey.get(SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES) ?? ""),
        10,
      );
      if (Number.isFinite(scheduleInterval) && scheduleInterval > 0) {
        intervalMinutes = Math.min(intervalMinutes, scheduleInterval);
      }
    }
  } catch (err: unknown) {
    // Never silently fall back to another provider after an administrator has
    // changed the destination. A failed config read must fail closed.
    if (isProductionDeployment()) throw err;
    // Defaults already give the required protection; a settings read failure
    // must not be the reason backups stop.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] Could not read off-site backup settings; using defaults",
    );
  }

  intervalMinutes = Math.min(
    MAX_OFFSITE_INTERVAL_MINUTES,
    Math.max(MIN_OFFSITE_INTERVAL_MINUTES, intervalMinutes),
  );
  return { enabled, intervalMinutes, destination };
}

/**
 * When the newest *verified* off-site archive was written. Read from
 * backup_runs rather than the shared watermark setting, because that setting
 * is also advanced by local/desktop runs that leave nothing off-site.
 */
export async function getLastVerifiedOffsiteBackupAt(): Promise<string | null> {
  try {
    if (isProductionDeployment()) return (await getDatabaseProtectionStatus()).lastVerifiedAt;
    const rows = await db
      .select({ completedAt: backupRuns.completedAt })
      .from(backupRuns)
      .where(and(eq(backupRuns.destination, "onedrive"), eq(backupRuns.status, "success"),
        eq(backupRuns.archiveKind, COMPLETE_PRODUCTION_KIND), eq(backupRuns.partialFailure, false)))
      .orderBy(sql`${backupRuns.completedAt} desc`)
      .limit(1);
    const value = rows[0]?.completedAt ?? null;
    return value === null ? null : new Date(value).toISOString();
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] Could not read the last verified off-site backup time",
    );
    return null;
  }
}

// ── Confirmed-archive freshness ─────────────────────────────────────────────
// The watchdog that should have caught the eighteen-day gap judged freshness
// from backup_runs and ran inside the API process. Both halves of that are
// wrong: a success row only says a run believed it worked, and a watchdog
// hosted by the process it watches cannot report that process being dead.
// Freshness is therefore read from the destination's own listing, by code a
// separate process can run (see jobs/check-backup-freshness.ts).

/** Stale window = this many missed intervals, never less than the floor. */
export const OFFSITE_STALE_WINDOW_MULTIPLIER = 3;
export const OFFSITE_STALE_WINDOW_FLOOR_MINUTES = 45;

/**
 * How old the newest archive may be before protection counts as lapsed.
 * A multiple of the configured cadence, not a flat seven days: at a
 * fifteen-minute cadence, seven days of silence is 672 missed copies.
 */
export function offsiteStaleWindowMinutes(intervalMinutes: number): number {
  const interval =
    Number.isFinite(intervalMinutes) && intervalMinutes > 0
      ? intervalMinutes
      : DEFAULT_OFFSITE_INTERVAL_MINUTES;
  return Math.max(
    OFFSITE_STALE_WINDOW_FLOOR_MINUTES,
    Math.round(interval * OFFSITE_STALE_WINDOW_MULTIPLIER),
  );
}

export interface OffsiteArchiveSummary {
  name: string;
  createdAt: string;
  sizeBytes: number;
  ageMinutes: number;
}

/**
 * Newest archive actually present in the off-site folder, read from OneDrive
 * rather than from anything this app recorded about itself. Files below the
 * plausible-size floor are ignored: a few kilobytes under a backup's name is
 * not a recovery point, however recently it was written.
 */
export async function getNewestOffsiteArchive(now: Date = new Date()): Promise<{
  archive: OffsiteArchiveSummary | null;
  error: string | null;
  archiveCount: number | null;
}> {
  if (!isOneDriveConnectorAvailable()) {
    return {
      archive: null,
      archiveCount: null,
      error: "This server cannot reach OneDrive (the integration is not available to it).",
    };
  }
  try {
    const files = await listOneDriveBackupFiles();
    const floor = minPlausibleBackupBytes();
    const verified = await db.select({
      remoteItemId: backupRuns.remoteItemId, fileName: backupRuns.fileName, size: backupRuns.sizeBytes,
    }).from(backupRuns).where(and(
      eq(backupRuns.destination, "onedrive"), eq(backupRuns.status, "success"),
      eq(backupRuns.archiveKind, COMPLETE_PRODUCTION_KIND), eq(backupRuns.partialFailure, false),
    ));
    const newest = files.find(f => f.size >= floor &&
      Number.isFinite(Date.parse(f.createdDateTime)) && Date.parse(f.createdDateTime) <= now.getTime() && verified.some(run =>
      run.remoteItemId === f.id && run.fileName === f.name && run.size === f.size)) ?? null;
    if (!newest) return { archive: null, error: null, archiveCount: files.length };
    const createdMs = new Date(newest.createdDateTime).getTime();
    return {
      archive: {
        name: newest.name,
        createdAt: newest.createdDateTime,
        sizeBytes: newest.size,
        ageMinutes: Number.isNaN(createdMs)
          ? 0
          : Math.max(0, Math.round((now.getTime() - createdMs) / 60_000)),
      },
      error: null,
      archiveCount: files.length,
    };
  } catch (err: unknown) {
    return {
      archive: null,
      archiveCount: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface OffsiteFreshnessInput {
  nowMs: number;
  intervalMinutes: number;
  /** When the newest confirmed archive was written, per the destination. */
  newestArchiveAt: string | null;
  /** Why the destination could not be listed, when it could not. */
  listingError: string | null;
  /** Capture/coverage or dependency-verification failure, not a folder listing error. */
  verificationError?: string | null;
  /** Informational only; a history row cannot replace destination evidence. */
  lastVerifiedAt: string | null;
}

export interface OffsiteFreshnessVerdict {
  stale: boolean;
  ageMinutes: number | null;
  windowMinutes: number;
  /** Which evidence the verdict rests on. */
  source: "onedrive" | "google-drive" | "database" | "none";
  /** True when the destination itself could not be read. */
  destinationUnreadable: boolean;
  /** Sentence an admin can act on; null when protection is healthy. */
  reason: string | null;
}

/**
 * Pure freshness verdict, so the window arithmetic can be tested without a
 * database or a Graph call and so both watchdogs agree on what "stale" means.
 *
 * A history row is never a substitute for a retained destination object.
 */
export function evaluateOffsiteFreshness(
  input: OffsiteFreshnessInput,
): OffsiteFreshnessVerdict {
  const windowMinutes = offsiteStaleWindowMinutes(input.intervalMinutes);
  const destinationUnreadable = input.listingError !== null;
  const ageOf = (iso: string | null): number | null => {
    if (iso === null) return null;
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms > input.nowMs) return null;
    return Math.max(0, Math.round((input.nowMs - ms) / 60_000));
  };

  const archiveAge = ageOf(input.newestArchiveAt);
  // A previous complete point remains useful history, but cannot clear an
  // incomplete capture or failed/overdue dependency check. Preserve the actual
  // diagnosis instead of claiming that the provider's folder was unreadable.
  if (input.verificationError != null) {
    return {
      stale: true,
      ageMinutes: archiveAge,
      windowMinutes,
      source: archiveAge === null ? "none" : "onedrive",
      destinationUnreadable,
      reason: input.verificationError,
    };
  }
  if (archiveAge !== null) {
    return {
      stale: archiveAge > windowMinutes,
      ageMinutes: archiveAge,
      windowMinutes,
      source: "onedrive",
      destinationUnreadable,
      reason:
        archiveAge > windowMinutes
          ? `No backup archive has landed off-site in ${archiveAge} minutes ` +
            `(one is expected every ${input.intervalMinutes}).`
          : null,
    };
  }

  // The folder was readable and holds no usable archive — that is the worst
  // case, not an inconclusive one.
  if (!destinationUnreadable) {
    return {
      stale: true,
      ageMinutes: null,
      windowMinutes,
      source: "none",
      destinationUnreadable: false,
      reason: "There is no verified complete database-and-files recovery point in the off-site folder.",
    };
  }

  return {
      stale: true,
      ageMinutes: null,
      windowMinutes,
      source: "none",
      destinationUnreadable: true,
      reason:
        "The OneDrive backup folder could not be read, and no complete production recovery point can currently be confirmed. " +
        "Check the OneDrive connection and inspect backup history.",
    };
}

export interface OffsiteFreshness extends OffsiteFreshnessVerdict {
  enabled: boolean;
  intervalMinutes: number;
  newestArchive: OffsiteArchiveSummary | null;
  /** How many files the off-site folder holds, when it could be listed. */
  archiveCount: number | null;
  listingError: string | null;
  verificationError?: string | null;
  lastVerifiedAt: string | null;
}

/** Freshness of off-site protection, judged from the destination itself. */
export async function getOffsiteFreshness(now: Date = new Date()): Promise<OffsiteFreshness> {
  const config = await getOffsiteBackupConfig();
  if (isProductionDeployment()) {
    const cloudDestination = config.destination === "google-drive" ? "google-drive" : "onedrive";
    const status = await getDatabaseProtectionStatus(undefined, cloudDestination);
    const verificationError = databaseProtectionVerificationError(status, now.getTime(), config.intervalMinutes);
    const verdict = evaluateOffsiteFreshness({
      nowMs: now.getTime(), intervalMinutes: config.intervalMinutes, newestArchiveAt: status.recoveryPointAt,
      listingError: null,
      verificationError,
      lastVerifiedAt: null,
    });
    return {
      ...verdict, source: verdict.source === "onedrive" ? cloudDestination : verdict.source,
      reason: cloudDestination === "google-drive" ? verdict.reason?.replaceAll("OneDrive", "Google Drive") ?? null : verdict.reason,
      enabled: config.enabled, intervalMinutes: config.intervalMinutes,
      newestArchive: status.recoveryPointAt ? {
        name: status.coverage === "partial" ? "Verified partial production recovery point" : "Verified production records and media point",
        createdAt: status.recoveryPointAt,
        sizeBytes: status.dumpBytes + status.mediaBytes,
        ageMinutes: Math.max(0, (now.getTime() - Date.parse(status.recoveryPointAt)) / 60_000),
      } : null,
      archiveCount: null, listingError: null, verificationError,
      lastVerifiedAt: status.lastVerifiedAt,
    };
  }
  const [{ archive, error, archiveCount }, lastVerifiedAt] = await Promise.all([
    getNewestOffsiteArchive(now),
    getLastVerifiedOffsiteBackupAt(),
  ]);
  const verdict = evaluateOffsiteFreshness({
    nowMs: now.getTime(),
    intervalMinutes: config.intervalMinutes,
    newestArchiveAt: archive?.createdAt ?? null,
    listingError: error,
    lastVerifiedAt: null,
  });
  return {
    ...verdict,
    enabled: config.enabled,
    intervalMinutes: config.intervalMinutes,
    newestArchive: archive,
    archiveCount,
    listingError: error,
    lastVerifiedAt,
  };
}

// ── Alert delivery record ───────────────────────────────────────────────────
// An alert that could not be delivered is itself a failure an admin has to
// see. The old code wrote that to the server log, which is exactly where
// nobody was looking.

export type BackupAlertChannel = "in_app" | "email";
export type BackupAlertOutcome = "delivered" | "failed";

export interface BackupAlertAttempt {
  at: string;
  channel: BackupAlertChannel;
  outcome: BackupAlertOutcome;
  /** How many admins the attempt was aimed at. */
  recipients: number;
  /** Which watchdog raised it. */
  source: string;
  /** Failure reason, when it failed. */
  detail: string | null;
}

const BACKUP_ALERT_LOG_MAX = 20;

export async function getBackupAlertDeliveryLog(): Promise<BackupAlertAttempt[]> {
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_BACKUP_ALERT_DELIVERY_LOG))
      .limit(1);
    const raw = rows[0]?.value ?? null;
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is BackupAlertAttempt =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as BackupAlertAttempt).at === "string" &&
        typeof (entry as BackupAlertAttempt).channel === "string" &&
        typeof (entry as BackupAlertAttempt).outcome === "string",
    );
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] Could not read the backup alert delivery log",
    );
    return [];
  }
}

/** Newest-first log; append one attempt and keep the tail bounded. */
export async function recordBackupAlertAttempt(
  attempt: Omit<BackupAlertAttempt, "at"> & { at?: string },
): Promise<void> {
  const entry: BackupAlertAttempt = {
    at: attempt.at ?? new Date().toISOString(),
    channel: attempt.channel,
    outcome: attempt.outcome,
    recipients: attempt.recipients,
    source: attempt.source,
    detail: attempt.detail,
  };
  try {
    const existing = await getBackupAlertDeliveryLog();
    await writeSystemSetting(
      SETTING_BACKUP_ALERT_DELIVERY_LOG,
      JSON.stringify([entry, ...existing].slice(0, BACKUP_ALERT_LOG_MAX)),
    );
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] Could not record the backup alert attempt",
    );
  }
}

/**
 * The newest alert attempt still sitting unresolved, or null when every
 * channel's latest attempt reached somebody.
 *
 * Resolution is per channel: only a later *email* clears a failed email, and
 * only a later in-app notification clears a failed in-app one. Letting either
 * channel clear the other hides the case this record exists for — an email
 * that bounced, then an in-app notification that worked, with the email rate
 * limit holding off another send for hours.
 */
export function findUndeliveredBackupAlert(
  log: BackupAlertAttempt[],
): BackupAlertAttempt | null {
  const decided = new Set<BackupAlertChannel>();
  for (const entry of log) {
    // The log is newest-first, so the first entry seen for a channel is that
    // channel's current state and older ones for it no longer matter.
    if (decided.has(entry.channel)) continue;
    decided.add(entry.channel);
    if (entry.outcome === "failed") return entry;
  }
  return null;
}

export async function getUndeliveredBackupAlert(): Promise<BackupAlertAttempt | null> {
  return findUndeliveredBackupAlert(await getBackupAlertDeliveryLog());
}

/**
 * Admin addresses for the off-site alarm. Unlike routine backup mail, this
 * list is not filtered by the backup-alert preference — see the call site.
 */
async function getOffsiteAlarmEmails(): Promise<string[]> {
  try {
    const rows = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.userType, "lab")));
    return Array.from(
      new Set(
        rows
          .map((r) => r.email?.trim().toLowerCase())
          .filter((e): e is string => Boolean(e)),
      ),
    );
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] Could not load admin emails for the off-site backup alert",
    );
    return [];
  }
}

/** Lab admins who should see an in-app alarm when protection lapses. */
async function getLabAdminUserIds(): Promise<string[]> {
  try {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.userType, "lab")));
    return rows.map((r) => r.id);
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] Could not load lab admins for the off-site backup alert",
    );
    return [];
  }
}

/**
 * Raise the alarm that off-site protection is not working.
 *
 * In-app first: the previous design alerted by email only, after seven days,
 * and the outage still went unnoticed for eighteen. A notification appears in
 * the app the owner already has open. Notifications are deduplicated per hour
 * so a continuing outage reminds without flooding, and the email repeats at
 * most every six hours.
 */
export interface OffsiteAlarmOptions {
  /** Send mail as well as the in-app alert (a lapse, not a single blip). */
  email?: boolean;
  /** Which watchdog raised this, recorded against every alert attempt. */
  source?: string;
  /**
   * Rate-limit row for the email. The out-of-process check owns its own row
   * so an alert claimed by the API process cannot silence the watchdog that
   * exists precisely for when that process is gone.
   */
  emailRateLimitKey?: string;
  emailRateLimitMs?: number;
}

/**
 * Tell admins, in the app and by email, that an alert of ours could not be
 * delivered. Deduplicated per hour like the alarm itself.
 */
async function notifyAlertUndeliverable(
  channel: BackupAlertChannel,
  detail: string,
  adminIds: string[],
): Promise<void> {
  const hourBucket = new Date().toISOString().slice(0, 13);
  for (const userId of adminIds) {
    try {
      await db
        .insert(notifications)
        .values({
          userId,
          type: "backup_alert_undeliverable",
          title: "A backup alert could not be delivered",
          body:
            `LabTrax tried to alert you that off-site backups are not running and the ` +
            `${channel === "email" ? "email" : "in-app"} alert failed: ${detail} ` +
            "Check the backup alert settings — until this is fixed, a backup outage may go unreported.",
          dataJson: { channel, detail },
          dedupeKey: `backup_alert_undeliverable:${userId}:${hourBucket}`,
        })
        .onConflictDoNothing();
    } catch (err: unknown) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "[backup] Could not create the undeliverable-alert notification",
      );
    }
  }
}

async function raiseOffsiteBackupAlarm(
  reason: string,
  lastVerifiedAt: string | null,
  options: OffsiteAlarmOptions = {},
): Promise<void> {
  const shouldEmail = options.email ?? false;
  const source = options.source ?? "offsite-watchdog";
  const rateLimitKey = options.emailRateLimitKey ?? SETTING_BACKUP_OFFSITE_ALERT_LAST_SENT_AT;
  const rateLimitMs = options.emailRateLimitMs ?? OFFSITE_ALERT_EMAIL_RATE_LIMIT_MS;
  const body =
    `${reason} ` +
    (lastVerifiedAt
      ? `The last verified off-site copy is from ${new Date(lastVerifiedAt).toUTCString()}.`
      : "There is no verified off-site copy on record.") +
    " Until this is fixed, recent work is not protected against losing this server.";

  logger.error({ reason, lastVerifiedAt, source }, "[backup] OFF-SITE BACKUP PROTECTION IS NOT WORKING");

  const hourBucket = new Date().toISOString().slice(0, 13);
  const adminIds = await getLabAdminUserIds();
  let inserted = 0;
  let inAppError: string | null = null;
  for (const userId of adminIds) {
    try {
      const result = await db
        .insert(notifications)
        .values({
          userId,
          type: "backup_offsite_failure",
          title: "Off-site backup is not running",
          body,
          dataJson: { lastVerifiedAt, reason, source },
          dedupeKey: `backup_offsite_failure:${userId}:${hourBucket}`,
        })
        .onConflictDoNothing();
      inserted += result.rowCount ?? 0;
    } catch (err: unknown) {
      inAppError = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err: inAppError },
        "[backup] Could not create the off-site backup notification",
      );
    }
  }
  if (adminIds.length === 0) {
    await recordBackupAlertAttempt({
      channel: "in_app",
      outcome: "failed",
      recipients: 0,
      source,
      detail: "No lab admin accounts were found to notify.",
    });
  } else if (inAppError !== null) {
    await recordBackupAlertAttempt({
      channel: "in_app",
      outcome: "failed",
      recipients: adminIds.length,
      source,
      detail: inAppError,
    });
  } else if (inserted > 0) {
    // Only when something new was written: a continuing outage re-raises the
    // alarm every few minutes and the hourly dedupe already absorbed it.
    await recordBackupAlertAttempt({
      channel: "in_app",
      outcome: "delivered",
      recipients: inserted,
      source,
      detail: null,
    });
  }

  // Email only for a confirmed lapse in protection, not for a single failed
  // tick: at a fifteen-minute cadence a transient blip would otherwise become
  // mail that people learn to ignore.
  if (!shouldEmail) return;

  // Email, rate-limited across instances by a compare-and-swap on the setting.
  let adminEmails: string[] = [];
  // Held so an alert that never reached anybody can give the claim back
  // instead of buying the outage another six hours of silence.
  let claim: { value: string; previous: string | null } | null = null;
  try {
    const now = Date.now();
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, rateLimitKey));
    const lastSentRaw = rows[0]?.value ?? null;
    if (lastSentRaw !== null) {
      const lastSentMs = new Date(lastSentRaw).getTime();
      if (Number.isFinite(lastSentMs) && now - lastSentMs < rateLimitMs) {
        return;
      }
    }

    const claimValue = new Date(now).toISOString();
    let claimed: boolean;
    if (lastSentRaw === null) {
      const insertedClaim = await db
        .insert(systemSettings)
        .values({ key: rateLimitKey, value: claimValue })
        .onConflictDoNothing();
      claimed = (insertedClaim.rowCount ?? 0) > 0;
    } else {
      const updated = await db
        .update(systemSettings)
        .set({ value: claimValue, updatedAt: new Date(now) })
        .where(
          sql`${systemSettings.key} = ${rateLimitKey} AND ${systemSettings.value} = ${lastSentRaw}`,
        );
      claimed = (updated.rowCount ?? 0) > 0;
    }
    if (!claimed) return;
    claim = { value: claimValue, previous: lastSentRaw };

    // Deliberately NOT filtered by the "backupAlerts" preference. That
    // opt-out exists for routine backup chatter, which defaults to off — and
    // with it off, nothing at all reached the lab owner for eighteen days.
    // This mail only goes out when protection has actually lapsed, at most
    // once every six hours.
    adminEmails = await getOffsiteAlarmEmails();
    if (adminEmails.length === 0) {
      await recordBackupAlertAttempt({
        channel: "email",
        outcome: "failed",
        recipients: 0,
        source,
        detail: "No lab admin email addresses are on record.",
      });
      await notifyAlertUndeliverable(
        "email",
        "no lab admin email addresses are on record.",
        adminIds,
      );
      return;
    }
    const delivery = await sendBackupNotificationEmail({
      adminEmails,
      triggeredBy: "scheduler:offsite",
      success: false,
      errorMessage: body,
      failedAt: new Date(now).toISOString(),
      destination: "onedrive",
    });
    // The mailer reports a refused or skipped send by returning, not by
    // throwing: unconfigured SMTP, a rejected recipient, a reserved domain.
    // Treating "it came back" as "it arrived" is how an alarm goes quiet
    // while its rate limit keeps the next six hours silent too.
    const sent = delivery?.sent ?? adminEmails.length;
    const failureNote = delivery ? describeBackupEmailFailures(delivery) : "";
    if (sent === 0) {
      const detail = failureNote || "The mail server did not accept the alert.";
      logger.error({ detail, source }, "[backup] Off-site backup alert email was not delivered");
      await recordBackupAlertAttempt({
        channel: "email",
        outcome: "failed",
        recipients: adminEmails.length,
        source,
        detail,
      });
      await notifyAlertUndeliverable("email", detail, adminIds);
      // Nothing went out, so this attempt must not hold the rate limit shut.
      await releaseAlertEmailRateLimit(rateLimitKey, claim.value, claim.previous);
      return;
    }
    await recordBackupAlertAttempt({
      channel: "email",
      outcome: "delivered",
      recipients: sent,
      source,
      // A send that reached some but not all admins is still worth naming.
      detail: failureNote || null,
    });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error({ err: detail }, "[backup] Off-site backup alert email failed");
    await recordBackupAlertAttempt({
      channel: "email",
      outcome: "failed",
      recipients: adminEmails.length,
      source,
      detail,
    });
    await notifyAlertUndeliverable("email", detail, adminIds);
    if (claim) {
      await releaseAlertEmailRateLimit(rateLimitKey, claim.value, claim.previous);
    }
  }
}

/**
 * Hand back a rate-limit claim when the alert it covered never went out.
 *
 * The claim is taken before sending so two instances cannot both mail. If the
 * send then reaches nobody, holding the claim would buy the outage six more
 * hours of silence, so the row goes back to what it was — and only if this
 * run still owns it.
 */
async function releaseAlertEmailRateLimit(
  key: string,
  claimValue: string,
  previous: string | null,
): Promise<void> {
  try {
    if (previous === null) {
      await db
        .delete(systemSettings)
        .where(
          sql`${systemSettings.key} = ${key} AND ${systemSettings.value} = ${claimValue}`,
        );
      return;
    }
    await db
      .update(systemSettings)
      .set({ value: previous })
      .where(
        sql`${systemSettings.key} = ${key} AND ${systemSettings.value} = ${claimValue}`,
      );
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), key },
      "[backup] Could not release the backup alert rate limit after an undelivered alert",
    );
  }
}

/** Protection is healthy again — let the next outage alert immediately. */
async function clearOffsiteBackupAlarmState(): Promise<void> {
  try {
    await db
      .delete(systemSettings)
      .where(
        sql`${systemSettings.key} in (${SETTING_BACKUP_OFFSITE_ALERT_LAST_SENT_AT}, ${SETTING_BACKUP_FRESHNESS_ALERT_LAST_SENT_AT})`,
      );
  } catch {
    /* non-fatal */
  }
}

/**
 * A healthy verdict is based on a recent complete archive matched to the
 * configured destination listing. Only then retire active in-app offsite
 * failure notifications and reset the alarm rate limits.
 */
export async function reconcileOffsiteBackupAlerts(
  freshness: OffsiteFreshness,
): Promise<void> {
  if (!freshness.enabled || freshness.stale) return;

  await clearOffsiteBackupAlarmState();
  try {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.type, "backup_offsite_failure"),
          isNull(notifications.readAt),
        ),
      );
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] Could not resolve active off-site backup notifications",
    );
  }
}

/**
 * Run one off-site backup. Never throws: a failure is recorded by runBackup
 * and alerted here, because the caller is a timer with nowhere to report to.
 */
async function runOffsiteBackupAttempt(
  trigger: "interval" | "startup" | "manual" | "catchup",
  intervalMinutes: number,
  archiveKind: BackupArchiveKind,
  timeoutMs: number,
  slot: BackupSlot,
): Promise<void> {
  const label = "scheduler:offsite";
  const deadline = createBackupDeadline(timeoutMs);
  _scheduledBackupDeadlineMs = timeoutMs;

  try {
    logger.info(
      {
        trigger,
        intervalMinutes,
        archiveKind,
        timeoutMs,
        databaseOnlyFallback: slot === null,
      },
      "[backup] Off-site backup starting",
    );
    const result = await runBackup(label, "onedrive", undefined, { archiveKind, deadline });
    logger.info(
      {
        fileName: result.fileName,
        size: result.size,
        archiveKind: result.archiveKind ?? archiveKind,
        partialFailure: result.partialFailure ?? false,
      },
      result.partialFailure ? "[backup] OneDrive archive saved with missing-file warnings; full recovery remains unverified"
        : "[backup] Off-site backup verified in OneDrive",
    );
    // No success email: at this cadence it would be 96 messages a day, and
    // mail people learn to ignore is worse than no mail. Silence means
    // healthy; the watchdog below is what breaks the silence.
    if (result.partialFailure) {
      await raiseOffsiteBackupAlarm(result.warnings ?? "The archive is partial; complete off-site recovery is still unverified.",
        await getLastVerifiedOffsiteBackupAt());
    } else {
      try {
        await reconcileOffsiteBackupAlerts(await getOffsiteFreshness());
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "[backup] Could not reconcile off-site backup alerts after a successful run",
        );
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await raiseOffsiteBackupAlarm(
      `The off-site backup to OneDrive failed: ${errMsg}`,
      await getLastVerifiedOffsiteBackupAt(),
    );
  } finally {
    deadline.dispose();
    releaseBackupSlot(slot);
  }
}

export async function fireOffsiteBackup(
  trigger: "interval" | "startup" | "manual" | "catchup" = "interval",
): Promise<void> {
  let config: OffsiteBackupConfig;
  try { config = await getOffsiteBackupConfig(); }
  catch (error) {
    logger.error({ err: safeBackupError(error) }, "[backup] Could not read the selected backup destination; no provider work started.");
    return;
  }
  if (!config.enabled) {
    logger.info("[backup] Off-site backup protection is switched off; skipping");
    return;
  }

  const connectorAvailable = config.destination === "google-drive" ? isGoogleDriveConnectorAvailable() : isOneDriveConnectorAvailable();
  if (!connectorAvailable) {
    await raiseOffsiteBackupAlarm(
      `This server cannot reach ${config.destination === "google-drive" ? "Google Drive" : "OneDrive"} (the integration is not available to it).`,
      await getLastVerifiedOffsiteBackupAt(),
    );
    return;
  }

  const label = "scheduler:offsite";
  const archiveKind = await decideScheduledArchiveKind(config.destination, config.intervalMinutes);
  const timeoutMs = await getBackupRunTimeoutMs(archiveKind);
  const slot = claimBackupSlot(label, archiveKind);
  if (slot === null) {
    if (isProductionDeployment()) {
      logger.info("[backup] Production records/media interval skipped/busy; an existing backup remains undisturbed.");
      if (trigger !== "catchup") {
        await noteDatabaseProtectionBusy().catch(() => logger.warn("[backup] Could not persist the skipped database interval."));
      }
      return;
    }
    const reason = "Missed required complete recovery point: another backup is still running. " +
      "No database-only fallback was taken. Check backup duration, disk capacity and destination connectivity.";
    await recordBackupError(label, "onedrive", undefined, reason);
    await raiseOffsiteBackupAlarm(reason, await getLastVerifiedOffsiteBackupAt());
    return;
  }
  if (slot.stolenAfterMs !== null) {
    await raiseOffsiteBackupAlarm(
      `A backup started ${Math.round(slot.stolenAfterMs / 60_000)} minutes ago and never finished, ` +
        "so scheduled backups had stopped running.",
      await getLastVerifiedOffsiteBackupAt(),
    );
  }

  // This is the job that actually produces production's archives, so it gets
  // the same budget, guard expiry, and archive-kind decision as the editable
  // interval schedule. Without the deadline the slot would expire against the
  // 90-minute fallback, and without the kind decision every fifteen-minute
  // tick would upload a full media archive.
  if (isProductionDeployment()) {
    const deadline = createBackupDeadline(timeoutMs);
    let captured: CompleteBackupCaptured<true> | undefined;
    try {
      const status = await runDatabaseProtectionJob({
        trigger,
        destination: config.destination === "google-drive" ? "google-drive" : "onedrive",
        intervalMinutes: config.intervalMinutes,
        codec: { encrypt: encryptBuffer, decrypt: decryptBuffer },
        capture: async (snapshot, previousJournalPosition, onMediaPinned, previousRecords) => {
          captured = await captureCompleteBackup(getUploadsRoot(),
            snapshotToken => buildPgDumpStream(deadline, snapshotToken, 64 * 1024 * 1024, "custom"),
            deadline.signal, {
              archiveDestination: "direct", allowMissingReferences: true, productionDataOnly: true,
              productionJournalAfterPosition: previousJournalPosition,
              snapshot,
              onMediaPinned,
              streamDatabaseDump: true,
              records: { previous: previousRecords ?? null, schemaSql: async snapshotToken => {
                const parts: Buffer[] = [];
                for await (const bytes of buildPgDumpStream(deadline, snapshotToken, 64 * 1024 * 1024, "plain")) parts.push(bytes);
                return Buffer.concat(parts).toString("utf8");
              } },
            });
          if (!captured.recordCapture) throw new Error("Production record capture evidence is missing.");
          return {kind: RECORD_DELTA_FORMAT, records: captured.recordCapture,
            schemaDump: captured.recordCapture.delta ? null : captured.pgDump};
        },
        captureMedia: async (write, selectPaths) => {
          if (!captured) throw new Error("Production snapshot inventory was not captured.");
          return captureProductionMedia(captured, write, selectPaths);
        },
        signal: deadline.signal,
      });
      if (status.state === "failed") {
        await raiseOffsiteBackupAlarm(`Production records/media protection failed: ${status.error}`, status.lastVerifiedAt);
      } else if (status.state === "verified") {
        await reconcileOffsiteBackupAlerts(await getOffsiteFreshness());
      } else if (status.state === "partial") {
        await raiseOffsiteBackupAlarm(
          `Production recovery point is partial: ${status.missingFiles} original files remain unavailable. ` +
            "The partial point is retained, but complete-recovery freshness was not advanced.",
          status.lastVerifiedAt,
        );
      }
    } catch (error) {
      await raiseOffsiteBackupAlarm(`Production records/media protection could not run: ${safeBackupError(error)}`,
        (await getDatabaseProtectionStatus()).lastVerifiedAt);
    } finally {
      try { await captured?.dispose?.(); }
      finally { deadline.dispose(); releaseBackupSlot(slot); }
    }
    return;
  }
  await runOffsiteBackupAttempt(trigger, config.intervalMinutes, archiveKind, timeoutMs, slot);
}

export interface OffsiteProtectionStatus extends OffsiteBackupConfig {
  /** True when this process has the off-site timers armed right now. */
  running: boolean;
  lastVerifiedAt: string | null;
  databaseProtection?: DatabaseProtectionStatus;
}

/**
 * What off-site protection is doing on this server, as opposed to what the
 * editable schedule row says. The two can disagree — protection runs at its
 * own cadence on the deployed server even when the editable schedule is
 * hourly or paused — so anything reporting "the server's cadence" to an admin
 * has to read this, not the settings row.
 */
export async function getOffsiteProtectionStatus(): Promise<OffsiteProtectionStatus> {
  const [config, lastVerifiedAt] = await Promise.all([
    getOffsiteBackupConfig(),
    getLastVerifiedOffsiteBackupAt(),
  ]);
  if (isProductionDeployment()) {
    const databaseProtection = await getDatabaseProtectionStatus();
    return { ...config, running: _offsiteIntervalTimer !== null,
      // Preserve the legacy full-media watermark. Database-only proof lives in
      // its explicitly scoped child and must not clear full-recovery warnings.
      lastVerifiedAt: await getLastVerifiedOffsiteBackupAt(), databaseProtection };
  }
  return { ...config, running: _offsiteIntervalTimer !== null, lastVerifiedAt };
}

/**
 * Watchdog. The backup job alerts when a run fails; this alerts when runs
 * stop happening at all — a wedged process, a timer that was never started,
 * a deploy that silently dropped the schedule. That is the failure mode that
 * actually cost eighteen days, and it is invisible from inside the job.
 */
export async function checkOffsiteBackupProtection(): Promise<void> {
  try {
    // Each protection job authenticates every remote dependency before committing.
    // Do not launch a second full-media verifier every five minutes: on a large
    // baseline it would hold the protection lease for hours and starve capture.
    // Freshness below uses the recorded read-back time, never a refreshed timestamp.
    const freshness = await getOffsiteFreshness();
    if (!freshness.enabled) return;
    if (!freshness.stale) {
      await reconcileOffsiteBackupAlerts(freshness);
      return;
    }

    await raiseOffsiteBackupAlarm(
      freshness.reason ?? "Off-site backup protection has stopped working.",
      freshness.newestArchive?.createdAt ?? freshness.lastVerifiedAt,
      // Protection has genuinely lapsed, not just one tick — email too.
      { email: true, source: "offsite-watchdog" },
    );
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] Off-site backup watchdog failed",
    );
  }
}

/**
 * The same freshness question, asked from outside the API process.
 *
 * Run on a schedule that does not depend on this app being alive (a Replit
 * Scheduled Deployment invoking `check-backup-freshness`), this is the only
 * check that still fires when the API is dead, crash-looping, or never
 * reached a tick — the exact condition that went unreported for eighteen
 * days. It reads the newest archive straight out of the OneDrive folder and
 * keeps its own rate-limit row so a long outage alerts without flooding.
 */
export interface BackupFreshnessCheckResult {
  /** True when a recent enough archive is confirmed present off-site. */
  ok: boolean;
  /** False when protection is switched off, so "ok" is not a claim. */
  enabled: boolean;
  freshness: OffsiteFreshness;
  alerted: boolean;
  /** An alert was due but a recent one already went out. */
  alertSuppressed: boolean;
  /** Set when raising the alarm itself failed. */
  alertError: string | null;
}

export async function runBackupFreshnessCheck(
  now: Date = new Date(),
): Promise<BackupFreshnessCheckResult> {
  const freshness = await getOffsiteFreshness(now);
  const base = { freshness, alerted: false, alertSuppressed: false, alertError: null };

  if (!freshness.enabled) {
    return { ...base, ok: false, enabled: false };
  }
  if (!freshness.stale) {
    await reconcileOffsiteBackupAlerts(freshness);
    return { ...base, ok: true, enabled: true };
  }

  const beforeLog = await getBackupAlertDeliveryLog();
  const previousAt = beforeLog[0]?.at ?? null;
  try {
    await raiseOffsiteBackupAlarm(
      freshness.reason ?? "Off-site backup protection has stopped working.",
      freshness.newestArchive?.createdAt ?? freshness.lastVerifiedAt,
      {
        email: true,
        source: "freshness-check",
        emailRateLimitKey: SETTING_BACKUP_FRESHNESS_ALERT_LAST_SENT_AT,
      },
    );
  } catch (err: unknown) {
    return {
      ...base,
      ok: false,
      enabled: true,
      alertError: err instanceof Error ? err.message : String(err),
    };
  }

  const afterLog = await getBackupAlertDeliveryLog();
  const latest = afterLog[0] ?? null;
  const raisedSomething = latest !== null && latest.at !== previousAt;
  const undelivered = findUndeliveredBackupAlert(afterLog);
  return {
    freshness,
    ok: false,
    enabled: true,
    alerted: raisedSomething && undelivered === null,
    alertSuppressed: !raisedSomething,
    alertError: undelivered ? (undelivered.detail ?? "An alert could not be delivered.") : null,
  };
}

/**
 * Start off-site protection: the recurring upload, the watchdog, and a
 * catch-up run when the process has been down long enough to miss a tick.
 */
export function startOffsiteBackupProtection(reschedule = false): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  // Only the deployed production server protects the lab's data. A workspace
  // server runs against development data: uploading it every fifteen minutes
  // would fill the lab's OneDrive with archives that look real but restore a
  // developer's database, and its retention pass would prune the real ones.
  if (!isProductionDeployment()) {
    logger.info(
      "[backup] Off-site backup protection is production-only; not scheduling it in this environment",
    );
    return;
  }
  if (reschedule) {
    // Replace future ticks only. A running capture/upload retains its selected
    // provider and deadline and is never cancelled by a settings edit.
    if (_offsiteIntervalTimer !== null) clearTimeout(_offsiteIntervalTimer);
    if (_offsiteMonitorTimer !== null) clearInterval(_offsiteMonitorTimer);
    if (_offsiteCatchupTimer !== null) clearInterval(_offsiteCatchupTimer);
    _offsiteIntervalTimer = _offsiteMonitorTimer = _offsiteCatchupTimer = null;
  }
  // Already protecting: leave the running timers alone. Restarting them on
  // every schedule edit would push the next off-site copy out by a full
  // interval each time.
  if (_offsiteIntervalTimer !== null || _offsiteMonitorTimer !== null || _offsiteCatchupTimer !== null) return;
  const generation = ++_offsiteTimerGeneration;

  void (async () => {
    const config = await getOffsiteBackupConfig();
    if (generation !== _offsiteTimerGeneration) return;
    if (!config.enabled) {
      logger.warn("[backup] Off-site backup protection is DISABLED by configuration");
      return;
    }

    const lastVerifiedAt = isProductionDeployment()
      ? (await getDatabaseProtectionStatus()).recoveryPointAt : await getLastVerifiedOffsiteBackupAt();
    // Recheck after asynchronous initialization in case another caller won.
    if (generation !== _offsiteTimerGeneration || _offsiteIntervalTimer !== null || _offsiteMonitorTimer !== null || _offsiteCatchupTimer !== null) return;
    const firstDelayMs = offsiteFirstTickDelayMs(
      Date.now(), lastVerifiedAt, config.intervalMinutes,
    );
    _offsiteIntervalTimer = setTimeout(() => {
      _offsiteIntervalTimer = setInterval(
        () => { void fireOffsiteBackup("interval"); },
        config.intervalMinutes * 60 * 1000,
      );
      void fireOffsiteBackup("interval");
    }, firstDelayMs);
    _offsiteMonitorTimer = setInterval(
      () => { void checkOffsiteBackupProtection(); },
      OFFSITE_MONITOR_INTERVAL_MS,
    );
    const drainCatchup = () => {
      if (generation !== _offsiteTimerGeneration) return;
      void hasPendingDatabaseProtectionCatchup()
        .then(pending => pending && generation === _offsiteTimerGeneration ? fireOffsiteBackup("catchup") : undefined)
        .catch(error => logger.warn(
          { err: safeBackupError(error) },
          "[backup] Could not poll persisted production catch-up state",
        ));
    };
    _offsiteCatchupTimer = setInterval(drainCatchup, OFFSITE_CATCHUP_POLL_INTERVAL_MS);
    // Pending work survives process restart; don't wait for another full
    // fifteen-minute cadence before making the single coalesced catch-up.
    setTimeout(drainCatchup, 1_000);
    logger.info(
      { intervalMinutes: config.intervalMinutes, firstDelayMs, destination: config.destination },
      "[backup] Off-site backup protection started",
    );

    // setInterval only counts time this process was alive. After a restart or
    // deploy the clock starts over, so without this a redeploy every few
    // minutes could postpone the backup indefinitely.
    setTimeout(() => {
      if (generation !== _offsiteTimerGeneration) return;
      void (async () => {
        const lastVerifiedAt = isProductionDeployment()
          ? (await getDatabaseProtectionStatus()).recoveryPointAt : await getLastVerifiedOffsiteBackupAt();
        const ageMinutes =
          lastVerifiedAt === null
            ? Number.POSITIVE_INFINITY
            : (Date.now() - new Date(lastVerifiedAt).getTime()) / 60_000;
        if (generation !== _offsiteTimerGeneration) return;
        if (generation !== _offsiteTimerGeneration) return;
        if (ageMinutes >= config.intervalMinutes) {
          logger.info(
            { lastVerifiedAt },
            "[backup] No recent verified off-site backup at startup; running one now",
          );
          await fireOffsiteBackup("startup");
        }
        await checkOffsiteBackupProtection();
      })().catch(error => logger.error({ err: safeBackupError(error) }, "[backup] Startup protection check failed; recurring ticks remain armed."));
    }, OFFSITE_STARTUP_DELAY_MS);
  })().catch(error => {
    logger.error({ err: safeBackupError(error) }, "[backup] Protection timer setup could not read its configuration; retrying configuration later.");
    if (generation !== _offsiteTimerGeneration) return;
    _offsiteIntervalTimer = setTimeout(() => {
      _offsiteIntervalTimer = null;
      startOffsiteBackupProtection();
    }, 60_000);
  });
}


/**
 * What a backup archive contains.
 *
 * - "full": database dump + case media + profile photos. The only archive a
 *   restore may be performed from.
 * - "database-only": database dump alone. Cheap enough to upload every 15
 *   minutes; restoring one would silently replace the media tree with nothing,
 *   so the restore pipeline refuses it.
 */
export type BackupArchiveKind = "full" | "database-only" | "complete-production" | "complete-non-production" | "partial-production" | "partial-non-production";

/** Overall budget for one scheduled run, in milliseconds. */
export async function getBackupRunTimeoutMs(archiveKind: BackupArchiveKind = "full"): Promise<number> {
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_BACKUP_RUN_TIMEOUT_MINUTES))
      .limit(1);
    const raw = rows[0]?.value ?? null;
    if (raw !== null) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 1) return parsed * 60_000;
    }
  } catch {
    // fall through to the env/default budget
  }
  const envRaw = Number.parseInt(process.env.BACKUP_RUN_TIMEOUT_MINUTES ?? "", 10);
  if (Number.isFinite(envRaw) && envRaw >= 1) return envRaw * 60_000;
  return (archiveKind !== "database-only" ? DEFAULT_FULL_BACKUP_RUN_TIMEOUT_MINUTES : DEFAULT_BACKUP_RUN_TIMEOUT_MINUTES) * 60_000;
}

/** Overall wall-clock budget for one scheduled run (dump + archive + upload). */
export const SETTING_BACKUP_RUN_TIMEOUT_MINUTES = "backup_run_timeout_minutes";

/**
 * Next wall-clock slot boundary at or after `fromMs`.
 *
 * Slots are anchored to the Unix epoch, not to process start. An interval
 * timer armed at startup drifts by however long the process has been up, so a
 * server that restarts frequently kept pushing the next run further out; slot
 * anchoring makes the due time a property of the clock instead.
 */
export function nextScheduleSlotMs(fromMs: number, intervalMinutes: number): number {
  const intervalMs = Math.max(1, Math.round(intervalMinutes)) * 60_000;
  return (Math.floor(fromMs / intervalMs) + 1) * intervalMs;
}

/**
 * Pick the archive kind for this run.
 *
 * A full archive (database + media) is ~591 MB and takes about a minute; 96 a
 * day is not a sensible upload volume. The fast cadence therefore takes a
 * database-only archive, and a full archive is taken whenever one is due on
 * the slower cadence. Destinations other than OneDrive keep their existing
 * behaviour of always taking a full archive.
 */
export async function decideScheduledArchiveKind(
  destination: BackupDestination,
  intervalMinutes: number | null,
  now: Date = new Date(),
): Promise<BackupArchiveKind> {
  return "full";
}

export const FULL_ARCHIVE_FILENAME_MARKER = "full";

/** Remember when the most recent media-bearing archive completed. */
async function recordLastFullArchiveAt(at: Date): Promise<void> {
  await writeSystemSetting(SETTING_BACKUP_LAST_FULL_ARCHIVE_AT, at.toISOString());
}

export async function getBackupScheduleState(): Promise<BackupScheduleState> {
  const [nextDueAt, lastAttemptAt] = await Promise.all([
    readSystemSettingDate(SETTING_BACKUP_SCHEDULE_NEXT_DUE_AT),
    readSystemSettingDate(SETTING_BACKUP_SCHEDULE_LAST_ATTEMPT_AT),
  ]);
  return { nextDueAt, lastAttemptAt };
}

export function createBackupDeadline(timeoutMs: number, cancellationSignal?: AbortSignal): BackupDeadline {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const onCancel = () => {
    cancelled = true;
    controller.abort();
  };
  if (cancellationSignal?.aborted) onCancel();
  else cancellationSignal?.addEventListener("abort", onCancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // The HTTP server keeps the loop alive in production; an un-unref'd timer
  // would keep short-lived processes (tests, scripts) running for the budget.
  timer.unref?.();
  const minutes = Math.round((timeoutMs / 60_000) * 10) / 10;
  return {
    signal: controller.signal,
    timeoutMs,
    expired: () => timedOut,
    cancelled: () => cancelled,
    throwIfExpired(stage: string) {
      if (cancelled) throw new BackupCancelledError();
      if (!timedOut) return;
      throw new BackupTimeoutError(
        `Backup timed out after ${minutes} minute(s) during ${stage}. ` +
          "The run was aborted so later scheduled runs are not blocked.",
      );
    },
    dispose() {
      clearTimeout(timer);
      cancellationSignal?.removeEventListener("abort", onCancel);
    },
  };
}

export interface BackupScheduleState {
  nextDueAt: Date | null;
  lastAttemptAt: Date | null;
}

/** Test-only: clear the in-flight guard and any armed timer. */
export function _resetBackupSchedulerForTests(): void {
  if (_scheduledIntervalTimer !== null) {
    clearTimeout(_scheduledIntervalTimer);
    _scheduledIntervalTimer = null;
  }
  _schedulerGeneration += 1;
  // Clearing the timestamps alone is not enough: claimBackupSlot blocks on the
  // in-flight flag, and with no start time it can never decide the holder is
  // stale — every later claim would return null. Bumping the token also makes
  // any slot handed out before the reset unable to release the new state.
  _scheduledBackupInFlight = false;
  _scheduledBackupStartedAtMs = null;
  _scheduledBackupDeadlineMs = 0;
  _scheduledBackupArchiveKind = null;
  _backupSlotToken += 1;
}

export const SETTING_BACKUP_FULL_ARCHIVE_INTERVAL_MINUTES =
  "backup_full_archive_interval_minutes";

/** Grace period beyond a run's deadline before its guard is considered stale. */
export const IN_FLIGHT_GUARD_GRACE_MS = 60_000;

export const SETTING_ONEDRIVE_RETENTION_HOURLY_FULL_DAYS =
  "onedrive_backup_retention_hourly_full_days";

export const DEFAULT_BACKUP_FULL_ARCHIVE_INTERVAL_MINUTES = 60;

/** How often a media-bearing archive should be taken, in minutes. */
export async function getFullArchiveIntervalMinutes(): Promise<number> {
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_BACKUP_FULL_ARCHIVE_INTERVAL_MINUTES))
      .limit(1);
    const raw = rows[0]?.value ?? null;
    if (raw !== null) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 1) return parsed;
    }
  } catch {
    // fall through to the default cadence
  }
  return DEFAULT_BACKUP_FULL_ARCHIVE_INTERVAL_MINUTES;
}

export const DATABASE_ONLY_FILENAME_MARKER = "db-only";

async function readSystemSettingDate(key: string): Promise<Date | null> {
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, key))
      .limit(1);
    const raw = rows[0]?.value ?? null;
    if (raw === null) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * Refuse to restore from a database-only archive.
 *
 * These are taken on the fast schedule and contain no media at all. Restoring
 * one would replace every case photo and profile photo with nothing while
 * reporting success, so it is rejected before the live database is touched.
 */
export function assertRestorableArchiveKind(
  manifest: Record<string, unknown>,
): void {
  if (manifestArchiveKind(manifest) !== "database-only") return;
  throw new Error(
    "This is a database-only backup: it contains the database but no case media or profile photos. " +
      "Restoring it would delete every media file. Choose a full backup (its name ends in " +
      `"-${FULL_ARCHIVE_FILENAME_MARKER}.zip.enc") instead.`,
  );
}

/**
 * Overall budget for a single run, shared by the dump, the archive assembly,
 * and the upload. Each stage aborts its own work when the signal fires, so a
 * wedged stage fails the run instead of pinning the in-flight guard forever.
 */
export interface BackupDeadline {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** True once the budget has been exhausted. */
  expired(): boolean;
  /** True when an authenticated user cancelled this run. */
  cancelled(): boolean;
  /** Throw a BackupTimeoutError naming `stage` if the budget is exhausted. */
  throwIfExpired(stage: string): void;
  /** Release the underlying timer. Safe to call more than once. */
  dispose(): void;
}

/**
 * Should a tick stand down because a previous run is still going?
 *
 * Only while that run is still within its own deadline (plus a grace period).
 * Past that it is wedged rather than slow, and suppressing every later run
 * forever is strictly worse than allowing a second attempt — the original
 * boolean flag had no expiry, so a crashed run silenced the schedule with no
 * error row to show for it.
 */
export function scheduledBackupGuardBlocks(
  startedAtMs: number | null,
  deadlineMs: number,
  nowMs: number,
): boolean {
  if (startedAtMs === null) return false;
  return nowMs - startedAtMs < deadlineMs + IN_FLIGHT_GUARD_GRACE_MS;
}

export const SETTING_ONEDRIVE_RETENTION_DAILY_FULL_DAYS =
  "onedrive_backup_retention_daily_full_days";

export const DEFAULT_BACKUP_RUN_TIMEOUT_MINUTES = 20;
// The production media set is about 36 GB. The measured archive transfer
// rate projects beyond an hour before the OneDrive upload even starts.
// Reserve a bounded six-hour window for archive creation and cloud transfer.
// Explicit operator budgets still win; stalled reads fail after 60 seconds.
export const DEFAULT_FULL_BACKUP_RUN_TIMEOUT_MINUTES = 360;

/**
 * When the last archive that included media was taken. Drives the slower full
 * archive cadence that runs alongside the fast database-only cadence.
 */
export const SETTING_BACKUP_LAST_FULL_ARCHIVE_AT = "backup_last_full_archive_at";

/** Replace the scheduler's destination runner in orchestration tests only. */
export function setScheduledBackupRunnerForTests(
  runner: typeof runBackup | null,
): void {
  _scheduledBackupRunnerForTests = runner;
}

/**
 * Upload a LabTrax-encrypted recovery archive through the managed Google Drive
 * connector. A run is not successful until Drive read-back confirms the exact
 * item identity, name, and size. Retention uses the same protected time tiers
 * and newest-complete-archive floor as OneDrive.
 */
export async function runGoogleDriveBackup(
  triggeredBy: string,
  options: {
    archiveKind?: BackupArchiveKind;
    deadline?: BackupDeadline;
    /** Isolated destination for restore-gate rehearsals; retention stays disabled there. */
    folderOverride?: { id: string; path: string };
  } = {},
): Promise<BackupRunResult> {
  const archiveKind: BackupArchiveKind = options.archiveKind ?? "full";
  const ownDeadline = !options.deadline ? createBackupDeadline(await getBackupRunTimeoutMs(archiveKind)) : undefined;
  const deadline = options.deadline ?? ownDeadline!;
  try {
  const connection = await getGoogleDriveStatus();
  if (!connection.connected) {
    throw new Error(
      connection.error ??
      "Google Drive is not connected. Reconnect it in the LabTrax hosting workspace before running backups.",
    );
  }

  const uploadAndVerify = async (
    archive: { fileName: string; size: number },
    isCompleteArchive: boolean,
    upload: () => Promise<GoogleDriveUploadResult>,
    getConfirmedBytes?: () => number,
  ): Promise<GoogleDriveUploadResult> => {
    if (archive.size < minPlausibleBackupBytes()) {
      throw new Error(
        `Backup aborted: the archive built for Google Drive was only ${archive.size} bytes, ` +
        `below the ${minPlausibleBackupBytes()}-byte minimum for a real backup.`,
      );
    }
    const uploaded = await measureBackupPhase(
      "Google Drive transfer",
      upload,
      () => ({
        archiveBytes: archive.size,
        ...(getConfirmedBytes ? { uploadedBytes: getConfirmedBytes(), uploadTotalBytes: archive.size } : {}),
      }),
      () => ({ uploadedBytes: archive.size, uploadTotalBytes: archive.size }),
    );
    await measureBackupPhase(
      "Google Drive verification",
      () => abortableBackupOperation(
        verifyGoogleDriveBackup(uploaded, archive.size, deadline?.signal),
        deadline?.signal,
      ),
      () => ({ archiveBytes: archive.size }),
    );
    try {
      if (options.folderOverride || (archiveKind !== "database-only" && !isCompleteArchive)) return uploaded;
      const pruned = await pruneGoogleDriveBackups(
        uploaded,
        isCompleteArchive,
      );
      if (pruned.length > 0) {
        logger.info(
          { prunedCount: pruned.length, pruned },
          "[backup] Google Drive retention: pruned old backups after upload",
        );
      }
    } catch (error: unknown) {
      // Retention follows a verified upload and must never turn that success
      // into a failed backup; failed pruning remains visible in the logs.
      logger.warn(
        { err: safeBackupError(error) },
        "[backup] Google Drive retention prune failed (non-fatal — backup succeeded)",
      );
    }
    return uploaded;
  };

  if (archiveKind !== "database-only") {
    const lock = await pool.connect();
    let claimed = false;
    try {
      claimed = (await lock.query<{ claimed: boolean }>(
        "SELECT pg_try_advisory_lock(5109, 15) AS claimed",
      )).rows[0]?.claimed === true;
      if (!claimed) {
        throw new Error(
          "Missed complete recovery point: another server instance is already capturing a full backup. " +
          "No database-only fallback was taken.",
        );
      }
      const archive = await prepareCompleteBackupArchive(triggeredBy, deadline, "cloud");
      // Drive also needs the final length before upload. Reuse the encrypted,
      // generation-pinned cloud stage instead of reserving a whole local copy.
      const stage = await measureBackupPhase("private cloud staging setup", () => createBackupCloudStage(
        archive.sourceEnvironment, deadline.timeoutMs, deadline.signal,
      ));
      try {
        const staged = await writeBackupArchiveToTarget(stage, archive.prepared, deadline);
        let confirmedBytes = 0;
        const uploaded = await uploadAndVerify(staged, !archive.partialFailure, () =>
          uploadGoogleDriveBackupSource({
            size: staged.size,
            readChunk: (offset, length) => {
              confirmedBytes = Math.max(confirmedBytes, offset);
              return stage.readChunk(offset, length);
            },
          }, staged.fileName, {
            signal: deadline.signal,
            ...(options.folderOverride ? { folderOverride: options.folderOverride } : {}),
          }),
          () => confirmedBytes);
        return {
          size: staged.size,
          completedAt: new Date().toISOString(),
          fileName: uploaded.name,
          remoteItemId: uploaded.id,
          archiveKind: archive.archiveKind,
          destination: "google-drive",
          path: googleDriveItemPath(uploaded.id),
          mediaFileCount: archive.mediaFileCount,
          attachmentRowCount: archive.attachmentRowCount,
          partialFailure: archive.partialFailure,
          warnings: archive.warnings,
        };
      } finally {
        await stage.cleanup();
      }
    } finally {
      if (claimed) await lock.query("SELECT pg_advisory_unlock(5109, 15)");
      lock.release();
    }
  }

  const uploadDirs = inspectUploadDirs();
  const [pgDump, counts] = await Promise.all([
    buildPgDumpBuffer(deadline),
    measureBackupPhase(
      "database manifest counts",
      () => abortableBackupOperation(buildManifestCounts(), deadline?.signal),
    ),
  ]);
  const archive = await assembleAndEncryptBackupToFile(
    triggeredBy,
    pgDump,
    counts,
    uploadDirs,
    {
      includeProfilePhotos: true,
      archiveKind,
      deadline,
      mediaDir: path.join(getUploadsRoot(), "case-media"),
    },
  );
  try {
    const uploaded = await uploadAndVerify(archive, false, () =>
      uploadGoogleDriveBackupFile(archive.filePath, archive.fileName, {
        signal: deadline.signal,
        ...(options.folderOverride ? { folderOverride: options.folderOverride } : {}),
      }));
    return {
      size: archive.size,
      completedAt: new Date().toISOString(),
      fileName: uploaded.name,
      remoteItemId: uploaded.id,
      archiveKind,
      destination: "google-drive",
      path: googleDriveItemPath(uploaded.id),
      mediaFileCount: 0,
      attachmentRowCount: counts.attachmentRowCount,
      partialFailure: false,
      warnings: null,
    };
  } finally {
    cleanupBackupTempFile(archive.filePath);
  }
  } finally {
    ownDeadline?.dispose();
  }
}

function runScheduledDestinationBackup(
  triggeredBy: string,
  destination: BackupDestination,
  destPath?: string,
  options?: { archiveKind?: BackupArchiveKind; deadline?: BackupDeadline },
): Promise<BackupRunResult> {
  return (_scheduledBackupRunnerForTests ?? runBackup)(
    triggeredBy,
    destination,
    destPath,
    options,
  );
}
