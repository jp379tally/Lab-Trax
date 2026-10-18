// Tests for `lib/authed-media-cache.ts`.
//
// The global vitest.setup.ts mocks authed-media-cache so screen tests don't
// hit the filesystem. These tests need the REAL implementation, so we unmock
// it here (hoisted above the import). expo-file-system/legacy and
// @/lib/query-client are re-mocked inline below with controllable stubs.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.unmock("@/lib/authed-media-cache");

// All vi.mock factories are hoisted — they cannot reference variables declared
// in the module body. Define the stubs entirely inside each factory.
vi.mock("@/lib/query-client", () => ({
  getAccessToken: vi.fn(() => "tok-initial"),
  getApiUrl: vi.fn(() => "https://api.labtrax.test/"),
  refreshAndGetAccessToken: vi.fn(async () => "tok-refreshed"),
}));

vi.mock("@/lib/case-media-source", () => ({
  isSameApiOrigin: vi.fn((url: string) =>
    url.startsWith("https://api.labtrax.test/"),
  ),
}));

vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  getInfoAsync: vi.fn(async () => ({ exists: false })),
  makeDirectoryAsync: vi.fn(async () => undefined),
  readDirectoryAsync: vi.fn(async () => []),
  downloadAsync: vi.fn(async (_url: string, dest: string) => ({
    status: 200,
    uri: dest,
  })),
  deleteAsync: vi.fn(async () => undefined),
}));

import {
  AUTHED_MEDIA_MAX_AGE_MS,
  AUTHED_MEDIA_MAX_BYTES,
  clearAuthedMediaCache,
  acquireAuthedMediaUri,
  getAuthedMediaUri,
  pruneAuthedMediaCache,
  refreshAuthedMediaUri,
  retainAuthedMediaUri,
} from "@/lib/authed-media-cache";
import { getAccessToken, refreshAndGetAccessToken } from "@/lib/query-client";
import * as FileSystemLegacy from "expo-file-system/legacy";

const SAME_ORIGIN_URL =
  "https://api.labtrax.test/api/cases/c1/attachments/a1/file";
const MIGRATED_RELATIVE_URL =
  "/api/cases/attachment-file/migrated-photo.jpg";
const MIGRATED_SPECIAL_CHARACTER_URLS = [
  "/api/cases/attachment-file/migrated%20photo.jpg",
  "/api/cases/attachment-file/migrated-%D1%84%D0%BE%D1%82%D0%BE-%E9%9B%AA.jpg",
  "/api/cases/attachment-file/migrated%23photo%3F100%25.jpg",
];
const EXTERNAL_URL = "https://evil.example.com/steal.jpg";

// Compute the cache path the way authed-media-cache.ts does it
function expectedCachePath(url: string): string {
  const cleaned = url.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(-120);
  return `file:///cache/labtrax-media/0_${cleaned || "media"}`;
}

beforeEach(() => {
  vi.clearAllMocks();

  // Default: valid token, refresh returns a fresh token
  vi.mocked(getAccessToken).mockReturnValue("tok-initial");
  vi.mocked(refreshAndGetAccessToken).mockResolvedValue("tok-refreshed");

  // Default filesystem: no cached files, downloads succeed
  vi.mocked(FileSystemLegacy.getInfoAsync).mockResolvedValue({ exists: false } as any);
  vi.mocked(FileSystemLegacy.downloadAsync).mockImplementation(
    async (_url: string, dest: string) => ({ status: 200, uri: dest } as any),
  );
  vi.mocked(FileSystemLegacy.deleteAsync).mockResolvedValue(undefined);
  vi.mocked(FileSystemLegacy.makeDirectoryAsync).mockResolvedValue(undefined);
});

