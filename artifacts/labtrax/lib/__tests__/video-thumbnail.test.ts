import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, createVideoThumbnail } from "react-native-compressor";
import { Platform } from "react-native";
import { acquireAuthedMediaUri } from "@/lib/authed-media-cache";
import {
  clearVideoThumbnailCacheForTests,
  clearVideoThumbnailCache,
  getVideoThumbnailUri,
  invalidateVideoThumbnail,
  pruneVideoThumbnailCache,
  retainVideoThumbnailUri,
  VIDEO_THUMBNAIL_MAX_AGE_MS,
  VIDEO_THUMBNAIL_MAX_BYTES,
} from "@/lib/video-thumbnail";
import * as FileSystem from "expo-file-system/legacy";

vi.mock("@/lib/authed-media-cache", () => ({
  acquireAuthedMediaUri: vi.fn(),
}));

describe("logout thumbnail cleanup", () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, "OS", { value: originalOS });
    vi.restoreAllMocks();
  });
  it("does not invoke an unavailable native compressor on mobile web", async () => {
    Object.defineProperty(Platform, "OS", { value: "web" });
    await expect(clearVideoThumbnailCache()).resolves.toBeUndefined();
    expect(clearCache).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      expect.stringContaining("labtrax-video-thumbnails/"), { idempotent: true },
    );
  });
  it("still clears protected files when a native cache call throws synchronously", async () => {
    vi.mocked(clearCache).mockImplementationOnce(() => { throw new Error("Native module not linked"); });
    await expect(clearVideoThumbnailCache()).resolves.toBeUndefined();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      expect.stringContaining("labtrax-video-thumbnails/"), { idempotent: true },
    );
  });
});

const THUMBNAIL_PATH =
  "file:///cache/labtrax-video-thumbnails/_api_cases_case-1_attachments_video-1_file.jpg";
const acquired = (uri: string) => ({ uri, release: vi.fn() });

