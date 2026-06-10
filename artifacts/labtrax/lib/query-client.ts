import { fetch } from "expo/fetch";
import { QueryClient, QueryFunction, MutationObserver } from "@tanstack/react-query";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { isUnauthenticatedPath } from "./unauthenticated-paths";

let cachedBaseUrl: string | null = null;

const PRODUCTION_URL = "https://lab-trax.replit.app/";

const TOKEN_KEY = "@labtrax_tokens";

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export function getApiUrl(): string {
  if (cachedBaseUrl) return cachedBaseUrl;

  if (Platform.OS === "web" && typeof window !== "undefined" && window.location && window.location.origin) {
    return normalizeBaseUrl(window.location.origin);
  }

  if (Platform.OS !== "web") {
    const host = process.env.EXPO_PUBLIC_DOMAIN;
    if (host) {
      try {
        let url = new URL(`https://${host}`);
        url.port = "";
        return normalizeBaseUrl(url.href);
      } catch {
        return PRODUCTION_URL;
      }
    }
    return PRODUCTION_URL;
  }

  return PRODUCTION_URL;
}

function getApiUrlWithoutPort(): string | null {
  let host = process.env.EXPO_PUBLIC_DOMAIN;
  if (!host || !host.includes(":")) return null;
  try {
    let url = new URL(`https://${host}`);
    url.port = "";
    return normalizeBaseUrl(url.href);
  } catch {
    return null;
  }
}

let _accessToken: string | null = null;
let _refreshToken: string | null = null;
let _refreshPromise: Promise<string | null> | null = null;

// ── Reconnecting listener ──────────────────────────────────────────────────
// A single subscriber (owned by AuthProvider) that is called with `true`
// when a token refresh starts and `false` when it finishes. Used to drive
// the non-blocking "Reconnecting…" indicator in the UI.
// Only the caller that actually initiates the refresh fires the signal;
// concurrent callers that return the already-in-flight _refreshPromise do
// not re-fire it.
type ReconnectingListener = (active: boolean) => void;
let _reconnectingListener: ReconnectingListener | null = null;
export function setReconnectingListener(fn: ReconnectingListener | null): void {
  _reconnectingListener = fn;
}

// ── Reconnecting tracker (pure, no React dependency) ──────────────────────
// Drives the "Reconnecting…" indicator with a 400ms delay so fast token
// refreshes don't flash the banner. Exported here (not in auth-context) so
// tests can import it from the already-unmocked query-client module.
export function createReconnectingTracker(
  setState: (v: boolean) => void,
  delayMs = 400,
): { start: () => void; end: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    start() {
      timer = setTimeout(() => setState(true), delayMs);
    },
    end() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      setState(false);
    },
  };
}

// ── Singleton hydration promise ────────────────────────────────────────────
// A module-level deduplication slot so concurrent callers at startup all
// await the same SecureStore read instead of each racing to hydrate
// independently. Set on the first loadTokens() call; subsequent calls return
// the same promise. Cleared by clearTokens() so a post-logout loadTokens()
// starts a fresh read.
let _hydrationPromise: Promise<void> | null = null;
let _isHydrated = false;

async function secureGetItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    try {
      return await AsyncStorage.getItem(key);
    } catch (e) {
      console.warn(`[token-store] AsyncStorage.getItem failed for key "${key}":`, e);
      return null;
    }
  }
  try {
    return await SecureStore.getItemAsync(key);
  } catch (e) {
    console.warn(`[token-store] SecureStore.getItemAsync failed for key "${key}":`, e);
    return null;
  }
}

async function secureSetItem(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      await AsyncStorage.setItem(key, value);
    } catch (e) {
      console.warn(`[token-store] AsyncStorage.setItem failed for key "${key}":`, e);
    }
    return;
  }
  try {
    await SecureStore.setItemAsync(key, value);
    await AsyncStorage.removeItem(key);
  } catch (e) {
    console.warn(`[token-store] SecureStore.setItemAsync failed for key "${key}":`, e);
  }
}