describe("getAuthedMediaUri", () => {
  it("downloads ID-based camera videos to a local path with their container extension", async () => {
    const acquired = await acquireAuthedMediaUri(
      "/api/cases/c1/attachments/camera/file",
      undefined,
      "IMG_0042.MOV",
      "application/octet-stream",
    );
    expect(acquired?.uri).toMatch(/\.mov$/);
    const [url, destination, options] = vi.mocked(FileSystemLegacy.downloadAsync).mock.calls[0]!;
    expect(url).toBe("https://api.labtrax.test/api/cases/c1/attachments/camera/file");
    expect(destination).toBe(acquired?.uri);
    expect(options?.headers).toEqual({ Authorization: "Bearer tok-initial" });
    acquired?.release();
  });

  it("uses known video MIME when a legacy clip has no filename, without accepting arbitrary suffixes", async () => {
    const mov = await acquireAuthedMediaUri(SAME_ORIGIN_URL, undefined, null, "video/quicktime");
    expect(mov?.uri).toMatch(/\.mov$/);
    mov?.release();
    const suspicious = await acquireAuthedMediaUri(SAME_ORIGIN_URL, undefined, "../unsafe.exe", "video/mp4");
    expect(suspicious?.uri).toMatch(/\.mp4$/);
    expect(suspicious?.uri).not.toContain("unsafe");
    suspicious?.release();
  });

  it("returns local URIs without auth", async () => {
    expect(await getAuthedMediaUri("file:///photos/x.jpg")).toBe(
      "file:///photos/x.jpg",
    );
    expect(await getAuthedMediaUri("ph://asset-id")).toBe("ph://asset-id");
    expect(await getAuthedMediaUri("data:image/jpeg;base64,abc")).toBe(
      "data:image/jpeg;base64,abc",
    );
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).not.toHaveBeenCalled();
  });

  it("returns null for null/undefined input", async () => {
    expect(await getAuthedMediaUri(null)).toBeNull();
    expect(await getAuthedMediaUri(undefined)).toBeNull();
  });

  it("downloads with bearer on a successful first attempt", async () => {
    const result = await getAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBeTruthy();
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).toHaveBeenCalledTimes(1);
    const [url, , opts] = vi.mocked(FileSystemLegacy.downloadAsync).mock.calls[0]!;
    expect(url).toBe(SAME_ORIGIN_URL);
    expect((opts as Record<string, any>)?.headers?.["Authorization"]).toBe(
      "Bearer tok-initial",
    );
  });

  it("resolves a migrated relative attachment-file reference against the authenticated API origin", async () => {
    const result = await getAuthedMediaUri(MIGRATED_RELATIVE_URL);

    expect(result).toBeTruthy();
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).toHaveBeenCalledTimes(1);
    const [url, , opts] = vi.mocked(FileSystemLegacy.downloadAsync).mock.calls[0]!;
    expect(url).toBe(
      "https://api.labtrax.test/api/cases/attachment-file/migrated-photo.jpg",
    );
    expect((opts as Record<string, any>)?.headers?.Authorization).toBe(
      "Bearer tok-initial",
    );
  });

  it.each(MIGRATED_SPECIAL_CHARACTER_URLS)(
    "downloads encoded migrated reference without decoding or double-encoding: %s",
    async (relativeUrl) => {
      await getAuthedMediaUri(relativeUrl);

      expect(FileSystemLegacy.downloadAsync).toHaveBeenCalledTimes(1);
      const [url, , opts] = vi.mocked(FileSystemLegacy.downloadAsync).mock.calls[0]!;
      expect(url).toBe(`https://api.labtrax.test${relativeUrl}`);
      expect(url).not.toContain("%2520");
      expect(url).not.toContain("%2523");
      expect((opts as Record<string, any>)?.headers?.Authorization).toBe(
        "Bearer tok-initial",
      );
    },
  );

  it("deduplicates concurrent downloads to the same destination", async () => {
    const path = expectedCachePath(SAME_ORIGIN_URL);
    let downloaded = false;
    vi.mocked(FileSystemLegacy.getInfoAsync).mockImplementation(async (uri) => ({
      exists: uri === path && downloaded,
      uri,
    }) as any);
    vi.mocked(FileSystemLegacy.downloadAsync).mockImplementation(
      async (_url, destination) => {
        downloaded = true;
        return { status: 200, uri: destination } as any;
      },
    );

    const [first, second] = await Promise.all([
      getAuthedMediaUri(SAME_ORIGIN_URL),
      getAuthedMediaUri(SAME_ORIGIN_URL),
    ]);

    expect(first).toBe(second);
    expect(FileSystemLegacy.downloadAsync).toHaveBeenCalledTimes(1);
  });

  it("never sends Bearer to external URLs", async () => {
    vi.mocked(getAccessToken).mockReturnValue("supersecret");
    const result = await getAuthedMediaUri(EXTERNAL_URL);
    // Returns the raw URL without downloading — no auth header leakage
    expect(result).toBe(EXTERNAL_URL);
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).not.toHaveBeenCalled();
  });

  it("returns cached file path without a network round-trip when cached", async () => {
    const cachePath = expectedCachePath(SAME_ORIGIN_URL);
    vi.mocked(FileSystemLegacy.getInfoAsync).mockResolvedValue({
      exists: true,
      uri: cachePath,
    } as any);

    const result = await getAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBe(cachePath);
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).not.toHaveBeenCalled();
  });

  it("refreshes token and retries after a 401 response", async () => {
    // First download: 401 (expired token); second (after refresh): 200
    vi.mocked(FileSystemLegacy.downloadAsync)
      .mockResolvedValueOnce({ status: 401, uri: "" } as any)
      .mockImplementation(async (_url: string, dest: string) => ({
        status: 200,
        uri: dest,
      } as any));

    const result = await getAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBeTruthy();
    expect(result).not.toBeNull();

    // refreshAndGetAccessToken called exactly once
    expect(vi.mocked(refreshAndGetAccessToken)).toHaveBeenCalledTimes(1);

    // downloadAsync called twice: initial + retry with fresh token
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).toHaveBeenCalledTimes(2);
    const [, , opts2] = vi.mocked(FileSystemLegacy.downloadAsync).mock.calls[1]!;
    expect((opts2 as Record<string, any>)?.headers?.["Authorization"]).toBe(
      "Bearer tok-refreshed",
    );
  });

  it("returns null when 401 occurs and token refresh fails", async () => {
    vi.mocked(refreshAndGetAccessToken).mockResolvedValue(null);
    vi.mocked(FileSystemLegacy.downloadAsync).mockResolvedValueOnce({
      status: 401,
      uri: "",
    } as any);

    const result = await getAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBeNull();
    expect(vi.mocked(refreshAndGetAccessToken)).toHaveBeenCalledTimes(1);
    // No retry after failed refresh
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).toHaveBeenCalledTimes(1);
  });

  it("returns raw URL when there is no access token", async () => {
    vi.mocked(getAccessToken).mockReturnValue(null);
    const result = await getAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBe(SAME_ORIGIN_URL);
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).not.toHaveBeenCalled();
  });
});

