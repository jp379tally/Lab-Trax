import { Storage, type File } from "@google-cloud/storage";
import type { ExternalAccountClientOptions } from "google-auth-library";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const replitSidecarCredentials: ExternalAccountClientOptions = {
  audience: "replit",
  subject_token_type: "access_token",
  token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
  type: "external_account",
  credential_source: {
    url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
    format: {
      type: "json",
      subject_token_field_name: "access_token",
    },
  },
  universe_domain: "googleapis.com",
};

const storageClient = new Storage({
  credentials: replitSidecarCredentials,
  projectId: "",
});

const OBJECT_KEY_SUFFIX = "desktop-installer/LabTrax-Windows-Portable.zip";

export class DesktopInstallerNotConfiguredError extends Error {
  constructor() {
    super(
      "App Storage is not configured (PRIVATE_OBJECT_DIR is unset). Provision Object Storage first.",
    );
    this.name = "DesktopInstallerNotConfiguredError";
  }
}

function getPrivateObjectDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR;
  if (!dir) {
    throw new DesktopInstallerNotConfiguredError();
  }
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

function parseObjectPath(fullPath: string): { bucketName: string; objectName: string } {
  const trimmed = fullPath.startsWith("/") ? fullPath.slice(1) : fullPath;
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    throw new Error(`Invalid object path: ${fullPath}`);
  }
  return {
    bucketName: trimmed.slice(0, slash),
    objectName: trimmed.slice(slash + 1),
  };
}

function getInstallerFile(): File {
  const fullPath = `${getPrivateObjectDir()}/${OBJECT_KEY_SUFFIX}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  return storageClient.bucket(bucketName).file(objectName);
}

export interface DesktopInstallerObjectMetadata {
  size: number;
  uploadedAt: string;
}

/**
 * Returns metadata about the currently-stored installer zip, or null if no
 * installer has been uploaded yet (or if Object Storage is not configured).
 *
 * Throws on real storage errors (network/auth/quota) so callers can decide
 * whether to surface the failure or treat it as "missing" — do NOT silently
 * collapse those into null here, that hides production misconfiguration.
 */
export async function getDesktopInstallerMetadata(): Promise<DesktopInstallerObjectMetadata | null> {
  if (!process.env.PRIVATE_OBJECT_DIR) {
    return null;
  }
  const file = getInstallerFile();
  const [exists] = await file.exists();
  if (!exists) return null;
  const [metadata] = await file.getMetadata();
  const sizeRaw = metadata.size;
  const size = typeof sizeRaw === "string" ? Number.parseInt(sizeRaw, 10) : Number(sizeRaw ?? 0);
  const updatedAt = (metadata.updated as string) || (metadata.timeCreated as string) || new Date().toISOString();
  return { size: Number.isFinite(size) ? size : 0, uploadedAt: updatedAt };
}

export interface DesktopInstallerStream {
  size: number;
  stream: NodeJS.ReadableStream;
}

/**
 * Returns a read stream + size for the stored installer, or null if missing.
 */
export async function openDesktopInstallerStream(): Promise<DesktopInstallerStream | null> {
  if (!process.env.PRIVATE_OBJECT_DIR) {
    return null;
  }
  const file = getInstallerFile();
  const [exists] = await file.exists();
  if (!exists) return null;
  const [metadata] = await file.getMetadata();
  const sizeRaw = metadata.size;
  const size = typeof sizeRaw === "string" ? Number.parseInt(sizeRaw, 10) : Number(sizeRaw ?? 0);
  return {
    size: Number.isFinite(size) ? size : 0,
    stream: file.createReadStream(),
  };
}

/**
 * Uploads a zip buffer to App Storage, replacing any existing installer.
 */
export async function uploadDesktopInstaller(buffer: Buffer): Promise<DesktopInstallerObjectMetadata> {
  const file = getInstallerFile();
  await file.save(buffer, {
    contentType: "application/zip",
    resumable: false,
    metadata: {
      contentDisposition: 'attachment; filename="LabTrax-Windows-Portable.zip"',
    },
  });
  const meta = await getDesktopInstallerMetadata();
  if (!meta) {
    throw new Error("Upload succeeded but metadata could not be read back.");
  }
  return meta;
}
