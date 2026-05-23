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

const storageClient = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? new Storage()
  : new Storage({
      credentials: replitSidecarCredentials,
      projectId: "",
    });

export class LabLogoNotConfiguredError extends Error {
  constructor() {
    super(
      "App Storage is not configured (PRIVATE_OBJECT_DIR is unset). Provision Object Storage first.",
    );
    this.name = "LabLogoNotConfiguredError";
  }
}

function getPrivateObjectDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR;
  if (!dir) {
    throw new LabLogoNotConfiguredError();
  }
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

function parseObjectPath(fullPath: string): {
  bucketName: string;
  objectName: string;
} {
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

const ALLOWED_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
};

export function isAllowedLogoMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_MIME, mime);
}

export function logoExtForMime(mime: string): string {
  return ALLOWED_MIME[mime] ?? "bin";
}

function getLogoFile(orgId: string, ext: string): File {
  const fullPath = `${getPrivateObjectDir()}/lab-logos/${orgId}.${ext}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  return storageClient.bucket(bucketName).file(objectName);
}

export interface UploadedLogo {
  ext: string;
  contentType: string;
  size: number;
  uploadedAt: string;
}

/**
 * Uploads a lab logo image to App Storage, replacing any existing logo
 * for that org. Old logos with a different extension are removed so we
 * don't leak orphan objects when the user uploads a new format.
 */
export async function uploadLabLogo(
  orgId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<UploadedLogo> {
  if (!isAllowedLogoMime(mimeType)) {
    throw new Error(`Unsupported image type: ${mimeType}`);
  }
  const ext = logoExtForMime(mimeType);

  // Delete any logo we previously stored under a different extension so
  // the org always has exactly one logo object on disk.
  await Promise.all(
    Object.values(ALLOWED_MIME)
      .filter((other) => other !== ext)
      .map(async (other) => {
        try {
          const f = getLogoFile(orgId, other);
          const [exists] = await f.exists();
          if (exists) await f.delete();
        } catch {
          /* best effort */
        }
      }),
  );

  const file = getLogoFile(orgId, ext);
  await file.save(buffer, {
    contentType: mimeType,
    resumable: false,
    metadata: { cacheControl: "public, max-age=300" },
  });
  const [meta] = await file.getMetadata();
  const sizeRaw = meta.size;
  const size =
    typeof sizeRaw === "string"
      ? Number.parseInt(sizeRaw, 10)
      : Number(sizeRaw ?? 0);
  const uploadedAt =
    (meta.updated as string) ||
    (meta.timeCreated as string) ||
    new Date().toISOString();
  return {
    ext,
    contentType: mimeType,
    size: Number.isFinite(size) ? size : buffer.length,
    uploadedAt,
  };
}

export interface LabLogoStream {
  size: number;
  stream: NodeJS.ReadableStream;
  contentType: string;
}

/**
 * Returns a read stream for the lab's stored logo, or null if missing.
 * The caller is responsible for setting cache + content-type headers
 * (we provide the content type here from the stored object's metadata).
 */
// ─── Invoice-template extra images (signatures, stamps, etc.) ───────────────
// Stored under <PRIVATE_OBJECT_DIR>/invoice-template-images/<orgId>/<id>.<ext>
// Each org may upload multiple supplementary images that the invoice editor
// places on the page.

function getInvoiceImageFile(orgId: string, id: string, ext: string): File {
  const fullPath = `${getPrivateObjectDir()}/invoice-template-images/${orgId}/${id}.${ext}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  return storageClient.bucket(bucketName).file(objectName);
}

export interface UploadedInvoiceImage {
  id: string;
  storageKey: string;
  ext: string;
  contentType: string;
  size: number;
}

/** Upload an extra invoice-template image. Returns the storage key + id. */
export async function uploadInvoiceTemplateImage(
  orgId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<UploadedInvoiceImage> {
  if (!isAllowedLogoMime(mimeType)) {
    throw new Error(`Unsupported image type: ${mimeType}`);
  }
  const ext = logoExtForMime(mimeType);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const file = getInvoiceImageFile(orgId, id, ext);
  await file.save(buffer, {
    contentType: mimeType,
    resumable: false,
    metadata: { cacheControl: "public, max-age=300" },
  });
  return {
    id,
    storageKey: `invoice-template-images/${orgId}/${id}.${ext}`,
    ext,
    contentType: mimeType,
    size: buffer.length,
  };
}

/** Stream a previously uploaded invoice-template image back to the client. */
export async function openInvoiceTemplateImageStream(
  orgId: string,
  id: string,
): Promise<LabLogoStream | null> {
  if (!process.env.PRIVATE_OBJECT_DIR) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  for (const ext of Object.values(ALLOWED_MIME)) {
    const f = getInvoiceImageFile(orgId, id, ext);
    const [exists] = await f.exists();
    if (!exists) continue;
    const [meta] = await f.getMetadata();
    const sizeRaw = meta.size;
    const size =
      typeof sizeRaw === "string"
        ? Number.parseInt(sizeRaw, 10)
        : Number(sizeRaw ?? 0);
    return {
      size: Number.isFinite(size) ? size : 0,
      stream: f.createReadStream(),
      contentType:
        (meta.contentType as string) ||
        Object.entries(ALLOWED_MIME).find(([, e]) => e === ext)?.[0] ||
        "application/octet-stream",
    };
  }
  return null;
}

/** Delete an extra invoice-template image. Best-effort; ignores missing. */
export async function deleteInvoiceTemplateImage(
  orgId: string,
  id: string,
): Promise<void> {
  if (!process.env.PRIVATE_OBJECT_DIR) return;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return;
  await Promise.all(
    Object.values(ALLOWED_MIME).map(async (ext) => {
      try {
        const f = getInvoiceImageFile(orgId, id, ext);
        const [exists] = await f.exists();
        if (exists) await f.delete();
      } catch {
        /* best effort */
      }
    }),
  );
}

export async function openLabLogoStream(
  orgId: string,
): Promise<LabLogoStream | null> {
  if (!process.env.PRIVATE_OBJECT_DIR) return null;
  for (const ext of Object.values(ALLOWED_MIME)) {
    const f = getLogoFile(orgId, ext);
    const [exists] = await f.exists();
    if (!exists) continue;
    const [meta] = await f.getMetadata();
    const sizeRaw = meta.size;
    const size =
      typeof sizeRaw === "string"
        ? Number.parseInt(sizeRaw, 10)
        : Number(sizeRaw ?? 0);
    return {
      size: Number.isFinite(size) ? size : 0,
      stream: f.createReadStream(),
      contentType:
        (meta.contentType as string) ||
        Object.entries(ALLOWED_MIME).find(([, e]) => e === ext)?.[0] ||
        "application/octet-stream",
    };
  }
  return null;
}