describe("refreshAuthedMediaUri", () => {
  it("forces a fresh download and returns the file URI", async () => {
    const result = await refreshAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBeTruthy();
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).toHaveBeenCalledTimes(1);
  });

  it("refreshes token and retries after a 401", async () => {
    vi.mocked(FileSystemLegacy.downloadAsync)
      .mockResolvedValueOnce({ status: 401, uri: "" } as any)
      .mockImplementation(async (_url: string, dest: string) => ({
        status: 200,
        uri: dest,
      } as any));

    const result = await refreshAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBeTruthy();
    expect(vi.mocked(refreshAndGetAccessToken)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).toHaveBeenCalledTimes(2);
    const [, , opts2] = vi.mocked(FileSystemLegacy.downloadAsync).mock.calls[1]!;
    expect((opts2 as Record<string, any>)?.headers?.["Authorization"]).toBe(
      "Bearer tok-refreshed",
    );
  });

  it("returns null when refresh fails after 401", async () => {
    vi.mocked(refreshAndGetAccessToken).mockResolvedValue(null);
    vi.mocked(FileSystemLegacy.downloadAsync).mockResolvedValueOnce({
      status: 401,
      uri: "",
    } as any);

    const result = await refreshAuthedMediaUri(SAME_ORIGIN_URL);
    expect(result).toBeNull();
  });

  it("never sends Bearer to external URLs", async () => {
    vi.mocked(getAccessToken).mockReturnValue("supersecret");
    const result = await refreshAuthedMediaUri(EXTERNAL_URL);
    expect(result).toBe(EXTERNAL_URL);
    expect(vi.mocked(FileSystemLegacy.downloadAsync)).not.toHaveBeenCalled();
  });

  it("does not replace a cached file while it is being viewed", async () => {
    const path = expectedCachePath(SAME_ORIGIN_URL);
    const release = retainAuthedMediaUri(path);

    await expect(refreshAuthedMediaUri(SAME_ORIGIN_URL)).resolves.toBe(path);
    expect(FileSystemLegacy.downloadAsync).not.toHaveBeenCalled();
    expect(FileSystemLegacy.deleteAsync).not.toHaveBeenCalledWith(path, expect.anything());
    release();
  });
});

