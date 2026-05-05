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
  if (
    !cookieToken ||
    typeof headerValue !== "string" ||
    !headerValue ||
    !timingSafeEqualStrings(cookieToken, headerValue)
  ) {
    return next(new HttpError(403, "Invalid or missing CSRF token."));
  }

  return next();
}
