import { getSessionSecret, clearSessionSecret } from "./platform-admin-session";

// Hardcoded production API origin used as a defensive fallback when an
// Electron installer was packaged without VITE_API_BASE_URL baked in.
// Past "Failed to fetch" reports on the login screen were traced to that
// case: _API_ORIGIN was empty, so apiUrl built "app://labtrax/api/..."
// which the Electron renderer (cross-origin to the API) cannot reach.
//
// The fallback is intentionally scoped to Electron-only — same-origin
// web builds legitimately set VITE_API_BASE_URL="" to use relative paths,
// and we must not hijack them to production. We detect Electron by the
// "app:" protocol exposed by the custom app://labtrax origin in
// production, or by the presence of window.electronAPI from preload.cjs.
const _PROD_API_FALLBACK = "https://lab-trax.replit.app";

function _isElectronRenderer(): boolean {
  if (typeof window === "undefined") return false;
  if ((window as unknown as { electronAPI?: unknown }).electronAPI) return true;
  if (typeof window.location !== "undefined" && window.location.protocol === "app:") {
    return true;
  }
  return false;
}

const _CONFIGURED_ORIGIN = (import.meta.env.VITE_API_BASE_URL as string | undefined)
  ?.replace(/\/$/, "");

const _API_ORIGIN =
  _CONFIGURED_ORIGIN || (_isElectronRenderer() ? _PROD_API_FALLBACK : "");

