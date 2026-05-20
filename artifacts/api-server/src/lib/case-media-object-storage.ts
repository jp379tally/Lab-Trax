/**
 * App Storage (Google Cloud Storage via Replit sidecar) layer for case-media
 * attachments.  Mirrors the same pattern as `desktop-installer-storage.ts`.
 *
 * Object keys:  `${PRIVATE_OBJECT_DIR}/case-media/<diskFilename>`
 *
 * When `PRIVATE_OBJECT_DIR` is unset the helpers return `null` / no-op so the
 * caller can fall through to local-disk behaviour transparently.
 */

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
  if (slash === -1) throw new Error(`Invalid object path: ${fullPath}`);
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
  await file.save(data, {
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
  await file.delete();
  return true;
}