async function secureRemoveItem(key: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      await AsyncStorage.removeItem(key);
    } catch (e) {
      console.warn(`[token-store] AsyncStorage.removeItem failed for key "${key}":`, e);
    }
    return;
  }
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (e) {
    console.warn(`[token-store] SecureStore.deleteItemAsync failed for key "${key}":`, e);
  }
  try {
    await AsyncStorage.removeItem(key);
  } catch {}
}

// loadTokens() creates the singleton hydration promise on first call and
// returns the same promise on every subsequent call — concurrent callers all
// await the same read instead of each independently hitting SecureStore.
export function loadTokens(): Promise<void> {
  if (_hydrationPromise) return _hydrationPromise;
  _hydrationPromise = (async () => {
    try {
      let raw = await secureGetItem(TOKEN_KEY);
      if (!raw && Platform.OS !== "web") {
        raw = await AsyncStorage.getItem(TOKEN_KEY);
        if (raw) {
          await SecureStore.setItemAsync(TOKEN_KEY, raw);
          await AsyncStorage.removeItem(TOKEN_KEY);
        }
      }
      if (raw) {
        const parsed = JSON.parse(raw);
        _accessToken = parsed.accessToken || null;
        _refreshToken = parsed.refreshToken || null;
      }
    } catch {}
    _isHydrated = true;
  })();
  return _hydrationPromise;
}

// waitForHydration() is the public API for callers (effects, providers) that
// want to ensure token state is ready before issuing their first request.
export function waitForHydration(): Promise<void> {
  return loadTokens();
}

// Returns true once the initial SecureStore read has completed at least once.
export function getIsHydrated(): boolean {
  return _isHydrated;
}

// ensureHydrated() awaits the singleton, then attempts one refresh if the
// store was empty but a refresh token is available. Internal to this module.
async function ensureHydrated(): Promise<void> {
  await loadTokens();
  if (Platform.OS !== "web" && !_accessToken && _refreshToken) {
    await refreshAccessToken();
  }
}

export async function saveTokens(accessToken: string, refreshToken: string) {
  _accessToken = accessToken;
  _refreshToken = refreshToken;
  await secureSetItem(TOKEN_KEY, JSON.stringify({ accessToken, refreshToken }));
}

export async function clearTokens() {
  _accessToken = null;
  _refreshToken = null;
  // Reset the singleton so a post-logout loadTokens() starts fresh. Without
  // this reset, the resolved hydration promise would short-circuit the next
  // SecureStore read, preventing a re-authenticated user from loading their
  // new tokens.
  _hydrationPromise = null;
  _isHydrated = false;
  await secureRemoveItem(TOKEN_KEY);
}

export function getAccessToken() {
  return _accessToken;
}

export function logDebugEvent(tag: string, payload: Record<string, unknown>): void {
  void (async () => {
    try {
      // Hydrate the bearer token from secure storage if not in memory — same
      // guard used by resilientFetch. Without this, logDebugEvent always fires
      // an unauthenticated request and receives 401 when _accessToken is null
      // (e.g. when the in-memory token hasn't been loaded yet on this launch).
      if (Platform.OS !== "web" && !_accessToken) {
        await loadTokens();
        if (!_accessToken && _refreshToken) {
          await refreshAccessToken();
        }
      }
      const token = _accessToken;
      if (!token) return; // still no token after hydration — skip silently
      const baseUrl = getApiUrl();
      const url = new URL("api/debug/event", baseUrl).toString();
      await globalThis.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tag, payload }),
      });
    } catch {}
  })();
}

