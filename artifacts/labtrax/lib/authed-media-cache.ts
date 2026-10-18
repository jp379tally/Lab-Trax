import * as FileSystem from "expo-file-system/legacy";
import { getApiUrl, getAccessToken, refreshAndGetAccessToken } from "./query-client";
import { isSameApiOrigin } from "./case-media-source";
import { fileExtension, VIDEO_EXTENSION_MIME } from "./video-asset";

const CACHE_DIR = `${FileSystem.cacheDirectory ?? ""}labtrax-media/`;
/** Protected case media files are retained for at most seven days. */
export const AUTHED_MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTHED_MEDIA_MAX_BYTES = 256 * 1024 * 1024;
export const AUTHED_MEDIA_MAX_ENTRIES = 200;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const activeUris = new Map<string, number>();
const inFlightUris = new Map<string, number>();
const pathOperations = new Map<string, Promise<unknown>>();
let lastPrunedAt = 0;

let cacheReady = false;
let cacheEpoch = 0;
async function ensureCacheDir(): Promise<void> {
  if (cacheReady) return;
  const info = await FileSystem.getInfoAsync(CACHE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
  }
  cacheReady = true;
}

function isProtected(uri: string): boolean {
  return activeUris.has(uri) || inFlightUris.has(uri);
}

function beginWork(uri: string): void {
  inFlightUris.set(uri, (inFlightUris.get(uri) ?? 0) + 1);
}

function endWork(uri: string): void {
  const remaining = (inFlightUris.get(uri) ?? 1) - 1;
  if (remaining > 0) inFlightUris.set(uri, remaining);
  else inFlightUris.delete(uri);
}

function withPathOperation<T>(uri: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathOperations.get(uri) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(operation);
  pathOperations.set(uri, pending);
  void pending.finally(() => {
    if (pathOperations.get(uri) === pending) pathOperations.delete(uri);
  }).catch(() => undefined);
  return pending;
}

export function retainAuthedMediaUri(uri: string | null | undefined): () => void {
  if (!uri?.startsWith(CACHE_DIR)) return () => {};
  activeUris.set(uri, (activeUris.get(uri) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeUris.get(uri) ?? 1) - 1;
    if (remaining > 0) activeUris.set(uri, remaining);
    else activeUris.delete(uri);
  };
}

export async function pruneAuthedMediaCache(now = Date.now()): Promise<void> {
  if (!FileSystem.cacheDirectory) return;
  try {
    await ensureCacheDir();
    const entries = await FileSystem.readDirectoryAsync(CACHE_DIR);
    const candidates = await Promise.all(entries.map(async (entry) => {
      const uri = `${CACHE_DIR}${entry}`;
      return withPathOperation(uri, async () => {
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists) return null;
        return {
          uri,
          size: typeof info.size === "number" ? info.size : 0,
          modifiedAt: typeof info.modificationTime === "number"
            ? info.modificationTime * 1000
            : 0,
        };
      });
    }));
    const existing = candidates
      .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate)
      .sort((a, b) => a.modifiedAt - b.modifiedAt || a.uri.localeCompare(b.uri));
    let totalBytes = existing.reduce((sum, candidate) => sum + candidate.size, 0);
    let totalEntries = existing.length;
    for (const candidate of existing) {
      const expired = now - candidate.modifiedAt > AUTHED_MEDIA_MAX_AGE_MS;
      const overBudget =
        totalBytes > AUTHED_MEDIA_MAX_BYTES ||
        totalEntries > AUTHED_MEDIA_MAX_ENTRIES;
      if (!expired && !overBudget) continue;
      const deleted = await withPathOperation(candidate.uri, async () => {
        if (isProtected(candidate.uri)) return false;
        await FileSystem.deleteAsync(candidate.uri, { idempotent: true });
        return true;
      });
      if (deleted) {
        totalBytes -= candidate.size;
        totalEntries -= 1;
      }
    }
    lastPrunedAt = now;
  } catch {
    // Cache maintenance must never prevent media from loading.
  }
}

export type AcquiredMediaUri = {
  uri: string;
  release: () => void;
};

