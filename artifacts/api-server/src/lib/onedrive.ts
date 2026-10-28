import { retryOneDriveUploadResponse } from "./onedrive-upload-retry";
import { isDatabaseProtectionObjectName } from "./database-protection-object-name";
/**
 * OneDrive (Microsoft Graph) backup destination.
 *
 * Credentials come from the Replit-managed Microsoft OneDrive connector, not
 * from env vars: the server fetches a short-lived Graph access token from the
 * Replit connector proxy at request time. The proxy refreshes the underlying
 * OAuth token automatically, so tokens must never be cached long-term here.
 *
 * The app owner connects (or reconnects) their Microsoft account through the
 * Replit workspace integration pane; this module only consumes the result.
 */
import * as fs from "node:fs";
import type { Readable } from "node:stream";
import { logger } from "./logger";
import { abortableBackupOperation, setBackupLiveProgress } from "./backup-phase";
import { createVerifiedBackupDownloadStream } from "./backup-download-stream";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const normalizedSha1 = (value: unknown): string | null =>
  typeof value === "string" && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : null;

/** Folder inside the connected OneDrive where backups are written. */
export const ONEDRIVE_BACKUP_FOLDER = "Apps/LabTrax Backups";

/**
 * Where non-production servers write. Development and CI share the lab's
 * OneDrive account, so without this a workspace archive (built from dev data)
 * would sit in the lab's backup folder looking exactly like a real one — and
 * worse, dev retention would prune the lab's real archives.
 */
export const ONEDRIVE_NON_PRODUCTION_FOLDER = `${ONEDRIVE_BACKUP_FOLDER}/non-production`;

/** True only in the deployed production server. */
export function isProductionDeployment(): boolean {
  return process.env.REPLIT_DEPLOYMENT === "1";
}

/**
 * The folder this server owns. Only production writes to (and prunes) the
 * lab's real backup folder; everything else is confined to a subfolder.
 */
export function getOneDriveBackupFolder(): string {
  return isProductionDeployment() ? ONEDRIVE_BACKUP_FOLDER : ONEDRIVE_NON_PRODUCTION_FOLDER;
}

/**
 * Graph upload-session chunks must be a multiple of 320 KiB.
 * 16 × 320 KiB = 5 MiB per chunk.
 */
const UPLOAD_CHUNK_BYTES = 320 * 1024 * 16;
const UPLOAD_CHUNK_TRANSPORT_RETRIES = 3;
const UPLOAD_CHUNK_RETRY_BASE_DELAY_MS = 250;
const TRANSIENT_UPLOAD_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Minimal fetch shape used by this module (overridable in tests). */
export type OneDriveFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  body?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null;
  headers?: { get(name: string): string | null };
}>;

let _fetchOverride: OneDriveFetch | null = null;

/** Test hook: replace the fetch implementation (pass null to restore). */
export function setOneDriveFetchForTests(f: OneDriveFetch | null): void {
  _fetchOverride = f;
  _tokenCache = null;
}

/**
 * Per-request deadlines.
 *
 * `fetch` has no default timeout: a TCP connection that is accepted and then
 * never answered leaves the promise pending forever. In the scheduled backup
 * that is worse than an error — the run never settles, the in-flight guard is
 * never cleared, and every later interval is skipped with nothing written to
 * backup_runs. A silent stop like that is exactly how an off-site backup can
 * go missing for weeks. Every Graph call below therefore carries an abort
 * deadline so a hung network path surfaces as a recorded, alerting failure.
 */
const GRAPH_METADATA_TIMEOUT_MS = 60_000;
/** One 5 MiB chunk; generous because large uploads share the connection. */
const GRAPH_UPLOAD_TIMEOUT_MS = 300_000;
/** Whole-file download of a multi-hundred-MB archive. */
const GRAPH_DOWNLOAD_TIMEOUT_MS = 1_800_000;

/**
 * Explain provider failures without copying response bodies or signed URLs.
 */
function oneDriveFailureGuidance(status: number): string {
  if (status === 401) return "Reconnect the OneDrive integration before retrying.";
  if (status === 403) return "Confirm this OneDrive account permits access to the configured backup folder.";
  if (status === 507) return "Check OneDrive storage capacity; no existing backups were deleted.";
  if ([429, 500, 502, 503, 504].includes(status)) {
    return "The provider is temporarily unavailable. Retry after the service recovers.";
  }
  return "Check the OneDrive connection and destination before retrying.";
}

