import { getAccessToken, getApiUrl } from "./query-client";

export type AuthedImageSource = {
  uri: string;
  headers?: Record<string, string>;
};

// Case-media file endpoints (e.g. /api/cases/:id/attachments/:attId/file,
// /api/cases/attachment-file/<name>, /uploads/case-media/<name>, /api/media/...)
// require a bearer Authorization header. A plain <Image source={{ uri }}/> cannot
// send that header, so remote case media renders blank. expo-image natively
// supports source.headers, so we attach the token for our own API/media URLs only.
//
// Local/inline URIs (file://, data:, blob:, content:, ph://, asset-library://)
// and third-party URLs are returned untouched so we never leak the token.
const LOCAL_URI = /^(file:|data:|blob:|content:|ph:|asset-library:|assets-library:)/i;

// True when `uri` resolves to our own API origin (or is a same-origin relative
// /api|/uploads path). Use this to gate attaching the bearer token on manual
// fetch/download calls (video/document open), so the token never reaches a
// third-party host.
export function isSameApiOrigin(uri: string): boolean {
  if (uri.startsWith("/api/") || uri.startsWith("/uploads/")) return true;
  try {
    return new URL(uri).origin === new URL(getApiUrl()).origin;
  } catch {
    return false;
  }
}

export function isCaseMediaUrl(uri: string): boolean {
  // Relative paths are same-origin by definition; allow our API/upload paths.
  if (uri.startsWith("/api/") || uri.startsWith("/uploads/")) return true;
  // Absolute URLs: ONLY attach the bearer token when the origin exactly matches
  // our API origin. A path-only check (e.g. matching "/uploads/case-media/")
  // would leak the token to https://evil.tld/uploads/case-media/x, so origin is
  // validated FIRST. Anything else (third-party hosts, unparseable URIs) is
  // returned without auth.
  try {
    const apiOrigin = new URL(getApiUrl()).origin;
    const u = new URL(uri);
    if (u.origin !== apiOrigin) return false;
    return u.pathname.startsWith("/api/") || u.pathname.startsWith("/uploads/");
  } catch {
    return false;
  }
}

export function caseMediaSource(
  uri: string | null | undefined,
): AuthedImageSource | undefined {
  if (!uri) return undefined;
  if (LOCAL_URI.test(uri)) return { uri };
  if (!isCaseMediaUrl(uri)) return { uri };
  const token = getAccessToken();
  if (!token) return { uri };
  return { uri, headers: { Authorization: `Bearer ${token}` } };
}
