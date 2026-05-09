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

export type DesktopInstallerKind = "zip" | "exe";

interface InstallerKindConfig {
  objectKeySuffix: string;
  fileName: string;
  contentType: string;
}

const INSTALLER_KIND_CONFIG: Record<DesktopInstallerKind, InstallerKindConfig> = {
  zip: {
    objectKeySuffix: "desktop-installer/LabTrax-Windows-Portable.zip",
    fileName: "LabTrax-Windows-Portable.zip",
    contentType: "application/zip",
  },
  exe: {
    objectKeySuffix: "desktop-installer/LabTrax-Setup.exe",
    fileName: "LabTrax-Setup.exe",
    contentType: "application/vnd.microsoft.portable-executable",
  },
};

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

function getInstallerFile(kind: DesktopInstallerKind): File {
  const cfg = INSTALLER_KIND_CONFIG[kind];
  const fullPath = `${getPrivateObjectDir()}/${cfg.objectKeySuffix}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  return storageClient.bucket(bucketName).file(objectName);
}

export interface DesktopInstallerObjectMetadata {
  size: number;
  uploadedAt: string;
}

/**
 * Returns metadata about the currently-stored installer of the given kind, or
 * null if no installer has been uploaded (or if Object Storage is not
 * configured).
 *
 * Throws on real storage errors (network/auth/quota) so callers can decide
 * whether to surface the failure or treat it as "missing" — do NOT silently
 * collapse those into null here, that hides production misconfiguration.
 */
export async function getDesktopInstallerMetadata(
  kind: DesktopInstallerKind = "zip",
): Promise<DesktopInstallerObjectMetadata | null> {
  if (!process.env.PRIVATE_OBJECT_DIR) {
    return null;
  }
  const file = getInstallerFile(kind);
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
  contentType: string;
  fileName: string;
}

/**
 * Returns a read stream + metadata for the stored installer of the given kind,
 * or null if missing.
 */
export async function openDesktopInstallerStream(
  kind: DesktopInstallerKind = "zip",
): Promise<DesktopInstallerStream | null> {
  if (!process.env.PRIVATE_OBJECT_DIR) {
    return null;
  }
  const cfg = INSTALLER_KIND_CONFIG[kind];
  const file = getInstallerFile(kind);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [metadata] = await file.getMetadata();
  const sizeRaw = metadata.size;
  const size = typeof sizeRaw === "string" ? Number.parseInt(sizeRaw, 10) : Number(sizeRaw ?? 0);
  return {
    size: Number.isFinite(size) ? size : 0,
    stream: file.createReadStream(),
    contentType: cfg.contentType,
    fileName: cfg.fileName,
  };
}

/**
 * Uploads an installer buffer to App Storage, replacing any existing installer
 * of the same kind.
 */
export async function uploadDesktopInstaller(
  buffer: Buffer,
  kind: DesktopInstallerKind = "zip",
): Promise<DesktopInstallerObjectMetadata> {
  const cfg = INSTALLER_KIND_CONFIG[kind];
  const file = getInstallerFile(kind);
  await file.save(buffer, {
    contentType: cfg.contentType,
    resumable: false,
    metadata: {
      contentDisposition: `attachment; filename="${cfg.fileName}"`,
    },
  });
  const meta = await getDesktopInstallerMetadata(kind);
  if (!meta) {
    throw new Error("Upload succeeded but metadata could not be read back.");
  }
  return meta;
}

/**
 * Maps a download URL or filename to the corresponding installer kind.
 * Returns null when the URL doesn't reference a locally-stored installer.
 */
export function installerKindFromUrl(url: string): DesktopInstallerKind | null {
  const lower = url.toLowerCase();
  if (lower.endsWith(".exe")) return "exe";
  if (lower.endsWith(".zip")) return "zip";
  return null;
}
