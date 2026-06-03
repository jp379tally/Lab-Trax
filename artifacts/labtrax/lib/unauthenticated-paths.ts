// Public auth endpoints are reached BEFORE the user has a token (the whole
// point is to obtain one). They must never be blocked by resilientFetch's
// no-bearer guard — otherwise the very act of signing in throws "Not
// authenticated: no bearer token available." and surfaces as a red
// "Connection error" on the login screen. These are unauthenticated by design
// on the server, so sending them without a bearer is correct (and they carry
// no cookie on a clean install, so the cookie-jar CSRF trap does not apply —
// see .agents/memory/mobile-cookie-jar-csrf-trap.md).
//
// Kept in a dependency-free module (no react-native / expo imports) so it can
// be unit-tested directly without loading native modules.
export const UNAUTHENTICATED_PATHS = [
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/2fa/challenge",
  "/api/auth/refresh",
];

export function isUnauthenticatedPath(path: string): boolean {
  let pathname = path;
  try {
    pathname = path.startsWith("http") ? new URL(path).pathname : path.split("?")[0];
  } catch {
    pathname = path.split("?")[0];
  }
  return UNAUTHENTICATED_PATHS.some((p) => pathname === p);
}