/** Fetch with a hard deadline, aborting a hung request rather than waiting indefinitely. */
async function gfetch(
  url: string,
  init?: Parameters<OneDriveFetch>[1],
  timeoutMs: number = GRAPH_METADATA_TIMEOUT_MS,
): ReturnType<OneDriveFetch> {
  const impl = _fetchOverride ?? (fetch as unknown as OneDriveFetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Chain the caller's signal into this request's own timeout rather than
  // replacing it. Each chunk gets a generous per-request budget, so without
  // this a run that has already blown its overall deadline would keep
  // uploading — holding the in-flight guard for the rest of a
  // multi-hundred-megabyte archive instead of ending as a failed run.
  const callerSignal = init?.signal ?? undefined;
  const abortFromCaller = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  }
  try {
    return await impl(url, { ...(init ?? {}), signal: controller.signal });
  } catch (err: unknown) {
    const aborted =
      controller.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
    if (aborted) {
      const parsed = new URL(url, "https://graph.microsoft.com");
      const where = parsed.hostname === "graph.microsoft.com" ? parsed.pathname : "upload session";
      if (callerSignal?.aborted) {
        throw new Error(
          `OneDrive request aborted (${where}) — the backup run exceeded its overall time budget.`,
        );
      }
      throw new Error(
        `OneDrive request timed out after ${Math.round(timeoutMs / 1000)}s (${where}).`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

let _tokenCache: { token: string; fetchedAtMs: number } | null = null;
const TOKEN_CACHE_MS = 60_000;

/**
 * True when the Replit connector infrastructure is reachable from this
 * process (dev workspace or Replit deployment). Says nothing about whether
 * the OneDrive account has actually been connected yet.
 */
export function isOneDriveConnectorAvailable(): boolean {
  return Boolean(
    process.env.REPLIT_CONNECTORS_HOSTNAME &&
      (process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL),
  );
}

async function getOneDriveAccessToken(): Promise<string> {
  if (_tokenCache && Date.now() - _tokenCache.fetchedAtMs < TOKEN_CACHE_MS) {
    return _tokenCache.token;
  }
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
      ? `depl ${process.env.WEB_REPL_RENEWAL}`
      : null;
  if (!hostname || !xReplitToken) {
    throw new Error(
      "OneDrive backups are not available in this environment (connector infrastructure not found).",
    );
  }
  const resp = await gfetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=onedrive`,
    { headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken } },
  );
  if (!resp.ok) {
    throw new Error(`Failed to look up the OneDrive connection (HTTP ${resp.status}).`);
  }
  const data = (await resp.json()) as {
    items?: Array<{
      settings?: {
        access_token?: string;
        oauth?: { credentials?: { access_token?: string } };
      };
    }>;
  };
  const settings = data.items?.[0]?.settings;
  const token = settings?.access_token ?? settings?.oauth?.credentials?.access_token;
  if (!token) {
    throw new Error(
      "OneDrive is not connected. Connect the Microsoft OneDrive integration for this app, then try again.",
    );
  }
  _tokenCache = { token, fetchedAtMs: Date.now() };
  return token;
}

export interface OneDriveStatus {
  connected: boolean;
  accountName: string | null;
  accountEmail: string | null;
  folder: string;
  error: string | null;
  /**
   * Where the admin connects or reconnects the Microsoft account. The OAuth
   * handshake is completed through the Replit-managed connector pane in the
   * hosting workspace, so this is the workspace URL (null when the hosting
   * environment does not expose its identity).
   */
  manageUrl: string | null;
}

/**
 * URL of the hosting workspace where the OneDrive connector is managed.
 * Connect/reconnect happens there: the Backup settings page opens this URL
 * so the admin can complete (or redo) the Microsoft OAuth handshake.
 */
export function getOneDriveManageUrl(): string | null {
  const owner = process.env.REPL_OWNER;
  const slug = process.env.REPL_SLUG;
  if (!owner || !slug) return null;
  return `https://replit.com/@${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
}

/**
 * Report whether a OneDrive account is connected and usable. Never throws —
 * failures come back as { connected: false, error }.
 */
export async function getOneDriveStatus(): Promise<OneDriveStatus> {
  const base = {
    accountName: null as string | null,
    accountEmail: null as string | null,
    folder: getOneDriveBackupFolder(),
    manageUrl: getOneDriveManageUrl(),
  };
  if (!isOneDriveConnectorAvailable()) {
    return {
      connected: false,
      ...base,
      error: "OneDrive backups are not available in this environment.",
    };
  }
  try {
    const token = await getOneDriveAccessToken();
    const resp = await gfetch(
      `${GRAPH_BASE}/me?$select=displayName,mail,userPrincipalName`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) {
      _tokenCache = null;
      return {
        connected: false,
        ...base,
        error: `Microsoft rejected the OneDrive credentials (HTTP ${resp.status}). Reconnect the OneDrive integration.`,
      };
    }
    const me = (await resp.json()) as {
      displayName?: string | null;
      mail?: string | null;
      userPrincipalName?: string | null;
    };
    return {
      ...base,
      connected: true,
      accountName: me.displayName ?? null,
      accountEmail: me.mail ?? me.userPrincipalName ?? null,
      error: null,
    };
  } catch (err: unknown) {
    return {
      connected: false,
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface OneDriveUploadResult {
  itemId: string;
  /**
   * The name OneDrive actually stored. Graph's "rename" conflict behaviour can
   * differ from the requested name, so this is read back from the completed
   * item rather than assumed.
   */
  fileName: string;
  size: number;
  webUrl: string | null;
  folder: string;
}

/**
 * Graph upload sessions are resumable: a failed/disconnected range request
 * transfers no bytes, so retry that same range on the existing session. Do
 * not retry HTTP responses here; callers handle them as explicit Graph errors.
 */
function isTransientUploadTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "fetch failed") return true;

  const directCode = (error as Error & { code?: unknown }).code;
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeCode =
    cause && typeof cause === "object" && "code" in cause
      ? (cause as { code?: unknown }).code
      : undefined;
  const code = directCode ?? causeCode;
  return typeof code === "string" && TRANSIENT_UPLOAD_ERROR_CODES.has(code);
}

/** Open a Graph resumable upload session and return its upload URL. */
async function createOneDriveUploadSession(
  fileName: string,
  folder: string = getOneDriveBackupFolder(),
  signal?: AbortSignal,
): Promise<string> {
  const token = await getOneDriveAccessToken();
  const itemPath = `${folder}/${fileName}`
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const sessionResp = await retryOneDriveUploadResponse(() => gfetch(
    `${GRAPH_BASE}/me/drive/root:/${itemPath}:/createUploadSession`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        item: { "@microsoft.graph.conflictBehavior": "rename", name: fileName },
      }),
      signal,
    },
  ), signal);
  if (!sessionResp.ok) {
    await sessionResp.text().catch(() => "");
    throw new Error(
      `OneDrive upload-session create failed (HTTP ${sessionResp.status}). ${oneDriveFailureGuidance(sessionResp.status)}`,
    );
  }
  const session = (await sessionResp.json()) as { uploadUrl?: string };
  if (!session.uploadUrl) {
    throw new Error("OneDrive did not return an upload URL.");
  }
  return session.uploadUrl;
}

/**
 * Drive a Graph upload session to completion, pulling each chunk on demand via
 * `readChunk` so the caller decides whether the bytes come from memory or disk.
 * Only one chunk (5 MiB) is resident at a time.
 */
async function uploadSessionChunks(
  uploadUrl: string,
  totalSize: number,
  fileName: string,
  readChunk: (offset: number, length: number) => Buffer | Promise<Buffer>,
  folder: string = getOneDriveBackupFolder(),
  signal?: AbortSignal,
): Promise<OneDriveUploadResult> {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let finalItem: { id: string; name: string; size: number; webUrl?: string } | null = null;
  for (let offset = 0; offset < totalSize; offset += UPLOAD_CHUNK_BYTES) {
    // A run that has blown its deadline must stop uploading rather than hold
    // the in-flight guard for the rest of a multi-hundred-megabyte archive.
    if (signal?.aborted) {
      throw new Error(
        `OneDrive upload aborted before bytes ${offset} of ${fileName} — the run exceeded its time budget.`,
      );
    }
    const end = Math.min(offset + UPLOAD_CHUNK_BYTES, totalSize);
    const chunk = await abortableBackupOperation(Promise.resolve(readChunk(offset, end - offset)), signal);
    if (chunk.length !== end - offset) {
      throw new Error("OneDrive upload aborted: backup source returned an incorrect chunk size.");
    }
    let resp: Awaited<ReturnType<typeof gfetch>>;
    for (let attempt = 0; ; attempt += 1) {
      try {
        resp = await retryOneDriveUploadResponse(() => gfetch(
          uploadUrl,
          {
            method: "PUT",
            headers: {
              "Content-Length": String(chunk.length),
              "Content-Range": `bytes ${offset}-${end - 1}/${totalSize}`,
            },
            body: chunk,
            signal,
          },
          GRAPH_UPLOAD_TIMEOUT_MS,
        ), signal);
        break;
      } catch (error) {
        if (signal?.aborted || !isTransientUploadTransportError(error)) {
          throw error;
        }
        if (attempt >= UPLOAD_CHUNK_TRANSPORT_RETRIES) {
          throw new Error(
            `OneDrive chunk upload transport failed after ${attempt + 1} attempts ` +
            `at bytes ${offset}-${end - 1} of ${totalSize}.`,
          );
        }
        const retryDelayMs = UPLOAD_CHUNK_RETRY_BASE_DELAY_MS * 2 ** attempt;
        logger.warn(
          {
            fileName,
            rangeStart: offset,
            rangeEnd: end - 1,
            retry: attempt + 1,
            retryDelayMs,
          },
          "[backup] OneDrive chunk transport failed; retrying the same upload range",
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        if (signal?.aborted) {
          throw new Error(
            `OneDrive upload aborted before retrying bytes ${offset}-${end - 1} — ` +
            "the run exceeded its time budget.",
          );
        }
      }
    }
    if (!resp.ok) {
      await resp.text().catch(() => "");
      throw new Error(
        `OneDrive chunk upload failed (HTTP ${resp.status}) at bytes ${offset}-${end - 1}. ${oneDriveFailureGuidance(resp.status)}`,
      );
    }
    if (resp.status === 200 || resp.status === 201) {
      if (end !== totalSize) {
        throw new Error("OneDrive reported completion before the final chunk.");
      }
      const item = (await resp.json().catch(() => null)) as {
        id?: unknown; name?: unknown; size?: unknown; webUrl?: string;
      } | null;
      if (!item || typeof item.size !== "number" || !Number.isSafeInteger(item.size) ||
          item.size !== totalSize) {
        throw new Error("OneDrive completed item size is missing or does not match the archive.");
      }
      if (typeof item.id !== "string" || !item.id.trim() ||
          typeof item.name !== "string" || !item.name.trim() || /[/\\\r\n]/.test(item.name)) {
        throw new Error("OneDrive completed item identity or name is missing or invalid.");
      }
      finalItem = { id: item.id, name: item.name, size: item.size, webUrl: item.webUrl };
    } else if (resp.status !== 202 || end === totalSize) {
      throw new Error("OneDrive upload finished without a completed-item response.");
    }
    setBackupLiveProgress({ uploadedBytes: end, uploadTotalBytes: totalSize });
    if (Date.now() - lastProgressAt >= 30_000 || end === totalSize) {
      logger.info({ elapsedMs: Date.now() - startedAt, uploadedBytes: end, totalBytes: totalSize },
        "[backup] OneDrive transfer progress");
      lastProgressAt = Date.now();
    }
  }
  if (!finalItem) {
    throw new Error("OneDrive upload finished without a completed-item response.");
  }
  // Report the name and id OneDrive kept, not the name we asked for: a
  // conflicting upload is stored under a renamed copy, and backup history must
  // address the file that actually exists.
  const storedName = finalItem.name ?? fileName;
  logger.info(
    { requestedFileName: fileName, fileName: finalItem.name, itemId: finalItem.id, size: finalItem.size },
    "[backup] OneDrive upload complete",
  );
  return {
    itemId: finalItem.id,
    fileName: finalItem.name,
    size: finalItem.size,
    webUrl: finalItem.webUrl ?? null,
    folder,
  };
}

/**
 * Upload an encrypted backup buffer to the connected OneDrive using a Graph
 * upload session (chunked, so large backups work). Throws on any failure.
 *
 * Prefer `uploadBackupFileToOneDrive` for real backups — this variant requires
 * the whole archive to already be resident in the heap.
 */
export async function uploadBackupToOneDrive(
  buffer: Buffer,
  fileName: string,
  options: { folder?: string; signal?: AbortSignal } = {},
): Promise<OneDriveUploadResult> {
  const folder = options.folder ?? getOneDriveBackupFolder();
  const uploadUrl = await createOneDriveUploadSession(fileName, folder, options.signal);
  return uploadSessionChunks(
    uploadUrl,
    buffer.length,
    fileName,
    (offset, length) => buffer.subarray(offset, offset + length),
    folder,
    options.signal,
  );
}

/**
 * Upload an encrypted backup that lives on disk, reading one 5 MiB chunk at a
 * time. Server memory stays flat regardless of how large the backup is, which
 * is what keeps the hourly scheduled backup from OOM-killing the process.
 */
export async function uploadBackupFileToOneDrive(
  filePath: string,
  fileName: string,
  options: { folder?: string; signal?: AbortSignal } = {},
): Promise<OneDriveUploadResult> {
  const folder = options.folder ?? getOneDriveBackupFolder();
  const totalSize = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, "r");
  try {
    const uploadUrl = await createOneDriveUploadSession(fileName, folder, options.signal);
    return await uploadSessionChunks(uploadUrl, totalSize, fileName, (offset, length) => {
      const buf = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, offset);
      // Never send a short body under a full-length Content-Range — Graph would
      // either reject it confusingly or, worse, accept a corrupt backup. Fail
      // loudly and locally instead.
      if (bytesRead !== length) {
        throw new Error(
          `OneDrive upload aborted: short read from ${fileName} at bytes ` +
          `${offset}-${offset + length - 1} (got ${bytesRead} of ${length}). ` +
          "The backup archive was truncated or modified mid-upload.",
        );
      }
      return buf;
    }, folder, options.signal);
  } finally {
    fs.closeSync(fd);
  }
}

/** A sealed cloud archive can supply bounded ranges without a local ZIP file. */
export async function uploadBackupSourceToOneDrive(
  source: { size: number; readChunk: (offset: number, length: number) => Promise<Buffer> },
  fileName: string,
  options: { folder?: string; signal?: AbortSignal } = {},
): Promise<OneDriveUploadResult> {
  if (!Number.isSafeInteger(source.size) || source.size <= 0) {
    throw new Error("OneDrive backup source must have a verified positive byte size.");
  }
  options.signal?.throwIfAborted();
  const folder = options.folder ?? getOneDriveBackupFolder();
  const uploadUrl = await createOneDriveUploadSession(fileName, folder, options.signal);
  return uploadSessionChunks(uploadUrl, source.size, fileName,
    (offset, length) => source.readChunk(offset, length), folder, options.signal);
}

export interface OneDriveBackupFile {
  id: string;
  name: string;
  size: number;
  createdDateTime: string;
  webUrl: string | null;
  /** Graph's provider-calculated file checksum; absent for some items/accounts. */
  sha1Hash?: string | null;
  driveId?: string;
  contentTag?: string;
}

/**
 * List all files in the OneDrive backup folder, sorted by creation time
 * (newest first). Returns an empty array if the folder does not exist yet.
 * Throws on auth or unexpected Graph errors.
 *
 * Note: this deliberately does NOT use Graph's `$orderby` query parameter.
 * Personal (consumer) OneDrive accounts only support ordering `driveItem`
 * children by `name` — passing `$orderby=createdDateTime desc` is rejected
 * with a generic "HTTP 400 Bad Request" on those accounts (business/SharePoint
 * drives allow it, personal drives don't). Sorting is done client-side below
 * instead so this works for both account types.
 */
export async function listOneDriveBackupFiles(
  folder: string = getOneDriveBackupFolder(),
  options: { databaseProtection?: boolean } = {},
): Promise<OneDriveBackupFile[]> {
  const token = await getOneDriveAccessToken();
  const folderPath = folder.split("/").map(encodeURIComponent).join("/");
  const files: OneDriveBackupFile[] = [];

  // Graph pages `children` (200 per page here). Time-tiered retention keeps
  // well over one page of archives, and a single-page read would silently
  // treat page 1 as the whole folder — making retention delete the wrong
  // files and "is my backup there?" checks answer from partial data.
  // `folder` is selected so subfolders can be told apart from archives. The
  // non-production subfolder lives inside the production backup folder, and a
  // directory listed as if it were a backup would be both a bogus entry in
  // "is my backup there?" answers and a deletable item for retention — which
  // would take every archive inside it along with it.
  let url: string | null =
    `${GRAPH_BASE}/me/drive/root:/${folderPath}:/children` +
    `?$select=id,name,size,createdDateTime,webUrl,folder,file,remoteItem,cTag,parentReference&$top=200`;
  const visited = new Set<string>();

  while (url) {
    const pageUrl = new URL(url);
    if (pageUrl.origin !== "https://graph.microsoft.com" || pageUrl.username || pageUrl.password ||
        pageUrl.hash ||
        !/^\/v1\.0\/(?:me\/drive\/|drives\/[^/]+\/).+\/children$/.test(pageUrl.pathname) ||
        visited.has(pageUrl.href)) {
      throw new Error("OneDrive folder list returned an unsafe or repeated pagination link.");
    }
    visited.add(pageUrl.href);
    const resp = await gfetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.status === 404 && visited.size === 1) {
      return [];
    }
    if (!resp.ok) {
      await resp.text().catch(() => "");
      throw new Error(
        `OneDrive folder list failed (HTTP ${resp.status}). ${oneDriveFailureGuidance(resp.status)}`,
      );
    }
    const data = (await resp.json()) as {
      value?: Array<{
        id: string;
        name: string;
        size?: number;
        createdDateTime?: string;
        webUrl?: string | null;
        folder?: { childCount?: number } | null;
        file?: { hashes?: { sha1Hash?: string | null } | null } | null;
        remoteItem?: object | null;
        cTag?: string | null;
        parentReference?: { driveId?: string } | null;
      }>;
      "@odata.nextLink"?: string;
    };
    if (!Array.isArray(data.value)) {
      throw new Error("OneDrive folder list returned a malformed page.");
    }
    for (const item of data.value) {
      if (!item || item.folder || item.remoteItem || !item.file ||
          typeof item.id !== "string" || !item.id ||
          typeof item.name !== "string" ||
          !(options.databaseProtection
            ? isDatabaseProtectionObjectName(item.name)
            : isOneDriveArchiveName(item.name))) continue;
      files.push({
        id: item.id,
        name: item.name,
        size: item.size ?? 0,
        createdDateTime: item.createdDateTime ?? "",
        webUrl: item.webUrl ?? null,
        sha1Hash: normalizedSha1(item.file?.hashes?.sha1Hash),
        ...(item.parentReference?.driveId ? {driveId:item.parentReference.driveId} : {}),
        ...(typeof item.cTag==="string" ? {contentTag:item.cTag} : {}),
      });
    }
    const next = data["@odata.nextLink"];
    if (next !== undefined && (typeof next !== "string" || !next)) {
      throw new Error("OneDrive folder list returned a malformed pagination link.");
    }
    url = next ?? null;
  }

  files.sort(
    (a, b) => new Date(b.createdDateTime).getTime() - new Date(a.createdDateTime).getTime(),
  );
  return files;
}

