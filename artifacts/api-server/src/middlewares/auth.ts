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
