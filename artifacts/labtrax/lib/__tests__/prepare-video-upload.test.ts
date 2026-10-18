import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  prepareVideoForUpload,
  shouldBypassVideoCompression,
  videoCompressionMaxSize,
} from "@/lib/prepare-video-upload";

const compress = vi.fn();
const getInfoAsync = vi.fn();

vi.mock("react-native-compressor", () => ({
  Video: { compress },
}));

vi.mock("expo-file-system/legacy", () => ({
  getInfoAsync,
}));

describe("prepareVideoForUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bypasses an already-efficient video at or below 720p", async () => {
    const asset = {
      uri: "file:///small.mov",
      fileName: "small.mov",
      mimeType: "video/quicktime",
      fileSize: 2_000_000,
      width: 1280,
      height: 720,
      duration: 10_000,
    };

    expect(shouldBypassVideoCompression(asset)).toBe(true);
    await expect(prepareVideoForUpload(asset)).resolves.toEqual({
      uri: asset.uri,
      fileName: "small.mov",
      mimeType: "video/quicktime",
      fileSize: 2_000_000,
      compressed: false,
    });
    expect(compress).not.toHaveBeenCalled();
  });

  it("compresses a large source to 720p and returns MP4 upload metadata", async () => {
    compress.mockResolvedValue("file:///compressed.mp4");
    getInfoAsync.mockResolvedValue({ exists: true, size: 3_000_000 });

    await expect(
      prepareVideoForUpload({
        uri: "file:///large.mov",
        fileName: "large.mov",
        mimeType: "video/quicktime",
        fileSize: 12_000_000,
        width: 1920,
        height: 1080,
        duration: 20_000,
      }),
    ).resolves.toEqual({
      uri: "file:///compressed.mp4",
      fileName: "large-720p.mp4",
      mimeType: "video/mp4",
      fileSize: 3_000_000,
      compressed: true,
    });
    expect(compress).toHaveBeenCalledWith(
      "file:///large.mov",
      expect.objectContaining({
        compressionMethod: "manual",
        maxSize: 1280,
        bitrate: 2_500_000,
      }),
    );
  });

  it("bypasses efficient portrait 720p video", async () => {
    expect(shouldBypassVideoCompression({
      fileSize: 2_000_000,
      width: 720,
      height: 1280,
      duration: 10_000,
      uri: "file:///portrait.mp4",
    })).toBe(true);
  });

  it("chooses aspect-aware limits for 4:3, square, and unknown dimensions", async () => {
    expect(videoCompressionMaxSize({
      uri: "file:///four-three.mp4",
      width: 1920,
      height: 1440,
    })).toBe(960);
    expect(videoCompressionMaxSize({
      uri: "file:///square.mp4",
      width: 1000,
      height: 1000,
    })).toBe(720);
    expect(videoCompressionMaxSize({ uri: "file:///unknown.mp4" })).toBe(720);
  });

  it("keeps the source when a successful transcode is larger", async () => {
    compress.mockResolvedValue("file:///larger.mp4");
    getInfoAsync.mockResolvedValue({ exists: true, size: 13_000_000 });

    const result = await prepareVideoForUpload({
      uri: "file:///source.mov",
      fileName: "source.mov",
      mimeType: "video/quicktime",
      fileSize: 12_000_000,
      width: 1920,
      height: 1080,
      duration: 20_000,
    });

    expect(result).toMatchObject({
      uri: "file:///source.mov",
      fileSize: 12_000_000,
      compressed: false,
    });
  });

  it("turns compressor failures into a clear retryable error", async () => {
    compress.mockRejectedValue(new Error("codec unavailable"));

    await expect(
      prepareVideoForUpload({
        uri: "file:///large.mov",
        fileName: "large.mov",
        fileSize: 12_000_000,
        width: 1920,
        height: 1080,
        duration: 20_000,
      }),
    ).rejects.toThrow("Video preparation failed. Please retry. codec unavailable");
  });
});