async function refreshAccessToken(): Promise<string | null> {
  if (!_refreshToken) return null;
  if (_refreshPromise) return _refreshPromise;

  // Only the first caller fires the signal — concurrent callers return the
  // already-in-flight promise above without re-firing.
  _reconnectingListener?.(true);

  _refreshPromise = (async () => {
    try {
      const apiUrl = getApiUrl();
      const url = new URL("/api/auth/refresh", apiUrl).toString();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: _refreshToken }),
      });
      if (!res.ok) {
        await clearTokens();
        return null;
      }
      const data = await res.json();
      const newAccessToken: string | undefined =
        data?.data?.accessToken ?? data?.accessToken;
      if (newAccessToken) {
        _accessToken = newAccessToken;
        // The server rotates the refresh token on every refresh. Persist
        // the new one if it was returned; otherwise keep the existing one
        // for backward compatibility with older API versions.
        const newRefreshToken: string | undefined =
          data?.data?.refreshToken ?? data?.refreshToken;
        if (newRefreshToken) {
          _refreshToken = newRefreshToken;
        }
        await secureSetItem(
          TOKEN_KEY,
          JSON.stringify({ accessToken: _accessToken, refreshToken: _refreshToken }),
        );
        return _accessToken;
      }
      return null;
    } catch {
      return null;
    } finally {
      _refreshPromise = null;
      // Signal end regardless of success or failure so the indicator always
      // clears. Fires even when the try-catch returns null (failure path).
      _reconnectingListener?.(false);
    }
  })();

  return _refreshPromise;
}

function getCsrfToken(): string | null {
  if (Platform.OS !== "web" || typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|; )lt_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function refreshAccessTokenViaCookie(): Promise<boolean> {
  try {
    const apiUrl = getApiUrl();
    const url = new URL("/api/auth/refresh", apiUrl).toString();
    const csrfToken = getCsrfToken();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      },
      credentials: "include",
      body: JSON.stringify({}),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!(data?.refreshed || data?.accessToken);
  } catch {
    return false;
  }
}

function injectAuthHeaders(options?: RequestInit): RequestInit {
  const headers = new Headers(options?.headers || {});
  if (_accessToken) {
    headers.set("Authorization", `Bearer ${_accessToken}`);
  }
  if (Platform.OS !== "web") {
    headers.set("x-labtrax-client", "mobile/2");
  }
  if (Platform.OS === "web") {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers.set("x-csrf-token", csrfToken);
    }
  }
  const result: RequestInit = { ...options, headers };
  if (Platform.OS === "web") {
    result.credentials = "include";
  }
  return result;
}