describe("cache eviction", () => {
  it("deletes entries older than the documented retention period", async () => {
    const oldPath = "file:///cache/labtrax-media/old.jpg";
    vi.mocked(FileSystemLegacy.readDirectoryAsync).mockResolvedValue(["old.jpg"]);
    vi.mocked(FileSystemLegacy.getInfoAsync).mockImplementation(async (uri) => ({
      exists: true,
      uri,
      modificationTime: 1,
    }) as any);

    await pruneAuthedMediaCache(AUTHED_MEDIA_MAX_AGE_MS + 2_000);

    expect(FileSystemLegacy.deleteAsync).toHaveBeenCalledWith(oldPath, {
      idempotent: true,
    });
  });

  it("evicts unleased files whose age metadata is unavailable", async () => {
    const path = "file:///cache/labtrax-media/unknown-age.jpg";
    vi.mocked(FileSystemLegacy.readDirectoryAsync).mockResolvedValue(["unknown-age.jpg"]);
    vi.mocked(FileSystemLegacy.getInfoAsync).mockResolvedValue({
      exists: true,
      uri: path,
    } as any);

    await pruneAuthedMediaCache(AUTHED_MEDIA_MAX_AGE_MS + 1);

    expect(FileSystemLegacy.deleteAsync).toHaveBeenCalledWith(path, {
      idempotent: true,
    });
  });

  it("evicts the oldest unleased entries until the byte budget is met", async () => {
    vi.mocked(FileSystemLegacy.readDirectoryAsync).mockResolvedValue(["old", "new"]);
    vi.mocked(FileSystemLegacy.getInfoAsync).mockImplementation(async (uri) => ({
      exists: true,
      uri,
      size: AUTHED_MEDIA_MAX_BYTES,
      modificationTime: uri.endsWith("/old") ? 10 : 20,
    }) as any);

    await pruneAuthedMediaCache(20_000);

    expect(FileSystemLegacy.deleteAsync).toHaveBeenCalledWith(
      "file:///cache/labtrax-media/old",
      { idempotent: true },
    );
    expect(FileSystemLegacy.deleteAsync).not.toHaveBeenCalledWith(
      "file:///cache/labtrax-media/new",
      expect.anything(),
    );
  });

  it("does not evict media while a viewer holds a lease", async () => {
    const path = "file:///cache/labtrax-media/viewed.jpg";
    vi.mocked(FileSystemLegacy.readDirectoryAsync).mockResolvedValue(["viewed.jpg"]);
    vi.mocked(FileSystemLegacy.getInfoAsync).mockResolvedValue({
      exists: true,
      modificationTime: 1,
    } as any);
    const release = retainAuthedMediaUri(path);

    await pruneAuthedMediaCache(AUTHED_MEDIA_MAX_AGE_MS + 2_000);
    expect(FileSystemLegacy.deleteAsync).not.toHaveBeenCalledWith(path, expect.anything());

    release();
    await pruneAuthedMediaCache(AUTHED_MEDIA_MAX_AGE_MS + 2_000);
    expect(FileSystemLegacy.deleteAsync).toHaveBeenCalledWith(path, {
      idempotent: true,
    });
  });

  it("does not publish a download that finishes after logout cleanup", async () => {
    let finishDownload!: (value: any) => void;
    vi.mocked(FileSystemLegacy.downloadAsync).mockReturnValue(
      new Promise((resolve) => {
        finishDownload = resolve;
      }),
    );

    const pending = getAuthedMediaUri(SAME_ORIGIN_URL);
    await vi.waitFor(() => {
      expect(FileSystemLegacy.downloadAsync).toHaveBeenCalledTimes(1);
    });
    await clearAuthedMediaCache();
    const path = expectedCachePath(SAME_ORIGIN_URL);
    finishDownload({ status: 200, uri: path });

    await expect(pending).resolves.toBeNull();
    expect(FileSystemLegacy.deleteAsync).toHaveBeenCalledWith(path, {
      idempotent: true,
    });
  });
});
