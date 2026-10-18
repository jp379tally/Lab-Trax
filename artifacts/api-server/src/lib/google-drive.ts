/**
 * Google Drive backup destination, using Replit's managed Google Drive
 * connector. OAuth tokens remain in the connector; this module only makes
 * authenticated API calls and never reads or stores credential values.
 */
import * as fs from "node:fs";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { logger } from "./logger";
import { setBackupLiveProgress } from "./backup-phase";

const GOOGLE_API = "https://www.googleapis.com";
const CONNECTOR_NAME = "google-drive";
export const GOOGLE_DRIVE_BACKUP_FOLDER = "LabTrax Backups";
export const GOOGLE_DRIVE_NON_PRODUCTION_FOLDER =
  `${GOOGLE_DRIVE_BACKUP_FOLDER}/non-production`;
const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const API_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_RETRIES = 3;
const MAX_LIST_PAGES = 100;

export type GoogleDriveFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

const connectors = new ReplitConnectors();
let proxyFetchOverride: GoogleDriveFetch | null = null;
let uploadFetchOverride: GoogleDriveFetch | null = null;

/** Test hook for mocking Drive API and resumable-upload requests. */
export function setGoogleDriveFetchForTests(
  proxyFetch: GoogleDriveFetch | null,
  uploadFetch: GoogleDriveFetch | null = proxyFetch,
): void {
  proxyFetchOverride = proxyFetch;
  uploadFetchOverride = uploadFetch;
}

function isGoogleDriveArchiveName(name: string): boolean {
  return /\.zip\.enc$/.test(name);
}

export function isGoogleDriveConnectorAvailable(): boolean {
  return Boolean(
    process.env.REPLIT_CONNECTORS_HOSTNAME &&
    (process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL),
  );
}

