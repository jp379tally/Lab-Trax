const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
]);
const VIDEO_EXTENSIONS = new Set([
  "mov",
  "mp4",
  "m4v",
  "webm",
  "ogv",
  "ogg",
]);

/**
 * Classify attachment metadata consistently across Files and History. Some
 * uploads (notably clips from mobile clients) arrive as
 * application/octet-stream, so MIME alone is not sufficient.
 */
export function classifyMediaKind(
  mimeType?: string,
  fileName?: string,
  declaredKind?: string,
): "image" | "video" | null {
  const normalizedMime = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  const extension = (fileName?.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  if (
    normalizedMime.startsWith("image/") ||
    declaredKind === "photo" ||
    IMAGE_EXTENSIONS.has(extension)
  ) {
    return "image";
  }
  if (
    normalizedMime.startsWith("video/") ||
    declaredKind === "video" ||
    VIDEO_EXTENSIONS.has(extension)
  ) {
    return "video";
  }
  return null;
}