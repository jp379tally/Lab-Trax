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

// When GOOGLE_APPLICATION_CREDENTIALS is set (e.g. in CI with a service
// account key file), let the Google Cloud library pick up Application Default
// Credentials automatically — do NOT override with the Replit sidecar, which
// is only available inside the Replit runtime.
const storageClient = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? new Storage()
  : new Storage({
      credentials: replitSidecarCredentials,
      projectId: "",
    });

export type DesktopInstallerKind = "zip" | "exe" | "dmg";

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
  dmg: {
    objectKeySuffix: "desktop-installer/LabTrax.dmg",
    fileName: "LabTrax.dmg",
    contentType: "application/x-apple-diskimage",
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

export interface DesktopInstallerRangeOptions {
  /** Inclusive start byte offset. */
  start?: number;
  /** Inclusive end byte offset. */
  end?: number;
}

/**
 * Returns a read stream + metadata for the stored installer of the given kind,
 * or null if missing. Pass `range` to stream a sub-range (used for HTTP Range
 * requests / resumable downloads).
 */
export async function openDesktopInstallerStream(
  kind: DesktopInstallerKind = "zip",
  range?: DesktopInstallerRangeOptions,
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
  const streamOpts: { start?: number; end?: number } = {};
  if (range && typeof range.start === "number") streamOpts.start = range.start;
  if (range && typeof range.end === "number") streamOpts.end = range.end;
  return {
    size: Number.isFinite(size) ? size : 0,
    stream: file.createReadStream(streamOpts),
    contentType: cfg.contentType,
    fileName: cfg.fileName,
  };
}

export interface DesktopInstallerHandle {
  size: number;
  uploadedAt: string;
  contentType: string;
  fileName: string;
  /** Strong ETag derived from size + uploadedAt. */
  etag: string;
}

/**
 * Returns metadata + ETag for the stored installer of the given kind without
 * opening a stream. Used by the download endpoint to answer conditional
 * (`If-None-Match`) and `Range` requests before allocating a read stream.
 */
export async function getDesktopInstallerHandle(
  kind: DesktopInstallerKind = "zip",
): Promise<DesktopInstallerHandle | null> {
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
  const uploadedAt =
    (metadata.updated as string) || (metadata.timeCreated as string) || new Date().toISOString();
  const uploadedAtMs = Date.parse(uploadedAt);
  const etag = `"${(Number.isFinite(size) ? size : 0).toString(16)}-${
    Number.isFinite(uploadedAtMs) ? uploadedAtMs.toString(16) : "0"
  }"`;
  return {
    size: Number.isFinite(size) ? size : 0,
    uploadedAt,
    contentType: cfg.contentType,
    fileName: cfg.fileName,
    etag,
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
 * Returns a short-lived GCS signed download URL for the installer of the given
 * kind, valid for 15 minutes.  Returns `null` when signing is unavailable
 * (Object Storage not configured, credentials don't support signing, or any
 * other signing error) so the caller can fall back to the streaming path.
 */
export async function getSignedDownloadUrl(
  kind: DesktopInstallerKind = "zip",
): Promise<string | null> {
  if (!process.env.PRIVATE_OBJECT_DIR) {
    return null;
  }
  try {
    const file = getInstallerFile(kind);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [urls] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 15 * 60 * 1000,
    });
    return urls ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetches a short-lived OAuth2 access token from the Replit GCS sidecar and
 * builds a direct GCS object URL that the browser can download from without
 * passing through the Replit reverse proxy.
 *
 * Returns `null` on any failure (sidecar unreachable, empty token, object
 * missing, Object Storage not configured) so the caller can fall back to the
 * existing server-streaming path.
 *
 * The returned URL contains the access token in the query string and must
 * NOT be cached by intermediaries — callers should set `Cache-Control: no-store`
 * on the redirect response.
 */
export async function getDirectDownloadUrl(
  kind: DesktopInstallerKind = "zip",
): Promise<string | null> {
  if (!process.env.PRIVATE_OBJECT_DIR) {
    return null;
  }
  try {
    const tokenRes = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/token`);
    if (!tokenRes.ok) return null;
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    const accessToken = tokenData.access_token;
    if (!accessToken) return null;

    const file = getInstallerFile(kind);
    const [exists] = await file.exists();
    if (!exists) return null;

    const cfg = INSTALLER_KIND_CONFIG[kind];
    const fullPath = `${getPrivateObjectDir()}/${cfg.objectKeySuffix}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const encodedObject = objectName
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    return `https://storage.googleapis.com/${bucketName}/${encodedObject}?access_token=${encodeURIComponent(accessToken)}`;
  } catch {
    return null;
  }
}

/**
 * Deletes the stored installer of the given kind from App Storage.
 * Returns true if the object was deleted, false if it did not exist.
 *
 * Intended for use in test teardown so CI runs don't accumulate dummy
 * files in the staging bucket.  Safe to call even when the object is
 * already absent (GCS delete is idempotent for non-versioned buckets).
 */
export async function deleteDesktopInstaller(
  kind: DesktopInstallerKind = "zip",
): Promise<boolean> {
  if (!process.env.PRIVATE_OBJECT_DIR) {
    return false;
  }
  const file = getInstallerFile(kind);
  const [exists] = await file.exists();
  if (!exists) return false;
  await file.delete();
  return true;
}

/**
 * Maps a download URL or filename to the corresponding installer kind.
 * Returns null when the URL doesn't reference a locally-stored installer.
 */
export function installerKindFromUrl(url: string): DesktopInstallerKind | null {
  const lower = url.toLowerCase();
  if (lower.endsWith(".exe")) return "exe";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".dmg")) return "dmg";
  return null;
}
