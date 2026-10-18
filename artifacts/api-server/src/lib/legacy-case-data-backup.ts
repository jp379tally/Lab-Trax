/**
 * Durable, read-back-verified backups of a legacy case's ORIGINAL
 * `lab_cases.case_data` blob, taken immediately before the inline-media
 * externalization migration rewrites that blob (see
 * `legacy-case-media-externalize.ts`).
 *
 * Why a dedicated store rather than a table:
 *   The whole point of the migration is to get ~35 MB of base64 photo data
 *   OUT of `lab_cases`. Parking the originals in another Postgres table would
 *   keep every byte inside `pg_dump`, so the nightly backup ZIP — one of the
 *   things the migration is meant to shrink — would not shrink at all. These
 *   backups therefore live next to the other App Storage blobs, under their
 *   own object prefix, and are deliberately NOT inside `uploads/case-media`
 *   (which the nightly ZIP archives wholesale).
 *
 * Object keys: `${PRIVATE_OBJECT_DIR}/legacy-case-data-backups/<runId>/<caseId>.json`
 * Disk paths:  `uploads/legacy-case-data-backups/<runId>/<caseId>.json`
 *
 * App Storage is the durable home (local disk is wiped on autoscale
 * redeploys). The disk path is a fallback for environments with no App
 * Storage configured; a live migration refuses to rewrite a blob it could
 * only back up to ephemeral disk unless the operator explicitly opts in.
 */

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { Storage } from "@google-cloud/storage";
import type { ExternalAccountClientOptions } from "google-auth-library";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const replitSidecarCredentials: ExternalAccountClientOptions = {
  audience: "replit",
  subject_token_type: "access_token",
  token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
  type: "external_account",
  credential_source: {
    url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
    format: { type: "json", subject_token_field_name: "access_token" },
  },
  universe_domain: "googleapis.com",
};

let _storageClient: Storage | null = null;
function storageClient(): Storage {
  if (!_storageClient) {
    _storageClient = process.env["GOOGLE_APPLICATION_CREDENTIALS"]
      ? new Storage()
      : new Storage({ credentials: replitSidecarCredentials, projectId: "" });
  }
  return _storageClient;
}

const OBJECT_PREFIX = "legacy-case-data-backups";

export const legacyCaseDataBackupDir = path.resolve(
  process.cwd(),
  "uploads",
  OBJECT_PREFIX,
);

/** Where a backup actually landed. */
export type LegacyCaseDataBackupLocation = "object-storage" | "disk";

export interface LegacyCaseDataBackupResult {
  location: LegacyCaseDataBackupLocation;
  /** Object key or absolute disk path — recorded in the migration report. */
  key: string;
  bytes: number;
}

/**
 * Writes the original blob somewhere durable and can read it back verbatim.
 * Injectable so tests can exercise the migration without touching App Storage.
 */
export interface LegacyCaseDataBackupStore {
  write(
    runId: string,
    caseId: string,
    caseData: string,
  ): Promise<LegacyCaseDataBackupResult>;
  read(runId: string, caseId: string): Promise<string | null>;
}

/** Restrict both path segments to characters that are safe in a key/path. */
function safeSegment(value: string, label: string): string {
  const cleaned = String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error(`Invalid ${label} for legacy case-data backup.`);
  }
  return cleaned;
}

function getPrivateObjectDir(): string | null {
  const dir = process.env["PRIVATE_OBJECT_DIR"];
  if (!dir) return null;
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

/** True when App Storage is provisioned for durable backups. */
export function legacyCaseDataBackupStorageAvailable(): boolean {
  return Boolean(getPrivateObjectDir());
}

function objectKey(runId: string, caseId: string): string | null {
  const dir = getPrivateObjectDir();
  if (!dir) return null;
  return `${dir}/${OBJECT_PREFIX}/${safeSegment(runId, "run id")}/${safeSegment(caseId, "case id")}.json`;
}

function objectFile(runId: string, caseId: string) {
  const fullPath = objectKey(runId, caseId);
  if (!fullPath) return null;
  const trimmed = fullPath.startsWith("/") ? fullPath.slice(1) : fullPath;
  const slash = trimmed.indexOf("/");
  if (slash === -1) throw new Error(`Invalid object path: ${fullPath}`);
  return storageClient()
    .bucket(trimmed.slice(0, slash))
    .file(trimmed.slice(slash + 1));
}

function diskPath(runId: string, caseId: string): string {
  return path.resolve(
    legacyCaseDataBackupDir,
    safeSegment(runId, "run id"),
    `${safeSegment(caseId, "case id")}.json`,
  );
}

/**
 * The backup envelope. `caseData` is the exact string that was in the column,
 * so a restore is `UPDATE lab_cases SET case_data = <caseData> WHERE id = ...`.
 */
interface BackupEnvelope {
  runId: string;
  caseId: string;
  capturedAt: string;
  caseData: string;
}

function encode(runId: string, caseId: string, caseData: string): string {
  const envelope: BackupEnvelope = {
    runId,
    caseId,
    capturedAt: new Date().toISOString(),
    caseData,
  };
  return JSON.stringify(envelope);
}

function decode(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BackupEnvelope>;
    return typeof parsed?.caseData === "string" ? parsed.caseData : null;
  } catch {
    return null;
  }
}

/**
 * Default store: App Storage when configured, otherwise local disk.
 * Callers inspect `location` to decide whether the backup is durable enough
 * to proceed with a destructive rewrite.
 */
export const defaultLegacyCaseDataBackupStore: LegacyCaseDataBackupStore = {
  async write(runId, caseId, caseData) {
    const body = encode(runId, caseId, caseData);
    const bytes = Buffer.byteLength(body, "utf8");
    const file = objectFile(runId, caseId);
    if (file) {
      await file.save(Buffer.from(body, "utf8"), {
        contentType: "application/json",
        resumable: false,
      });
      return {
        location: "object-storage",
        key: objectKey(runId, caseId)!,
        bytes,
      };
    }
    const target = diskPath(runId, caseId);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, body, "utf8");
    return { location: "disk", key: target, bytes };
  },

  async read(runId, caseId) {
    const file = objectFile(runId, caseId);
    if (file) {
      const [exists] = await file.exists();
      if (!exists) return null;
      const [buf] = await file.download();
      return decode(buf.toString("utf8"));
    }
    try {
      return decode(await fsp.readFile(diskPath(runId, caseId), "utf8"));
    } catch {
      return null;
    }
  },
};
