import { fetch } from "expo/fetch";
import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

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
