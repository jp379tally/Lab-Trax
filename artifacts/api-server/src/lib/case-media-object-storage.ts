/**
 * App Storage (Google Cloud Storage via Replit sidecar) layer for case-media
 * attachments.  Mirrors the same pattern as `desktop-installer-storage.ts`.
 *
 * Object keys:  `${PRIVATE_OBJECT_DIR}/case-media/<diskFilename>`
 *
 * When `PRIVATE_OBJECT_DIR` is unset the helpers return `null` / no-op so the
 * caller can fall through to local-disk behaviour transparently.
 */

import { createWriteStream, promises as fsp } from "node:fs";
import { writeProductionObject, writeProductionObjectStream, deleteProductionObject,
  openPinnedProductionObject, MEDIA_HISTORY_DIRECTORY } from "./production-media-object-write";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { Storage, type Bucket, type FileMetadata } from "@google-cloud/storage";
import { createHash } from "node:crypto";
import type { ExternalAccountClientOptions } from "google-auth-library";
import pLimit from "p-limit";
import { abortableBackupOperation, measureBackupPhase } from "./backup-phase";

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

const storageClient = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? new Storage()
  : new Storage({ credentials: replitSidecarCredentials, projectId: "" });

function getPrivateObjectDir(): string | null {
  const dir = process.env.PRIVATE_OBJECT_DIR;
  if (!dir) return null;
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

function parseObjectPath(fullPath: string): { bucketName: string; objectName: string } {
  const trimmed = fullPath.startsWith("/") ? fullPath.slice(1) : fullPath;
  const slash = trimmed.indexOf("/");
  if (slash === -1) throw new Error("Invalid App Storage object path.");
  return { bucketName: trimmed.slice(0, slash), objectName: trimmed.slice(slash + 1) };
}

function getObjectFile(diskFilename: string) {
  const dir = getPrivateObjectDir();
  if (!dir) return null;
  const fullPath = `${dir}/case-media/${diskFilename}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  return storageClient.bucket(bucketName).file(objectName);
}

/** Returns true when App Storage is provisioned. */
export function caseMediaObjectStorageAvailable(): boolean {
  return Boolean(process.env.PRIVATE_OBJECT_DIR);
}

/** Separate from both recovery inventory and publicly served object prefixes. */
export function getBackupStagingLocation(environment: "production" | "non-production") {
  const root = getPrivateObjectDir();
  if (!root) throw new Error("Private App Storage is required for cloud backup staging.");
  const { bucketName, objectName } = parseObjectPath(root);
  if (!objectName) throw new Error("Backup staging requires a scoped private storage root.");
  const identity = createHash("sha256").update(`${bucketName}/${objectName}`).digest("hex");
  const prefix = `.labtrax-backup-staging/${identity}/${environment}`;
  if (prefix === objectName || prefix.startsWith(`${objectName}/`)) {
    throw new Error("Backup staging must be outside the recovery inventory.");
  }
  const fullPrefix = `${bucketName}/${prefix}`;
  for (const entry of (process.env.PUBLIC_OBJECT_SEARCH_PATHS ?? "").split(",")) {
    const publicPrefix = entry.trim().replace(/^\/+|\/+$/g, "");
    if (publicPrefix && (fullPrefix === publicPrefix || fullPrefix.startsWith(`${publicPrefix}/`))) {
      throw new Error("Backup staging cannot use a publicly served storage prefix.");
    }
  }
  return { bucket: storageClient.bucket(bucketName), prefix };
}

export interface CaseMediaBackupObject {
  relativeName: string;
  size: number;
  generation?: string;
  modifiedAt?: string;
  metadata?: Record<string, unknown>;
  openStream?(signal?: AbortSignal): Readable;
  copyTo(destination: string, signal?: AbortSignal): Promise<void>;
}

export const MEDIA_TRANSFER_IDLE_MS = 60_000;

/**
 * Inventory once and pin object generations. The backup producer streams these
 * CRC-validated objects directly into the archive instead of staging media on
 * local disk.
 */
export async function listCaseMediaBackupObjects(signal?: AbortSignal): Promise<CaseMediaBackupObject[]> {
  return listPrivateBackupObjects("case-media", signal);
}

/** Inventory an entire private namespace, pinning the exact generation read. */
export async function listPrivateBackupObjects(subdirectory: string = "", signal?: AbortSignal): Promise<CaseMediaBackupObject[]> {
  if (signal?.aborted) throw new Error("Case-media inventory was aborted.");
  const dir = getPrivateObjectDir();
  if (!dir) throw new Error("App Storage is not configured for production case-media backups.");
  const { bucketName, objectName } = parseObjectPath(subdirectory ? `${dir}/${subdirectory}` : dir);
  const prefix = `${objectName}/`;
  const bucket = storageClient.bucket(bucketName);
  const [files] = await measureBackupPhase(
    "case-media storage inventory",
    () => abortableBackupOperation(bucket.getFiles({ prefix }), signal),
    undefined,
    ([items]) => ({
      objectCount: items.length,
      objectBytes: items.reduce((sum, file) => sum + Number(file.metadata.size ?? 0), 0),
    }),
  );
  return files.flatMap((file): CaseMediaBackupObject[] => {
    if (!file.name.startsWith(prefix)) throw new Error("App Storage returned an object outside the case-media prefix.");
    const relativeName = file.name.slice(prefix.length);
    if (!relativeName || relativeName.endsWith("/")) return [];
    if (relativeName.split("/").includes(MEDIA_HISTORY_DIRECTORY)) return [];
    if (!isSafePrivateObjectName(relativeName)) {
      throw new Error("App Storage returned an unsafe case-media object path.");
    }
    return [pinnedBackupObject(bucket, file.name, relativeName, file.metadata)];
  });
}

function isSafePrivateObjectName(relativeName: string): boolean {
  return !relativeName.includes("\\") && !relativeName.includes("\0") &&
    !path.posix.isAbsolute(relativeName) &&
    !relativeName.split("/").some((segment) => !segment || segment === "." || segment === "..");
}
/** Restore only beneath the operator's selected private namespace. */
function privateRestoreFile(relativeName: string) {
  if (!relativeName || relativeName.includes("\\") || relativeName.includes("\0") ||
      path.posix.isAbsolute(relativeName) ||
      relativeName.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("Unsafe private recovery object identity.");
  }
  const root = getPrivateObjectDir();
  if (!root) throw new Error("Private storage must be configured before restoring complete archives.");
  const { bucketName, objectName } = parseObjectPath(`${root}/${relativeName}`);
  return storageClient.bucket(bucketName).file(objectName);
}
export async function restorePrivateBackupObject(
  relativeName: string, data: Buffer, metadata: Record<string, unknown>,
): Promise<void> {
  await writeProductionObject(privateRestoreFile(relativeName),
    relativeName.startsWith("case-media/") ? relativeName : `private-objects/${relativeName}`, "private-recovery", data, {
    resumable: false,
    validation: "crc32c",
    metadata,
  });
}
export async function restorePrivateBackupObjectStream(
  relativeName: string, data: Readable, metadata: Record<string, unknown>,
): Promise<void> {
  await writeProductionObjectStream(privateRestoreFile(relativeName),
    relativeName.startsWith("case-media/") ? relativeName : `private-objects/${relativeName}`, "private-recovery", data, {
    resumable: true, validation: "crc32c", metadata,
  });
}

/**
 * Copy the durable case-media object tree into a private staging directory.
 * Full production backups use this after deployments, when the local uploads
 * directory may have been reset. Streams are bounded so a large media library
 * does not require buffering file contents or opening every object at once.
 */
export async function copyCaseMediaObjectsToDirectory(
  destinationDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const dir = getPrivateObjectDir();
  if (!dir) {
    throw new Error("App Storage is not configured for production case-media backups.");
  }

  const files = await listCaseMediaBackupObjects(signal);
  const destinationRoot = path.resolve(destinationDir);
  const limit = pLimit(12);
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });

  try {
    const results = await Promise.allSettled(
      files.map((file) =>
        limit(async () => {
          if (controller.signal.aborted) throw controller.signal.reason;
          let targetPath: string | null = null;
          try {
            const relativeName = file.relativeName;
            if (!relativeName || relativeName.endsWith("/")) return;
            if (
              relativeName.includes("\\") ||
              relativeName.includes("\0") ||
              path.posix.isAbsolute(relativeName)
            ) {
              throw new Error("App Storage returned an unsafe case-media object path.");
            }
            const segments = relativeName.split("/");
            if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
              throw new Error("App Storage returned an unsafe case-media object path.");
            }
            targetPath = path.resolve(destinationRoot, ...segments);
            const relativeTarget = path.relative(destinationRoot, targetPath);
            if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
              throw new Error("App Storage case-media object escaped its staging directory.");
            }

            await fsp.mkdir(path.dirname(targetPath), { recursive: true });
            await file.copyTo(targetPath, controller.signal);
          } catch (error) {
            if (!controller.signal.aborted) controller.abort(error);
            if (targetPath) await fsp.rm(targetPath, { force: true }).catch(() => undefined);
            throw error;
          }
        }),
      ),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  } finally {
    signal?.removeEventListener("abort", abortFromParent);
  }
}

/**
 * Upload a case-media buffer to App Storage.
 * No-op (returns false) when App Storage is not configured.
 */
export async function writeCaseMediaToObjectStorage(
  diskFilename: string,
  data: Buffer,
  contentType: string,
): Promise<boolean> {
  const file = getObjectFile(diskFilename);
  if (!file) return false;
  await writeProductionObject(file, `case-media/${diskFilename}`, "case-media", data, {
    contentType,
    resumable: false,
    metadata: {
      contentDisposition: `attachment; filename="${diskFilename}"`,
    },
  });
  return true;
}

export interface CaseMediaObjectStream {
  stream: NodeJS.ReadableStream;
  contentType: string;
}

/**
 * Open a read stream for a previously-uploaded case-media file.
 * Returns `null` when App Storage is not configured or the object is missing.
 */
export async function openCaseMediaObjectStream(
  diskFilename: string,
  contentType?: string,
): Promise<CaseMediaObjectStream | null> {
  const file = getObjectFile(diskFilename);
  if (!file) return null;
  const [exists] = await file.exists();
  if (!exists) return null;
  let resolvedContentType = contentType ?? "application/octet-stream";
  if (!contentType) {
    try {
      const [meta] = await file.getMetadata();
      if (typeof meta.contentType === "string" && meta.contentType) {
        resolvedContentType = meta.contentType;
      }
    } catch {
      // fall through to default content type
    }
  }
  return { stream: file.createReadStream(), contentType: resolvedContentType };
}

/**
 * Check whether a case-media object exists in App Storage.
 * Returns false when storage is not configured or the object is absent.
 */
export async function caseMediaObjectStorageKeyExists(
  diskFilename: string,
): Promise<boolean> {
  const file = getObjectFile(diskFilename);
  if (!file) return false;
  const [exists] = await file.exists();
  return exists;
}

/**
 * Delete a case-media object from App Storage.
 * Returns false when storage is not configured or the object did not exist.
 */
export async function deleteCaseMediaFromObjectStorage(
  diskFilename: string,
): Promise<boolean> {
  const file = getObjectFile(diskFilename);
  if (!file) return false;
  const [exists] = await file.exists();
  if (!exists) return false;
  await deleteProductionObject(file, `case-media/${diskFilename}`, "case-media");
  return true;
}

function pinnedBackupObject(
  bucket: Bucket,
  objectName: string,
  relativeName: string,
  objectMetadata: FileMetadata,
): CaseMediaBackupObject {
  const size = Number(objectMetadata.size);
  if (!Number.isSafeInteger(size) || size < 0 || !objectMetadata.generation) {
    throw new Error("Case-media inventory is missing a valid size or object generation.");
  }
  // Uploads use identity encoding. Do not silently change restored bytes or
  // advertise compressed metadata sizes as decompressed media sizes.
  if (objectMetadata.contentEncoding && objectMetadata.contentEncoding !== "identity") {
    throw new Error("Case-media inventory contains encoded objects; verify their restored byte sizes before backing up.");
  }
  return {
    relativeName,
    size,
    generation: String(objectMetadata.generation),
    modifiedAt: objectMetadata.updated,
    metadata: {
      contentType: objectMetadata.contentType,
      contentDisposition: objectMetadata.contentDisposition,
      cacheControl: objectMetadata.cacheControl,
      metadata: objectMetadata.metadata,
    },
    openStream(parentSignal) {
      const source = openPinnedProductionObject(bucket.file(objectName), String(objectMetadata.generation), objectMetadata);
      let lastProgressAt = Date.now();
      const guarded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          lastProgressAt = Date.now();
          callback(null, chunk);
        },
      });
      const abort = () => {
        const error = new Error("Case-media transfer was aborted.");
        source.destroy(error);
        guarded.destroy(error);
      };
      const cleanup = () => {
        clearInterval(idleTimer);
        parentSignal?.removeEventListener("abort", abort);
      };
      const idleTimer = setInterval(() => {
        const now = Date.now();
        // ZIP entries are serialized. Queued reads can be paused by downstream
        // backpressure while a different entry is still making progress.
        // The parent job deadline still bounds the entire transfer.
        if (source.isPaused() || guarded.writableNeedDrain) {
          lastProgressAt = now;
          return;
        }
        if (now - lastProgressAt >= MEDIA_TRANSFER_IDLE_MS) {
          const error = new Error("Case-media transfer stalled for 60 seconds. Check App Storage connectivity and retry.");
          source.destroy(error);
          guarded.destroy(error);
        }
      }, 1000);
      idleTimer.unref?.();
      if (parentSignal?.aborted) abort();
      else parentSignal?.addEventListener("abort", abort, { once: true });
      source.once("error", error => guarded.destroy(error));
      guarded.once("close", cleanup);
      guarded.once("end", cleanup);
      guarded.once("error", cleanup);
      source.pipe(guarded);
      return guarded;
    },
    async copyTo(destination, parentSignal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (parentSignal?.aborted) abort();
      else parentSignal?.addEventListener("abort", abort, { once: true });
      let bytes = 0;
      let lastProgressAt = Date.now();
      const idleTimer = setInterval(() => {
        if (Date.now() - lastProgressAt >= MEDIA_TRANSFER_IDLE_MS) {
          controller.abort(new Error("Case-media transfer stalled for 60 seconds. Check App Storage connectivity and retry."));
        }
      }, 1000);
      idleTimer.unref?.();
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          lastProgressAt = Date.now();
          callback(null, chunk);
        },
      });
      try {
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await pipeline(openPinnedProductionObject(bucket.file(objectName), String(objectMetadata.generation), objectMetadata),
          counter, createWriteStream(destination), { signal: controller.signal });
        if (bytes !== size) throw new Error("Case-media transfer size did not match the pinned object; the partial archive was discarded.");
      } catch (error) {
        await fsp.rm(destination, { force: true }).catch(() => undefined);
        if (controller.signal.reason instanceof Error && !parentSignal?.aborted &&
            controller.signal.reason.message.includes("stalled")) throw controller.signal.reason;
        if (error instanceof Error && error.message.startsWith("Case-media transfer size did not match")) throw error;
        const code = (error as { code?: unknown })?.code;
        const safeCode = typeof code === "string" && /^[A-Z_]+$/.test(code) ? code
          : typeof code === "number" && code >= 100 && code <= 599 ? String(code) : "read/validation failure";
        throw new Error(`Case-media App Storage transfer failed (${safeCode}); no partial archive was kept. Check storage access and available disk space.`);
      } finally {
        clearInterval(idleTimer);
        parentSignal?.removeEventListener("abort", abort);
      }
    },
  };
}

/**
 * Resolve one exact object beneath PRIVATE_OBJECT_DIR without listing its
 * namespace, pinning the generation that was inspected. Returns null only when
 * the object does not exist; every other storage failure is thrown.
 */
export async function openPrivateBackupObject(
  relativeName: string,
  signal?: AbortSignal,
): Promise<CaseMediaBackupObject | null> {
  if (!relativeName || relativeName.endsWith("/") || !isSafePrivateObjectName(relativeName)) {
    throw new Error("Unsafe private backup object identity.");
  }
  const dir = getPrivateObjectDir();
  if (!dir) throw new Error("App Storage is not configured, so private files cannot be read for this backup.");
  const { bucketName, objectName } = parseObjectPath(`${dir}/${relativeName}`);
  const bucket = storageClient.bucket(bucketName);
  let metadata: FileMetadata;
  try {
    [metadata] = await abortableBackupOperation(bucket.file(objectName).getMetadata(), signal);
  } catch (error) {
    if (Number((error as { code?: unknown })?.code) === 404) return null;
    throw error;
  }
  return pinnedBackupObject(bucket, objectName, relativeName, metadata);
}