async function resilientFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  // Native clients authenticate with a bearer token. Await the singleton
  // hydration promise before every request so all concurrent callers at
  // startup queue behind the same SecureStore read rather than each racing
  // to hydrate independently. ensureHydrated() also attempts one refresh if
  // the store was empty but a refresh token is available.
  //
  // Without this guard a request that fires at launch before loadTokens() has
  // run (or after a transient clear) would go out with no Authorization header
  // but with the auth cookie that React Native's fetch jar auto-attaches.
  // The server's CSRF guard rejects cookie-only POST/PUT/PATCH/DELETE with 403,
  // permanently wedging case-status/photo/note syncs as "lab rejected".
  if (Platform.OS !== "web") {
    await ensureHydrated();
    // Still no bearer after hydrating + refreshing: the user is effectively
    // logged out (token store empty/corrupt) but a stale auth cookie may
    // linger in React Native's fetch jar. Sending now would go out cookie-only
    // and earn a CSRF 403. Fail fast instead — callers treat a thrown fetch as
    // a transient failure recoverable once the user re-authenticates.
    // Exception: public paths (login, register, verification, etc.) must be
    // allowed through even with no token — blocking them prevents the login
    // form itself from working on a fresh install or after logout.
    // See `lib/unauthenticated-paths.ts` for the exact-match allowlist.
    if (!_accessToken && !isUnauthenticatedPath(path)) {
      console.error(
        "[resilientFetch] No bearer token available for path:",
        path,
        "— SecureStore hydration failed or session expired. Request will not be sent.",
      );
      throw new Error("Not authenticated: no bearer token available.");
    }
  }
  const primaryUrl = getApiUrl();
  const primaryFullUrl = new URL(path, primaryUrl).toString();
  const authedOptions = injectAuthHeaders(options) as any;

  try {
    let res = await fetch(primaryFullUrl, authedOptions);

    if (res.status === 401) {
      if (_refreshToken) {
        const newToken = await refreshAccessToken();
        if (newToken) {
          const retryHeaders = new Headers(authedOptions.headers || {});
          retryHeaders.set("Authorization", `Bearer ${newToken}`);
          res = await fetch(primaryFullUrl, { ...authedOptions, headers: retryHeaders });
        }
      } else if (Platform.OS === "web") {
        const refreshed = await refreshAccessTokenViaCookie();
        if (refreshed) {
          res = await fetch(primaryFullUrl, authedOptions);
        }
      }
    }

    if (res.ok) {
      cachedBaseUrl = primaryUrl;
      return res;
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      cachedBaseUrl = primaryUrl;
      return res;
    }
    const fallbackUrl = getApiUrlWithoutPort();
    if (fallbackUrl && fallbackUrl !== primaryUrl) {
      try {
        const fallbackFullUrl = new URL(path, fallbackUrl).toString();
        const fallbackRes = await fetch(fallbackFullUrl, authedOptions);
        if (fallbackRes.ok || (fallbackRes.headers.get("content-type") || "").includes("application/json")) {
          cachedBaseUrl = fallbackUrl;
          return fallbackRes;
        }
      } catch {}
    }
    cachedBaseUrl = primaryUrl;
    return res;
  } catch (primaryError) {
    const fallbackUrl = getApiUrlWithoutPort();
    if (fallbackUrl && fallbackUrl !== primaryUrl) {
      try {
        const fallbackFullUrl = new URL(path, fallbackUrl).toString();
        const res = await fetch(fallbackFullUrl, authedOptions);
        cachedBaseUrl = fallbackUrl;
        return res;
      } catch {}
    }
    throw primaryError;
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  route: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await resilientFetch(route, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export { resilientFetch };

// ── Multipart file upload ──────────────────────────────────────────────────
// IMPORTANT: do NOT route file uploads through `resilientFetch`. That helper is
// built on `expo/fetch`, whose FormData implementation rejects React Native's
// native file descriptor `{ uri, name, type }` with the runtime error
// "Unsupported FormDataPart implementation" — which is exactly why attaching
// photos/files was failing. We instead upload with XMLHttpRequest, which uses
// React Native's own networking + Blob module that fully supports the native
// file descriptor (and works identically on web with a Blob). This is immune
// to whichever `fetch` implementation happens to be active.
export type MediaUploadResult = {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
};

function buildUploadHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (Platform.OS === "web") {
    const csrf = getCsrfToken();
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  return headers;
}

async function buildUploadBody(
  fileUri: string,
  fileName: string,
  mimeType: string,
): Promise<FormData> {
  const formData = new FormData();
  if (Platform.OS === "web") {
    // On web `fileUri` may be a blob:/data: URL — materialize it into a Blob
    // so the standard FormData.append(name, Blob, filename) overload is used.
    const blob = await globalThis.fetch(fileUri).then((r) => r.blob());
    formData.append("file", blob, fileName);
  } else {
    // React Native's FormData runtime accepts the native file descriptor.
    (formData as any).append("file", { uri: fileUri, name: fileName, type: mimeType });
  }
  return formData;
}

function xhrUpload(
  url: string,
  formData: FormData,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    if (Platform.OS === "web") xhr.withCredentials = true;
    // Never set Content-Type manually — the runtime adds the multipart boundary.
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new Error("Network request failed"));
    xhr.send(formData as any);
  });
}

