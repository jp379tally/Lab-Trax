const STORAGE_KEY = "labtrax_desktop_session_v1";

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

export type Session = {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
};

type SessionListener = (session: Session | null) => void;
const listeners = new Set<SessionListener>();

export function subscribeSession(fn: SessionListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(session: Session | null) {
  for (const fn of listeners) {
    try {
      fn(session);
    } catch {
      /* ignore */
    }
  }
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function saveSession(s: Session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  emit(s);
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
  emit(null);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const session = loadSession();
    if (!session?.refreshToken) return null;
    try {
      const r = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      if (!r.ok) {
        clearSession();
        return null;
      }
      const data = await r.json();
      const newToken: string | undefined = data?.data?.accessToken || data?.accessToken;
      if (!newToken) {
        clearSession();
        return null;
      }
      // Re-read in case logout happened during the request.
      const current = loadSession();
      if (!current) return null;
      saveSession({ ...current, accessToken: newToken });
      return newToken;
    } catch {
      clearSession();
      return null;
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
  const session = loadSession();
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (session?.accessToken) {
    headers["Authorization"] = `Bearer ${session.accessToken}`;
  }
  const url = path.startsWith("http") ? path : `/api${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, { ...options, headers });

  if (res.status === 401 && !retried && session?.refreshToken) {
    const fresh = await refreshAccessToken();
    if (fresh) return apiFetch<T>(path, options, true);
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

export async function login(username: string, password: string): Promise<Session> {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password,
      deviceName: "LabTrax Desktop Web",
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body?.success) {
    throw new ApiError(body?.message || "Invalid username or password.", r.status);
  }
  const session: Session = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    user: body.user,
  };
  saveSession(session);
  return session;
}

export async function logout(): Promise<void> {
  // Cancel any pending refresh so it can't resurrect the session post-logout.
  refreshInFlight = null;
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    /* swallow */
  }
  clearSession();
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
