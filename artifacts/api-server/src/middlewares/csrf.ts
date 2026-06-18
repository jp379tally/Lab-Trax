import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db } from "@workspace/db";
import { userSessions } from "@workspace/db";
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

function hashCsrfToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function requireCsrf(req: Request, _res: Response, next: NextFunction) {
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
    // Session-binding check: verify the presented CSRF token matches the
    // hash stored on the server-side session row. This closes the gap where
    // an attacker exfiltrates both the auth cookie and the CSRF cookie (e.g.
    // via a misconfigured subdomain or careful XSS), because the per-session
    // hash is not accessible from the client side.
    //
    // We decode (not verify) the access token to extract the session ID.
    // Full signature verification happens later in requireAuth; here we only
    // need the `sid` claim to look up the session row. If the access token is
    // absent, malformed, or expired, we skip the binding check and let
    // requireAuth handle the rejection.
    try {
      const accessToken = cookies[ACCESS_COOKIE_NAME];
      if (accessToken) {
        const decoded = jwt.decode(accessToken) as { sid?: string } | null;
        const sessionId = decoded?.sid;
        if (sessionId) {
          const session = await db.query.userSessions.findFirst({
            where: eq(userSessions.id, sessionId),
          });
          // Only enforce when the session row has a stored hash. Rows created
          // before this change (csrfTokenHash IS NULL) are allowed through so
          // that existing logged-in users aren't immediately logged out.
          if (
            session?.csrfTokenHash != null &&
            !timingSafeEqualStrings(
              hashCsrfToken(cookieToken),
              session.csrfTokenHash
            )
          ) {
            return next(new HttpError(403, "Invalid or missing CSRF token."));
          }
        }
      }
    } catch {
      // If the DB lookup fails for any transient reason, don't block the
      // request here — the double-submit check already passed and requireAuth
      // will enforce session validity independently.
    }
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
