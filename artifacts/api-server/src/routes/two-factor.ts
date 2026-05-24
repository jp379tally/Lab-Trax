import crypto from "node:crypto";
import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import { db } from "@workspace/db";
import { users, userSessions } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { asyncHandler } from "../middlewares/async-handler";
import { HttpError, ok } from "../lib/http";
import { hashPassword, verifyPassword } from "../lib/crypto";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  makeSessionHash,
  verifyPendingTwoFactorToken,
} from "../lib/auth";
import { setAuthCookies } from "../lib/cookies";
import { encryptTotpSecret, decryptTotpSecret } from "../lib/totp-encryption";
import { writeAuditLog } from "../lib/audit";
import {
  sendTwoFactorEnabledEmail,
  sendTwoFactorDisabledEmail,
  sendTwoFactorBackupCodeUsedEmail,
} from "../lib/mail";

const router = Router();

const APP_NAME = "LabTrax";
const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_LENGTH = 10;

function generateBackupCode(): string {
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}

router.post(
  "/setup",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");

    const secret = generateSecret();
    const encryptedSecret = encryptTotpSecret(secret);

    const identifier = user.email || user.username;
    const otpauthUrl = generateURI({ issuer: APP_NAME, label: identifier, secret });
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    await db.update(users).set({ twoFactorSecret: encryptedSecret }).where(eq(users.id, userId));

    await writeAuditLog({
      req,
      userId,
      action: "2fa_setup_initiated",
      entityType: "user",
      entityId: userId,
    });

    return ok(res, { otpauthUrl, qrCodeDataUrl, secret });
  })
);

router.post(
  "/confirm",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const { code } = z.object({ code: z.string().min(1) }).parse(req.body);

    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");
    if (!user.twoFactorSecret) {
      throw new HttpError(400, "No 2FA setup in progress. Call /setup first.");
    }
    if (user.twoFactorEnabled) {
      throw new HttpError(400, "Two-factor authentication is already enabled.");
    }

    const secret = decryptTotpSecret(user.twoFactorSecret);
    const isValid = verifySync({ token: code, secret }).valid;
    if (!isValid) {
      throw new HttpError(422, "Invalid verification code. Please check your authenticator app and try again.");
    }

    const plainCodes: string[] = [];
    const hashedCodes: string[] = [];
    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
      const plain = generateBackupCode();
      const hashed = await hashPassword(plain);
      plainCodes.push(plain);
      hashedCodes.push(hashed);
    }

    await db.update(users).set({
      twoFactorEnabled: true,
      twoFactorBackupCodes: hashedCodes,
    }).where(eq(users.id, userId));

    await writeAuditLog({
      req,
      userId,
      action: "2fa_enabled",
      entityType: "user",
      entityId: userId,
    });

    if (user.email) {
      sendTwoFactorEnabledEmail({
        to: user.email,
        username: user.username ?? user.email,
        ipAddress: req.ip ?? null,
        timestamp: new Date().toISOString(),
      }).catch((err) => {
        req.log.warn({ err }, "[2fa] failed to send 2fa_enabled email");
      });
    }

    return ok(res, { enabled: true, backupCodes: plainCodes });
  })
);

router.delete(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const { code } = z.object({ code: z.string().min(1) }).parse(req.body);

    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");
    if (!user.twoFactorEnabled) {
      throw new HttpError(400, "Two-factor authentication is not enabled.");
    }
    if (!user.twoFactorSecret) {
      throw new HttpError(400, "2FA secret not found.");
    }

    const trimmedCode = code.replace(/\s/g, "");
    const secret = decryptTotpSecret(user.twoFactorSecret);
    let verified = verifySync({ token: trimmedCode, secret }).valid;

    if (!verified && user.twoFactorBackupCodes) {
      const codes = user.twoFactorBackupCodes as string[];
      for (let i = 0; i < codes.length; i++) {
        const match = await verifyPassword(trimmedCode, codes[i]);
        if (match) {
          verified = true;
          const remaining = codes.filter((_, idx) => idx !== i);
          await db.update(users).set({ twoFactorBackupCodes: remaining }).where(eq(users.id, userId));
          break;
        }
      }
    }

    if (!verified) {
      throw new HttpError(422, "Invalid verification code.");
    }

    await db.update(users).set({
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorBackupCodes: null,
    }).where(eq(users.id, userId));

    await writeAuditLog({
      req,
      userId,
      action: "2fa_disabled",
      entityType: "user",
      entityId: userId,
    });

    if (user.email) {
      sendTwoFactorDisabledEmail({
        to: user.email,
        username: user.username ?? user.email,
        ipAddress: req.ip ?? null,
        timestamp: new Date().toISOString(),
      }).catch((err) => {
        req.log.warn({ err }, "[2fa] failed to send 2fa_disabled email");
      });
    }

    return ok(res, { success: true });
  })
);