export function getGoogleDriveManageUrl(): string | null {
  const owner = process.env.REPL_OWNER;
  const slug = process.env.REPL_SLUG;
  if (!owner || !slug) return null;
  return `https://replit.com/@${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
}

export function getGoogleDriveBackupFolder(): string {
  return process.env.REPLIT_DEPLOYMENT === "1"
    ? GOOGLE_DRIVE_BACKUP_FOLDER
    : GOOGLE_DRIVE_NON_PRODUCTION_FOLDER;
}

function getProxyFetch(): GoogleDriveFetch {
  if (proxyFetchOverride) return proxyFetchOverride;
  const proxyFetch = connectors.createProxyFetch(CONNECTOR_NAME);
  return (input, init) => proxyFetch(input, init);
}

function requestUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Google Drive request path must be relative to the Drive API.");
  }
  return `${GOOGLE_API}${path}`;
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

async function bufferBoundedResponse(response: Response): Promise<Response> {
  const declaredSize = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_API_RESPONSE_BYTES) {
    throw new Error("Google Drive API response exceeded its size limit.");
  }
  if (!response.body) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_API_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Google Drive API response exceeded its size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

function describeDriveRequestFailure(status: number, operation: string): string {
  if (status === 401 || status === 403) {
    return `Google Drive denied the ${operation} request (HTTP ${status}). ` +
      "Reconnect Google Drive in the LabTrax hosting workspace and confirm the connection has Drive file access.";
  }
  if (status === 429 || status >= 500) {
    return `Google Drive could not complete the ${operation} request (HTTP ${status}). ` +
      "Check the Google Drive connection, storage quota, and service status, then try again.";
  }
  return `Google Drive could not complete the ${operation} request (HTTP ${status}). ` +
    "Check the Google Drive connection and try again.";
}

async function driveRequest(
  path: string,
  init: RequestInit = {},
  timeoutMs = API_TIMEOUT_MS,
): Promise<Response> {
  const timeout = withTimeout(init.signal ?? undefined, timeoutMs);
  try {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("Content-Type") &&
        typeof init.body !== "string" && !(init.body instanceof Uint8Array)) {
      headers.set("Content-Type", "application/json");
    }
    const response = await getProxyFetch()(requestUrl(path), {
      ...init,
      headers,
      signal: timeout.signal,
    });
    return await bufferBoundedResponse(response);
  } catch (error: unknown) {
    if (timeout.signal.aborted) {
      throw new Error(`Google Drive request timed out during ${path.split("?")[0]}.`);
    }
    // SDK and fetch errors can contain request metadata. Return only a fixed
    // provider-neutral message; never persist connector credentials in logs.
    throw new Error(
      `Google Drive connection request failed during ${path.split("?")[0]}. ` +
      "Check the connection and network, then try again.",
    );
  } finally {
    timeout.dispose();
  }
}

async function driveJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await driveRequest(path, init);
  if (!response.ok) {
    throw new Error(describeDriveRequestFailure(response.status, "Drive API"));
  }
  try {
    return await response.json() as T;
  } catch {
    throw new Error("Google Drive returned an invalid API response.");
  }
}

export interface GoogleDriveStatus {
  connected: boolean;
  accountName: string | null;
  accountEmail: string | null;
  folder: string;
  error: string | null;
  manageUrl: string | null;
}

export async function getGoogleDriveStatus(): Promise<GoogleDriveStatus> {
  const base = {
    accountName: null as string | null,
    accountEmail: null as string | null,
    folder: getGoogleDriveBackupFolder(),
    manageUrl: getGoogleDriveManageUrl(),
  };
  if (!isGoogleDriveConnectorAvailable()) {
    return {
      connected: false,
      ...base,
      error: "Google Drive backups are not available in this environment. " +
        "The server-managed Google Drive connector is unavailable.",
    };
  }
  try {
    const response = await driveRequest(
      "/drive/v3/about?fields=user(displayName,emailAddress)",
    );
    if (!response.ok) {
      return {
        connected: false,
        ...base,
        error: describeDriveRequestFailure(response.status, "connection check"),
      };
    }
    const about = await response.json() as {
      user?: { displayName?: string | null; emailAddress?: string | null };
    };
    return {
      connected: true,
      accountName: about.user?.displayName ?? null,
      accountEmail: about.user?.emailAddress ?? null,
      folder: base.folder,
      error: null,
      manageUrl: base.manageUrl,
    };
  } catch (error: unknown) {
    return {
      connected: false,
      ...base,
      error: error instanceof Error
        ? error.message
        : "Could not check Google Drive. Check the hosting workspace connection and try again.",
    };
  }
}

export interface GoogleDriveBackupFile {
  id: string;
  name: string;
  size: number;
  createdDateTime: string;
  webUrl: string | null;
  parentIds: string[];
}

export interface GoogleDriveUploadResult extends GoogleDriveBackupFile {
  folderId: string;
  folder: string;
}

interface DriveFile {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  size?: unknown;
  createdTime?: unknown;
  webViewLink?: unknown;
  parents?: unknown;
}

function driveFileSize(value: unknown): number | null {
  const parsed = typeof value === "number" ? value :
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeDriveFile(value: DriveFile): GoogleDriveBackupFile | null {
  const size = driveFileSize(value.size);
  if (typeof value.id !== "string" || !value.id.trim() ||
      typeof value.name !== "string" || !value.name.trim() ||
      size === null) return null;
  return {
    id: value.id,
    name: value.name,
    size,
    createdDateTime:
      typeof value.createdTime === "string" ? value.createdTime : new Date(0).toISOString(),
    webUrl: typeof value.webViewLink === "string" ? value.webViewLink : null,
    parentIds: Array.isArray(value.parents)
      ? value.parents.filter((parent): parent is string => typeof parent === "string")
      : [],
  };
}

async function listDriveFiles(query: string, fields: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;
  do {
    pageCount += 1;
    if (pageCount > MAX_LIST_PAGES) {
      throw new Error("Google Drive returned too many pages while listing backup files.");
    }
    const params = new URLSearchParams({
      q: query,
      fields: `nextPageToken,files(${fields})`,
      pageSize: "100",
      spaces: "drive",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await driveJson<{
      files?: DriveFile[];
      nextPageToken?: string;
    }>(`/drive/v3/files?${params.toString()}`);
    if (!Array.isArray(page.files)) {
      throw new Error("Google Drive returned a malformed file-list response.");
    }
    files.push(...page.files);
    if (page.nextPageToken !== undefined &&
        (typeof page.nextPageToken !== "string" || !page.nextPageToken)) {
      throw new Error("Google Drive returned an invalid pagination token.");
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

function escapeDriveQueryString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function ensureFolder(name: string, parentId?: string): Promise<{ id: string }> {
  const clauses = [
    `name = '${escapeDriveQueryString(name)}'`,
    `mimeType = '${GOOGLE_FOLDER_MIME_TYPE}'`,
    "trashed = false",
    parentId ? `'${escapeDriveQueryString(parentId)}' in parents` : "'root' in parents",
  ];
  const matches = await listDriveFiles(
    clauses.join(" and "),
    "id,name,mimeType,createdTime",
  );
  const existing = matches.find((file) =>
    typeof file.id === "string" &&
    file.name === name &&
    file.mimeType === GOOGLE_FOLDER_MIME_TYPE,
  );
  if (existing && typeof existing.id === "string") return { id: existing.id };

  const created = await driveJson<DriveFile>(
    "/drive/v3/files?fields=id,name,mimeType,parents",
    {
      method: "POST",
      body: JSON.stringify({
        name,
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        ...(parentId ? { parents: [parentId] } : {}),
      }),
      headers: { "Content-Type": "application/json" },
    },
  );
  if (typeof created.id !== "string" || !created.id.trim() ||
      created.name !== name || created.mimeType !== GOOGLE_FOLDER_MIME_TYPE) {
    throw new Error("Google Drive did not confirm creation of the LabTrax backup folder.");
  }
  return { id: created.id };
}

export async function getGoogleDriveBackupFolderId(): Promise<string> {
  return getGoogleDriveFolderIdForPath(getGoogleDriveBackupFolder());
}

/** Resolve a Drive folder path, creating missing folders along the way. */
export async function getGoogleDriveFolderIdForPath(folderPath: string): Promise<string> {
  const pathParts = folderPath.split("/").filter(Boolean);
  if (pathParts.length === 0 || pathParts.some((part) => part === "." || part === "..")) {
    throw new Error("Google Drive folder path is invalid.");
  }
  let parentId: string | undefined;
  for (const part of pathParts) {
    const folder = await ensureFolder(part, parentId);
    parentId = folder.id;
  }
  if (!parentId) throw new Error("Google Drive folder path is not configured.");
  return parentId;
}

function isSafeResumableUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      ["www.googleapis.com", "upload.googleapis.com"].includes(url.hostname) &&
      !url.username && !url.password && !url.hash &&
      (url.port === "" || url.port === "443") &&
      url.pathname.startsWith("/upload/drive/v3/files");
  } catch {
    return false;
  }
}

async function openResumableUpload(
  fileName: string,
  totalSize: number,
  folderId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await driveRequest(
    "/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,createdTime,webViewLink,parents",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/octet-stream",
        "X-Upload-Content-Length": String(totalSize),
      },
      body: JSON.stringify({
        name: fileName,
        mimeType: "application/octet-stream",
        parents: [folderId],
      }),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(describeDriveRequestFailure(response.status, "upload setup"));
  }
  const location = response.headers.get("Location");
  if (!location || !isSafeResumableUrl(location)) {
    throw new Error("Google Drive did not return a safe resumable upload address.");
  }
  return location;
}

function isRetryableUploadResponse(status: number): boolean {
  return status === 429 || status === 500 || status === 502 ||
    status === 503 || status === 504;
}

function isTransientTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "fetch failed") return true;
  const candidate = error as Error & { code?: unknown; cause?: unknown };
  const cause = candidate.cause;
  const code = candidate.code ??
    (cause && typeof cause === "object" && "code" in cause
      ? (cause as { code?: unknown }).code
      : undefined);
  return typeof code === "string" && new Set([
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH",
    "ENETUNREACH", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  ]).has(code);
}

async function uploadChunk(
  uploadUrl: string,
  chunk: Buffer,
  offset: number,
  totalSize: number,
  signal?: AbortSignal,
): Promise<Response> {
  const end = offset + chunk.length - 1;
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) {
      throw new Error("Google Drive upload aborted because the backup run exceeded its time budget.");
    }
    const timeout = withTimeout(signal, UPLOAD_TIMEOUT_MS);
    try {
      const fetcher = uploadFetchOverride ?? (fetch as unknown as GoogleDriveFetch);
      const response = await fetcher(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${offset}-${end}/${totalSize}`,
          "Content-Type": "application/octet-stream",
        },
        body: chunk,
        signal: timeout.signal,
      });
      const bufferedResponse = await bufferBoundedResponse(response);
      if (bufferedResponse.ok || bufferedResponse.status === 308 ||
          !isRetryableUploadResponse(bufferedResponse.status) ||
          attempt >= MAX_UPLOAD_RETRIES) {
        return bufferedResponse;
      }
    } catch (error: unknown) {
      if (signal?.aborted || !isTransientTransportError(error) ||
          attempt >= MAX_UPLOAD_RETRIES) {
        if (signal?.aborted) {
          throw new Error("Google Drive upload aborted because the backup run exceeded its time budget.");
        }
        throw new Error(
          `Google Drive upload transport failed after ${attempt + 1} attempts at bytes ${offset}-${end}.`,
        );
      }
    } finally {
      timeout.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
}

