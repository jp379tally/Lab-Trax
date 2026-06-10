import * as FileSystem from "expo-file-system/legacy";
import { getApiUrl, getAccessToken } from "./query-client";
import { isSameApiOrigin } from "./case-media-source";

const CACHE_DIR = `${FileSystem.cacheDirectory ?? ""}labtrax-media/`;

let cacheReady = false;
async function ensureCacheDir(): Promise<void> {
  if (cacheReady) return;
  const info = await FileSystem.getInfoAsync(CACHE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
  }
  cacheReady = true;
}

function urlToFilename(url: string): string {
  const cleaned = url.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(-120);
  return cleaned || "media";
}

function resolveMediaUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = getApiUrl().replace(/\/+$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

export async function getAuthedMediaUri(
  url: string | null | undefined,
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

  try {
    await ensureCacheDir();
    const filename = urlToFilename(absolute);
    const cachePath = `${CACHE_DIR}${filename}`;

    const info = await FileSystem.getInfoAsync(cachePath);
    if (info.exists) return cachePath;

    const result = await FileSystem.downloadAsync(absolute, cachePath, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (result.status >= 200 && result.status < 300) {
      return result.uri;
    }

    // Download failed — clean up any partial file
    await FileSystem.deleteAsync(cachePath, { idempotent: true });
    return null;
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

  try {
    await ensureCacheDir();
    const filename = urlToFilename(absolute);
    const cachePath = `${CACHE_DIR}${filename}`;

    // Force a fresh download by deleting the cached file first
    await FileSystem.deleteAsync(cachePath, { idempotent: true });

    const result = await FileSystem.downloadAsync(absolute, cachePath, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (result.status >= 200 && result.status < 300) {
      return result.uri;
    }
    await FileSystem.deleteAsync(cachePath, { idempotent: true });
    return null;
  } catch {
    return null;
  }
}
