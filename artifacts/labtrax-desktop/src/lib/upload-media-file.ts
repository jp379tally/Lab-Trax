import { apiFetch, createUploadSession, sendUploadChunk, ApiError } from "@/lib/api";

// Single-shot /media/upload is capped by the Replit reverse proxy well below
// multer's 200 MB limit, so anything over ~20 MB is routed through the
// resumable /media/upload-session pipeline instead (1 MB chunks).
const SINGLE_SHOT_UPLOAD_LIMIT = 20 * 1024 * 1024;
const CHUNK_BYTES = 1 * 1024 * 1024;

export interface MediaUploadResult {
  url: string;
  filename?: string;
  size?: number;
}

/**
 * Upload a file to object storage. Files ≤20 MB use a single multipart POST;
 * larger files use the resumable chunked /media/upload-session pipeline so
 * they are never dropped by the Replit reverse proxy.
 */
export async function uploadMediaFile(file: File): Promise<MediaUploadResult> {
  if (file.size <= SINGLE_SHOT_UPLOAD_LIMIT) {
    const fd = new FormData();
    fd.append("file", file);
    return apiFetch<MediaUploadResult>("/media/upload", {
      method: "POST",
      body: fd,
      headers: {},
    });
  }

  const session = await createUploadSession({
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || "application/octet-stream",
  });
  let offset = session.uploadedBytes ?? 0;
  while (offset < file.size) {
    const end = Math.min(offset + CHUNK_BYTES, file.size);
    const blob = file.slice(offset, end);
    try {
      const result = await sendUploadChunk(session.sessionId, blob, offset);
      offset = result.uploadedBytes;
      if (result.complete) {
        if (!result.url) {
          throw new Error("Upload completed but server did not return a URL.");
        }
        return { url: result.url, filename: result.filename, size: result.size };
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const reported = (err as ApiError & { uploadedBytes?: number }).uploadedBytes;
        if (typeof reported === "number" && reported !== offset) {
          offset = reported;
          continue;
        }
      }
      throw err;
    }
  }
  throw new Error("Upload finished without a server confirmation.");
}
