import { fetch } from "expo/fetch";
import { QueryClient, QueryFunction } from "@tanstack/react-query";

let cachedBaseUrl: string | null = null;

export function getApiUrl(): string {
  if (cachedBaseUrl) return cachedBaseUrl;

  let host = process.env.EXPO_PUBLIC_DOMAIN;

  if (!host) {
    throw new Error("EXPO_PUBLIC_DOMAIN is not set");
  }

  let url = new URL(`https://${host}`);

  return url.href;
}

function getApiUrlWithoutPort(): string | null {
  let host = process.env.EXPO_PUBLIC_DOMAIN;
  if (!host || !host.includes(":")) return null;
  let url = new URL(`https://${host}`);
  url.port = "";
  return url.href;
}

async function resilientFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const primaryUrl = getApiUrl();
  const primaryFullUrl = new URL(path, primaryUrl).toString();

  try {
    const res = await fetch(primaryFullUrl, options);
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
        const fallbackRes = await fetch(fallbackFullUrl, options);
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
        const res = await fetch(fallbackFullUrl, options);
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
    credentials: "include",
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

    const res = await resilientFetch(route, {
      credentials: "include",
    });

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