export async function uploadCaseMedia(
  path: string,
  fileUri: string,
  fileName: string,
  mimeType: string,
): Promise<MediaUploadResult> {
  // Mirror the same null-token guard as resilientFetch via the shared
  // ensureHydrated() singleton. Without this, a null _accessToken causes the
  // XHR to go out with no Authorization header. React Native's networking
  // stack may still attach a stale auth cookie, which the server's CSRF guard
  // rejects with a 403 — a PERMANENT "rejected" failure that wedges the photo
  // in the queue forever instead of retrying.
  if (Platform.OS !== "web") {
    await ensureHydrated();
    if (!_accessToken) {
      // No bearer token available. Throw so the caller treats this as a
      // transient network failure and retries after the user re-authenticates.
      throw new Error("Not authenticated: no bearer token available for upload.");
    }
  }

  const fullUrl = new URL(path, getApiUrl()).toString();
  const run = async (token: string | null) => {
    // Rebuild the body on each attempt — a consumed Blob cannot be re-sent.
    const formData = await buildUploadBody(fileUri, fileName, mimeType);
    return xhrUpload(fullUrl, formData, buildUploadHeaders(token));
  };

  let res = await run(_accessToken);
  if (res.status === 401 && _refreshToken) {
    const newToken = await refreshAccessToken();
    if (newToken) res = await run(newToken);
  }

  let parsed: any;
  let didParse = false;
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    json: async () => {
      if (!didParse) {
        try {
          parsed = JSON.parse(res.body);
        } catch {
          parsed = {};
        }
        didParse = true;
      }
      return parsed;
    },
  };
}

// ── Chunked media upload ───────────────────────────────────────────────────
// Uploads a file to /api/media/upload-session in 1 MB chunks so large files
// (PDFs, photos) are never dropped by the Replit proxy's ~20 MB single-shot
// limit. Falls back cleanly if the session cannot be created.
export type ChunkedUploadResult =
  | { ok: true; url: string }
  | { ok: false; status?: number; error?: string };

const CHUNKED_UPLOAD_CHUNK_SIZE = 1 * 1024 * 1024; // 1 MB

// Per-chunk retry budget for transient network / 5xx failures. A single
// dropped packet on a flaky mobile connection used to fail the whole upload;
// now each chunk PATCH is retried with exponential back-off before giving up.
const CHUNK_MAX_RETRIES = 3;

function chunkBackoffDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 8_000);
}

// Maps a stable file identity (uri + size) to a live server upload session so a
// fresh chunkedUploadCaseMedia() call after a dropped connection resumes from
// the server's current offset instead of restarting from byte 0. Keyed on
// (uri + size) — NOT fileName — because callers mint a new timestamped fileName
// on every retry attempt.
const resumableSessionCache = new Map<string, string>();

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
}

function sendBinaryPatch(
  url: string,
  data: ArrayBuffer,
  offset: number,
  token: string | null,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", url);
    if (Platform.OS === "web") xhr.withCredentials = true;
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    if (Platform.OS === "web") {
      const csrf = getCsrfToken();
      if (csrf) xhr.setRequestHeader("x-csrf-token", csrf);
    }
    xhr.setRequestHeader("Upload-Offset", String(offset));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new Error("Network request failed"));
    xhr.send(data);
  });
}

// Sends a single chunk PATCH, retrying transient failures (network drops and
// 5xx responses) up to CHUNK_MAX_RETRIES times with exponential back-off.
// A 401 is handled inline by refreshing the bearer token once per attempt.
// Definitive responses — 2xx success, 409 offset-resync, and other 4xx — are
// returned to the caller rather than retried. Throws only when every transient
// retry is exhausted.
async function sendChunkWithRetry(
  patchUrl: string,
  chunkBuffer: ArrayBuffer,
  offset: number,
): Promise<{ status: number; body: string }> {
  let lastError: unknown = new Error("Chunk upload failed");
  for (let attempt = 0; attempt <= CHUNK_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((r) => setTimeout(r, chunkBackoffDelayMs(attempt)));
    }
    try {
      let result = await sendBinaryPatch(patchUrl, chunkBuffer, offset, _accessToken);
      if (result.status === 401 && _refreshToken) {
        const newToken = await refreshAccessToken();
        if (newToken) {
          result = await sendBinaryPatch(patchUrl, chunkBuffer, offset, newToken);
        }
      }
      if (result.status >= 500 && result.status < 600) {
        // Transient server error — back off and retry the same chunk.
        lastError = new Error(`Chunk upload failed with status ${result.status}`);
        continue;
      }
      return result;
    } catch (e) {
      // Network-level failure (sendBinaryPatch rejected) — back off and retry.
      lastError = e;
    }
  }
  throw lastError;
}