/**
 * Read one file's metadata straight from OneDrive by name. Returns null when
 * the file is not in the folder.
 *
 * This is the independent read-back used to verify an upload: the upload
 * response is the sender's account of what happened, while this is the
 * drive's. A backup is only called successful once the bytes are confirmed
 * present at the expected size by this call.
 */
export async function getOneDriveFileByName(
  fileName: string,
  folder: string = getOneDriveBackupFolder(),
  itemId?: string,
): Promise<OneDriveBackupFile | null> {
  const token = await getOneDriveAccessToken();
  const itemPath = `${folder}/${fileName}`.split("/").map(encodeURIComponent).join("/");
  const resp = await gfetch(
    itemId
      ? `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}?$select=id,name,size,createdDateTime,webUrl,file,parentReference,cTag`
      : `${GRAPH_BASE}/me/drive/root:/${itemPath}?$select=id,name,size,createdDateTime,webUrl,file,parentReference,cTag`,
    { headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" } },
  );
  if (resp.status === 404) return null;
  if (!resp.ok) {
    await resp.text().catch(() => "");
    throw new Error(
      `OneDrive file lookup failed (HTTP ${resp.status}) for "${fileName}". ${oneDriveFailureGuidance(resp.status)}`,
    );
  }
  const item = (await resp.json()) as {
    id?: string;
    name?: string;
    size?: number;
    createdDateTime?: string;
    webUrl?: string | null;
    file?: { hashes?: { sha1Hash?: string | null } | null } | null;
    cTag?: string;
    parentReference?: { driveId?: string };
  };
  if (typeof item.id !== "string" || !item.id || typeof item.name !== "string" || !item.name ||
      typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0) {
    throw new Error("OneDrive file lookup returned missing or invalid item identity, name, or size.");
  }
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    createdDateTime: item.createdDateTime ?? new Date(0).toISOString(),
    webUrl: item.webUrl ?? null,
    sha1Hash: normalizedSha1(item.file?.hashes?.sha1Hash),
    ...(typeof item.cTag === "string" ? { contentTag: item.cTag } : {}),
    ...(typeof item.parentReference?.driveId === "string" ? { driveId: item.parentReference.driveId } : {}),
  };
}

