import { and, eq, isNull, gt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db } from "@workspace/db";
import { userSessions, users } from "@workspace/db";
import { verifyAccessToken, extractBearerToken } from "../lib/auth";
import { getAccessCookie } from "../lib/cookies";
import { HttpError } from "../lib/http";

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractBearerToken(req) ?? getAccessCookie(req);
  if (!token) {
    return next(new HttpError(401, "Authentication required."));
  }

  try {
    const payload = verifyAccessToken(token);
    const session = await db.query.userSessions.findFirst({
      where: and(
        eq(userSessions.id, payload.sid),
        eq(userSessions.userId, payload.sub),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, new Date())
      ),
    });

    if (!session) {
      return next(new HttpError(401, "Session is invalid or expired."));
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.sub),
    });
    if (!user || !user.isActive) {
      return next(new HttpError(401, "User account is inactive."));
    }

    (req as any).auth = { userId: payload.sub, sessionId: payload.sid };
    (req as any).user = user;
    return next();
  } catch {
    return next(new HttpError(401, "Invalid access token."));
  }
}

/**
 * A canonical (Account epic Phase 2) account number looks like
 * `<L|P>-<YEAR>-<SEQUENCE>[-<PHONE>]`, e.g. "L-2026-3-5551234567". Only
 * accounts created under the new signup flow carry this format.
 */
const CANONICAL_ACCOUNT_NUMBER = /^[LP]-\d{4}-\d+(-\d{10})?$/;

export function isCanonicalAccount(user: any): boolean {
  return CANONICAL_ACCOUNT_NUMBER.test(user?.platformAccountNumber ?? "");
}

export function isAccountVerified(user: any): boolean {
  return Boolean(user?.emailVerifiedAt || user?.phoneVerifiedAt);
}

/**
 * Block PHI access until the account has verified at least one contact
 * (email and/or phone) — Account epic Phase 2 §0 rule 2.
 *
 * Lazy adoption: enforcement applies **only** to accounts created under the
 * new canonical signup (which carry a canonical account number). Legacy
 * accounts (old-format or null account numbers) are grandfathered so no
 * existing user is locked out. Set `DISABLE_VERIFICATION_ENFORCEMENT=true`
 * as an emergency kill-switch.
 *
 * Must run after {@link requireAuth} so `req.user` is populated.
 */
export function requireVerifiedAccount(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  if (process.env.DISABLE_VERIFICATION_ENFORCEMENT === "true") {
    return next();
  }
  const user = (req as any).user;
  if (!user) {
    return next(new HttpError(401, "Authentication required."));
  }
  if (!isCanonicalAccount(user) || isAccountVerified(user)) {
    return next();
  }
  return next(
    new HttpError(
      403,
      "Account verification required. Please verify your email or phone before accessing case data.",
      { code: "VERIFICATION_REQUIRED" }
    )
  );
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractBearerToken(req) ?? getAccessCookie(req);
  if (!token) {
    return next();
  }

  try {
    const payload = verifyAccessToken(token);
    (req as any).auth = { userId: payload.sub, sessionId: payload.sid };
  } catch {
    // ignore invalid token for optional auth
  }
  return next();
}
