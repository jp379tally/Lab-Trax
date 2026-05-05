import crypto from "node:crypto";
import type { CookieOptions, Request, Response } from "express";

export const ACCESS_COOKIE_NAME = "lt_access";
export const REFRESH_COOKIE_NAME = "lt_refresh";
export const CSRF_COOKIE_NAME = "lt_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CSRF_MAX_AGE_MS = REFRESH_MAX_AGE_MS;

function isSecureRequest(req: Request): boolean {
  if (req.secure) return true;
  const xfProto = req.headers["x-forwarded-proto"];
  if (typeof xfProto === "string" && xfProto.split(",")[0].trim() === "https") {
    return true;
  }
  return process.env.NODE_ENV === "production";
}

function baseCookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
  };
}

export function setAccessCookie(req: Request, res: Response, accessToken: string) {
  res.cookie(ACCESS_COOKIE_NAME, accessToken, {
    ...baseCookieOptions(req),
    maxAge: ACCESS_MAX_AGE_MS,
  });
}

export function setRefreshCookie(req: Request, res: Response, refreshToken: string) {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...baseCookieOptions(req),
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

export function setCsrfCookie(req: Request, res: Response, token: string) {
  // Readable by JS in the desktop app (must be sent back as a header on
  // state-changing requests). Still SameSite=Lax + Secure so it isn't sent
  // on cross-site requests.
  res.cookie(CSRF_COOKIE_NAME, token, {
    ...baseCookieOptions(req),
    httpOnly: false,
    maxAge: CSRF_MAX_AGE_MS,
  });
}

export function generateCsrfToken(): string {
  // 32 bytes -> 43 char base64url, opaque to clients.
  return crypto.randomBytes(32).toString("base64url");
}

export function setAuthCookies(
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string,
) {
  setAccessCookie(req, res, accessToken);
  setRefreshCookie(req, res, refreshToken);
  // Mint a fresh CSRF token whenever auth cookies are (re)issued so it
  // rotates on login, refresh, and registration.
  setCsrfCookie(req, res, generateCsrfToken());
}

export function clearAuthCookies(req: Request, res: Response) {
  const opts = baseCookieOptions(req);
  res.clearCookie(ACCESS_COOKIE_NAME, opts);
  res.clearCookie(REFRESH_COOKIE_NAME, opts);
  res.clearCookie(CSRF_COOKIE_NAME, { ...opts, httpOnly: false });
}

export function getAccessCookie(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[ACCESS_COOKIE_NAME] ?? null;
}

export function getRefreshCookie(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[REFRESH_COOKIE_NAME] ?? null;
}