export async function chunkedUploadCaseMedia(
  fileUri: string,
  fileName: string,
  mimeType: string,
): Promise<ChunkedUploadResult> {
  // Use the shared ensureHydrated() singleton instead of an ad hoc guard.
  if (Platform.OS !== "web") {
    await ensureHydrated();
    if (!_accessToken) {
      throw new Error("Not authenticated: no bearer token available for upload.");
    }
  }

  // Resolve the file to either a Blob (web) or a decoded ArrayBuffer (native)
  let fileBlob: Blob | null = null;
  let fullBuffer: ArrayBuffer | null = null;
  let fileSize = 0;

  if (Platform.OS === "web") {
    const resp = await globalThis.fetch(fileUri);
    fileBlob = await resp.blob();
    fileSize = fileBlob.size;
  } else {
    // Native: read entire file as base64, decode to ArrayBuffer once
    let rawB64 = "";
    if (fileUri.startsWith("data:")) {
      const idx = fileUri.indexOf(",");
      rawB64 = idx >= 0 ? fileUri.slice(idx + 1) : fileUri;
    } else {
      // Dynamic import avoids bundling issues on web
      const FS = await import("expo-file-system");
      rawB64 = await (FS as any).readAsStringAsync(fileUri, {
        encoding: (FS as any).EncodingType.Base64,
      });
    }
    fullBuffer = base64ToArrayBuffer(rawB64);
    fileSize = fullBuffer.byteLength;
  }

  if (fileSize <= 0) {
    return { ok: false, error: "Could not determine file size" };
  }

  // Resume an in-flight session for this exact file if one is still alive on
  // the server (e.g. a previous attempt dropped mid-upload). This avoids
  // re-uploading bytes the server already has.
  const cacheKey = `${fileUri}::${fileSize}`;
  let sessionId: string | null = null;
  let uploadedBytes = 0;

  const cachedSessionId = resumableSessionCache.get(cacheKey);
  if (cachedSessionId) {
    try {
      const statusRes = await resilientFetch(
        `/api/media/upload-session/${cachedSessionId}`,
        { method: "GET" },
      );
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        // Only resume if the server agrees on the file size — otherwise the
        // cached id is stale/mismatched and we start fresh.
        if (typeof statusData?.fileSize === "number" && statusData.fileSize === fileSize) {
          sessionId = cachedSessionId;
          uploadedBytes = (statusData.uploadedBytes as number) ?? 0;
        }
      }
    } catch {
      // Status check failed (network error / expired session) — fall through
      // and create a fresh session below.
    }
    if (!sessionId) {
      resumableSessionCache.delete(cacheKey);
    }
  }

  // Create a new upload session if we couldn't resume an existing one.
  if (!sessionId) {
    const sessionRes = await resilientFetch("/api/media/upload-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName, fileSize, mimeType }),
    });
    if (!sessionRes.ok) {
      return { ok: false, status: sessionRes.status, error: "Could not create upload session" };
    }
    const sessionData = await sessionRes.json();
    sessionId = sessionData.sessionId as string;
    uploadedBytes = (sessionData.uploadedBytes as number) ?? 0;
    resumableSessionCache.set(cacheKey, sessionId);
  }

  const patchUrl = new URL(
    `/api/media/upload-session/${sessionId}`,
    getApiUrl(),
  ).toString();

  // Upload in 1 MB chunks. Each chunk PATCH is retried with back-off on
  // transient failures (see sendChunkWithRetry); a thrown error means all
  // retries were exhausted, so we bail but KEEP the session cached so a later
  // call can resume from the server's offset rather than restarting.
  try {
    while (uploadedBytes < fileSize) {
      const chunkSize = Math.min(CHUNKED_UPLOAD_CHUNK_SIZE, fileSize - uploadedBytes);
      let chunkBuffer: ArrayBuffer;

      if (fileBlob) {
        chunkBuffer = await fileBlob.slice(uploadedBytes, uploadedBytes + chunkSize).arrayBuffer();
      } else {
        chunkBuffer = fullBuffer!.slice(uploadedBytes, uploadedBytes + chunkSize);
      }

      const patchResult = await sendChunkWithRetry(patchUrl, chunkBuffer, uploadedBytes);

      if (patchResult.status === 409) {
        // Server reports a different offset; resync before retrying
        try {
          const body = JSON.parse(patchResult.body);
          uploadedBytes = (body.uploadedBytes as number) ?? uploadedBytes;
        } catch {}
        continue;
      }

      if (patchResult.status < 200 || patchResult.status >= 300) {
        return { ok: false, status: patchResult.status, error: "Chunk upload failed" };
      }

      let patchBody: any = {};
      try { patchBody = JSON.parse(patchResult.body); } catch {}

      if (patchBody.complete && patchBody.url) {
        resumableSessionCache.delete(cacheKey);
        return { ok: true, url: patchBody.url as string };
      }

      uploadedBytes = (patchBody.uploadedBytes as number) ?? uploadedBytes + chunkBuffer.byteLength;
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Chunk upload failed after retries",
    };
  }

  return { ok: false, error: "Upload ended without a complete response" };
}