export async function acquireAuthedMediaUri(
  url: string | null | undefined,
  onProgress?: (progress: number) => void,
  videoFileName?: string | null,
  videoMime?: string | null,
): Promise<AcquiredMediaUri | null> {
  if (!url) return null;
  const absolute = resolveMediaUrl(url);
  const token = getAccessToken();
  if (
    !token ||
    !isSameApiOrigin(absolute) ||
    url.startsWith("data:") ||
    url.startsWith("file://") ||
    url.startsWith("assets-library://") ||
    url.startsWith("ph://")
  ) {
    const uri = await getAuthedMediaUri(url, onProgress, videoFileName, videoMime);
    return uri ? { uri, release: () => {} } : null;
  }

  const epoch = cacheEpoch;
  const path = cachePathFor(absolute, epoch, videoFileName, videoMime);
  const currentOperation = pathOperations.get(path);
  if (currentOperation) await currentOperation.catch(() => undefined);
  const release = retainAuthedMediaUri(path);
  const uri = await getAuthedMediaUri(url, onProgress, videoFileName, videoMime);
  if (!uri) {
    release();
    return null;
  }
  if (uri !== path) {
    release();
    return { uri, release: retainAuthedMediaUri(uri) };
  }
  return { uri, release };
}

async function maybePruneAuthedMediaCache(): Promise<void> {
  const now = Date.now();
  if (now - lastPrunedAt >= PRUNE_INTERVAL_MS) {
    await pruneAuthedMediaCache(now);
  }
}

function urlToFilename(url: string): string {
  const cleaned = url.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(-120);
  return cleaned || "media";
}

function cachePathFor(
  absolute: string,
  epoch: number,
  videoFileName?: string | null,
  videoMime?: string | null,
): string {
  const fromName = fileExtension(videoFileName ?? "");
  const mime = (videoMime ?? "").trim().toLowerCase();
  const extension = Object.prototype.hasOwnProperty.call(VIDEO_EXTENSION_MIME, fromName)
    ? fromName
    : mime === "video/quicktime" ? "mov"
    : mime === "video/mp4" || mime === "video/x-m4v" ? "mp4"
    : mime === "video/3gpp" ? "3gp"
    : mime === "video/3gpp2" ? "3g2"
    : "";
  // Attachment URLs end in /file, not in the original filename. AVPlayer uses
  // the local path extension to identify MOV/MP4 containers. Only append a
  // recognized video extension; never trust arbitrary user-supplied path text.
  const suffix = Object.prototype.hasOwnProperty.call(VIDEO_EXTENSION_MIME, extension) ? `.${extension}` : "";
  return `${CACHE_DIR}${epoch}_${urlToFilename(absolute)}${suffix}`;
}

function resolveMediaUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = getApiUrl().replace(/\/+$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

// Download `absolute` to `cachePath` with the given bearer token.
// Returns the local URI on success, or null if the server returns an error.
// Does NOT handle 401 internally — callers should refresh and retry if needed.
// `onProgress` receives values in [0, 1] as bytes arrive; it is only called when
// the server provides a Content-Length header (totalBytesExpectedToWrite > 0).
async function downloadWithToken(
  absolute: string,
  cachePath: string,
  token: string,
  onProgress?: (progress: number) => void,
): Promise<{ uri: string } | { status: number } | null> {
  try {
    const result = await FileSystem.downloadAsync(absolute, cachePath, {
      headers: { Authorization: `Bearer ${token}` },
      ...(onProgress
        ? {
            downloadProgressCallback: ({
              totalBytesWritten,
              totalBytesExpectedToWrite,
            }: {
              totalBytesWritten: number;
              totalBytesExpectedToWrite: number;
            }) => {
              if (totalBytesExpectedToWrite > 0) {
                onProgress(totalBytesWritten / totalBytesExpectedToWrite);
              }
            },
          }
        : undefined),
    });
    if (result.status >= 200 && result.status < 300) {
      return { uri: result.uri };
    }
    return { status: result.status };
  } catch {
    return null;
  }
}

export async function getAuthedMediaUri(
  url: string | null | undefined,
  onProgress?: (progress: number) => void,
  videoFileName?: string | null,
  videoMime?: string | null,
): Promise<string | null> {
  if (!url) return null;

  // Self-contained or already-local URIs — no caching or auth needed
  if (
    url.startsWith("data:") ||
    url.startsWith("file://") ||
    url.startsWith("assets-library://") ||
    url.startsWith("ph://")
  ) {
    return url;
  }

  const token = getAccessToken();
  const absolute = resolveMediaUrl(url);

  // If no auth token, fall back to direct URL (web path handles cookies)
  if (!token) return absolute;

  // Only attach Bearer token to same-origin API requests.  External or
  // attacker-controlled URLs must never receive the JWT.
  if (!isSameApiOrigin(absolute)) return absolute;

  const epoch = cacheEpoch;
  try {
    await ensureCacheDir();
    await maybePruneAuthedMediaCache();
    // Epoch-scoped destinations keep a stale download from a prior signed-in
    // session from overwriting or deleting the current session's file.
    const cachePath = cachePathFor(absolute, epoch, videoFileName, videoMime);

    const resolved = await withPathOperation(cachePath, async () => {
      const info = await FileSystem.getInfoAsync(cachePath);
      if (info.exists) return cachePath;

      beginWork(cachePath);
      try {
        const result = await downloadWithToken(absolute, cachePath, token, onProgress);
        if (result && "uri" in result) {
          if (epoch !== cacheEpoch) {
            await FileSystem.deleteAsync(result.uri, { idempotent: true });
            return null;
          }
          return result.uri;
        }

        if (result && "status" in result && result.status === 401) {
          const newToken = await refreshAndGetAccessToken();
          if (newToken) {
            const retryResult = await downloadWithToken(absolute, cachePath, newToken, onProgress);
            if (retryResult && "uri" in retryResult) {
              if (epoch !== cacheEpoch) {
                await FileSystem.deleteAsync(retryResult.uri, { idempotent: true });
                return null;
              }
              return retryResult.uri;
            }
          }
        }

        await FileSystem.deleteAsync(cachePath, { idempotent: true });
        return null;
      } finally {
        endWork(cachePath);
      }
    });
    void pruneAuthedMediaCache();
    return resolved;
  } catch {
    return null;
  }
}

export async function refreshAuthedMediaUri(
  url: string | null | undefined,
): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith("data:")) return url;

  const token = getAccessToken();
  const absolute = resolveMediaUrl(url);
  if (!token) return absolute;

  // Same-origin guard — never send JWTs to external hosts
  if (!isSameApiOrigin(absolute)) return absolute;

  const epoch = cacheEpoch;
  try {
    await ensureCacheDir();
    await maybePruneAuthedMediaCache();
    const filename = urlToFilename(absolute);
    const cachePath = `${CACHE_DIR}${epoch}_${filename}`;

    return await withPathOperation(cachePath, async () => {
      if (activeUris.has(cachePath)) return cachePath;
      await FileSystem.deleteAsync(cachePath, { idempotent: true });

      beginWork(cachePath);
      try {
        const result = await downloadWithToken(absolute, cachePath, token);
        if (result && "uri" in result) {
          if (epoch !== cacheEpoch) {
            await FileSystem.deleteAsync(result.uri, { idempotent: true });
            return null;
          }
          return result.uri;
        }

        if (result && "status" in result && result.status === 401) {
          const newToken = await refreshAndGetAccessToken();
          if (newToken) {
            const retryResult = await downloadWithToken(absolute, cachePath, newToken);
            if (retryResult && "uri" in retryResult) {
              if (epoch !== cacheEpoch) {
                await FileSystem.deleteAsync(retryResult.uri, { idempotent: true });
                return null;
              }
              return retryResult.uri;
            }
          }
        }

        await FileSystem.deleteAsync(cachePath, { idempotent: true });
        return null;
      } finally {
        endWork(cachePath);
      }
    });
  } catch {
    return null;
  }
}

export async function clearAuthedMediaCache(): Promise<void> {
  cacheEpoch += 1;
  cacheReady = false;
  lastPrunedAt = 0;
  activeUris.clear();
  inFlightUris.clear();
  pathOperations.clear();
  if (!FileSystem.cacheDirectory) return;
  try {
    await FileSystem.deleteAsync(CACHE_DIR, { idempotent: true });
  } catch {
    // Cache cleanup must never prevent logout.
  }
}
