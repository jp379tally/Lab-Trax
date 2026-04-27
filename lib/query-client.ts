import { fetch } from "expo/fetch";
import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

let cachedBaseUrl: string | null = null;

const PRODUCTION_URL = "https://lab-trax.replit.app/";

const TOKEN_KEY = "@labtrax_tokens";

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildBaseUrl(
  input: string,
  options: { stripPort?: boolean } = {},
): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const value = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(value);
    if (options.stripPort) {
      url.port = "";
    }
    return normalizeBaseUrl(url.origin);
  } catch {
    return null;
  }
}

function addCandidateUrl(urls: string[], value: string | null) {
  if (value && !urls.includes(value)) {
    urls.push(value);
  }
}

export function getApiBaseUrlCandidates(): string[] {
  const urls: string[] = [];

  if (typeof window !== "undefined" && window.location?.origin) {
    addCandidateUrl(urls, normalizeBaseUrl(window.location.origin));
  }

  const host = process.env.EXPO_PUBLIC_DOMAIN;
  if (host) {
    addCandidateUrl(urls, buildBaseUrl(host));
    addCandidateUrl(urls, buildBaseUrl(host, { stripPort: true }));
  }

  if (Platform.OS !== "web") {
    addCandidateUrl(urls, PRODUCTION_URL);
  } else if (urls.length === 0) {
    addCandidateUrl(urls, PRODUCTION_URL);
  }

  if (cachedBaseUrl && !urls.includes(cachedBaseUrl)) {
    return [cachedBaseUrl, ...urls];
  }

  if (cachedBaseUrl) {
    return [cachedBaseUrl, ...urls.filter((url) => url !== cachedBaseUrl)];
  }

  return urls;
}

export function getApiUrl(): string {
  return getApiBaseUrlCandidates()[0] ?? PRODUCTION_URL;
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

async function refreshAccessToken(baseUrlOverride?: string): Promise<string | null> {
  if (!_refreshToken) return null;
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    const candidateUrls = baseUrlOverride
      ? [baseUrlOverride, ...getApiBaseUrlCandidates().filter((url) => url !== baseUrlOverride)]
      : getApiBaseUrlCandidates();
    let sawAuthFailure = false;

    try {
      for (const apiUrl of candidateUrls) {
        try {
          const url = new URL("/api/auth/refresh", apiUrl).toString();
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken: _refreshToken }),
          });

          if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
              sawAuthFailure = true;
            }
            continue;
          }

          const data = await res.json();
          if (data.data?.accessToken) {
            _accessToken = data.data.accessToken;
            cachedBaseUrl = apiUrl;
            await AsyncStorage.setItem(
              TOKEN_KEY,
              JSON.stringify({
                accessToken: _accessToken,
                refreshToken: _refreshToken,
              }),
            );
            return _accessToken;
          }
        } catch {}
      }

      if (sawAuthFailure) {
        await clearTokens();
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

async function fetchWithAuthRetry(
  path: string,
  baseUrl: string,
  options: RequestInit,
): Promise<Response> {
  const requestUrl = new URL(path, baseUrl).toString();
  let res = await fetch(requestUrl, options as any);

  if (res.status === 401 && _refreshToken) {
    const newToken = await refreshAccessToken(baseUrl);
    if (newToken) {
      const retryHeaders = new Headers(options.headers || {});
      retryHeaders.set("Authorization", `Bearer ${newToken}`);
      res = await fetch(requestUrl, { ...options, headers: retryHeaders } as any);
    }
  }

  return res;
}

async function resilientFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const authedOptions = injectAuthHeaders(options);
  const candidateUrls = getApiBaseUrlCandidates();
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (const baseUrl of candidateUrls) {
    try {
      const res = await fetchWithAuthRetry(path, baseUrl, authedOptions);
      const contentType = res.headers.get("content-type") || "";

      if (res.ok || contentType.includes("application/json")) {
        cachedBaseUrl = baseUrl;
        return res;
      }

      lastResponse = res;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastResponse) {
    return lastResponse;
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`Unable to reach API for ${path}`);
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