describe("getVideoThumbnailUri", () => {
  beforeEach(() => {
    clearVideoThumbnailCacheForTests();
    vi.clearAllMocks();
    vi.mocked(createVideoThumbnail).mockResolvedValue({
      path: "file:///tmp/video-thumbnail.jpg",
      size: 100,
      mime: "image/jpeg",
      width: 320,
      height: 180,
    });
    vi.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: false } as any);
    vi.mocked(FileSystem.readDirectoryAsync).mockResolvedValue([]);
  });

  it("generates the frame from the authenticated local media file", async () => {
    vi.mocked(acquireAuthedMediaUri).mockResolvedValue({
      uri: "file:///cache/protected.mp4",
      release: vi.fn(),
    });

    await expect(
      getVideoThumbnailUri("/api/cases/case-1/attachments/video-1/file"),
    ).resolves.toBe(THUMBNAIL_PATH);

    expect(createVideoThumbnail).toHaveBeenCalledWith(
      "file:///cache/protected.mp4",
      { quality: 80 },
    );
    expect(FileSystem.copyAsync).toHaveBeenCalledWith({
      from: "file:///tmp/video-thumbnail.jpg",
      to: THUMBNAIL_PATH,
    });
  });

  it("shares a cached generation attempt for the same attachment", async () => {
    vi.mocked(acquireAuthedMediaUri).mockResolvedValue({
      uri: "file:///cache/video.mp4",
      release: vi.fn(),
    });
    const url = "/api/cases/case-1/attachments/video-1/file";

    await Promise.all([getVideoThumbnailUri(url), getVideoThumbnailUri(url)]);

    expect(acquireAuthedMediaUri).toHaveBeenCalledTimes(1);
    expect(createVideoThumbnail).toHaveBeenCalledTimes(1);
  });

  it("returns null when protected media or frame generation is unavailable", async () => {
    vi.mocked(acquireAuthedMediaUri).mockResolvedValue(null);
    await expect(getVideoThumbnailUri("/api/video")).resolves.toBeNull();

    clearVideoThumbnailCacheForTests();
    vi.mocked(acquireAuthedMediaUri).mockResolvedValue(acquired("file:///cache/video.mp4"));
    vi.mocked(createVideoThumbnail).mockRejectedValueOnce(new Error("codec"));
    await expect(getVideoThumbnailUri("/api/video")).resolves.toBeNull();
  });

  it("retries after a transient thumbnail failure", async () => {
    vi.mocked(acquireAuthedMediaUri).mockResolvedValue(acquired("file:///cache/video.mp4"));
    vi.mocked(createVideoThumbnail)
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({
        path: "file:///tmp/retried-thumbnail.jpg",
        size: 100,
        mime: "image/jpeg",
        width: 320,
        height: 180,
      });

    await expect(getVideoThumbnailUri("/api/video")).resolves.toBeNull();
    await expect(getVideoThumbnailUri("/api/video")).resolves.toBe(
      "file:///cache/labtrax-video-thumbnails/_api_video.jpg",
    );
    expect(createVideoThumbnail).toHaveBeenCalledTimes(2);
  });

  it("retries when authenticated media resolution rejects", async () => {
    vi.mocked(acquireAuthedMediaUri)
      .mockRejectedValueOnce(new Error("temporary auth failure"))
      .mockResolvedValueOnce(acquired("file:///cache/video.mp4"));

    await expect(getVideoThumbnailUri("/api/video")).resolves.toBeNull();
    await expect(getVideoThumbnailUri("/api/video")).resolves.toBe(
      "file:///cache/labtrax-video-thumbnails/_api_video.jpg",
    );
    expect(acquireAuthedMediaUri).toHaveBeenCalledTimes(2);
  });

  it("evicts old generated frames after their lease is released", async () => {
    const path = "file:///cache/labtrax-video-thumbnails/old.jpg";
    vi.mocked(FileSystem.readDirectoryAsync).mockResolvedValue(["old.jpg"]);
    vi.mocked(FileSystem.getInfoAsync).mockResolvedValue({
      exists: true,
      modificationTime: 1,
    } as any);
    const release = retainVideoThumbnailUri(path);

    await pruneVideoThumbnailCache(VIDEO_THUMBNAIL_MAX_AGE_MS + 2_000);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(path, expect.anything());

    release();
    await pruneVideoThumbnailCache(VIDEO_THUMBNAIL_MAX_AGE_MS + 2_000);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(path, { idempotent: true });
  });

  it("does not evict the destination while its frame is being generated", async () => {
    const url = "/api/video";
    const path = "file:///cache/labtrax-video-thumbnails/_api_video.jpg";
    let finishGeneration!: (value: any) => void;
    vi.mocked(acquireAuthedMediaUri).mockResolvedValue(acquired("file:///cache/video.mp4"));
    vi.mocked(createVideoThumbnail).mockReturnValue(
      new Promise((resolve) => {
        finishGeneration = resolve;
      }),
    );

    const pending = getVideoThumbnailUri(url);
    await vi.waitFor(() => expect(createVideoThumbnail).toHaveBeenCalledTimes(1));
    vi.mocked(FileSystem.readDirectoryAsync).mockResolvedValue(["_api_video.jpg"]);
    vi.mocked(FileSystem.getInfoAsync).mockResolvedValue({
      exists: true,
      modificationTime: 1,
    } as any);

    const pruning = pruneVideoThumbnailCache(VIDEO_THUMBNAIL_MAX_AGE_MS + 2_000);
    await Promise.resolve();
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(path, expect.anything());

    finishGeneration({
      path: "file:///tmp/generated.jpg",
      size: 100,
      mime: "image/jpeg",
      width: 320,
      height: 180,
    });
    await expect(pending).resolves.toBe(path);
    await pruning;
  });

  it("waits for invalidation before regenerating the same frame", async () => {
    const url = "/api/video";
    vi.mocked(acquireAuthedMediaUri).mockResolvedValue(acquired("file:///cache/video.mp4"));
    await getVideoThumbnailUri(url);
    invalidateVideoThumbnail(url);

    await getVideoThumbnailUri(url);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      "file:///cache/labtrax-video-thumbnails/_api_video.jpg",
      { idempotent: true },
    );
    expect(createVideoThumbnail).toHaveBeenCalledTimes(2);
  });

  it("resolves a persistent cache hit while startup pruning is due", async () => {
    const url = "/api/video";
    const entry = "_api_video.jpg";
    vi.mocked(FileSystem.readDirectoryAsync).mockResolvedValue([entry]);
    vi.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri) => ({
      exists: true,
      uri,
      modificationTime: Date.now() / 1000,
    }) as any);

    await expect(getVideoThumbnailUri(url)).resolves.toBe(
      `file:///cache/labtrax-video-thumbnails/${entry}`,
    );
    expect(createVideoThumbnail).not.toHaveBeenCalled();
  });

  it("evicts oldest frames until the thumbnail byte budget is met", async () => {
    vi.mocked(FileSystem.readDirectoryAsync).mockResolvedValue(["old.jpg", "new.jpg"]);
    vi.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri) => ({
      exists: true,
      uri,
      size: VIDEO_THUMBNAIL_MAX_BYTES,
      modificationTime: uri.endsWith("/old.jpg") ? 10 : 20,
    }) as any);

    await pruneVideoThumbnailCache(20_000);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      "file:///cache/labtrax-video-thumbnails/old.jpg",
      { idempotent: true },
    );
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
      "file:///cache/labtrax-video-thumbnails/new.jpg",
      expect.anything(),
    );
  });
});
