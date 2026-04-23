import jwt from "jsonwebtoken";
import type { Request } from "express";
import { randomToken, sha256 } from "./crypto";

const JWT_SECRET = process.env.JWT_SECRET || "labtrax-jwt-secret-change-in-production";
const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL = "7d";

export type AccessTokenPayload = {
  sub: string;
  sid: string;
  type: "access";
};

export type RefreshTokenPayload = {
  sub: string;
  sid: string;
  type: "refresh";
  exp?: number;
};

export function signAccessToken(userId: string, sessionId: string) {
  return jwt.sign({ sub: userId, sid: sessionId, type: "access" }, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

export function signRefreshToken(userId: string, sessionId: string) {
  return jwt.sign({ sub: userId, sid: sessionId, type: "refresh" }, JWT_SECRET, {
    expiresIn: REFRESH_TOKEN_TTL,
  });
}

export function verifyAccessToken(token: string) {
  const payload = jwt.verify(token, JWT_SECRET) as AccessTokenPayload;
  if (payload.type !== "access") {
    throw new Error("Invalid token type: expected access token");
  }
  return payload;
}

export function verifyRefreshToken(token: string) {
  const payload = jwt.verify(token, JWT_SECRET) as RefreshTokenPayload;
  if (payload.type !== "refresh") {
    throw new Error("Invalid token type: expected refresh token");
  }
  return payload;
}

export function extractBearerToken(req: Request) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
}

export function generateInviteToken() {
  return randomToken(24);
}

export function makeSessionHash(rawRefreshToken: string) {
  return sha256(rawRefreshToken);
}