function apiUrl(path: string): string {
  if (path.startsWith("http")) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${_API_ORIGIN}/api${normalized}`;
}

/** Origin of the API server this build was compiled against (empty if the
 * installer was built without VITE_API_BASE_URL). Exposed so the login
 * screen can surface it in network-error messages — past "Failed to
 * fetch" reports turned out to be installers built without the env var,
 * which is impossible to diagnose without seeing the URL the renderer
 * actually tried to reach. */
export function getApiOrigin(): string {
  return _API_ORIGIN;
}

export type SessionUser = {
  id: string;
  username: string;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  initials?: string | null;
  userType?: string | null;
  role?: string | null;
  practiceName?: string | null;
  // Caller's primary lab (from active memberships) and its uploaded
  // logo URL, surfaced by the API so the desktop can show + replace
  // the lab logo without re-resolving membership client-side.
  practiceOrganizationId?: string | null;
  practiceLogoUrl?: string | null;
  // Which documents/emails should include the lab logo.
  // null = unset (treated as all-enabled when practiceLogoUrl exists).
  // Non-null = exact list the admin has chosen.
  practiceLogoplacements?: string[] | null;
  // PDF logo size preference. null = default "medium".
  practiceLogoSize?: string | null;
  // Per-lab visual invoice-layout template (Task #751). Null = use
  // built-in default; otherwise an InvoiceTemplate JSON blob.
  practiceInvoiceTemplate?: unknown;
  // Current work-status presence indicator. One of "available" (at
  // work), "break", "lunch", or "out_of_office". Defaults to
  // "available" server-side when unset.
  workStatus?: "available" | "break" | "lunch" | "out_of_office" | string | null;
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
  // The encrypted blob on disk is preserved so the next sign-in still sees it.
  clearPlatformAdminSecretCacheSafe();
  // Drop the in-memory web-view session secret so it doesn't carry over to a
  // new sign-in by a different user.
  try {
    clearSessionSecret();
  } catch {
    /* ignore */
  }
  emit(null);
}

// Indirection for ordering: clearPlatformAdminSecretCache is declared below.
function clearPlatformAdminSecretCacheSafe() {
  try {
    clearPlatformAdminSecretCache();
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Bearer-token auth
//
// The packaged desktop app loads its renderer from a custom `app://labtrax`
// protocol, which makes every request to the hosted API cross-site. Browsers
// will not attach SameSite=Lax cookies on those requests, so cookie-based
// auth cannot work from the desktop. We mirror the mobile app's approach:
// the login response returns access + refresh tokens, we store them locally,
// and we send the access token as `Authorization: Bearer …` on every API
// call. Bearer-authenticated requests are exempt from CSRF on the server, so
// we don't need the lt_csrf cookie either.
// ---------------------------------------------------------------------------

// Two header names are accepted by the API server's isPlatformAdmin():
//   - "X-Platform-Admin-Secret" → matches PLATFORM_ADMIN_SECRET (long
//     random string from the OS keychain, used by the Electron desktop
//     bridge and by CI/automation).
//   - "X-Platform-Admin-Pin"    → matches PLATFORM_ADMIN_PIN    (short
//     numeric PIN entered by humans through the web unlock modal).
// Both paths still require a signed-in admin user — the credential alone
// is never sufficient.
const PLATFORM_ADMIN_HEADER_SECRET = "X-Platform-Admin-Secret";
const PLATFORM_ADMIN_HEADER_PIN = "X-Platform-Admin-Pin";

type PlatformAdminCred = { header: string; value: string };

type PlatformAdminBridge = {
  getSecret: () => Promise<string | null>;
  onChanged?: (cb: (status: unknown) => void) => () => void;
};

function getPlatformAdminBridge(): PlatformAdminBridge | null {
  if (typeof window === "undefined") return null;
  const electronAPI = (window as { electronAPI?: { platformAdmin?: PlatformAdminBridge } })
    .electronAPI;
  return electronAPI?.platformAdmin ?? null;
}

let platformAdminSecretCache: string | null = null;
let platformAdminCacheLoaded = false;
let platformAdminInflight: Promise<string | null> | null = null;

function isAdminApiPath(path: string): boolean {
  if (!path) return false;
  // Match the post-`/api` path exposed to apiFetch callers, e.g. "/admin/...".
  // Tolerate query strings and missing leading slash.
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  return trimmed.startsWith("/admin/");
}

async function loadPlatformAdminSecret(): Promise<string | null> {
  const bridge = getPlatformAdminBridge();
  if (!bridge) return null;
  if (platformAdminInflight) return platformAdminInflight;
  platformAdminInflight = (async () => {
    try {
      const value = await bridge.getSecret();
      platformAdminSecretCache = typeof value === "string" && value ? value : null;
    } catch {
      platformAdminSecretCache = null;
    } finally {
      platformAdminCacheLoaded = true;
      platformAdminInflight = null;
    }
    return platformAdminSecretCache;
  })();
  return platformAdminInflight;
}

async function getPlatformAdminSecretForRequest(): Promise<PlatformAdminCred | null> {
  if (!getPlatformAdminBridge()) {
    // No Electron bridge (web view / Replit preview): fall back to the
    // in-memory session PIN that the admin entered via the unlock modal.
    // Sent under X-Platform-Admin-Pin so the server matches it against
    // PLATFORM_ADMIN_PIN.
    const pin = getSessionSecret();
    return pin ? { header: PLATFORM_ADMIN_HEADER_PIN, value: pin } : null;
  }
  // Electron desktop: prefer the long PLATFORM_ADMIN_SECRET saved in the
  // OS keychain. If none is saved yet, fall back to the session PIN the
  // admin entered via the unlock modal so the desktop app can use the
  // same lightweight PIN flow as the web build.
  const value = platformAdminCacheLoaded ? platformAdminSecretCache : await loadPlatformAdminSecret();
  if (value) return { header: PLATFORM_ADMIN_HEADER_SECRET, value };
  const pin = getSessionSecret();
  return pin ? { header: PLATFORM_ADMIN_HEADER_PIN, value: pin } : null;
}

export function clearPlatformAdminSecretCache(): void {
  platformAdminSecretCache = null;
  platformAdminCacheLoaded = false;
  platformAdminInflight = null;
}

// Refresh the cache whenever the main process tells us the secret was
// added, replaced, or cleared on this machine.
(() => {
  const bridge = getPlatformAdminBridge();
  if (!bridge?.onChanged) return;
  try {
    bridge.onChanged(() => {
      clearPlatformAdminSecretCache();
      void loadPlatformAdminSecret();
    });
  } catch {
    /* ignore */
  }
})();

const TOKEN_STORAGE_KEY = "labtrax_desktop_tokens_v1";
const TRUSTED_DEVICE_STORAGE_KEY = "labtrax_trusted_device_v1";

export function getTrustedDeviceToken(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(TRUSTED_DEVICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveTrustedDeviceToken(token: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(TRUSTED_DEVICE_STORAGE_KEY, token);
    }
  } catch {
    /* ignore */
  }
}

export function clearTrustedDeviceToken(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(TRUSTED_DEVICE_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

type TokenPair = { accessToken: string; refreshToken: string };

import type { AuthRestoreStatus } from "./auth-restore-status";

type AuthBridge = {
  getTokens: () => Promise<TokenPair | null>;
  getTokensStatus?: () => Promise<{
    status: AuthRestoreStatus;
    tokens?: TokenPair;
  }>;
  setTokens: (payload: TokenPair) => Promise<unknown>;
  clearTokens: () => Promise<unknown>;
  isAvailable?: () => Promise<boolean>;
};

let _restoreStatus: AuthRestoreStatus = "empty";

/**
 * The outcome of the desktop main-process trying to restore the saved
 * sign-in on launch. Drives the keychain-unavailable banner and the
 * "saved sign-in expired" toast in the renderer.
 */
export function getAuthRestoreStatus(): AuthRestoreStatus {
  return _restoreStatus;
}

function getAuthBridge(): AuthBridge | null {
  if (typeof window === "undefined") return null;
  const electronAPI = (window as { electronAPI?: { auth?: AuthBridge } }).electronAPI;
  return electronAPI?.auth ?? null;
}

let _tokens: TokenPair | null = null;

function readTokensFromLocalStorage(): TokenPair | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.accessToken === "string" &&
      typeof parsed.refreshToken === "string"
    ) {
      return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function clearLocalStorageTokens() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

function writeLocalStorageTokens(next: TokenPair | null) {
  try {
    if (typeof localStorage === "undefined") return;
    if (next) {
      localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(next));
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

function persistTokens(next: TokenPair | null) {
  _tokens = next;
  const bridge = getAuthBridge();
  if (bridge) {
    // Always keep localStorage cleared in the Electron renderer — the
    // encrypted blob managed by the main process is the source of truth.
    clearLocalStorageTokens();
    if (next) {
      void bridge.setTokens(next).catch(() => {
        /* ignore — best effort persistence */
      });
    } else {
      void bridge.clearTokens().catch(() => {
        /* ignore */
      });
    }
    return;
  }
  // Browser/dev fallback (no Electron bridge): use localStorage.
  writeLocalStorageTokens(next);
}

// Hydrate on module load. In the Electron renderer this asynchronously pulls
// the encrypted tokens out of the OS keychain via IPC, and migrates any
// legacy plain-text localStorage blob into the keychain on first run. In a
// plain browser context (dev server preview) we fall back to localStorage so
// the app still works for local development.
const hydrationPromise: Promise<void> = (async () => {
  const bridge = getAuthBridge();
  if (bridge) {
    try {
      // Prefer the rich status call so we can tell the user *why* their
      // saved sign-in didn't restore (no keychain vs. corrupt blob) instead
      // of silently bouncing them to the login screen.
      let status: AuthRestoreStatus = "empty";
      let fromKeychain: TokenPair | null = null;
      if (bridge.getTokensStatus) {
        const result = await bridge.getTokensStatus();
        status = result?.status ?? "empty";
        fromKeychain = result?.tokens ?? null;
      } else {
        fromKeychain = await bridge.getTokens();
        status = fromKeychain ? "ok" : "empty";
      }
      _restoreStatus = status;
      if (fromKeychain) {
        _tokens = fromKeychain;
        // Drop any leftover plain-text copy in localStorage from older builds.
        clearLocalStorageTokens();
        return;
      }
      // One-time migration: an older desktop build stored the tokens in
      // plain-text localStorage. Move them into the encrypted store and wipe
      // the plaintext copy so the user stays signed in across this upgrade.
      const legacy = readTokensFromLocalStorage();
      if (legacy) {
        try {
          await bridge.setTokens(legacy);
          _tokens = legacy;
          _restoreStatus = "ok";
        } catch {
          // Encryption unavailable (e.g. headless Linux without a keyring).
          // Keep the legacy tokens in memory so the user isn't kicked out,
          // but do not re-write them anywhere on disk.
          _tokens = legacy;
          _restoreStatus = "keychain-unavailable";
        } finally {
          clearLocalStorageTokens();
        }
      }
    } catch {
      /* ignore — treated as no saved session */
    }
    return;
  }
  // No Electron bridge: dev browser. Read from localStorage as before.
  _tokens = readTokensFromLocalStorage();
  _restoreStatus = _tokens ? "ok" : "empty";
})();

export function waitForTokenHydration(): Promise<void> {
  return hydrationPromise;
}

export function getAccessToken(): string | null {
  return _tokens?.accessToken ?? null;
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const current = _tokens;
  if (!current?.refreshToken) {
    emit(null);
    return false;
  }
  refreshInFlight = (async () => {
    try {
      const r = await fetch(apiUrl("/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!r.ok) {
        persistTokens(null);
        emit(null);
        return false;
      }
      let body: any = null;
      try {
        body = await r.json();
      } catch {
        /* ignore */
      }
      const data = body?.data ?? body;
      const accessToken: string | undefined = data?.accessToken;
      const refreshToken: string | undefined = data?.refreshToken;
      if (!accessToken) {
        persistTokens(null);
        emit(null);
        return false;
      }
      persistTokens({
        accessToken,
        refreshToken: refreshToken || current.refreshToken,
      });
      return true;
    } catch {
      // Network blip — keep tokens so a subsequent retry can succeed, but
      // signal that this attempt did not refresh.
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function authHeader(): Record<string, string> {
  const token = _tokens?.accessToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeader(),
    ...(options.headers as Record<string, string> | undefined),
  };
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (
    isAdminApiPath(path) &&
    !headers[PLATFORM_ADMIN_HEADER_SECRET] &&
    !headers[PLATFORM_ADMIN_HEADER_PIN]
  ) {
    const cred = await getPlatformAdminSecretForRequest();
    if (cred) headers[cred.header] = cred.value;
  }
  const url = apiUrl(path);
  const res = await fetch(url, { ...options, headers });

  if (res.status === 401 && !retried && _tokens?.refreshToken) {
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
    throw new ApiError(msg, res.status, parsed);
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

/**
 * Like apiFetch but returns an ArrayBuffer instead of parsed JSON. Use for
 * binary download endpoints (e.g. the backup generate endpoint). Handles
 * bearer-token auth, platform-admin headers, and a single 401-refresh retry
 * in the same way apiFetch does.
 */
export async function apiFetchArrayBuffer(
  path: string,
  options: RequestInit = {},
  retried = false,
): Promise<{ buffer: ArrayBuffer; headers: Headers }> {
  const headers: Record<string, string> = {
    ...authHeader(),
    ...(options.headers as Record<string, string> | undefined),
  };
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (
    isAdminApiPath(path) &&
    !headers[PLATFORM_ADMIN_HEADER_SECRET] &&
    !headers[PLATFORM_ADMIN_HEADER_PIN]
  ) {
    const cred = await getPlatformAdminSecretForRequest();
    if (cred) headers[cred.header] = cred.value;
  }
  const url = apiUrl(path);
  const res = await fetch(url, { ...options, headers });

  if (res.status === 401 && !retried && _tokens?.refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return apiFetchArrayBuffer(path, options, true);
    throw new ApiError("Your session has expired. Please sign in again.", 401);
  }

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.message === "string") msg = obj.message;
        else if (typeof obj.error === "string") msg = obj.error;
      }
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status);
  }

  const buffer = await res.arrayBuffer();
  return { buffer, headers: res.headers };
}

export interface UploadWithProgressOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

async function performXhrUpload<T>(
  url: string,
  formData: FormData,
  opts: UploadWithProgressOptions,
  platformAdminCred: PlatformAdminCred | null = null,
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Accept", "application/json");
    const token = _tokens?.accessToken;
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    if (platformAdminCred) xhr.setRequestHeader(platformAdminCred.header, platformAdminCred.value);

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
  const url = apiUrl(path);

  const platformAdminCred = isAdminApiPath(path)
    ? await getPlatformAdminSecretForRequest()
    : null;

  let result = await performXhrUpload<T>(url, formData, opts, platformAdminCred);
  if (!result.ok && result.status === 401 && _tokens?.refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      result = await performXhrUpload<T>(url, formData, opts, platformAdminCred);
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
  opts: SendChunkOptions,
  platformAdminCred: PlatformAdminCred | null = null,
): Promise<{ ok: true; data: ChunkUploadResult } | { ok: false; status: number; message: string; uploadedBytes?: number }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", url, true);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Upload-Offset", String(offset));
    const token = _tokens?.accessToken;
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    if (platformAdminCred) xhr.setRequestHeader(platformAdminCred.header, platformAdminCred.value);

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
  const path = `/media/upload-session/${encodeURIComponent(sessionId)}`;
  const url = apiUrl(path);

  // Today this path is non-admin (/media/...), but parity with the other
  // upload helpers keeps us safe if a future admin chunked endpoint reuses it.
  const platformAdminCred = isAdminApiPath(path)
    ? await getPlatformAdminSecretForRequest()
    : null;

  let result = await sendChunkXhr(url, blob, offset, opts, platformAdminCred);
  if (!result.ok && result.status === 401 && _tokens?.refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      result = await sendChunkXhr(url, blob, offset, opts, platformAdminCred);
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

export class TwoFactorRequiredError extends Error {
  readonly pendingToken: string;
  constructor(pendingToken: string) {
    super("Two-factor authentication required.");
    this.name = "TwoFactorRequiredError";
    this.pendingToken = pendingToken;
  }
}

export async function login(username: string, password: string): Promise<SessionUser> {
  let r: Response;
  try {
    r = await fetch(apiUrl("/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        deviceName: "LabTrax Desktop",
        clientType: "desktop",
        // Include a previously saved trust token so a recognised device skips
        // the 2FA challenge on re-login (Task #863).
        deviceTrustToken: getTrustedDeviceToken() ?? undefined,
      }),
    });
  } catch {
    // Surface the URL the renderer tried to reach so a tech-support
    // screenshot is enough to diagnose the problem. An empty origin means
    // the installer was built without VITE_API_BASE_URL and the request
    // resolved against the `app://labtrax` renderer origin (which can't
    // serve /api/...) — that needs a fresh build, not a network retry.
    const origin = getApiOrigin();
    const detail = origin
      ? ` (tried ${origin}/api/auth/login)`
      : " (this installer was built without an API server URL — please reinstall the latest LabTrax Desktop)";
    throw new ApiError(
      `Can't reach the LabTrax server. Check your internet connection and try again.${detail}`,
      0,
    );
  }
  const body = await r.json().catch(() => ({}));
  if (r.ok && body?.requiresTwoFactor && typeof body.pendingToken === "string") {
    throw new TwoFactorRequiredError(body.pendingToken);
  }
  if (!r.ok || !body?.success) {
    throw new ApiError(body?.message || "Invalid username or password.", r.status);
  }
  if (typeof body.accessToken === "string" && typeof body.refreshToken === "string") {
    persistTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken });
  } else {
    // Server didn't return tokens (e.g. an older deployment). Without a token
    // the desktop client can't authenticate any subsequent request, so treat
    // this as a hard failure rather than silently ending up unauthenticated.
    throw new ApiError(
      "The server didn't return a sign-in token. Please contact your administrator.",
      r.status,
    );
  }
  emit(body.user);
  return body.user as SessionUser;
}

export async function completeTwoFactorChallenge(
  pendingToken: string,
  code: string,
  trustDevice = false,
): Promise<SessionUser> {
  const r = await fetch(apiUrl("/auth/2fa/challenge"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pendingToken,
      code,
      deviceName: "LabTrax Desktop",
      clientType: "desktop",
      trustDevice,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body?.data?.success) {
    throw new ApiError(body?.error || body?.message || "Invalid code.", r.status);
  }
  const { accessToken, refreshToken, deviceTrustToken } = body.data;
  if (typeof accessToken === "string" && typeof refreshToken === "string") {
    persistTokens({ accessToken, refreshToken });
  } else {
    throw new ApiError("The server didn't return a sign-in token. Please contact your administrator.", r.status);
  }
  // Persist the trust token for future logins (Task #863).
  if (typeof deviceTrustToken === "string" && deviceTrustToken) {
    saveTrustedDeviceToken(deviceTrustToken);
  }
  const me = await apiFetch<{ success?: boolean; user?: SessionUser } | SessionUser>("/auth/me");
  const user = (me as any)?.user ?? (me as SessionUser);
  emit(user);
  return user;
}

export async function logout(): Promise<void> {
  // Cancel any pending refresh so it can't resurrect the session post-logout.
  refreshInFlight = null;
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    /* swallow */
  }
  persistTokens(null);
  // Drop the in-memory platform-admin secret on logout so a follow-up sign-in
  // by a different user doesn't carry the previous user's elevated header.
  // The encrypted blob on disk is preserved.
  clearPlatformAdminSecretCache();
  emit(null);
}

export async function fetchMe(): Promise<SessionUser> {
  // Wait for the encrypted token store to finish hydrating from the OS
  // keychain before deciding whether the user has a saved session, otherwise
  // the very first /auth/me call after launch would race the IPC round-trip
  // and incorrectly send the user to the login screen.
  await hydrationPromise;
  // No token = no session; skip the network call so we don't trigger an
  // immediate 401 on a fresh install.
  if (!_tokens?.accessToken) {
    throw new ApiError("Not signed in.", 401);
  }
  const body = await apiFetch<{ success?: boolean; user?: SessionUser } | SessionUser>(
    "/auth/me",
  );
  if (body && typeof body === "object" && "user" in body && body.user) {
    return body.user;
  }
  return body as SessionUser;
}

// Legacy migration: clear any cookie-era marker so old keys don't linger.
try {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("labtrax_desktop_session_v1");
  }
} catch {
  /* ignore */
}
