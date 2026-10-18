/**
 * Utilities for classifying and resolving MIME types for video assets
 * picked from the photo library (expo-image-picker).
 *
 * Expo's ImagePickerAsset.type is documented as optional/nullable for some
 * Android content providers, and mimeType is similarly nullable.  We use a
 * three-tier check so a video with no type and no MIME is still correctly
 * identified by its file extension rather than passed to ImageManipulator:
 *
 *   1. asset.type === "video"   (Expo picker discriminator — most reliable)
 *   2. mimeType starts with "video/"
 *   3. file extension is in the known video-extension table
 */

/** Maps common video file extensions to their canonical MIME type. */
export const VIDEO_EXTENSION_MIME: Record<string, string> = {
  mp4:  "video/mp4",
  m4v:  "video/mp4",
  mov:  "video/quicktime",
  qt:   "video/quicktime",
  avi:  "video/x-msvideo",
  wmv:  "video/x-ms-wmv",
  webm: "video/webm",
  mkv:  "video/x-matroska",
  "3gp":  "video/3gpp",
  "3g2":  "video/3gpp2",
  ogv:  "video/ogg",
  ts:   "video/mp2t",
};

/** Extracts the lowercased extension (without the dot) from a filename, or "" if none. */
export function fileExtension(fileName: string): string {
  const match = fileName.trim().match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Returns true when the asset is a video, using a three-tier fallback:
 *   picker type field → MIME prefix → file extension.
 */
export function isVideoAsset(asset: {
  type?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
}): boolean {
  if (asset.type === "video") return true;
  if (asset.type && asset.type !== "video") return false;
  const normalizedMime = (asset.mimeType ?? "").trim().toLowerCase();
  if (normalizedMime.startsWith("video/")) return true;
  const mayUseFilename =
    !normalizedMime ||
    normalizedMime === "application/octet-stream" ||
    normalizedMime === "binary/octet-stream";
  if (mayUseFilename && asset.fileName) {
    const ext = fileExtension(asset.fileName);
    if (ext in VIDEO_EXTENSION_MIME) return true;
  }
  return false;
}

/**
 * Returns the best available MIME type for a video asset.
 * Prefers the existing mimeType (if it is a video/ type), then looks up
 * the extension table, and falls back to "video/mp4".
 */
export function resolveVideoMime(asset: {
  mimeType?: string | null;
  fileName?: string | null;
}): string {
  const mime = (asset.mimeType ?? "").trim().toLowerCase();
  if (mime.startsWith("video/")) return mime;
  if (asset.fileName) {
    const ext = fileExtension(asset.fileName);
    const mapped = VIDEO_EXTENSION_MIME[ext];
    if (mapped) return mapped;
  }
  return "video/mp4";
}

/**
 * Native AVPlayer/ExoPlayer support for common camera formats used by mobile
 * uploads. Other recognized video formats remain available through the OS
 * open/download fallback.
 */
export function isInlinePlayableVideo(asset: {
  mimeType?: string | null;
  fileName?: string | null;
}): boolean {
  const mime = resolveVideoMime(asset);
  return [
    "video/mp4",
    "video/quicktime",
    "video/x-m4v",
    "video/3gpp",
    "video/3gpp2",
  ].includes(mime);
}
