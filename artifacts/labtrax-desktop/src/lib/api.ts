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

const CSRF_COOKIE_NAME = "lt_csrf";
const CSRF_HEADER_NAME = "X-CSRF-Token";

function readCsrfCookie(): string | null {
  if (typeof document === "undefined" || !document.cookie) return null;
  for (const part of document.cookie.split(";")) {
    const [rawName, ...rest] = part.split("=");
    if (rawName?.trim() === CSRF_COOKIE_NAME) {
      return decodeURIComponent(rest.join("=").trim());
    }
  }
  return null;
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const refreshHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const csrf = readCsrfCookie();
      if (csrf) refreshHeaders[CSRF_HEADER_NAME] = csrf;
      const r = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: refreshHeaders,
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
  const method = (options.method ?? "GET").toUpperCase();
  const isUnsafe = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (isUnsafe && !headers[CSRF_HEADER_NAME]) {
    let csrf = readCsrfCookie();
    // Existing sessions from before CSRF was introduced won't have an
    // lt_csrf cookie yet. Seed one by refreshing — the server mints a fresh
    // CSRF token whenever auth cookies are reissued. Only do this once per
    // call to avoid loops if refresh itself fails.
    if (!csrf && !retried) {
      const seeded = await refreshAccessToken();
      if (seeded) csrf = readCsrfCookie();
    }
    if (csrf) headers[CSRF_HEADER_NAME] = csrf;
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

export interface UploadWithProgressOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

async function performXhrUpload<T>(
  url: string,
  formData: FormData,
  csrf: string | null,
  opts: UploadWithProgressOptions,
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    if (csrf) xhr.setRequestHeader(CSRF_HEADER_NAME, csrf);

    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && opts.onProgress) {
          const pct = Math.min(99, Math.round((event.loaded / event.total) * 100));
          opts.onProgress(pct);
        }
      };
      xhr.upload.onload = () => {
        opts.onProgress?.(99);
      };
    }

    xhr.onload = () => {
      const status = xhr.status;
      const text = xhr.responseText || "";
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (status >= 200 && status < 300) {
        let payload: unknown = parsed;
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          "data" in (parsed as Record<string, unknown>) &&
          Object.keys(parsed as Record<string, unknown>).length <= 3
        ) {
          payload = (parsed as { data: unknown }).data;
        }
        resolve({ ok: true, data: payload as T });
      } else {
        const fromObj =
          parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : null;
        const msg =
          (fromObj && typeof fromObj.message === "string" && fromObj.message) ||
          (fromObj && typeof fromObj.error === "string" && fromObj.error) ||
          `Request failed (${status})`;
        resolve({ ok: false, status, message: msg });
      }
    };
    xhr.onerror = () => {
      resolve({ ok: false, status: 0, message: "Network error during upload." });
    };
    xhr.onabort = () => {
      resolve({ ok: false, status: 0, message: "Upload was canceled." });
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        xhr.abort();
      } else {
        opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }
    }

    xhr.send(formData);
  });
}

export async function apiUploadWithProgress<T = unknown>(
  path: string,
  formData: FormData,
  opts: UploadWithProgressOptions = {},
): Promise<T> {
  const url = path.startsWith("http")
    ? path
    : `/api${path.startsWith("/") ? path : `/${path}`}`;

  let csrf = readCsrfCookie();
  if (!csrf) {
    const seeded = await refreshAccessToken();
    if (seeded) csrf = readCsrfCookie();
  }

  let result = await performXhrUpload<T>(url, formData, csrf, opts);
  if (!result.ok && result.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      csrf = readCsrfCookie();
      result = await performXhrUpload<T>(url, formData, csrf, opts);
    } else {
      throw new ApiError("Your session has expired. Please sign in again.", 401);
    }
  }

  if (!result.ok) {
    throw new ApiError(result.message, result.status);
  }
  return result.data;
}

// --- Chunked / resumable uploads ------------------------------------------

export interface ChunkUploadResult {
  uploadedBytes: number;
  fileSize: number;
  complete: boolean;
  url?: string;
  filename?: string;
  size?: number;
}

export interface SendChunkOptions {
  onChunkProgress?: (bytesUploadedInThisChunk: number) => void;
  signal?: AbortSignal;
}

function sendChunkXhr(
  url: string,
  blob: Blob,
  offset: number,
  csrf: string | null,
  opts: SendChunkOptions,
): Promise<{ ok: true; data: ChunkUploadResult } | { ok: false; status: number; message: string; uploadedBytes?: number }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Upload-Offset", String(offset));
    if (csrf) xhr.setRequestHeader(CSRF_HEADER_NAME, csrf);

    if (xhr.upload && opts.onChunkProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          opts.onChunkProgress?.(event.loaded);
        }
      };
    }

    xhr.onload = () => {
      const status = xhr.status;
      const text = xhr.responseText || "";
      let parsed: unknown = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
      }
      if (status >= 200 && status < 300) {
        resolve({ ok: true, data: parsed as ChunkUploadResult });
      } else {
        const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
        const msg =
          (obj && typeof obj.message === "string" && obj.message) ||
          (obj && typeof obj.error === "string" && obj.error) ||
          `Request failed (${status})`;
        const uploadedBytes =
          obj && typeof obj.uploadedBytes === "number" ? obj.uploadedBytes : undefined;
        resolve({ ok: false, status, message: msg, uploadedBytes });
      }
    };
    xhr.onerror = () => {
      resolve({ ok: false, status: 0, message: "Network error during upload." });
    };
    xhr.onabort = () => {
      resolve({ ok: false, status: 0, message: "Upload was canceled." });
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        xhr.abort();
      } else {
        opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }
    }

    xhr.send(blob);
  });
}

export async function createUploadSession(params: {
  fileName: string;
  fileSize: number;
  mimeType: string;
}): Promise<{ sessionId: string; uploadedBytes: number; fileSize: number }> {
  return apiFetch("/media/upload-session", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function getUploadSessionStatus(
  sessionId: string,
): Promise<{ sessionId: string; uploadedBytes: number; fileSize: number; fileName: string; mimeType: string }> {
  return apiFetch(`/media/upload-session/${encodeURIComponent(sessionId)}`);
}

export async function deleteUploadSession(sessionId: string): Promise<void> {
  try {
    await apiFetch(`/media/upload-session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  } catch {
    /* best effort */
  }
}

export async function sendUploadChunk(
  sessionId: string,
  blob: Blob,
  offset: number,
  opts: SendChunkOptions = {},
): Promise<ChunkUploadResult> {
  const url = `/api/media/upload-session/${encodeURIComponent(sessionId)}`;
  let csrf = readCsrfCookie();
  if (!csrf) {
    const seeded = await refreshAccessToken();
    if (seeded) csrf = readCsrfCookie();
  }

  let result = await sendChunkXhr(url, blob, offset, csrf, opts);
  if (!result.ok && result.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      csrf = readCsrfCookie();
      result = await sendChunkXhr(url, blob, offset, csrf, opts);
    } else {
      throw new ApiError("Your session has expired. Please sign in again.", 401);
    }
  }

  if (!result.ok) {
    const err = new ApiError(result.message, result.status);
    (err as ApiError & { uploadedBytes?: number }).uploadedBytes = result.uploadedBytes;
    throw err;
  }
  return result.data;
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
