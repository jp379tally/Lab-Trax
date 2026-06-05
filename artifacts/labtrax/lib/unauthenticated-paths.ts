/**
 * Exact path allowlist for endpoints that the server accepts WITHOUT a bearer
 * token.  Used by `resilientFetch` in `query-client.ts` to exempt pre-auth
 * flows (login, registration, verification, etc.) from the native CSRF guard
 * that otherwise throws "Not authenticated: no bearer token available." before
 * the request leaves the device.
 *
 * Rules:
 *  - Use EXACT matches only.  Prefix matching is dangerous: an authed path
 *    (e.g. PUT /api/auth/users/:id/password) must never be mis-classified as
 *    public just because its prefix is in the list.
 *  - Query strings are stripped before matching (handled by `isUnauthenticatedPath`).
 *  - Add a path here only when the server-side route has NO requireAuth guard.
 *  - Keep the list sorted for easier review.
 */
export const UNAUTHENTICATED_PATHS = new Set<string>([
  "/api/auth/2fa/challenge",
  "/api/auth/login",
  "/api/auth/refresh",
  "/api/auth/register",
  "/api/auth/users",
  "/api/check-username",
  "/api/forgot-password",
  "/api/forgot-username",
  "/api/labs/groups",
  "/api/send-email-code",
  "/api/send-phone-code",
  "/api/sms/twilio-inbound",
  "/api/verify-email-code",
  "/api/verify-phone-code",
]);

/**
 * Returns true when `path` is a known unauthenticated (public) endpoint.
 * Query strings are ignored; only the path component is matched.
 */
export function isUnauthenticatedPath(path: string): boolean {
  const bare = path.split("?")[0];
  return UNAUTHENTICATED_PATHS.has(bare);
}
