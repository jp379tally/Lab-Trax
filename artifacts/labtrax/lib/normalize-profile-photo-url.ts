import { getApiUrl } from "./query-client";

/**
 * Normalises a server-returned profile photo URL so it is always a fully-
 * qualified URL on every platform. The server stores a relative path
 * (`/uploads/profile-photos/<file>.jpg`). Browsers resolve relative URLs
 * against the window origin automatically, but React Native's <Image>
 * requires an absolute `http(s)://` URI.
 *
 * Rules:
 * - Already absolute (starts with "http") → unchanged (covers https too).
 * - Local file/content picker URIs (file://, content://) → unchanged; these
 *   are already absolute and will be replaced by the server URL once upload
 *   completes.
 * - Relative path → resolve against the API host, not the web preview origin.
 * - Unsupported schemes → null (render initials instead).
 */
export function normalizeProfilePhotoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  // Already absolute or a local picker URI — leave untouched.
  if (/^https?:\/\//i.test(url) || url.startsWith("file://") || url.startsWith("content://")) {
    return url;
  }
  // Strip the /api path segment and any
  // trailing slash so we don't produce double-slashes in the final URL).
  const base = getApiUrl().replace(/\/api\/?$/, "").replace(/\/$/, "");
  try {
    const resolved = new URL(url, `${base}/`);
    return /^https?:$/.test(resolved.protocol) ? resolved.href : null;
  } catch { return null; }
}