export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const route = queryKey.join("/") as string;

    const res = await resilientFetch(route);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

/**
 * Async retry helper for awaitable operations.
 * Treats a null result as failure when isFailure is omitted (null-check default).
 * Throws after all retries are exhausted.
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  retries = 3,
  isFailure: (v: T) => boolean = (v) => v === null || v === undefined,
): Promise<T> {
  let lastError: unknown = new Error("retryAsync: all attempts failed");
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((r) =>
        setTimeout(r, Math.min(1_000 * 2 ** (attempt - 1), 30_000)),
      );
    }
    try {
      const result = await fn();
      if (!isFailure(result)) return result;
      lastError = new Error(`retryAsync: attempt ${attempt} returned a failure value`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * Fire-and-forget wrapper that executes fn() with up to `retries` attempts
 * and exponential back-off using React Query's MutationObserver retry engine.
 * fn() must throw (or return a rejected Promise) for a retry to be triggered.
 * Errors after all retries are silently discarded.
 *
 * Used for status syncs, note posts, and attachment creates that should retry
 * on transient network failures without blocking the calling code path.
 */
export function fireWithRetry(
  fn: () => Promise<unknown>,
  retries = 3,
): void {
  const obs = new MutationObserver<unknown, Error, void>(queryClient, {
    mutationFn: (_vars: void) => fn(),
    retry: retries,
    retryDelay: (attempt: number) => Math.min(1_000 * 2 ** attempt, 30_000),
  });
  // mutate() returns a Promise in v5 — drives the retry loop.
  void obs.mutate(undefined as unknown as void).catch(() => {});
}

// ── Wire @workspace/api-client-react for mobile ─────────────────────────────
// Generated and custom hooks in api-client-react use customFetch, which needs
// (a) a base URL (relative /api/* paths won't resolve on native without it),
// (b) a Bearer token getter with SecureStore hydration (native has no session cookie),
// (c) a token refresher so 401 responses transparently retry after a token refresh.
// Called at module init so hooks are ready before any component mounts.
import { setBaseUrl, setAuthTokenGetter, setAuthRefresher } from "@workspace/api-client-react";
setBaseUrl(getApiUrl().replace(/\/+$/, ""));

// Auth getter: use the shared ensureHydrated() singleton so all callers
// (resilientFetch, XHR uploads, and generated hooks) queue behind the same
// SecureStore read rather than each racing independently.
setAuthTokenGetter(async () => {
  if (Platform.OS !== "web") {
    await ensureHydrated();
  }
  return _accessToken;
});

// Refresher: called by customFetch on 401 — fetches a new access token so the
// failed query is retried with a fresh bearer token without requiring re-login.
setAuthRefresher(async () => {
  await refreshAccessToken();
  return _accessToken;
});
