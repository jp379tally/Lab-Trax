import { fetch } from "expo/fetch";
import { QueryClient, QueryFunction } from "@tanstack/react-query";
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

export async function loadTokens() {
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
}

export async function saveTokens(accessToken: string, refreshToken: string) {
  _accessToken = accessToken;
  _refreshToken = refreshToken;
  await secureSetItem(TOKEN_KEY, JSON.stringify({ accessToken, refreshToken }));
}

export async function clearTokens() {
  _accessToken = null;
  _refreshToken = null;
  await secureRemoveItem(TOKEN_KEY);
}

export function getAccessToken() {
  return _accessToken;
}

// Force-refresh the auth token for rendering auth-gated case media
// (images/video). Native <Image> attaches the bearer token synchronously via
// caseMediaSource(); when that in-memory token is missing (cold start before
// loadTokens ran) or expired, the file request 401s and the image renders
// blank with NO retry — unlike resilientFetch JSON calls, which refresh and
// retry. The AuthedImage component calls this on a load error to hydrate +
// rotate the token, then re-renders with fresh headers. Returns the current
// access token (native) or null when refresh failed / user is logged out.
export async function refreshAuthForMedia(): Promise<string | null> {
  if (Platform.OS === "web") {
    const ok = await refreshAccessTokenViaCookie();
    return ok ? _accessToken : null;
  }
  if (!_accessToken && !_refreshToken) {
    await loadTokens();
  }
  if (_refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return refreshed;
  }
  return _accessToken;
}

async function refreshAccessToken(): Promise<string | null> {
  if (!_refreshToken) return null;
  if (_refreshPromise) return _refreshPromise;

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
  // Native clients authenticate with a bearer token. If the in-memory token
  // isn't populated yet — e.g. the offline-queue drain fires at launch before
  // loadTokens() has run, or after a transient clear — hydrate it from secure
  // storage (and refresh if needed) BEFORE sending. Otherwise the request goes
  // out with no Authorization header but with the auth cookie that React
  // Native's fetch jar auto-attaches, which the server's CSRF guard rejects
  // with a 403 on every state-changing request (POST/PUT/PATCH/DELETE) —
  // silently wedging case-status/photo/note syncs as "lab rejected".
  if (Platform.OS !== "web" && !_accessToken && !isUnauthenticatedPath(path)) {
    await loadTokens();
    if (!_accessToken && _refreshToken) {
      await refreshAccessToken();
    }
    // Still no bearer after hydrating + refreshing: the user is effectively
    // logged out (token store empty/corrupt) but a stale auth cookie may
    // linger in React Native's fetch jar. Sending now would go out cookie-only
    // and earn a CSRF 403, which the offline queue records as a PERMANENT
    // "lab rejected this change". Fail fast instead — a thrown fetch is treated
    // as a transient/retryable error, so the change stays recoverable until the
    // user re-authenticates.
    if (!_accessToken) {
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
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
