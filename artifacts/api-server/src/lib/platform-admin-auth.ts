import { eq } from "drizzle-orm";
import { db, systemSettings } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { getEffectiveAdminPin } from "./admin-pin";

export function isPlatformAdmin(req: any): boolean {
  if (req._platformAdminSessionVerified) return req.user?.role === "admin";
  if (req.user?.role !== "admin") return false;
  const secret = process.env.PLATFORM_ADMIN_SECRET;
  if (secret && req.headers["x-platform-admin-secret"] === secret) return true;
  return req.headers["x-platform-admin-pin"] === getEffectiveAdminPin();
}

export function platformAdminUserOrSecret(req: any, res: any, next: any) {
  const secret = process.env.PLATFORM_ADMIN_SECRET;
  const header = req.headers["x-platform-admin-secret"];
  if (secret && header === secret && !req.user) {
    req.user = {
      id: null,
      username: "ci:platform-admin-secret",
      role: "admin",
      isActive: true,
    };
    return next();
  }
  requireAuth(req, res, async (err?: unknown) => {
    if (err) return next(err);
    const sessionHeader = req.headers["x-platform-admin-session"] as string | undefined;
    if (sessionHeader) {
      const colonIdx = sessionHeader.indexOf(":");
      if (colonIdx > 0) {
        const userId = sessionHeader.slice(0, colonIdx);
        const sessionId = sessionHeader.slice(colonIdx + 1);
        if (req.user?.id === userId && sessionId) {
          try {
            const [row] = await db.select().from(systemSettings)
              .where(eq(systemSettings.key, `padmin_sess:${userId}:${sessionId}`));
            if (row) {
              const data = JSON.parse(row.value ?? "{}");
              const expiresAt = data?.expiresAt ? new Date(data.expiresAt) : null;
              if (expiresAt && expiresAt > new Date()) req._platformAdminSessionVerified = true;
            }
          } catch {
            // Header/PIN checks remain available if session lookup fails.
          }
        }
      }
    }
    next();
  });
}

export function requireAuthenticatedPlatformAdmin(req: any, res: any, next: any) {
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Platform creator/admin access required." });
    }
    platformAdminUserOrSecret(req, res, (sessionErr?: unknown) => {
      if (sessionErr) return next(sessionErr);
      if (
        req._platformAdminSessionVerified
        || req.headers["x-platform-admin-pin"] === getEffectiveAdminPin()
      ) return next();
      return res.status(403).json({ error: "Platform admin unlock required." });
    });
  });
}