router.post(
  "/backup-codes",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const { code } = z.object({ code: z.string().min(1) }).parse(req.body);

    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new HttpError(400, "Two-factor authentication is not enabled.");
    }

    const trimmedCode = code.replace(/\s/g, "");
    const secret = decryptTotpSecret(user.twoFactorSecret);
    const isValid = verifySync({ token: trimmedCode, secret }).valid;
    if (!isValid) {
      throw new HttpError(422, "Invalid verification code. Please check your authenticator app and try again.");
    }

    const plainCodes: string[] = [];
    const hashedCodes: string[] = [];
    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
      const plain = generateBackupCode();
      const hashed = await hashPassword(plain);
      plainCodes.push(plain);
      hashedCodes.push(hashed);
    }

    await db.update(users).set({ twoFactorBackupCodes: hashedCodes }).where(eq(users.id, userId));

    await writeAuditLog({
      req,
      userId,
      action: "2fa_backup_codes_regenerated",
      entityType: "user",
      entityId: userId,
    });

    return ok(res, { backupCodes: plainCodes });
  })
);

router.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found.");
    return ok(res, { twoFactorEnabled: user.twoFactorEnabled });
  })
);

const challengeSchema = z.object({
  pendingToken: z.string().min(1),
  code: z.string().min(1),
  deviceName: z.string().max(180).optional(),
  clientType: z.enum(["web", "mobile", "desktop"]).optional(),
});

router.post(
  "/challenge",
  asyncHandler(async (req, res) => {
    const { pendingToken, code, deviceName, clientType } = challengeSchema.parse(req.body);

    let userId: string;
    try {
      const payload = verifyPendingTwoFactorToken(pendingToken);
      userId = payload.sub;
    } catch {
      throw new HttpError(401, "Invalid or expired 2FA session. Please sign in again.");
    }

    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user || !user.isActive) throw new HttpError(401, "User not found or inactive.");
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new HttpError(400, "Two-factor authentication is not enabled for this account.");
    }

    const trimmedCode = code.replace(/\s/g, "");
    let verified = false;

    const secret = decryptTotpSecret(user.twoFactorSecret);
    if (verifySync({ token: trimmedCode, secret }).valid) {
      verified = true;
    }

    if (!verified && user.twoFactorBackupCodes) {
      const codes = user.twoFactorBackupCodes as string[];
      for (let i = 0; i < codes.length; i++) {
        const match = await verifyPassword(trimmedCode, codes[i]);
        if (match) {
          const remaining = codes.filter((_, idx) => idx !== i);
          await db.update(users).set({ twoFactorBackupCodes: remaining }).where(eq(users.id, userId));
          await writeAuditLog({ req, userId, action: "2fa_backup_code_used", entityType: "user", entityId: userId });
          if (user.email) {
            sendTwoFactorBackupCodeUsedEmail({
              to: user.email,
              username: user.username ?? user.email,
              remainingCount: remaining.length,
              ipAddress: req.ip ?? null,
              timestamp: new Date().toISOString(),
            }).catch((err) => {
              req.log.warn({ err }, "[2fa] failed to send 2fa_backup_code_used email");
            });
          }
          verified = true;
          break;
        }
      }
    }

    if (!verified) {
      throw new HttpError(422, "Invalid code. Please check your authenticator app or use a backup code.");
    }

    const sessionId = crypto.randomUUID();
    const rawRefreshToken = signRefreshToken(userId, sessionId);
    const decoded = verifyRefreshToken(rawRefreshToken);

    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: makeSessionHash(rawRefreshToken),
      deviceName: deviceName ?? null,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null,
      expiresAt: new Date((decoded.exp ?? 0) * 1000),
    });

    const accessToken = signAccessToken(userId, sessionId);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));

    await writeAuditLog({
      req,
      userId,
      action: "login_succeeded",
      entityType: "session",
      entityId: sessionId,
    });

    setAuthCookies(req, res, accessToken, rawRefreshToken);

    const useCookies = clientType === "web";
    return ok(res, {
      success: true,
      ...(useCookies ? {} : { accessToken, refreshToken: rawRefreshToken }),
    });
  })
);

export default router;
