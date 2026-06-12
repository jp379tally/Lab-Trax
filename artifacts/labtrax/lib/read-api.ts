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