/**
 * Delete a single OneDrive file by its Graph item ID. Throws on failure.
 */
export async function deleteOneDriveBackupFile(fileId: string): Promise<void> {
  const token = await getOneDriveAccessToken();
  const resp = await gfetch(
    `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok && resp.status !== 204) {
    throw new Error(
      `OneDrive file delete failed (HTTP ${resp.status}) for item ${fileId}.`,
    );
  }
}

/**
 * Hard upper bound on how many archives the backup folder may hold. This is a
 * storage guard, not the retention rule — the time tiers below decide which
 * archives are worth keeping, and only then does this cap trim the oldest
 * survivors.
 */
export const DEFAULT_ONEDRIVE_RETENTION_MAX_BACKUPS = 250;

/**
 * The floor no configured policy may go below: the newest 30 archives are
 * always kept. Retention settings are editable, and a cap set to a handful of
 * files would leave the lab with hours of history instead of days — the exact
 * position the eighteen-day gap put it in. A smaller configured cap is raised
 * to this number rather than honoured.
 */
export const ONEDRIVE_MIN_RETAINED_ARCHIVES = 30;

/** File name suffix of a LabTrax archive. Retention deletes nothing else. */
export const ONEDRIVE_ARCHIVE_SUFFIX = ".zip.enc";

/** Graph can insert a collision suffix between ".zip" and ".enc". */
export function isOneDriveArchiveName(name: string): boolean {
  return /\.zip(?: \d+| \(\d+\))?\.enc$/.test(name);
}

/** Store a stable item reference in backup_runs.path, without a schema migration. */
export function oneDriveItemPath(itemId: string): string {
  return `OneDrive:item:${encodeURIComponent(itemId)}`;
}

export function oneDriveItemIdFromPath(path: string | null): string | undefined {
  if (!path?.startsWith("OneDrive:item:")) return undefined; // legacy name-based history
  const id = decodeURIComponent(path.slice("OneDrive:item:".length));
  if (!id.trim()) throw new Error("The recorded OneDrive item ID is empty.");
  return id;
}

/**
 * Time-tiered retention.
 *
 * A flat "keep the newest N files" rule cannot serve a fifteen-minute cadence:
 * at 96 archives a day, any count small enough to be affordable covers only a
 * few hours, so a problem noticed days later has nothing left to restore from.
 * Tiers keep the recent past dense and the older past sparse, which is what
 * makes "we discovered this on Friday, roll back to Tuesday" possible at a
 * fraction of the storage.
 */
export interface OneDriveRetentionPolicy {
  /** Verified complete recovery points; incomplete copies cannot displace their floor. */
  completeItemIds?: string[];
  /** Keep every archive created within this many hours. */
  keepAllWithinHours: number;
  /** Beyond that, keep the newest archive of each hour for this many days. */
  keepHourlyWithinDays: number;
  /** Beyond that, keep the newest archive of each day for this many days. */
  keepDailyWithinDays: number;
  /** Absolute ceiling on retained files (storage guard). */
  maxFiles: number;
  /**
   * Always keep this many newest archives, whatever the tiers say. When
   * backups have been sparse — exactly when the lab is in trouble — tier
   * thinning would otherwise collapse a cluster of hourly archives down to
   * one per day and throw away the only copies anyone can still recover from.
   */
  keepNewestCount: number;
}

export const DEFAULT_ONEDRIVE_RETENTION_POLICY: OneDriveRetentionPolicy = {
  keepAllWithinHours: 12,
  keepHourlyWithinDays: 3,
  keepDailyWithinDays: 30,
  maxFiles: DEFAULT_ONEDRIVE_RETENTION_MAX_BACKUPS,
  keepNewestCount: 30,
};

export interface ParsedBackupFileName {
  /** Null when the name does not carry a readable timestamp. */
  takenAt: Date | null;
  isDatabaseOnly: boolean;
  isLabTraxBackup: boolean;
}

/**
 * Read the run time and archive kind out of an archive's name.
 *
 * Handles both the current `labtrax-backup-2026-10-06T154500Z-db-only.zip.enc`
 * form and the legacy date-only `labtrax-backup-2026-09-18.zip.enc` names
 * (including the ` 22.enc` copies Graph's rename conflict behaviour produced),
 * which are always full archives.
 */
export function parseBackupFileName(name: string): ParsedBackupFileName {
  const isLabTraxBackup = name.startsWith("labtrax-backup-");
  if (!isLabTraxBackup) {
    return { takenAt: null, isDatabaseOnly: false, isLabTraxBackup: false };
  }
  const isDatabaseOnly = /-db-only(\b|[.\- ])/.test(name);

  const timestamped = name.match(
    /^labtrax-backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
  );
  if (timestamped) {
    const [, y, mo, d, h, mi, s] = timestamped;
    const takenAt = new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
    );
    return {
      takenAt: Number.isNaN(takenAt.getTime()) ? null : takenAt,
      isDatabaseOnly,
      isLabTraxBackup: true,
    };
  }

  const dateOnly = name.match(/^labtrax-backup-(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    const takenAt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    return {
      takenAt: Number.isNaN(takenAt.getTime()) ? null : takenAt,
      isDatabaseOnly,
      isLabTraxBackup: true,
    };
  }
  return { takenAt: null, isDatabaseOnly, isLabTraxBackup: true };
}

/**
 * Decide which archives to delete. Pure (no network) so the policy can be
 * tested directly against awkward histories — clock skew, bursts, gaps.
 *
 * The newest archive is never selected for deletion, whatever the policy says:
 * an empty backup folder is never an improvement over a stale one.
 */
export function selectOneDriveBackupsToPrune(
  files: OneDriveBackupFile[],
  policy: OneDriveRetentionPolicy,
  nowMs: number = Date.now(),
): OneDriveBackupFile[] {
  const sorted = files.filter((file) => isOneDriveArchiveName(file.name)).sort(
    (a, b) => new Date(b.createdDateTime).getTime() - new Date(a.createdDateTime).getTime(),
  );
  if (sorted.length === 0) return [];
  type Tier = "protected" | "recent" | "hourly" | "daily" | "expired";

  const keepAllCutoff = nowMs - policy.keepAllWithinHours * 60 * 60 * 1000;
  const hourlyCutoff = nowMs - policy.keepHourlyWithinDays * 24 * 60 * 60 * 1000;
  const dailyCutoff = nowMs - policy.keepDailyWithinDays * 24 * 60 * 60 * 1000;

  const seenHours = new Set<string>();
  const seenDays = new Set<string>();
  const keep: OneDriveBackupFile[] = [];
  const drop: OneDriveBackupFile[] = [];
  // The storage ceiling is clamped to the floor: the cap is the one setting an
  // admin can edit, and a cap of a handful of files would leave about an hour
  // of history at a fifteen-minute cadence. The tier counts are not editable,
  // so they are honoured as given (which is what makes them testable).
  const maxFiles =
    policy.maxFiles > 0
      ? Math.max(policy.maxFiles, ONEDRIVE_MIN_RETAINED_ARCHIVES)
      : policy.maxFiles;
  const protectedNewest = new Set(
    sorted.slice(0, Math.max(0, policy.keepNewestCount)).map((f) => f.id),
  );

  const tierOf = (file: OneDriveBackupFile): Tier => {
    if (protectedNewest.has(file.id)) return "protected";
    const ms = new Date(file.createdDateTime).getTime();
    if (!Number.isFinite(ms) || ms >= keepAllCutoff) return "recent";
    if (ms >= hourlyCutoff) return "hourly";
    if (ms >= dailyCutoff) return "daily";
    return "expired";
  };
  const tiers = new Map(sorted.map((f) => [f.id, tierOf(f)] as const));

  // Which archive represents an hour or a day, once that bucket has to be
  // thinned to one. A database-only archive carries no media, so letting one
  // win a bucket would quietly turn that recovery point into a partial
  // restore. Full archives therefore outrank database-only ones, and newest
  // wins among equals. Representatives are chosen within a tier so a bucket
  // straddling a cutoff cannot nominate a file the tier never evaluates.
  const completeIds = new Set(policy.completeItemIds ?? []);
  const isFullArchive = (file: OneDriveBackupFile): boolean =>
    policy.completeItemIds ? completeIds.has(file.id) : !parseBackupFileName(file.name).isDatabaseOnly;
  const representatives = (tier: Tier, sliceEnd: number): Map<string, string> => {
    const rep = new Map<string, OneDriveBackupFile>();
    for (const file of sorted) {
      if (tiers.get(file.id) !== tier) continue;
      const ms = new Date(file.createdDateTime).getTime();
      if (!Number.isFinite(ms)) continue;
      const key = new Date(ms).toISOString().slice(0, sliceEnd);
      const current = rep.get(key);
      // `sorted` is newest-first, so the first file seen for a bucket is its
      // newest; only a full archive may displace a database-only one.
      if (!current || (!isFullArchive(current) && isFullArchive(file))) rep.set(key, file);
    }
    return new Map([...rep].map(([key, file]) => [key, file.id]));
  };
  const hourlyRep = representatives("hourly", 13);
  const dailyRep = representatives("daily", 10);

  for (const file of sorted) {
    if (protectedNewest.has(file.id)) {
      keep.push(file);
      const createdMsProtected = new Date(file.createdDateTime).getTime();
      if (Number.isFinite(createdMsProtected)) {
        const isoProtected = new Date(createdMsProtected).toISOString();
        seenHours.add(isoProtected.slice(0, 13));
        seenDays.add(isoProtected.slice(0, 10));
      }
      continue;
    }
    const createdMs = new Date(file.createdDateTime).getTime();
    // An unparseable or future timestamp must never make a file eligible for
    // deletion by accident — treat it as current and keep it.
    if (!Number.isFinite(createdMs) || createdMs >= keepAllCutoff) {
      keep.push(file);
      continue;
    }
    const iso = new Date(createdMs).toISOString();
    const hourKey = iso.slice(0, 13);
    const dayKey = iso.slice(0, 10);

    if (createdMs >= hourlyCutoff) {
      if (seenHours.has(hourKey) || hourlyRep.get(hourKey) !== file.id) drop.push(file);
      else {
        seenHours.add(hourKey);
        seenDays.add(dayKey);
        keep.push(file);
      }
      continue;
    }
    if (createdMs >= dailyCutoff) {
      if (seenDays.has(dayKey) || dailyRep.get(dayKey) !== file.id) drop.push(file);
      else {
        seenDays.add(dayKey);
        keep.push(file);
      }
      continue;
    }
    drop.push(file);
  }

  // Storage ceiling: trim the oldest survivors last, so the tiers decide
  // *which* history is valuable and the cap only decides how much fits.
  if (maxFiles > 0 && keep.length > maxFiles) {
    drop.push(...keep.slice(maxFiles));
  }

  const newestId = sorted[0]!.id;
  const completeFloor = new Set(sorted.filter(file => completeIds.has(file.id))
    .slice(0, Math.max(1, policy.keepNewestCount)).map(file => file.id));
  return drop.filter((f) => f.id !== newestId && !completeFloor.has(f.id));
}

/**
 * Download a backup file from OneDrive by its fileName (relative to the backup
 * folder). Returns the raw encrypted Buffer. Throws on auth or network errors.
 */
export async function downloadFileFromOneDrive(
  fileName: string,
  expectedSize: number,
  folder: string = getOneDriveBackupFolder(),
  itemId?: string,
  signal?: AbortSignal,
): Promise<Readable> {
  if (!fileName.trim() || !Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new Error("OneDrive archive download requires a file name and valid expected size.");
  }
  const token = await getOneDriveAccessToken();
  if (signal?.aborted) throw new Error("OneDrive archive download was cancelled.");
  const filePath = `${folder}/${fileName}`
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const impl = _fetchOverride ?? (fetch as unknown as OneDriveFetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPH_DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  };
  try {
    const resp = await impl(
      itemId
        ? `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}/content`
        : `${GRAPH_BASE}/me/drive/root:/${filePath}:/content`,
      { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
    );
    if (!resp.ok) {
      throw new Error(
        `OneDrive download failed (HTTP ${resp.status}) for file "${fileName}".`,
      );
    }
    const declaredSize = resp.headers?.get("Content-Length");
    if (declaredSize !== null && declaredSize !== undefined && Number(declaredSize) !== expectedSize) {
      throw new Error(
        `OneDrive archive download reported ${declaredSize} bytes; expected ${expectedSize}.`,
      );
    }
    if (!resp.body) throw new Error("OneDrive archive download returned no stream.");
    return createVerifiedBackupDownloadStream(resp.body, expectedSize, "OneDrive", dispose);
  } catch (error: unknown) {
    dispose();
    if (controller.signal.aborted) {
      throw new Error("OneDrive archive download timed out or was cancelled.");
    }
    if (error instanceof Error && error.message.startsWith("OneDrive ")) throw error;
    throw new Error("OneDrive archive download failed. Check the connection and try again.");
  }
}

/**
 * Apply the time-tiered retention policy to the OneDrive backup folder.
 *
 * Never throws — individual delete failures are logged as warnings and the
 * remaining files are still attempted. A list failure is also non-fatal.
 *
 * Returns the file names that were successfully deleted.
 */
export async function pruneOneDriveBackups(
  policy: OneDriveRetentionPolicy,
): Promise<string[]> {
  const pruned: string[] = [];
  try {
    // Retention only ever considers archives. Directories are already filtered
    // out by the listing, and anything else a person may have put in the
    // folder is not this job's to delete.
    const files = await listOneDriveBackupFiles();
    const toDelete = selectOneDriveBackupsToPrune(files, policy);
    for (const file of toDelete) {
      try {
        await deleteOneDriveBackupFile(file.id);
        pruned.push(file.name);
        logger.info(
          { fileName: file.name, fileId: file.id },
          "[backup] OneDrive retention: pruned old backup",
        );
      } catch (err: unknown) {
        logger.warn(
          {
            fileName: file.name,
            fileId: file.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "[backup] OneDrive retention: failed to delete file (non-fatal)",
        );
      }
    }
  } catch (err: unknown) {
    // A missing folder is already handled inside listOneDriveBackupFiles
    // (it returns [] on 404), so anything that reaches here is a genuine,
    // unexpected failure (auth, network, Graph API error). Retention is
    // still non-fatal to the overall backup — the upload already succeeded —
    // but log it loudly (error, not warn) with full detail so it doesn't
    // silently mask indefinite backup accumulation.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[backup] OneDrive retention: failed to list backup folder — old backups were NOT pruned this run",
    );
  }
  return pruned;
}
