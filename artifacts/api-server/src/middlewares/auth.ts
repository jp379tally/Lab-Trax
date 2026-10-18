import { and, eq, isNull, gt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db } from "@workspace/db";
import { userSessions, users } from "@workspace/db";
import { verifyAccessToken, extractBearerToken } from "../lib/auth";
import { getAccessCookie } from "../lib/cookies";
import { HttpError } from "../lib/http";
import { timeRequestStage } from "./request-performance";
import { getSubjectForUser } from "../lib/entitlement";
import { classifyAccountNumber, ACCOUNT_NUMBER_NEW_VALID } from "@workspace/account-number";
import {
  assertBillingSubjectMutationAllowed,
  isMutationAllowedDuringReadOnly,
  runWithEntitlementRequestContext,
} from "../lib/entitlement-write-guard";

export { isMutationAllowedDuringReadOnly } from "../lib/entitlement-write-guard";

const authUserColumns = {
  id: users.id,
  username: users.username,
  password: users.password,
  email: users.email,
  phone: users.phone,
  firstName: users.firstName,
  lastName: users.lastName,
  initials: users.initials,
  userType: users.userType,
  role: users.role,
  isActive: users.isActive,
  licenseNumber: users.licenseNumber,
  practiceName: users.practiceName,
  doctorName: users.doctorName,
  practiceAddress: users.practiceAddress,
  practicePhone: users.practicePhone,
  phoneContactName: users.phoneContactName,
  accountNumber: users.accountNumber,
  platformAccountNumber: users.platformAccountNumber,
  wantsUpdates: users.wantsUpdates,
  lastLoginAt: users.lastLoginAt,
  workStatus: users.workStatus,
  emailPreferences: users.emailPreferences,
  smsPreferences: users.smsPreferences,
  inAppPreferences: users.inAppPreferences,
  emailVerifiedAt: users.emailVerifiedAt,
  phoneVerifiedAt: users.phoneVerifiedAt,
  profilePhotoUrl: users.profilePhotoUrl,
  createdAt: users.createdAt,
  deletedAt: users.deletedAt,
  deletedByUserId: users.deletedByUserId,
};

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req) ?? getAccessCookie(req);
  if (!token) {
    return next(new HttpError(401, "Authentication required."));
  }
  let payload: ReturnType<typeof verifyAccessToken>;
  try { payload = verifyAccessToken(token); }
  catch { return next(new HttpError(401, "Invalid access token.")); }
  try {
    // Read the live session and live user together. No cross-request cache:
    // revocation, deactivation and deletion still take effect immediately.
    const [user] = await timeRequestStage(res, "authIdentity", () => db
      .select(authUserColumns)
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(and(
        eq(userSessions.id, payload.sid),
        eq(userSessions.userId, payload.sub),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, new Date())
      ))
      .limit(1));
    if (!user) {
      return next(new HttpError(401, "Session is invalid or expired."));
    }
    if (!user || !user.isActive || user.deletedAt) {
      return next(new HttpError(401, "User account is inactive."));
    }

    (req as any).auth = { userId: payload.sub, sessionId: payload.sid };
    (req as any).user = user;
    // User-scoped subscriptions can be checked here. Organization-scoped
    // subscriptions are checked when RBAC/provider selection resolves the
    // actual tenant, never from an unrelated header or first membership.
    const subject = await timeRequestStage(res, "authSubject", () => getSubjectForUser(payload.sub, user.userType));
    const accountScopedMutation =
      req.originalUrl.split("?")[0]!.startsWith("/api/auth/") &&
      !isMutationAllowedDuringReadOnly(req.method, req.originalUrl);
    if (subject.subjectType === "user" || accountScopedMutation) {
      await runWithEntitlementRequestContext(
        { method: req.method, originalUrl: req.originalUrl },
        () => assertBillingSubjectMutationAllowed(subject),
      );
    }
    return runWithEntitlementRequestContext(
      { method: req.method, originalUrl: req.originalUrl },
      () => next(),
    );
  } catch (error) {
    if (error instanceof HttpError) return next(error);
    // Infrastructure failure is not a bad credential. In particular, never
    // cause clients to refresh/logout just because the pool is saturated.
    return next(error);
  }
}

/**
 * Old canonical V2 account numbers look like
 * `<L|P>-<YEAR>-<SEQUENCE>[-<PHONE>]`. New twelve-digit account numbers are
 * canonical too; older initials-based values remain grandfathered.
 */
const CANONICAL_ACCOUNT_NUMBER = /^[LP]-\d{4}-\d+(-\d{10})?$/;

export function isCanonicalAccount(user: any): boolean {
  const accountNumber = user?.platformAccountNumber ?? "";
  return (
    CANONICAL_ACCOUNT_NUMBER.test(accountNumber) ||
    classifyAccountNumber(accountNumber) === ACCOUNT_NUMBER_NEW_VALID
  );
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