function nextOffsetFromRange(response: Response, currentOffset: number, end: number): number {
  const range = response.headers.get("Range");
  if (!range) return currentOffset;
  const match = /^bytes=0-(\d+)$/.exec(range.trim());
  const lastByte = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(lastByte) || lastByte < currentOffset || lastByte > end) {
    throw new Error("Google Drive returned an invalid resumable-upload byte range.");
  }
  return lastByte + 1;
}

/** A sealed archive whose bounded ranges can be read without a local spool. */
export interface GoogleDriveBackupSource {
  size: number;
  readChunk(offset: number, length: number): Promise<Buffer>;
}

export async function uploadGoogleDriveBackupSource(
  source: GoogleDriveBackupSource,
  fileName: string,
  options: {
    signal?: AbortSignal;
    folderOverride?: { id: string; path: string };
  } = {},
): Promise<GoogleDriveUploadResult> {
  const totalSize = source.size;
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
    throw new Error("Google Drive cannot upload an empty or invalid backup archive.");
  }
  if (options.signal?.aborted) {
    throw new Error("Google Drive upload aborted because the backup run exceeded its time budget.");
  }
  const folder = options.folderOverride?.path ?? getGoogleDriveBackupFolder();
  const folderId = options.folderOverride?.id ?? await getGoogleDriveBackupFolderId();
  const uploadUrl = await openResumableUpload(
    fileName,
    totalSize,
    folderId,
    options.signal,
  );
  let offset = 0;
  let finalFile: GoogleDriveBackupFile | null = null;
  let noProgressCount = 0;
  while (offset < totalSize) {
    if (options.signal?.aborted) {
      throw new Error("Google Drive upload aborted because the backup run exceeded its time budget.");
    }
    const length = Math.min(UPLOAD_CHUNK_BYTES, totalSize - offset);
    const chunk = await source.readChunk(offset, length);
    if (!Buffer.isBuffer(chunk) || chunk.length !== length) {
      throw new Error(
        `Google Drive upload stopped because the archive changed while reading bytes ${offset}-${offset + length - 1}.`,
      );
    }
    const end = offset + length - 1;
    const response = await uploadChunk(
      uploadUrl,
      chunk,
      offset,
      totalSize,
      options.signal,
    );
    if (response.status === 200 || response.status === 201) {
      if (end !== totalSize - 1) {
        throw new Error("Google Drive reported upload completion before the final archive chunk.");
      }
      let item: DriveFile;
      try {
        item = await response.json() as DriveFile;
      } catch {
        throw new Error("Google Drive completed the upload without valid file metadata.");
      }
      const normalized = normalizeDriveFile(item);
      if (!normalized || normalized.name !== fileName || normalized.size !== totalSize) {
        throw new Error("Google Drive completed the upload without confirming its file name and exact size.");
      }
      const parents = Array.isArray(item.parents) ? item.parents : [];
      if (!parents.includes(folderId)) {
        throw new Error("Google Drive stored the archive outside the LabTrax backup folder.");
      }
      finalFile = normalized;
      offset = totalSize;
    } else if (response.status === 308) {
      const nextOffset = nextOffsetFromRange(response, offset, end);
      if (nextOffset === offset) {
        noProgressCount += 1;
        if (noProgressCount > MAX_UPLOAD_RETRIES) {
          throw new Error("Google Drive upload did not advance after repeated resumable-upload checks.");
        }
      } else {
        noProgressCount = 0;
        offset = nextOffset;
      }
    } else {
      throw new Error(describeDriveRequestFailure(response.status, "archive upload"));
    }
    setBackupLiveProgress({ uploadedBytes: offset, uploadTotalBytes: totalSize });
  }
  if (!finalFile) {
    throw new Error("Google Drive upload ended without a completed file response.");
  }
  logger.info(
    { fileName: finalFile.name, fileId: finalFile.id, size: finalFile.size },
    "[backup] Google Drive upload complete",
  );
  return { ...finalFile, folderId, folder };
}

