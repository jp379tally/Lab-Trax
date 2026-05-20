import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import archiver from "archiver";
import AdmZip from "adm-zip";
import { db } from "@workspace/db";
import { systemSettings, users, backupRuns } from "@workspace/db";
import { eq, lt, sql } from "drizzle-orm";
import { uploadToOneDrive } from "./onedrive";
import { logger } from "./logger";
import { sendBackupNotificationEmail, sendBackupStaleAlertEmail } from "./mail";

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

export interface BackupResult {
  fileName: string;
  size: number;
  webUrl: string;
  folder: string;
}

export interface BackupRunResult {
  size: number;
  completedAt: string;
  fileName: string;
  destination: BackupDestination;
  path?: string;
}

export type BackupDestination = "onedrive" | "local" | "network";

export const SETTING_BACKUP_HOUR_UTC = "backup_hour_utc";
export const SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES = "backup_schedule_interval_minutes";
export const SETTING_BACKUP_SCHEDULE_DESTINATION = "backup_schedule_destination";
export const SETTING_BACKUP_SCHEDULE_PATH = "backup_schedule_path";
export const SETTING_BACKUP_SCHEDULE_ENABLED = "backup_schedule_enabled";
export const SETTING_BACKUP_LAST_SUCCESSFUL_AT = "backup_last_successful_at";
export const SETTING_BACKUP_HISTORY_RETENTION_DAYS = "backup_history_retention_days";
export const SETTING_BACKUP_HISTORY_MAX_ROWS = "backup_history_max_rows";
export const SETTING_ROLLING_BACKUP_ENABLED = "rolling_backup_enabled";
export const SETTING_ROLLING_BACKUP_LAST_RUN_AT = "rolling_backup_last_run_at";
export const SETTING_ROLLING_BACKUP_LAST_ERROR = "rolling_backup_last_error";
export const SETTING_BACKUP_STALE_ALERT_LAST_SENT_AT = "backup_stale_alert_last_sent_at";
export const SETTING_BACKUP_STALE_ALERT_THRESHOLD_DAYS = "backup_stale_alert_threshold_days";
export const SETTING_BACKUP_STALE_ALERT_RATE_LIMIT_DAYS = "backup_stale_alert_rate_limit_days";
export const SETTING_BACKUP_STALE_DAYS = "backup_stale_days";
export const DEFAULT_BACKUP_STALE_DAYS = 7;

export const ALL_SCHEDULE_SETTINGS = [
  SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES,
  SETTING_BACKUP_SCHEDULE_DESTINATION,
  SETTING_BACKUP_SCHEDULE_PATH,
  SETTING_BACKUP_SCHEDULE_ENABLED,
] as const;

/**
 * Run pg_dump --format=custom against DATABASE_URL asynchronously.
 * Uses spawn (non-blocking) instead of spawnSync so the Node.js event loop
 * remains responsive to health-checks and API requests while pg_dump runs.
 * Throws if pg_dump exits non-zero or DATABASE_URL is not set.
 */
async function buildPgDumpBuffer(): Promise<Buffer> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set — cannot run pg_dump.");
  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawn("pg_dump", ["--format=custom", `--dbname=${dbUrl}`]);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("pg_dump timed out after 10 minutes."));
    }, 10 * 60 * 1000);

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
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
      clearTimeout(timer);
      reject(err);
    });
  });
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
function encryptBuffer(plaintext: Buffer): Buffer {
  const secret = process.env.BACKUP_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "Backup encryption requires BACKUP_ENCRYPTION_KEY (or JWT_SECRET) to be set. " +
      "Set one of these environment variables before running a backup.",
    );
  }
  const key = createHash("sha256").update(secret).digest(); // 32-byte key
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes
  const magic = Buffer.from("LTRX");
  return Buffer.concat([magic, iv, authTag, ciphertext]);
}

