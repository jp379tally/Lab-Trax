import { Platform } from "react-native";

import { fileExtension, resolveVideoMime } from "@/lib/video-asset";

// react-native-compressor's maxSize is the landscape width or portrait height.
// 1280 therefore produces a standard maximum 1280×720 / 720×1280 output.
const MAX_VIDEO_LONG_EDGE = 1280;
const MODERATE_VIDEO_BITRATE = 2_500_000;
const EFFICIENT_SOURCE_BITRATE = 2_750_000;

export interface VideoPreparationAsset {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

export interface PreparedVideoUpload {
  uri: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  compressed: boolean;
}

async function nativeFileSize(uri: string): Promise<number> {
  const FS = await import("expo-file-system/legacy");
  const info = await (FS as any).getInfoAsync(uri, { size: true });
  if (!info.exists || typeof info.size !== "number" || info.size <= 0) {
    throw new Error("Could not determine the prepared video's size.");
  }
  return info.size;
}

function sourceBitrate(asset: VideoPreparationAsset): number | null {
  if (!asset.fileSize || !asset.duration || asset.duration <= 0) return null;
  return (asset.fileSize * 8 * 1000) / asset.duration;
}

export function shouldBypassVideoCompression(asset: VideoPreparationAsset): boolean {
  const dimensionsKnown =
    typeof asset.width === "number" && typeof asset.height === "number";
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  const within720p = dimensionsKnown && (
    width >= height
      ? width <= 1280 && height <= 720
      : width <= 720 && height <= 1280
  );
  const bitrate = sourceBitrate(asset);
  return within720p && bitrate !== null && bitrate <= EFFICIENT_SOURCE_BITRATE;
}

export function videoCompressionMaxSize(asset: VideoPreparationAsset): number {
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  if (width <= 0 || height <= 0) {
    // Without dimensions, a 720 long edge is the conservative bound that
    // cannot exceed 720 on either axis.
    return 720;
  }
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  return Math.max(
    1,
    Math.round(Math.min(MAX_VIDEO_LONG_EDGE, (720 * longEdge) / shortEdge)),
  );
}

function preparedName(sourceName: string): string {
  const stem = sourceName.replace(/\.[^.]+$/, "") || "video";
  return `${stem}-720p.mp4`;
}

export async function prepareVideoForUpload(
  asset: VideoPreparationAsset,
): Promise<PreparedVideoUpload> {
  if (Platform.OS === "web") {
    throw new Error("Video preparation is only available in the mobile app.");
  }

  const sourceSize = asset.fileSize ?? (await nativeFileSize(asset.uri));
  const sourceName =
    asset.fileName ||
    `video-${Date.now()}.${fileExtension(asset.fileName ?? "") || "mp4"}`;
  const sourceMime = resolveVideoMime(asset);

  if (shouldBypassVideoCompression({ ...asset, fileSize: sourceSize })) {
    return {
      uri: asset.uri,
      fileName: sourceName,
      mimeType: sourceMime,
      fileSize: sourceSize,
      compressed: false,
    };
  }

  try {
    const { Video } = await import("react-native-compressor");
    const uri = await Video.compress(asset.uri, {
      compressionMethod: "manual",
      maxSize: videoCompressionMaxSize(asset),
      bitrate: MODERATE_VIDEO_BITRATE,
      minimumFileSizeForCompress: 0,
    });
    const compressedSize = await nativeFileSize(uri);

    // A transcode can occasionally grow a short, already-efficient clip. Never
    // increase transfer size just to normalize its container.
    if (compressedSize >= sourceSize) {
      return {
        uri: asset.uri,
        fileName: sourceName,
        mimeType: sourceMime,
        fileSize: sourceSize,
        compressed: false,
      };
    }

    return {
      uri,
      fileName: preparedName(sourceName),
      mimeType: "video/mp4",
      fileSize: compressedSize,
      compressed: true,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown compression error.";
    throw new Error(`Video preparation failed. Please retry. ${detail}`);
  }
}