/** Retained for explicit database-only archives and existing file callers. */
export async function uploadGoogleDriveBackupFile(
  filePath: string,
  fileName: string,
  options: {
    signal?: AbortSignal;
    folderOverride?: { id: string; path: string };
  } = {},
): Promise<GoogleDriveUploadResult> {
  const fd = fs.openSync(filePath, "r");
  try {
    return await uploadGoogleDriveBackupSource({
      size: fs.fstatSync(fd).size,
      async readChunk(offset, length) {
        const chunk = Buffer.allocUnsafe(length);
        const bytesRead = fs.readSync(fd, chunk, 0, length, offset);
        return chunk.subarray(0, bytesRead);
      },
    }, fileName, options);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Download one known archive by ID. This deliberately does not list a folder:
 * callers must already have the exact item identity and expected byte count.
 */
export async function downloadGoogleDriveBackupFile(
  fileId: string,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!fileId.trim() || !Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new Error("Google Drive archive download requires an item ID and a valid expected size.");
  }
  if (signal?.aborted) {
    throw new Error("Google Drive archive download timed out or was cancelled.");
  }
  const timeout = withTimeout(signal, UPLOAD_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({ alt: "media" });
    const response = await getProxyFetch()(
      requestUrl(`/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`),
      { signal: timeout.signal },
    );
    if (!response.ok) {
      throw new Error(describeDriveRequestFailure(response.status, "archive download"));
    }
    const declaredSize = response.headers.get("Content-Length");
    if (declaredSize !== null && Number(declaredSize) !== expectedSize) {
      throw new Error(
        `Google Drive archive download reported ${declaredSize} bytes; expected ${expectedSize}.`,
      );
    }
    if (!response.body) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== expectedSize) {
        throw new Error(
          `Google Drive archive download returned ${bytes.length} bytes; expected ${expectedSize}.`,
        );
      }
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > expectedSize) {
          await reader.cancel();
          throw new Error("Google Drive archive download exceeded the verified archive size.");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    if (total !== expectedSize) {
      throw new Error(
        `Google Drive archive download returned ${total} bytes; expected ${expectedSize}.`,
      );
    }
    return Buffer.concat(chunks, total);
  } catch (error: unknown) {
    if (timeout.signal.aborted) {
      throw new Error("Google Drive archive download timed out or was cancelled.");
    }
    if (error instanceof Error && error.message.startsWith("Google Drive ")) throw error;
    throw new Error("Google Drive archive download failed. Check the connection and network, then try again.");
  } finally {
    timeout.dispose();
  }
}

