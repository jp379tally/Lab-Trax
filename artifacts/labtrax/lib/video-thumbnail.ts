import { clearCache, createVideoThumbnail } from "react-native-compressor";
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import {
  acquireAuthedMediaUri,
  type AcquiredMediaUri,
} from "./authed-media-cache";

const thumbnailPromises = new Map<string, Promise<string | null>>();
const thumbnailInvalidations = new Map<string, Promise<void>>();
const generatedThumbnailUris = new Set<string>();
const activeThumbnailUris = new Map<string, number>();
const inFlightThumbnailUris = new Set<string>();
const thumbnailPathOperations = new Map<string, Promise<unknown>>();
const THUMBNAIL_DIR = `${FileSystem.cacheDirectory ?? ""}labtrax-video-thumbnails/`;
/** Generated video frame files are retained for at most seven days. */
export const VIDEO_THUMBNAIL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const VIDEO_THUMBNAIL_MAX_BYTES = 64 * 1024 * 1024;
export const VIDEO_THUMBNAIL_MAX_ENTRIES = 500;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let generationEpoch = 0;
let cachePathEpoch: number | null = null;
let thumbnailCacheReady = false;
let lastPrunedAt = 0;

function thumbnailPath(url: string): string {
  const filename = url.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-120) || "video";
  const epochPrefix = cachePathEpoch === null ? "" : `${cachePathEpoch}_`;
  return `${THUMBNAIL_DIR}${epochPrefix}${filename}.jpg`;
}

function withThumbnailPathOperation<T>(
  uri: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = thumbnailPathOperations.get(uri) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(operation);
  thumbnailPathOperations.set(uri, pending);
  void pending.finally(() => {
    if (thumbnailPathOperations.get(uri) === pending) {
      thumbnailPathOperations.delete(uri);
    }
  }).catch(() => undefined);
  return pending;
}

async function ensureThumbnailDir(): Promise<void> {
  if (thumbnailCacheReady) return;
  const info = await FileSystem.getInfoAsync(THUMBNAIL_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(THUMBNAIL_DIR, { intermediates: true });
  }
  thumbnailCacheReady = true;
}

export function retainVideoThumbnailUri(uri: string | null | undefined): () => void {
  if (!uri?.startsWith(THUMBNAIL_DIR)) return () => {};
  activeThumbnailUris.set(uri, (activeThumbnailUris.get(uri) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeThumbnailUris.get(uri) ?? 1) - 1;
    if (remaining > 0) activeThumbnailUris.set(uri, remaining);
    else activeThumbnailUris.delete(uri);
  };
}

