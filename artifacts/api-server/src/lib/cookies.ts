import type { CookieOptions, Request, Response } from "express";

export const ACCESS_COOKIE_NAME = "lt_access";
export const REFRESH_COOKIE_NAME = "lt_refresh";

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

export function setAuthCookies(
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string,
) {
  setAccessCookie(req, res, accessToken);
  setRefreshCookie(req, res, refreshToken);
}

export function clearAuthCookies(req: Request, res: Response) {
  const opts = baseCookieOptions(req);
  res.clearCookie(ACCESS_COOKIE_NAME, opts);
  res.clearCookie(REFRESH_COOKIE_NAME, opts);
}

export function getAccessCookie(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[ACCESS_COOKIE_NAME] ?? null;
}

export function getRefreshCookie(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[REFRESH_COOKIE_NAME] ?? null;
}
