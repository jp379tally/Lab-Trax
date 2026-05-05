export type SessionUser = {
  id: string;
  username: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  initials?: string | null;
  userType?: string | null;
  role?: string | null;
  practiceName?: string | null;
};

type SessionListener = (user: SessionUser | null) => void;
const listeners = new Set<SessionListener>();

export function subscribeSession(fn: SessionListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(user: SessionUser | null) {
  for (const fn of listeners) {
    try {
      fn(user);
    } catch {
      /* ignore */
    }
  }
}

export function notifySessionCleared() {
  emit(null);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const r = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!r.ok) {
        emit(null);
        return false;
      }
      return true;
    } catch {
      emit(null);
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const url = path.startsWith("http") ? path : `/api${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, { ...options, headers, credentials: "include" });

  if (res.status === 401 && !retried) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return apiFetch<T>(path, options, true);
    throw new ApiError("Your session has expired. Please sign in again.", 401);
  }

  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    /* ignore */
  }
  let parsed: unknown = null;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = bodyText;
    }
  }

  if (!res.ok) {
    const fromObj =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const msg =
      (fromObj && typeof fromObj.message === "string" && fromObj.message) ||
      (fromObj && typeof fromObj.error === "string" && fromObj.error) ||
      `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "data" in (parsed as Record<string, unknown>) &&
    Object.keys(parsed as Record<string, unknown>).length <= 3
  ) {
    return (parsed as { data: T }).data;
  }
  return parsed as T;
}

export async function login(username: string, password: string): Promise<SessionUser> {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password,
      deviceName: "LabTrax Desktop Web",
      clientType: "web",
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body?.success) {
    throw new ApiError(body?.message || "Invalid username or password.", r.status);
  }
  emit(body.user);
  return body.user as SessionUser;
}

export async function logout(): Promise<void> {
  // Cancel any pending refresh so it can't resurrect the session post-logout.
  refreshInFlight = null;
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    /* swallow */
  }
  emit(null);
}

export async function fetchMe(): Promise<SessionUser> {
  const body = await apiFetch<{ success?: boolean; user?: SessionUser } | SessionUser>(
    "/auth/me",
  );
  if (body && typeof body === "object" && "user" in body && body.user) {
    return body.user;
  }
  return body as SessionUser;
}

// Legacy migration: clear any tokens that may have been written by a previous
// version of the desktop app so they cannot be exfiltrated by XSS.
try {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("labtrax_desktop_session_v1");
  }
} catch {
  /* ignore */
}
