import { fetch } from "expo/fetch";
import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

let cachedBaseUrl: string | null = null;

const PRODUCTION_URL = "https://lab-trax.replit.app/";

const TOKEN_KEY = "@labtrax_tokens";

export function getApiUrl(): string {
  if (cachedBaseUrl) return cachedBaseUrl;

  if (Platform.OS !== "web") {
    const host = process.env.EXPO_PUBLIC_DOMAIN;
    if (host) {
      try {
        let url = new URL(`https://${host}`);
        url.port = "";
        return url.href;
      } catch {
        return PRODUCTION_URL;
      }
    }
    return PRODUCTION_URL;
  }

  if (typeof window !== "undefined" && window.location && window.location.origin) {
    const origin = window.location.origin;
    if (origin && !origin.includes("localhost")) {
      return origin.endsWith("/") ? origin : origin + "/";
    }
  }

  return PRODUCTION_URL;
}

function getApiUrlWithoutPort(): string | null {
  let host = process.env.EXPO_PUBLIC_DOMAIN;
  if (!host || !host.includes(":")) return null;
  let url = new URL(`https://${host}`);
  url.port = "";
  return url.href;
}

let _accessToken: string | null = null;
let _refreshToken: string | null = null;
let _refreshPromise: Promise<string | null> | null = null;

export async function loadTokens() {
  try {
    const raw = await AsyncStorage.getItem(TOKEN_KEY);
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
  await AsyncStorage.setItem(TOKEN_KEY, JSON.stringify({ accessToken, refreshToken }));
}

export async function clearTokens() {
  _accessToken = null;
  _refreshToken = null;
  await AsyncStorage.removeItem(TOKEN_KEY);
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
      if (data.data?.accessToken) {
        _accessToken = data.data.accessToken;
        await AsyncStorage.setItem(TOKEN_KEY, JSON.stringify({ accessToken: _accessToken, refreshToken: _refreshToken }));
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

function injectAuthHeaders(options?: RequestInit): RequestInit {
  const headers = new Headers(options?.headers || {});
  if (_accessToken) {
    headers.set("Authorization", `Bearer ${_accessToken}`);
  }
  return { ...options, headers };
}

async function resilientFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const primaryUrl = getApiUrl();
  const primaryFullUrl = new URL(path, primaryUrl).toString();
  const authedOptions = injectAuthHeaders(options);

  try {
    let res = await fetch(primaryFullUrl, authedOptions);

    if (res.status === 401 && _refreshToken) {
      const newToken = await refreshAccessToken();
      if (newToken) {
        const retryHeaders = new Headers(authedOptions.headers || {});
        retryHeaders.set("Authorization", `Bearer ${newToken}`);
        res = await fetch(primaryFullUrl, { ...authedOptions, headers: retryHeaders });
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
    const prodUrl = "https://lab-trax.replit.app/";
    if (prodUrl !== primaryUrl && prodUrl !== fallbackUrl) {
      try {
        const prodFullUrl = new URL(path, prodUrl).toString();
        const res = await fetch(prodFullUrl, authedOptions);
        cachedBaseUrl = prodUrl;
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