export async function pruneVideoThumbnailCache(now = Date.now()): Promise<void> {
  if (!FileSystem.cacheDirectory) return;
  try {
    await ensureThumbnailDir();
    const entries = await FileSystem.readDirectoryAsync(THUMBNAIL_DIR);
    const candidates = await Promise.all(entries.map(async (entry) => {
      const uri = `${THUMBNAIL_DIR}${entry}`;
      return withThumbnailPathOperation(uri, async () => {
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
      const expired = now - candidate.modifiedAt > VIDEO_THUMBNAIL_MAX_AGE_MS;
      const overBudget =
        totalBytes > VIDEO_THUMBNAIL_MAX_BYTES ||
        totalEntries > VIDEO_THUMBNAIL_MAX_ENTRIES;
      if (!expired && !overBudget) continue;
      const deleted = await withThumbnailPathOperation(candidate.uri, async () => {
        if (
          activeThumbnailUris.has(candidate.uri) ||
          inFlightThumbnailUris.has(candidate.uri)
        ) return false;
        generatedThumbnailUris.delete(candidate.uri);
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
    // Cache maintenance must never prevent thumbnail rendering.
  }
}

async function maybePruneVideoThumbnailCache(): Promise<void> {
  const now = Date.now();
  if (now - lastPrunedAt >= PRUNE_INTERVAL_MS) {
    await pruneVideoThumbnailCache(now);
  }
}

async function generateVideoThumbnail(
  url: string,
  epoch: number,
): Promise<string | null> {
  try {
    await ensureThumbnailDir();
    const cachedPath = thumbnailPath(url);
    const cachedInfo = await FileSystem.getInfoAsync(cachedPath);
    if (cachedInfo.exists && epoch === generationEpoch) {
      generatedThumbnailUris.add(cachedPath);
      return cachedPath;
    }

    const source = await acquireAuthedMediaUri(url);
    if (!source || epoch !== generationEpoch) {
      source?.release();
      return null;
    }

    inFlightThumbnailUris.add(cachedPath);
    let thumbnail;
    try {
      thumbnail = await createVideoThumbnail(source.uri, {
        quality: 80,
      });
    } finally {
      source.release();
    }
    if (!thumbnail.path) return null;
    if (epoch !== generationEpoch) {
      await FileSystem.deleteAsync(thumbnail.path, { idempotent: true });
      return null;
    }
    await FileSystem.copyAsync({ from: thumbnail.path, to: cachedPath });
    await FileSystem.deleteAsync(thumbnail.path, { idempotent: true });
    generatedThumbnailUris.add(cachedPath);
    return cachedPath;
  } catch {
    return null;
  } finally {
    inFlightThumbnailUris.delete(thumbnailPath(url));
  }
}

/**
 * Resolves protected case media to a local file before thumbnail generation.
 * The native generator therefore never receives bearer credentials, and each
 * media URL shares one cached generation attempt while the app is running.
 */
export function getVideoThumbnailUri(
  url: string | null | undefined,
): Promise<string | null> {
  if (!url) return Promise.resolve(null);

  const invalidation = thumbnailInvalidations.get(url);
  if (invalidation) {
    return invalidation.then(() => getVideoThumbnailUri(url));
  }

  const existing = thumbnailPromises.get(url);
  if (existing) return existing;

  const epoch = generationEpoch;
  const path = thumbnailPath(url);
  const pending = maybePruneVideoThumbnailCache()
    .then(() => withThumbnailPathOperation(
      path,
      () => generateVideoThumbnail(url, epoch),
    ))
    .then((uri) => {
      if (!uri || epoch !== generationEpoch) thumbnailPromises.delete(url);
      return epoch === generationEpoch ? uri : null;
    })
    .catch(() => {
      thumbnailPromises.delete(url);
      return null;
    });
  thumbnailPromises.set(url, pending);
  void pending.finally(() => pruneVideoThumbnailCache()).catch(() => undefined);
  return pending;
}

export async function acquireVideoThumbnailUri(
  url: string | null | undefined,
): Promise<AcquiredMediaUri | null> {
  if (!url) return null;
  const path = thumbnailPath(url);
  const currentOperation = thumbnailPathOperations.get(path);
  if (currentOperation) await currentOperation.catch(() => undefined);
  const release = retainVideoThumbnailUri(path);
  const uri = await getVideoThumbnailUri(url);
  if (!uri) {
    release();
    return null;
  }
  return { uri, release };
}

export async function clearVideoThumbnailCache(): Promise<void> {
  generationEpoch += 1;
  cachePathEpoch = (cachePathEpoch ?? 0) + 1;
  thumbnailCacheReady = false;
  lastPrunedAt = 0;
  activeThumbnailUris.clear();
  inFlightThumbnailUris.clear();
  const inFlight = [...thumbnailPromises.values()];
  thumbnailPromises.clear();
  thumbnailInvalidations.clear();
  thumbnailPathOperations.clear();
  await Promise.allSettled(inFlight);

  const uris = [...generatedThumbnailUris];
  generatedThumbnailUris.clear();
  await Promise.allSettled([
    // The compressor has no linked native module on mobile web. Defer
    // invocation as well: an unavailable native module can throw synchronously
    // before allSettled receives its array, which used to abort logout.
    Promise.resolve().then(() => Platform.OS === "web" ? undefined : clearCache()),
    Promise.resolve().then(() => FileSystem.deleteAsync(THUMBNAIL_DIR, { idempotent: true })),
    ...uris.map(async (uri) => {
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {
        // Cache cleanup must never prevent logout.
      }
    }),
  ]);
}

export function invalidateVideoThumbnail(url: string): void {
  const generation = thumbnailPromises.get(url);
  thumbnailPromises.delete(url);
  const uri = thumbnailPath(url);
  generatedThumbnailUris.delete(uri);
  const previous = thumbnailInvalidations.get(url);
  const pending = Promise.allSettled([
    previous ?? Promise.resolve(),
    generation ?? Promise.resolve(null),
  ]).then(async () => {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  }).catch(() => {
    // A failed invalidation can be retried by the next cache prune.
  }).finally(() => {
    if (thumbnailInvalidations.get(url) === pending) {
      thumbnailInvalidations.delete(url);
    }
  });
  thumbnailInvalidations.set(url, pending);
}

export function clearVideoThumbnailCacheForTests(): void {
  generationEpoch += 1;
  cachePathEpoch = null;
  thumbnailCacheReady = false;
  lastPrunedAt = 0;
  thumbnailPromises.clear();
  thumbnailInvalidations.clear();
  thumbnailPathOperations.clear();
  generatedThumbnailUris.clear();
  activeThumbnailUris.clear();
  inFlightThumbnailUris.clear();
}
