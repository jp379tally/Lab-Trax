import { ApiError } from "@/lib/api";

/**
 * Helpers for React Query hooks that hit **platform-admin-only** maintenance
 * endpoints (backup schedule, orphaned-media cleanup, cleanup schedule).
 *
 * A lab-scoped admin who lacks platform-admin credentials legitimately gets a
 * `403 Forbidden` from these endpoints (this is correct and must stay). The
 * problem these helpers solve is purely client-side: without them the queries
 * keep retrying and polling on their `refetchInterval`, hammering a forbidden
 * endpoint indefinitely and flooding the console with repeated 403s.
 *
 * Use both helpers on every query that targets a platform-admin endpoint:
 *   - `retry: retryUnlessForbidden` so a 403 is never retried (at most one
 *     request per mount before the error surfaces).
 *   - `refetchInterval: haltPollingIfForbidden(...)` so polling stops the
 *     moment a 403 has been observed.
 *
 * Once a platform admin unlocks (PIN/secret) the caller invalidates the query;
 * the next fetch succeeds and normal polling resumes because the query's error
 * state is cleared.
 */

/** True when the error is an ApiError carrying HTTP 403 (platform-admin gate). */
export function isForbiddenError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 403;
}

/**
 * React Query `retry` predicate: never retry a 403 (forbidden — retrying can't
 * help until the admin unlocks), otherwise mirror the app default of one retry.
 */
export function retryUnlessForbidden(failureCount: number, error: unknown): boolean {
  if (isForbiddenError(error)) return false;
  return failureCount < 1;
}

/**
 * Wrap a `refetchInterval` so polling halts once the query has observed a 403.
 * `base` is the interval (or interval function) you would normally pass.
 *
 * The structural `{ state: { error } }` constraint accepts React Query's
 * `Query` object without pulling in its full generic signature.
 */
export function haltPollingIfForbidden<Q extends { state: { error: unknown } }>(
  base: number | false | ((query: Q) => number | false),
): (query: Q) => number | false {
  return (query: Q) => {
    if (isForbiddenError(query.state.error)) return false;
    return typeof base === "function" ? base(query) : base;
  };
}
