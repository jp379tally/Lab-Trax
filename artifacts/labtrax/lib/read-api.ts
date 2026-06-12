// Tiny typed GET helper for the read-only parity screens.
//
// The API server wraps successful responses with `ok(res, data)` →
// `{ ok: true, data }` (see artifacts/api-server/src/lib/http.ts). resilientFetch
// resolves to a Response, so the body MUST be parsed here and the `data` envelope
// unwrapped. Endpoints that return a bare object (e.g. /api/auth/me) fall through
// to the raw body. Reading hooks are NOT generated for these GET endpoints, so
// the read-only screens fetch through this helper directly.
import { resilientFetch } from "@/lib/query-client";

// Typed API error so screens can distinguish an authorization failure (403 —
// the user's role can't access this lab-scoped resource) from a generic load
// failure and render a friendly "not available for your role" state instead of
// a retry-able error. Authorization is still enforced server-side; this only
// improves UX for users who pass the client-side gate but lack the server role.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isForbiddenError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || err.status === 401);
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await resilientFetch(path);
  if (!res.ok) {
    throw new ApiError(res.status, `Request failed (${res.status}).`);
  }
  const body = (await res.json()) as unknown;
  if (
    body &&
    typeof body === "object" &&
    "data" in (body as Record<string, unknown>)
  ) {
    return (body as { data: T }).data;
  }
  return body as T;
}

// Mutation counterpart to getJson — issues a write request through the same
// resilientFetch path (so cookies/CSRF on web and bearer tokens on native are
// handled), unwraps the `{ ok, data }` envelope, and throws an ApiError on a
// non-2xx so screens can distinguish a 403 (role can't edit this lab) from a
// generic failure. The server message is surfaced when present.
export async function sendJson<T>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await resilientFetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    try {
      const parsed = (await res.json()) as { error?: string; message?: string };
      if (parsed?.error) message = parsed.error;
      else if (parsed?.message) message = parsed.message;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new ApiError(res.status, message);
  }
  const parsed = (await res.json().catch(() => null)) as unknown;
  if (
    parsed &&
    typeof parsed === "object" &&
    "data" in (parsed as Record<string, unknown>)
  ) {
    return (parsed as { data: T }).data;
  }
  return parsed as T;
}
