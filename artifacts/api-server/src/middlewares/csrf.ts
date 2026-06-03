import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  REFRESH_COOKIE_NAME,
} from "../lib/cookies";
import { extractBearerToken } from "../lib/auth";
import { HttpError } from "../lib/http";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Unauthenticated auth endpoints. These cannot be CSRF-checked because the
// caller, by definition, does not yet have a valid session/cookie pair —
// and we must not reject them just because the browser still has stale
// cookies left over from a previous deploy with a different JWT secret.
// Login requires password knowledge; refresh validates a signed token;
// register creates a brand-new account. Forging these gets an attacker
// nothing useful.
const CSRF_EXEMPT_PATHS = new Set([
  "/auth/login",
  "/auth/register",
  "/auth/refresh",
  "/auth/logout",
]);

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  // Unauthenticated auth endpoints are exempt — see comment above.
  // `req.path` here is relative to the /api mount.
  if (CSRF_EXEMPT_PATHS.has(req.path)) {
    return next();
  }

  // Mobile / API clients authenticate with a bearer token. They are not
  // subject to ambient browser cookie attachment, so CSRF does not apply.
  if (extractBearerToken(req)) {
    return next();
  }

  const cookies =
    (req as Request & { cookies?: Record<string, string> }).cookies ?? {};

  // No auth cookie means this isn't a cookie-authenticated request (e.g.
  // the login or register call). Auth-required routes will reject it later
  // via requireAuth; nothing to enforce here.
  const hasAuthCookie =
    !!cookies[ACCESS_COOKIE_NAME] || !!cookies[REFRESH_COOKIE_NAME];
  if (!hasAuthCookie) {
    return next();
  }

  const cookieToken = cookies[CSRF_COOKIE_NAME];
  const headerValue = req.get(CSRF_HEADER_NAME);
  const hasValidCsrfToken =
    !!cookieToken &&
    typeof headerValue === "string" &&
    !!headerValue &&
    timingSafeEqualStrings(cookieToken, headerValue);
  if (hasValidCsrfToken) {
    // Browser (web) client presented a valid double-submit token.
    return next();
  }

  // No valid CSRF token. A cross-site request forged by a logged-in user's
  // browser carries browser-set headers it cannot suppress: `Origin` and/or
  // `Referer` on state-changing fetch/XHR/form POSTs, plus a Fetch-Metadata
  // `Sec-Fetch-Site` header on every request in modern browsers. A
  // cookie-authenticated unsafe request that carries NONE of these is not a
  // browser request: it's a native client (React Native's fetch sets no
  // Origin/Referer/Sec-Fetch-Site), curl, or server-to-server, and therefore
  // cannot be a browser CSRF vector. Allow it. (Auth cookies are also
  // SameSite=Lax+Secure, which already blocks most cross-site attachment on
  // unsafe methods — this is defense in depth, not the only control.)
  //
  // This is the lever that lets an already-installed mobile app recover WITHOUT
  // an app-store update: its fetch cookie jar may still hold a stale auth
  // cookie while momentarily lacking an in-memory bearer to attach, producing a
  // cookie-only POST that previously 403'd and wedged the offline queue as
  // "the lab rejected this change". The legitimate web client always sends a
  // valid CSRF token (handled above) and any browser request carrying these
  // headers without a token is still rejected below. Treat this branch as a
  // compatibility bridge for the legacy mobile population.
  const hasBrowserSignals =
    !!req.get("origin") ||
    !!req.get("referer") ||
    !!req.get("sec-fetch-site");
  if (!hasBrowserSignals) {
    return next();
  }

  return next(new HttpError(403, "Invalid or missing CSRF token."));
}