/**
 * Decrypt a buffer that was produced by encryptBuffer.
 *
 * Format: [4 bytes magic "LTRX"] [12 bytes IV] [16 bytes GCM auth-tag] [ciphertext]
 *
 * Throws if the magic bytes are wrong, the secret is missing, or decryption
 * fails (wrong key or corrupted ciphertext).
 */
export function decryptBuffer(encrypted: Buffer): Buffer {
  if (encrypted.length < 32) {
    throw new Error("File is too short to be a valid LabTrax backup.");
  }
  const magic = encrypted.slice(0, 4).toString("ascii");
  if (magic !== "LTRX") {
    throw new Error(
      `Invalid backup file: expected magic bytes 'LTRX', got '${magic}'. ` +
      "Make sure the file is a LabTrax .zip.enc backup.",
    );
  }
  const secret = process.env.BACKUP_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BACKUP_ENCRYPTION_KEY (or JWT_SECRET) is not set — cannot decrypt backup.",
    );
  }
  const key = createHash("sha256").update(secret).digest();
  const iv = encrypted.slice(4, 16);
  const authTag = encrypted.slice(16, 32);
  const ciphertext = encrypted.slice(32);
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

export function getRestoreState(): RestoreState {
  return { ..._restoreState };
}

function setRestorePhase(phase: RestorePhase, message?: string) {
  _restoreState = {
    ..._restoreState,
    phase,
    message: message ?? null,
  };
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
export async function executeRestore(
  encryptedBuffer: Buffer,
  triggeredBy: string,
): Promise<{ manifest: Record<string, unknown> }> {
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "labtrax-restore-"));
  try {
    // ── Step 1: decrypt ──────────────────────────────────────────────────────
    setRestorePhase("decrypting", "Decrypting backup…");
    let zipBuffer: Buffer;
    try {
      zipBuffer = decryptBuffer(encryptedBuffer);
    } catch (err: unknown) {
      throw err;
    }

    // ── Step 2: parse and validate manifest ──────────────────────────────────
    setRestorePhase("validating", "Validating manifest…");
    let zip: AdmZip;
    let manifest: Record<string, unknown>;
    try {
      zip = new AdmZip(zipBuffer);
      const manifestEntry = zip.getEntry("manifest.json");
      if (!manifestEntry) {
        throw new Error("Invalid backup: manifest.json is missing from the archive.");
      }
      const raw = manifestEntry.getData().toString("utf8");
      manifest = JSON.parse(raw) as Record<string, unknown>;
      if (manifest.appName !== "LabTrax") {
        throw new Error(
          `Invalid backup: manifest.json has appName '${manifest.appName}', expected 'LabTrax'.`,
        );
      }
      const dbEntry = zip.getEntry("db/database.pgdump");
      if (!dbEntry) {
        throw new Error("Invalid backup: db/database.pgdump is missing from the archive.");
      }
    } catch (err: unknown) {
      throw err;
    }

    // ── Step 3: extract pg dump to temp file ─────────────────────────────────
    const pgDumpPath = path.join(tmpDir, "database.pgdump");
    const dbEntry = zip.getEntry("db/database.pgdump")!;
    fs.writeFileSync(pgDumpPath, dbEntry.getData());

    // ── Step 4: run pg_restore ────────────────────────────────────────────────
    setRestorePhase("restoring_db", "Restoring database (this may take a moment)…");
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error("DATABASE_URL is not set — cannot restore database.");
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("pg_restore", [
        "--clean",
        "--if-exists",
        `--dbname=${dbUrl}`,
        pgDumpPath,
      ]);
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
        if (code !== null && code > 1) {
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

    // ── Step 5: restore media files ───────────────────────────────────────────
    setRestorePhase("restoring_media", "Restoring case media files…");
    const mediaDir = path.resolve(process.cwd(), "uploads", "case-media");

    // Move existing media to trash (consistent with orphan-cleanup trash pattern).
    if (fs.existsSync(mediaDir)) {
      const trashBase = path.join(mediaDir, ".trash");
      const trashStamp = path.join(trashBase, `restore-${Date.now()}`);
      fs.mkdirSync(trashStamp, { recursive: true });
      for (const entry of fs.readdirSync(mediaDir)) {
        if (entry === ".trash" || entry === ".sessions") continue;
        try {
          fs.renameSync(path.join(mediaDir, entry), path.join(trashStamp, entry));
        } catch {
          // best-effort
        }
      }
    }
    fs.mkdirSync(mediaDir, { recursive: true });

    // Extract media/ entries from ZIP into mediaDir.
    for (const entry of zip.getEntries()) {
      const entryName = entry.entryName;
      if (!entryName.startsWith("media/")) continue;
      const relative = entryName.slice("media/".length);
      if (!relative) continue; // skip the directory entry itself
      const destPath = path.join(mediaDir, relative);
      const destDir = path.dirname(destPath);
      fs.mkdirSync(destDir, { recursive: true });
      if (!entry.isDirectory) {
        fs.writeFileSync(destPath, entry.getData());
      }
    }

    // ── Step 6: record restore run ────────────────────────────────────────────
    try {
      await db.insert(backupRuns).values({
        triggeredBy,
        destination: "local" as const,
        path: null,
        fileName: null,
        sizeBytes: encryptedBuffer.length,
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
      message: "Restore complete.",
      startedAt: _restoreState.startedAt,
      completedAt: new Date().toISOString(),
    };

    return { manifest };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    _restoreState = {
      phase: "error",
      message: msg,
      startedAt: _restoreState.startedAt,
      completedAt: new Date().toISOString(),
    };
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
export async function buildBackupZipBuffer(triggeredBy: string): Promise<{
  buffer: Buffer;
  fileName: string;
}> {
  const pgDump = await buildPgDumpBuffer();

  const dateStr = new Date().toISOString().split("T")[0];
  const fileName = `labtrax-backup-${dateStr}.zip.enc`;

  const manifest = {
    version: "2.0",
    appName: "LabTrax",
    exportedAt: new Date().toISOString(),
    exportedBy: triggeredBy,
    dbFormat: "pg_dump:custom",
    decryptNote:
      "This file is AES-256-GCM encrypted. Format: 4-byte magic 'LTRX' + 12-byte IV + 16-byte GCM auth-tag + ciphertext. " +
      "Set BACKUP_ENCRYPTION_KEY (or JWT_SECRET) to the same value used during backup, derive a 32-byte key via SHA-256, " +
      "then decrypt to get the inner ZIP. Restore the database with: pg_restore --clean --if-exists -d <dbname> db/database.pgdump",
    mediaNote: "Case-media attachments are in the media/ directory of the inner ZIP.",
  };

  const mediaDir = path.resolve(process.cwd(), "uploads", "case-media");
  const mediaExists = fs.existsSync(mediaDir);

  const zipBuffer: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
    archive.append(pgDump, { name: "db/database.pgdump" });
    if (mediaExists) archive.directory(mediaDir, "media");
    archive.finalize();
  });

  const buffer = encryptBuffer(zipBuffer);
  return { buffer, fileName };
}

export async function runOneDriveBackup(
  triggeredBy: string,
  options?: {
    conflictBehavior?: "replace" | "rename" | "fail";
    fileName?: string;
  },
): Promise<BackupResult> {
  const { buffer, fileName: generatedFileName } = await buildBackupZipBuffer(triggeredBy);
  const targetFileName = options?.fileName ?? generatedFileName;
  const conflictBehavior = options?.conflictBehavior ?? "rename";
  const result = await uploadToOneDrive(buffer, targetFileName, "LabTrax Backups", conflictBehavior);
  return {
    fileName: result.name,
    size: result.size,
    webUrl: result.webUrl,
    folder: "LabTrax Backups",
  };
}

/**
 * Write an encrypted backup to a local filesystem path.
 * On Linux, UNC/SMB paths must be pre-mounted (e.g. via cifs-utils) so they
 * appear as a local directory — pass the mount point as targetPath.
 */
export async function runLocalBackup(
  triggeredBy: string,
  targetPath: string,
): Promise<BackupRunResult> {
  const { buffer, fileName } = await buildBackupZipBuffer(triggeredBy);
  const resolvedDir = path.resolve(targetPath);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const destFile = path.join(resolvedDir, fileName);
  fs.writeFileSync(destFile, buffer);
  return {
    size: buffer.length,
    completedAt: new Date().toISOString(),
    fileName,
    destination: "local",
    path: destFile,
  };
}

/** Minimal interface covering the ssh2 API surface used by runSftpBackup. */
interface SshClient {
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  sftp(callback: (err: Error | undefined, sftp: SftpSession) => void): void;
  connect(opts: { host: string; port: number; username: string; password?: string }): void;
  end(): void;
}
interface SftpSession {
  createWriteStream(path: string): NodeJS.WritableStream;
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

  const { buffer, fileName } = await buildBackupZipBuffer(triggeredBy);

  // Dynamically import ssh2 — optional runtime dep. Absence surfaces a clear install message.
  let Ssh2Client: new () => SshClient;
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

  const host = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : 22;
  const username = decodeURIComponent(parsed.username || "");
  const remoteDir = parsed.pathname || "/";
  const remoteFile = `${remoteDir.replace(/\/$/, "")}/${fileName}`;

  await new Promise<void>((resolve, reject) => {
    const conn = new Ssh2Client();
    conn.on("ready", () => {
      conn.sftp((err: Error | undefined, sftp: SftpSession) => {
        if (err) { conn.end(); return reject(err); }
        const writeStream = sftp.createWriteStream(remoteFile);
        writeStream.on("error", (e: Error) => { conn.end(); reject(e); });
        writeStream.on("close", () => { conn.end(); resolve(); });
        writeStream.end(buffer);
      });
    });
    conn.on("error", (e: Error) => reject(e));
    conn.connect({ host, port, username });
  });

  return {
    size: buffer.length,
    completedAt: new Date().toISOString(),
    fileName,
    destination: "network",
    path: remoteFile,
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
  result: BackupRunResult & { triggeredBy: string; error?: string },
): Promise<void> {
  try {
    await db.insert(backupRuns).values({
      triggeredBy: result.triggeredBy,
      destination: result.destination,
      path: result.path ?? null,
      fileName: result.fileName,
      sizeBytes: result.size,
      status: result.error ? "error" : "success",
      error: result.error ?? null,
      completedAt: new Date(result.completedAt),
    });
  } catch (err) {
    logger.warn({ err }, "Failed to record backup run in DB");
    return;
  }
  await pruneBackupHistory();
}

async function recordBackupError(
  triggeredBy: string,
  destination: BackupDestination,
  destPath: string | undefined,
  error: string,
): Promise<string> {
  const failedAt = new Date();
  try {
    await db.insert(backupRuns).values({
      triggeredBy,
      destination,
      path: destPath ?? null,
      fileName: null,
      sizeBytes: null,
      status: "error",
      error,
      completedAt: failedAt,
    });
  } catch (err) {
    logger.warn({ err }, "Failed to record backup error in DB");
    return failedAt.toISOString();
  }
  await pruneBackupHistory();
  return failedAt.toISOString();
}

export async function runBackup(
  triggeredBy: string,
  destination: BackupDestination,
  destPath?: string,
): Promise<BackupRunResult> {
  let result: BackupRunResult;
  try {
    if (destination === "onedrive") {
      const { buffer, fileName } = await buildBackupZipBuffer(triggeredBy);
      const uploaded = await uploadToOneDrive(buffer, fileName, "LabTrax Backups");
      result = {
        size: uploaded.size,
        completedAt: new Date().toISOString(),
        fileName: uploaded.name,
        destination: "onedrive",
      };
    } else if (destination === "local") {
      if (!destPath) throw new Error("A destination path is required for local backups.");
      result = await runLocalBackup(triggeredBy, destPath);
    } else if (destination === "network") {
      if (!destPath) throw new Error("A network path or sftp:// URL is required for network backups.");
      result = destPath.startsWith("sftp://")
        ? await runSftpBackup(triggeredBy, destPath)
        : await runLocalBackup(triggeredBy, destPath);
    } else {
      throw new Error(`Unknown backup destination: ${destination}`);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failedAt = await recordBackupError(triggeredBy, destination, destPath, errMsg);
    const outErr = err instanceof Error ? err : new Error(errMsg);
    (outErr as Error & { backupRunFailedAt?: string }).backupRunFailedAt = failedAt;
    throw outErr;
  }
  await recordSuccessfulBackup();
  await recordBackupRun({ ...result, triggeredBy });
  return result;
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
      destinationRaw === "onedrive" || destinationRaw === "local" || destinationRaw === "network"
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
    return admins.map((u) => u.email).filter((e): e is string => Boolean(e));
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
 */
export async function checkAndAlertBackupStaleness(): Promise<void> {
  try {
    const [lastSuccessfulAt, { thresholdDays, rateLimitDays }] = await Promise.all([
      getLastSuccessfulBackupAt(),
      getBackupStaleAlertSettings(),
    ]);
    const now = Date.now();

    let daysSince: number;
    if (lastSuccessfulAt === null) {
      daysSince = Infinity;
    } else {
      const lastMs = new Date(lastSuccessfulAt).getTime();
      if (isNaN(lastMs)) {
        daysSince = Infinity;
      } else {
        daysSince = (now - lastMs) / (1000 * 60 * 60 * 24);
      }
    }

    if (daysSince < thresholdDays) {
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
        lastSuccessfulAt,
        daysSinceBackup: isFinite(daysSince) ? daysSince : 0,
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

export async function startDailyOneDriveBackup() {
  if (scheduled) return;
  scheduled = true;

  const hourUtc = await getBackupHourUtc();

  const tick = async () => {
    try {
      logger.info(
        { startedAt: new Date().toISOString() },
        "Daily OneDrive backup starting",
      );
      const result = await runOneDriveBackup("scheduler:daily");
      logger.info(
        {
          fileName: result.fileName,
          size: result.size,
        },
        "Daily OneDrive backup OK",
      );
      try {
        const adminEmails = await getAdminEmails();
        await sendBackupNotificationEmail({
          adminEmails,
          triggeredBy: "scheduler:daily",
          success: true,
          result: {
            destination: "onedrive",
            fileName: result.fileName,
            size: result.size,
            completedAt: new Date().toISOString(),
          },
        });
      } catch (mailErr: unknown) {
        logger.error(
          { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
          "Daily OneDrive backup: success notification email failed",
        );
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err: errMsg },
        "Daily OneDrive backup FAILED",
      );
      try {
        const adminEmails = await getAdminEmails();
        await sendBackupNotificationEmail({
          adminEmails,
          triggeredBy: "scheduler:daily",
          success: false,
          errorMessage: errMsg,
          destination: "onedrive",
        });
      } catch (mailErr: unknown) {
        logger.error(
          { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
          "Daily OneDrive backup: failure notification email failed",
        );
      }
    } finally {
      // Re-schedule for the next day even if this run failed.
      setTimeout(tick, msUntilNext(hourUtc));
    }
  };

  const initialDelay = msUntilNext(hourUtc);
  logger.info(
    {
      hourUtc,
      firstRunInMinutes: Math.round(initialDelay / 60000),
    },
    "Daily OneDrive backup scheduled",
  );
  setTimeout(tick, initialDelay);
}

// ── Dynamic recurring backup scheduler ──────────────────────────────────────
// Driven by system_settings rows written by PUT /api/admin/backup/schedule.
// The interval timer is replaced each time the schedule is updated.

let _scheduledIntervalTimer: ReturnType<typeof setInterval> | null = null;

async function fireScheduledBackup() {
  const config = await getBackupScheduleConfig();
  if (!config.enabled || !config.destination) return;
  const label = `scheduler:interval`;
  try {
    logger.info(
      { destination: config.destination, path: config.path },
      "Scheduled interval backup starting",
    );
    const result = await runBackup(label, config.destination, config.path ?? undefined);
    logger.info(
      { size: result.size, fileName: result.fileName },
      "Scheduled interval backup OK",
    );
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
        },
      });
    } catch (mailErr: unknown) {
      logger.error(
        { err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
        "Scheduled interval backup: success notification email failed",
      );
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
  }
}

export async function restartScheduledBackupJob(): Promise<void> {
  if (_scheduledIntervalTimer !== null) {
    clearInterval(_scheduledIntervalTimer);
    _scheduledIntervalTimer = null;
  }
  const config = await getBackupScheduleConfig();
  if (!config.enabled || !config.intervalMinutes || !config.destination) {
    logger.info("[backup] Recurring backup schedule is disabled or not configured.");
    return;
  }
  const intervalMs = config.intervalMinutes * 60 * 1000;
  logger.info(
    { intervalMinutes: config.intervalMinutes, destination: config.destination },
    "[backup] Recurring backup schedule started",
  );
  _scheduledIntervalTimer = setInterval(fireScheduledBackup, intervalMs);
}

// ── 15-minute rolling OneDrive backup scheduler ──────────────────────────────
// Keeps a single rolling backup on OneDrive by uploading every 15 minutes,
// replacing the previous file each time. Skips ticks when disabled via the
// rolling_backup_enabled system_settings row. Outcomes are written to
// rolling_backup_last_run_at and rolling_backup_last_error.

let _rollingBackupScheduled = false;

const ROLLING_BACKUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function start15MinRollingBackup(): void {
  if (_rollingBackupScheduled) return;
  _rollingBackupScheduled = true;

  logger.info("[backup] 15-minute rolling OneDrive backup scheduler armed");

  const tick = async () => {
    try {
      const rows = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, SETTING_ROLLING_BACKUP_ENABLED));
      const enabledRaw = rows[0]?.value ?? null;
      const enabled = enabledRaw === null ? true : enabledRaw !== "false";
      if (!enabled) {
        return;
      }
    } catch (dbErr: unknown) {
      logger.warn(
        { err: dbErr instanceof Error ? dbErr.message : String(dbErr) },
        "[backup] Rolling backup: failed to read enabled setting; skipping tick",
      );
      return;
    }

    const runAt = new Date().toISOString();
    try {
      logger.info({ startedAt: runAt }, "[backup] Rolling OneDrive backup starting");
      const result = await runOneDriveBackup("scheduler:rolling", {
        conflictBehavior: "replace",
        fileName: "labtrax-rolling-backup.zip.enc",
      });
      logger.info(
        { fileName: result.fileName, size: result.size },
        "[backup] Rolling OneDrive backup OK",
      );
      await db
        .insert(systemSettings)
        .values({ key: SETTING_ROLLING_BACKUP_LAST_RUN_AT, value: runAt })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: runAt, updatedAt: new Date() },
        });
      await db
        .insert(systemSettings)
        .values({ key: SETTING_ROLLING_BACKUP_LAST_ERROR, value: "" })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: "", updatedAt: new Date() },
        });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMsg }, "[backup] Rolling OneDrive backup FAILED");
      try {
        await db
          .insert(systemSettings)
          .values({ key: SETTING_ROLLING_BACKUP_LAST_RUN_AT, value: runAt })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: runAt, updatedAt: new Date() },
          });
        await db
          .insert(systemSettings)
          .values({ key: SETTING_ROLLING_BACKUP_LAST_ERROR, value: errMsg })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: errMsg, updatedAt: new Date() },
          });
      } catch (writeErr: unknown) {
        logger.warn(
          { err: writeErr instanceof Error ? writeErr.message : String(writeErr) },
          "[backup] Rolling backup: failed to write error to settings",
        );
      }
    }
  };

  setInterval(() => {
    tick().catch((err: unknown) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[backup] Rolling backup tick threw unexpectedly",
      );
    });
  }, ROLLING_BACKUP_INTERVAL_MS);
}