export async function getGoogleDriveFileById(
  fileId: string,
  signal?: AbortSignal,
): Promise<GoogleDriveBackupFile | null> {
  const params = new URLSearchParams({
    fields: "id,name,size,createdTime,webViewLink,parents,mimeType",
  });
  const response = await driveRequest(
    `/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(describeDriveRequestFailure(response.status, "archive verification"));
  }
  let file: DriveFile;
  try {
    file = await response.json() as DriveFile;
  } catch {
    throw new Error("Google Drive returned invalid metadata during archive verification.");
  }
  return normalizeDriveFile(file);
}

export async function verifyGoogleDriveBackup(
  uploaded: GoogleDriveUploadResult,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new Error("Google Drive verification aborted because the backup run exceeded its time budget.");
  }
  const remote = await getGoogleDriveFileById(uploaded.id, signal);
  if (!remote) {
    throw new Error(
      `Google Drive did not contain the uploaded archive "${uploaded.name}" during verification.`,
    );
  }
  if (remote.id !== uploaded.id || remote.name !== uploaded.name ||
      remote.size !== expectedSize || !remote.parentIds.includes(uploaded.folderId)) {
    throw new Error(
      `Google Drive archive verification failed: expected ${expectedSize} bytes for "${uploaded.name}", ` +
      `but the stored item reported ${remote.size} bytes.`,
    );
  }
  logger.info(
    { fileName: remote.name, size: remote.size },
    "[backup] Google Drive upload verified against the backup folder",
  );
}

export async function listGoogleDriveBackupFiles(
  folderId?: string,
): Promise<GoogleDriveBackupFile[]> {
  const targetFolderId = folderId ?? await getGoogleDriveBackupFolderId();
  const query = [
    `'${escapeDriveQueryString(targetFolderId)}' in parents`,
    "trashed = false",
    `mimeType != '${GOOGLE_FOLDER_MIME_TYPE}'`,
  ].join(" and ");
  const driveFiles = await listDriveFiles(
    query,
    "id,name,size,createdTime,webViewLink,mimeType,parents",
  );
  return driveFiles
    .filter((file) =>
      typeof file.id === "string" &&
      typeof file.name === "string" &&
      isGoogleDriveArchiveName(file.name) &&
      file.mimeType !== GOOGLE_FOLDER_MIME_TYPE &&
      Array.isArray(file.parents) &&
      file.parents.includes(targetFolderId),
    )
    .map(normalizeDriveFile)
    .filter((file): file is GoogleDriveBackupFile => file !== null)
    .sort((a, b) => Date.parse(b.createdDateTime) - Date.parse(a.createdDateTime));
}

export async function deleteGoogleDriveBackupFile(fileId: string): Promise<void> {
  const response = await driveRequest(
    `/drive/v3/files/${encodeURIComponent(fileId)}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 204) {
    throw new Error(describeDriveRequestFailure(response.status, "retention deletion"));
  }
}

export function googleDriveItemPath(fileId: string): string {
  return `GoogleDrive:item:${encodeURIComponent(fileId)}`;
}

