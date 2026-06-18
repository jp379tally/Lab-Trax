import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import sharp from "sharp";
import { Router } from "express";
import { createRateLimit } from "../lib/rate-limit";
import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  organizationInvites,
  organizationJoinRequests,
  organizationMemberships,
  organizations,
  userSessions,
  users,
  trustedDevices,
  systemSettings,
} from "@workspace/db";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  makeSessionHash,
  signPendingTwoFactorToken,
} from "../lib/auth";
import { hashPassword, verifyPassword, sha256 } from "../lib/crypto";
import {
  clearAuthCookies,
  generateCsrfToken,
  getRefreshCookie,
  setAccessCookie,
  setAuthCookies,
} from "../lib/cookies";
import { HttpError, ok } from "../lib/http";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import { writeAuditLog } from "../lib/audit";
import { assertLabNameAvailable, assertLabCreationFields } from "../lib/lab-creation";
import { softDeleteById } from "../lib/soft-delete";
import { notifications } from "@workspace/db";
import {
  allocateAccountNumberV2,
  accountTypeFor,
} from "../lib/platform-account-number";
import {
  matchAndInviteCrossLabDoctors,
  resolveLabNameForUser,
} from "../lib/match-and-invite";
import { startBillingTrial } from "../lib/entitlement";
import { sendSecurityAlertEmail } from "../lib/mail";

const router = Router();

const loginRateLimit = createRateLimit({
  windowMs: 60_000,
  max: 10,
  message: "Too many login attempts. Please wait a minute and try again.",
});
const registerRateLimit = createRateLimit({
  windowMs: 60_000,
  max: 5,
  message: "Too many registration attempts. Please wait a minute and try again.",
});

const profilePhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

function safeUser(user: any) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    phone: user.phone,
    firstName: user.firstName,
    lastName: user.lastName,
    initials: user.initials,
    userType: user.userType,
    role: user.role,
    licenseNumber: user.licenseNumber,
    practiceName: user.practiceName,
    doctorName: user.doctorName,
    practiceAddress: user.practiceAddress,
    practicePhone: user.practicePhone,
    phoneContactName: user.phoneContactName,
    accountNumber: user.accountNumber,
    platformAccountNumber: user.platformAccountNumber ?? null,
    emailVerifiedAt: user.emailVerifiedAt
      ? new Date(user.emailVerifiedAt).toISOString()
      : null,
    phoneVerifiedAt: user.phoneVerifiedAt
      ? new Date(user.phoneVerifiedAt).toISOString()
      : null,
    twoFactorChannel: user.twoFactorChannel ?? null,
    wantsUpdates: user.wantsUpdates,
    workStatus: user.workStatus ?? "available",
    profilePhotoUrl: user.profilePhotoUrl ?? null,
  };
}

function mapMembershipRoleToUserRole(
  role?: string | null
): "admin" | "billing" | "user" {
  if (role === "owner" || role === "admin") return "admin";
  if (role === "billing") return "billing";
  return "user";
}

function buildOrganizationAddress(organization: any): string | null {
  const address = [
    organization?.addressLine1,
    organization?.addressLine2,
    organization?.city,
    organization?.state,
    organization?.zip,
  ]
    .filter(Boolean)
    .join(", ");

  return address || null;
}

function deriveInitialsFromUsername(username?: string | null) {
  const normalizedUsername = username?.trim() || "";
  if (!normalizedUsername) {
    return "LT";
  }

  const tokenizedParts = normalizedUsername
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (tokenizedParts.length >= 2) {
    return (tokenizedParts[0][0] + tokenizedParts[tokenizedParts.length - 1][0]).toUpperCase();
  }

  const lettersOnly = normalizedUsername.replace(/[^A-Za-z0-9]/g, "");
  if (lettersOnly.length >= 2) {
    return (lettersOnly[0] + lettersOnly[1]).toUpperCase();
  }

  return lettersOnly[0]?.toUpperCase() || "LT";
}

function deriveUserInitials(input: {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
}) {
  const firstInitial = input.firstName?.trim()?.[0];
  const lastInitial = input.lastName?.trim()?.[0];

  if (firstInitial && lastInitial) {
    return `${firstInitial}${lastInitial}`.toUpperCase();
  }

  return deriveInitialsFromUsername(input.username);
}

async function hydrateUsersWithActiveMemberships(rawUsers: any[]) {
  if (rawUsers.length === 0) {
    return [];
  }

  const userIds = rawUsers.map((user) => user.id);
  const memberships = await db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        inArray(organizationMemberships.userId, userIds),
        eq(organizationMemberships.status, "active")
      )
    );

  const organizationIds = [...new Set(memberships.map((membership) => membership.labId))];
  const membershipOrganizations = organizationIds.length
    ? await db
        .select()
        .from(organizations)
        .where(inArray(organizations.id, organizationIds))
    : [];

  const organizationsById = new Map(
    membershipOrganizations.map((organization) => [organization.id, organization])
  );
  const membershipsByUserId = new Map<string, typeof memberships>();

  for (const membership of memberships) {
    const existingMemberships = membershipsByUserId.get(membership.userId) ?? [];
    existingMemberships.push(membership);
    membershipsByUserId.set(membership.userId, existingMemberships);
  }

  return rawUsers.map((user) => {
    const base = safeUser(user);
    const activeMemberships = membershipsByUserId.get(user.id) ?? [];
    const primaryMembership =
      activeMemberships.find((membership) => {
        const organization = organizationsById.get(membership.labId);
        return organization?.type === "lab";
      }) ?? activeMemberships[0];

    const primaryOrganization = primaryMembership
      ? organizationsById.get(primaryMembership.labId)
      : null;

    return {
      ...base,
      practiceName:
        primaryOrganization?.displayName ||
        primaryOrganization?.name ||
        null,
      practiceAddress:
        base.practiceAddress || buildOrganizationAddress(primaryOrganization),
      practicePhone: base.practicePhone || primaryOrganization?.phone || null,
      // Surface the primary org id + uploaded logo URL so the desktop
      // can show the lab logo in the header and POST a new logo to the
      // right org without having to re-resolve membership.
      practiceOrganizationId: primaryOrganization?.id ?? null,
      practiceLogoUrl: (primaryOrganization as any)?.logoUrl ?? null,
      // Logo placement preferences for the lab. null = unset (client
      // should treat as all-enabled when practiceLogoUrl is set, or
      // empty otherwise). See organizations PATCH /logo-placements.
      practiceLogoplacements: (primaryOrganization as any)?.logoplacements ?? null,
      practiceLogoSize: (primaryOrganization as any)?.logoPdfSize ?? null,
      // Per-lab visual invoice-layout template (Task #751). Null = use the
      // built-in default. Surfaced here so the desktop client can render
      // every invoice PDF using the lab's saved layout without an extra
      // round-trip on each PDF build.
      practiceInvoiceTemplate:
        (primaryOrganization as any)?.invoiceTemplate ?? null,
      // Surface the lab-scoped account number from the user's primary
      // practice organization so providers can see it in their profile.
      // Falls back to the legacy per-user accountNumber field.
      practiceAccountNumber: primaryOrganization?.accountNumber || null,
      accountNumber:
        base.accountNumber || primaryOrganization?.accountNumber || null,
      role: primaryMembership
        ? mapMembershipRoleToUserRole(primaryMembership.role)
        : base.role,
    };
  });
}

// Username rules (Account epic Phase 2): 3–12 characters, ASCII letters,
// digits, and underscore only. Uniqueness is enforced case-insensitively
// below. Documented in docs/account-epic/account-number-format.md.
export const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,12}$/;

const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .regex(
      USERNAME_REGEX,
      "Username must be 3–12 characters using only letters, numbers, and underscores."
    ),
  password: z.string().min(1),
  // Canonical signup (Account epic Phase 2) requires an email and an account
  // type. Phone stays optional: design note §0 mandates "email and/or phone"
  // verification, not both, and provider signups without SMS opt-in are valid
  // (the canonical account number simply omits the phone segment).
  email: z.string().email(),
  phone: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  // Account type is constrained to lab|provider. A strict enum also prevents a
  // public caller from self-assigning an elevated/arbitrary userType (e.g.
  // "master_admin") via this unauthenticated endpoint (design note §1, §8).
  userType: z.enum(["lab", "provider"]),
  licenseNumber: z.string().optional(),
  practiceName: z.string().optional(),
  doctorName: z.string().optional(),
  practiceAddress: z.string().optional(),
  practicePhone: z.string().optional(),
  phoneContactName: z.string().optional(),
  accountNumber: z.string().optional(),
  wantsUpdates: z.boolean().optional(),
  joinOrganizationId: z.string().optional(),
  createOrganization: z.boolean().optional(),
  // Optional claim-by-account-number flow: a new provider user identifies the
  // existing practice their lab created for them by lab id + account number.
  // We then file a join request against that provider org, which the lab
  // admin can approve from the practices page.
  claimProvider: z
    .object({
      labId: z.string().min(1),
      accountNumber: z.string().min(1),
    })
    .optional(),
  clientType: z.enum(["web", "mobile", "desktop"]).optional(),
});

router.post(
  "/register",
  registerRateLimit,
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const shouldCreateOrganization =
      !!input.createOrganization &&
      !!input.practiceName?.trim() &&
      (input.userType === "lab" || input.userType === "provider");
    // Always register with the base "user" role. Org ownership/admin rights
    // are tracked via organizationMemberships.role ("owner"/"admin"), not by
    // elevating the global users.role field via a public endpoint.
    const normalizedUserRole = "user";
    const normalizedPracticeName = shouldCreateOrganization
      ? input.practiceName?.trim() || null
      : null;

    const existing = await db.query.users.findFirst({
      where: sql`lower(${users.username}) = ${input.username.trim().toLowerCase()}`,
    });
    if (existing)
      throw new HttpError(409, "Username already taken.");

    if (input.email) {
      const allUsers = await db.select().from(users);
      const emailMatch = allUsers.find(
        (u) => u.email?.toLowerCase() === input.email!.toLowerCase()
      );
      if (emailMatch)
        throw new HttpError(
          409,
          "An account with this email already exists."
        );
    }

    // Resolve any join-target organization BEFORE we persist the user. If the
    // claim/join lookup fails we want to bail out without leaving a half-
    // created account behind — otherwise a retry would hit a "username
    // already taken" 409 even though no successful registration occurred.
    let joinTargetOrg:
      | {
          id: string;
          name: string;
          displayName: string | null;
        }
      | null = null;
    if (input.joinOrganizationId) {
      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, input.joinOrganizationId));
      if (!org) {
        throw new HttpError(404, "We couldn't find that organization.");
      }
      joinTargetOrg = {
        id: org.id,
        name: org.name,
        displayName: org.displayName,
      };
    } else if (input.claimProvider) {
      const claimLab = await db.query.organizations.findFirst({
        where: and(
          eq(organizations.id, input.claimProvider.labId),
          eq(organizations.type, "lab")
        ),
      });
      const trimmedAccountNumber = input.claimProvider.accountNumber.trim();
      const practice = claimLab
        ? await db.query.organizations.findFirst({
            where: and(
              eq(organizations.parentLabOrganizationId, claimLab.id),
              eq(organizations.accountNumber, trimmedAccountNumber),
              eq(organizations.type, "provider")
            ),
          })
        : null;
      if (!practice) {
        // Generic 404 so callers cannot probe for valid account numbers.
        throw new HttpError(
          404,
          "We couldn't find a practice with that lab and account number. Please double-check with your lab."
        );
      }
      joinTargetOrg = {
        id: practice.id,
        name: practice.name,
        displayName: practice.displayName,
      };
    }

    const initials = deriveUserInitials({
      firstName: input.firstName,
      lastName: input.lastName,
      username: input.username,
    });

    const hashed = await hashPassword(input.password);

    // Canonical (Account epic Phase 2) account TYPE for the new user.
    const userAccountType = accountTypeFor(input.userType);

    let responseMessage = "Account created.";
    let pendingJoinRequest = false;
    let organizationInfo: any = null;
    // Captured inside the transaction; billing trials are started AFTER the
    // commit (best-effort, must never roll back account creation).
    let orgCreation:
      | {
          orgId: string;
          billingSubjectType: "lab_org" | "provider_org";
          org: typeof organizations.$inferSelect;
        }
      | null = null;

    // Allocate the immutable platform account number(s) and create the user
    // (plus any org/membership or join request) atomically. The canonical
    // account number MUST be allocated in the same transaction as the row it
    // belongs to so it can never be partially assigned or duplicated.
    const user = await db.transaction(async (tx) => {
      const userPlatformAccountNumber = await allocateAccountNumberV2(
        userAccountType,
        input.phone,
        { tx }
      );

      const [createdUser] = await tx
        .insert(users)
        .values({
          username: input.username.trim(),
          password: hashed,
          email: input.email || null,
          phone: input.phone || null,
          firstName: input.firstName || null,
          lastName: input.lastName || null,
          initials,
          userType: input.userType || "lab",
          licenseNumber: input.licenseNumber || null,
          doctorName: input.doctorName || null,
          practiceAddress: input.practiceAddress || null,
          practicePhone: input.practicePhone || null,
          phoneContactName: input.phoneContactName || null,
          accountNumber: input.accountNumber || null,
          wantsUpdates: input.wantsUpdates || false,
          role: normalizedUserRole,
          practiceName: normalizedPracticeName,
          platformAccountNumber: userPlatformAccountNumber,
        })
        .returning();

      if (joinTargetOrg) {
        const targetName = joinTargetOrg.displayName || joinTargetOrg.name;
        await tx.insert(organizationJoinRequests).values({
          labId: joinTargetOrg.id,
          userId: createdUser.id,
          requestedRole: "user",
          message: `${createdUser.username} would like to join ${targetName}.`,
          status: "pending",
        });
        organizationInfo = { id: joinTargetOrg.id, name: targetName };
        pendingJoinRequest = true;
        responseMessage = `Your request to join ${targetName} has been sent to the lab admin.`;
      } else if (shouldCreateOrganization) {
        const orgType = input.userType === "provider" ? "provider" : "lab";
        // Account epic Phase 3 — lab names are unique (case-insensitive)
        // across all non-deleted lab orgs. Checked inside the transaction so
        // the user row rolls back if the name collides.
        if (orgType === "lab") {
          // Account epic Phase 3 — a lab environment cannot be created without
          // all required fields. Enforced here as well as in
          // POST /api/organizations so the signup path can't bypass it.
          assertLabCreationFields({
            name: input.practiceName,
            addressLine1: input.practiceAddress,
            licenseNumber: input.licenseNumber,
            phone: input.practicePhone,
            billingEmail: input.email,
          });
          await assertLabNameAvailable(input.practiceName!.trim());
        }
        const orgPlatformAccountNumber = await allocateAccountNumberV2(
          accountTypeFor(orgType),
          input.practicePhone || input.phone,
          { tx }
        );
        const [org] = await tx
          .insert(organizations)
          .values({
            type: orgType,
            name: input.practiceName!.trim(),
            displayName: input.practiceName!.trim(),
            addressLine1: input.practiceAddress || null,
            phone: input.practicePhone || null,
            billingEmail: input.email || null,
            licenseNumber:
              orgType === "lab" ? input.licenseNumber?.trim() || null : null,
            createdByUserId: createdUser.id,
            platformAccountNumber: orgPlatformAccountNumber,
          })
          .returning();
        await tx.insert(organizationMemberships).values({
          labId: org.id,
          userId: createdUser.id,
          role: "owner",
          status: "active",
          approvedByUserId: createdUser.id,
          joinedAt: new Date(),
        });
        organizationInfo = { id: org.id, name: org.displayName || org.name };
        responseMessage = `${org.displayName || org.name} created and linked to your account.`;
        orgCreation = {
          orgId: org.id,
          billingSubjectType: orgType === "lab" ? "lab_org" : "provider_org",
          org,
        };
      }

      return createdUser;
    });

    const sessionId = crypto.randomUUID();
    const rawRefreshToken = signRefreshToken(user.id, sessionId);
    const decoded = verifyRefreshToken(rawRefreshToken);

    await db.insert(userSessions).values({
      id: sessionId,
      userId: user.id,
      tokenHash: makeSessionHash(rawRefreshToken),
      deviceName: null,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null,
      expiresAt: new Date((decoded.exp ?? 0) * 1000),
    });

    const accessToken = signAccessToken(user.id, sessionId);

    await writeAuditLog({
      req,
      userId: user.id,
      action: "user_registered",
      entityType: "user",
      entityId: user.id,
    });

    // Start billing trials AFTER the account-creation transaction commits.
    // These are best-effort and must never roll back the new account.
    if (orgCreation) {
      const { billingSubjectType, orgId, org } = orgCreation;
      // Account epic Phase 3 — record lab/provider environment creation so it
      // is audited consistently with POST /api/organizations.
      await writeAuditLog({
        req,
        userId: user.id,
        organizationId: orgId,
        action: "organization_created",
        entityType: "organization",
        entityId: orgId,
        afterJson: org,
      });
      startBillingTrial(billingSubjectType, orgId, user.id).catch((err: any) => {
        req.log?.warn?.(
          { err: err?.message },
          "[billing] Failed to start org billing trial (non-fatal)"
        );
      });
    } else if (!joinTargetOrg) {
      // Solo user who didn't create or join an org yet (e.g. a provider
      // who will claim their practice later). Give them a user-level trial
      // so they can explore the app before attaching to an org.
      startBillingTrial("user", user.id, user.id).catch((err: any) => {
        req.log?.warn?.(
          { err: err?.message },
          "[billing] Failed to start user billing trial (non-fatal)"
        );
      });
    }

    // Cross-lab account-link: if the new provider user matches an existing
    // platform doctor by email/phone, fire a Twilio SMS invite to YES-link
    // the two accounts. Best-effort; never blocks registration (Task #320).
    if (
      (input.userType || "lab") === "provider" &&
      user.platformAccountNumber
    ) {
      const labName =
        (organizationInfo as any)?.name ||
        (await resolveLabNameForUser(user.id));
      await matchAndInviteCrossLabDoctors({
        newUser: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          platformAccountNumber: user.platformAccountNumber,
        },
        newLabName: labName,
        log: req.log,
      });
    }

    const [hydratedUser] = await hydrateUsersWithActiveMemberships([user]);

    const useCookies = input.clientType === "web";
    // Only browser (cookie) clients should receive Set-Cookie. Mobile and
    // desktop are bearer-token clients; issuing cookies to them causes React
    // Native's fetch cookie jar to silently attach an auth cookie on later
    // POSTs, which trips the CSRF guard (403) whenever the in-memory bearer
    // token is momentarily absent (e.g. the offline-queue drain at launch).
    if (useCookies) {
      const csrfToken = setAuthCookies(req, res, accessToken, rawRefreshToken);
      // Bind the issued CSRF token to the session row so the CSRF middleware
      // can verify the token wasn't exfiltrated from a sibling subdomain.
      await db
        .update(userSessions)
        .set({ csrfTokenHash: sha256(csrfToken) })
        .where(eq(userSessions.id, sessionId));
    }
    return res.json({
      success: true,
      ...(useCookies ? {} : { accessToken, refreshToken: rawRefreshToken }),
      user: hydratedUser || safeUser(user),
      message: responseMessage,
      pendingJoinRequest,
      organization: organizationInfo,
    });
  })
);

const loginSchema = z
  .object({
    // Either `username` (legacy) or `identifier` (new). `identifier` accepts
    // either a username or a platform-wide account number (Task #320). Login
    // by account number is case-insensitive and ignores leading/trailing
    // whitespace.
    username: z.string().min(1).optional(),
    identifier: z.string().min(1).optional(),
    password: z.string().min(1),
    deviceName: z.string().max(180).optional(),
    clientType: z.enum(["web", "mobile", "desktop"]).optional(),
    // Optional: a trust token previously issued by the 2FA challenge endpoint.
    // If the token is valid for this user and not expired, the 2FA challenge is
    // skipped and a full session is issued immediately (Task #863).
    deviceTrustToken: z.string().optional(),
  })
  .refine((v) => v.username || v.identifier, {
    message: "username or identifier is required",
    path: ["identifier"],
  });

router.post(
  "/login",
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const rawIdentifier = (input.identifier ?? input.username ?? "").trim();
    const lowered = rawIdentifier.toLowerCase();
    const upperedAcct = rawIdentifier.toUpperCase();

    const allUsers = await db.select().from(users);
    const user = allUsers.find(
      (u) =>
        u.username.toLowerCase() === lowered ||
        (u.email && u.email.toLowerCase() === lowered) ||
        (u.platformAccountNumber &&
          u.platformAccountNumber.toUpperCase() === upperedAcct)
    );
    if (!user)
      throw new HttpError(401, "Invalid username or password.");

    let valid = false;
    if (user.password.startsWith("$2")) {
      valid = await verifyPassword(input.password, user.password);
    } else {
      valid = user.password === input.password;
      if (valid) {
        const hashed = await hashPassword(input.password);
        await db
          .update(users)
          .set({ password: hashed })
          .where(eq(users.id, user.id));
      }
    }

    if (!valid) {
      await writeAuditLog({
        req,
        userId: user.id,
        action: "login_failed",
        entityType: "user",
        entityId: user.id,
      });
      throw new HttpError(401, "Invalid username or password.");
    }

    if (user.twoFactorEnabled) {
      // Check if the client supplied a valid trusted-device token (Task #863).
      // If so, skip the interactive 2FA challenge and issue a full session.
      if (input.deviceTrustToken) {
        const tokenHash = sha256(input.deviceTrustToken);
        const now = new Date();
        const [device] = await db
          .select()
          .from(trustedDevices)
          .where(
            and(
              eq(trustedDevices.userId, user.id),
              eq(trustedDevices.tokenHash, tokenHash),
              gt(trustedDevices.expiresAt, now)
            )
          );

        if (device) {
          // Valid trust token — record usage and skip 2FA.
          await db
            .update(trustedDevices)
            .set({ lastUsedAt: now })
            .where(eq(trustedDevices.id, device.id));
          // Fall through to session creation below (no pendingToken response).
        } else {
          // Token not found or expired — require 2FA as normal.
          const pendingToken = signPendingTwoFactorToken(user.id);
          return res.json({ requiresTwoFactor: true, pendingToken });
        }
      } else {
        const pendingToken = signPendingTwoFactorToken(user.id);
        return res.json({ requiresTwoFactor: true, pendingToken });
      }
    }

    const sessionId = crypto.randomUUID();
    const rawRefreshToken = signRefreshToken(user.id, sessionId);
    const decoded = verifyRefreshToken(rawRefreshToken);

    await db.insert(userSessions).values({
      id: sessionId,
      userId: user.id,
      tokenHash: makeSessionHash(rawRefreshToken),
      deviceName: input.deviceName ?? null,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null,
      expiresAt: new Date((decoded.exp ?? 0) * 1000),
    });

    const accessToken = signAccessToken(user.id, sessionId);
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    await writeAuditLog({
      req,
      userId: user.id,
      action: "login_succeeded",
      entityType: "session",
      entityId: sessionId,
    });

    const [hydratedUser] = await hydrateUsersWithActiveMemberships([user]);

    const useCookies = input.clientType === "web";
    // Only browser (cookie) clients should receive Set-Cookie. Mobile and
    // desktop are bearer-token clients; issuing cookies to them causes React
    // Native's fetch cookie jar to silently attach an auth cookie on later
    // POSTs, which trips the CSRF guard (403) whenever the in-memory bearer
    // token is momentarily absent (e.g. the offline-queue drain at launch).
    if (useCookies) {
      const csrfToken = setAuthCookies(req, res, accessToken, rawRefreshToken);
      // Bind the issued CSRF token to the session row so the CSRF middleware
      // can verify the token wasn't exfiltrated from a sibling subdomain.
      await db
        .update(userSessions)
        .set({ csrfTokenHash: sha256(csrfToken) })
        .where(eq(userSessions.id, sessionId));
    }
    return res.json({
      success: true,
      ...(useCookies ? {} : { accessToken, refreshToken: rawRefreshToken }),
      user: hydratedUser || safeUser(user),
    });
  })
);

const refreshSchema = z.object({ refreshToken: z.string().min(1).optional() });
router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const parsed = refreshSchema.parse(req.body ?? {});
    // If the client supplied the refresh token in the request body it's a
    // bearer-token client (mobile). If we read it from the cookie instead,
    // it's the cookie-based desktop flow and we must not echo tokens back
    // in JSON, since any XSS-controlled script could read them.
    const fromBody = !!parsed.refreshToken;
    const refreshToken = parsed.refreshToken ?? getRefreshCookie(req);
    if (!refreshToken) {
      if (!fromBody) clearAuthCookies(req, res);
      throw new HttpError(401, "Refresh token is invalid or expired.");
    }
    let payload: ReturnType<typeof verifyRefreshToken>;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      if (!fromBody) clearAuthCookies(req, res);
      throw new HttpError(401, "Refresh token is invalid or expired.");
    }

    // Look up the session by id + user only, so we can distinguish "no such
    // session" from "wrong token hash" (i.e. a reused / leaked refresh token).
    const sessionRow = await db.query.userSessions.findFirst({
      where: and(
        eq(userSessions.id, payload.sid),
        eq(userSessions.userId, payload.sub)
      ),
    });

    if (!sessionRow) {
      if (!fromBody) clearAuthCookies(req, res);
      throw new HttpError(401, "Refresh token is invalid or expired.");
    }

    const presentedHash = makeSessionHash(refreshToken);
    const sessionExpired = sessionRow.expiresAt.getTime() <= Date.now();
    const tokenHashMismatch = sessionRow.tokenHash !== presentedHash;
    const sessionRevoked = sessionRow.revokedAt !== null;

    // Refresh-token reuse detection: the signature is valid and the session
    // exists, but the presented token does not match the currently-active
    // hash, or the session row has already been revoked. This is a strong
    // signal that an old refresh token was replayed (likely leaked). Revoke
    // this session chain (the sid is stable across rotations, so the row
    // *is* the chain) to force a fresh login on the affected device. We
    // intentionally do NOT revoke other sessions for this user, since a
    // benign concurrent-refresh race could otherwise log a user out across
    // every device.
    if (tokenHashMismatch || sessionRevoked) {
      const now = new Date();
      await db
        .update(userSessions)
        .set({ revokedAt: sessionRow.revokedAt ?? now })
        .where(eq(userSessions.id, payload.sid));
      await writeAuditLog({
        req,
        userId: payload.sub,
        action: "refresh_token_reuse_detected",
        entityType: "session",
        entityId: payload.sid,
      });
      try {
        await db.insert(notifications).values({
          userId: payload.sub,
          type: "security_session_revoked",
          title: "Suspicious sign-in activity detected",
          body: "We detected a reused sign-in token from one of your devices and signed that device out as a precaution. If this wasn't you, please reset your password and review your active sessions.",
          dataJson: {
            reason: "refresh_token_reuse_detected",
            sessionId: payload.sid,
            detectedAt: now.toISOString(),
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            passwordResetPath: "/settings/security/password",
            deviceReviewPath: "/settings/security/sessions",
          },
        });
      } catch (err) {
        console.error(
          "[AUTH] Failed to write reuse-detection notification:",
          err
        );
      }
      // Send a security alert email on a separate channel so the user is
      // notified even if they're not actively watching the app.
      try {
        const affectedUser = await db.query.users.findFirst({
          where: eq(users.id, payload.sub),
          columns: { email: true, username: true },
        });
        if (affectedUser?.email) {
          await sendSecurityAlertEmail({
            to: affectedUser.email,
            username: affectedUser.username ?? affectedUser.email,
            detectedAt: now.toISOString(),
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
          });
        }
      } catch (err) {
        req.log.error(
          { err },
          "[AUTH] Failed to send reuse-detection security alert email"
        );
      }
      if (!fromBody) clearAuthCookies(req, res);
      throw new HttpError(401, "Refresh token is invalid or expired.");
    }

    if (sessionExpired) {
      if (!fromBody) clearAuthCookies(req, res);
      throw new HttpError(401, "Refresh token is invalid or expired.");
    }

    // Rotate the refresh token: mint a new one, update the stored hash and
    // expiry, and invalidate the old refresh token. Re-using the previous
    // refresh token after this point will fail the tokenHash check above and
    // trigger reuse detection, which limits the blast radius of a leak.
    const newRefreshToken = signRefreshToken(payload.sub, payload.sid);
    const newDecoded = verifyRefreshToken(newRefreshToken);

    // Pre-generate the CSRF token for web (cookie) clients so it can be
    // stored on the session row atomically with the refresh-token rotation,
    // binding the new token to the server side in a single DB round-trip.
    // Bearer clients don't use CSRF so we skip token generation for them.
    const newCsrfToken = fromBody ? undefined : generateCsrfToken();

    await db
      .update(userSessions)
      .set({
        tokenHash: makeSessionHash(newRefreshToken),
        expiresAt: new Date((newDecoded.exp ?? 0) * 1000),
        ...(newCsrfToken ? { csrfTokenHash: sha256(newCsrfToken) } : {}),
      })
      .where(eq(userSessions.id, payload.sid));

    const accessToken = signAccessToken(payload.sub, payload.sid);
    if (fromBody) {
      // Bearer client (mobile/desktop) supplied the refresh token in the
      // body. Echo the rotated tokens in JSON and do NOT issue cookies — see
      // the note in the login handler about the native cookie-jar CSRF trap.
      return ok(res, { accessToken, refreshToken: newRefreshToken });
    }
    setAuthCookies(req, res, accessToken, newRefreshToken, newCsrfToken);
    return ok(res, { refreshed: true });
  })
);

router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(userSessions.id, (req as any).auth.sessionId));
    await writeAuditLog({
      req,
      action: "logout",
      entityType: "session",
      entityId: (req as any).auth.sessionId,
    });
    clearAuthCookies(req, res);
    return ok(res, { loggedOut: true });
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const memberships =
      await db.query.organizationMemberships.findMany({
        where: and(
          eq(organizationMemberships.userId, (req as any).auth.userId),
          isNull(organizationMemberships.deletedAt)
        ),
        orderBy: [asc(organizationMemberships.labId)],
      });
    const orgIds = memberships.map((m: any) => m.labId);
    const orgs = orgIds.length
      ? await db
          .select()
          .from(organizations)
          .where(inArray(organizations.id, orgIds))
      : [];

    const [hydratedUser] = await hydrateUsersWithActiveMemberships([user]);

    return res.json({
      success: true,
      user: hydratedUser || safeUser(user),
      memberships: memberships.map((m: any) => ({
        id: m.id,
        role: m.role,
        status: m.status,
        organizationId: m.labId,
        organization: orgs.find((org) => org.id === m.labId) ?? null,
      })),
    });
  })
);

router.get(
  "/users",
  requireAuth,
  asyncHandler(async (req, res) => {
    const reqUser = (req as any).user;
    if (!reqUser || reqUser.role !== "admin") {
      throw new HttpError(403, "Forbidden");
    }
    const allUsers = await db.select().from(users);
    const hydratedUsers = await hydrateUsersWithActiveMemberships(allUsers);
    res.json({
      users: hydratedUsers,
    });
  })
);

router.put(
  "/users/:id/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const authUserId = (req as any).auth.userId;
    if (authUserId !== id) {
      throw new HttpError(403, "Unauthorized");
    }
    const user = await db.query.users.findFirst({
      where: eq(users.id, id),
    });
    if (!user) throw new HttpError(404, "User not found");

    const {
      practiceName,
      practiceAddress,
      practicePhone,
      email,
      phone,
      firstName,
      lastName,
      profilePhotoUrl,
      username: newUsername,
    } = req.body;
    const updates: Partial<typeof user> = {};
    if (practiceName !== undefined) updates.practiceName = practiceName;
    if (practiceAddress !== undefined) updates.practiceAddress = practiceAddress;
    if (practicePhone !== undefined) updates.practicePhone = practicePhone;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (firstName !== undefined) updates.firstName = firstName;
    if (lastName !== undefined) updates.lastName = lastName;
    if (profilePhotoUrl !== undefined) updates.profilePhotoUrl = profilePhotoUrl || null;
    if (newUsername !== undefined && newUsername !== null) {
      const trimmed = String(newUsername).trim().toLowerCase();
      if (trimmed.length < 3) throw new HttpError(400, "Username must be at least 3 characters.");
      if (trimmed !== user.username) {
        const conflict = await db.query.users.findFirst({ where: eq(users.username, trimmed) });
        if (conflict) throw new HttpError(409, "Username already taken.");
        updates.username = trimmed;
      }
    }
    if (firstName !== undefined || lastName !== undefined) {
      updates.initials = deriveUserInitials({
        firstName: firstName !== undefined ? firstName : user.firstName,
        lastName: lastName !== undefined ? lastName : user.lastName,
        username: (updates.username as string | undefined) ?? user.username,
      });
    }

    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();

    await writeAuditLog({
      req,
      userId: id,
      action: "profile_updated",
      entityType: "user",
      entityId: id,
      beforeJson: safeUser(user),
      afterJson: safeUser(updated),
    });

    res.json({ success: true, user: safeUser(updated) });
  })
);

router.put(
  "/users/:id/password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const authUserId = (req as any).auth.userId;
    if (authUserId !== id) {
      throw new HttpError(403, "You can only change your own password.");
    }
    const { currentPassword, newPassword } = req.body;
    const user = await db.query.users.findFirst({
      where: eq(users.id, id),
    });
    if (!user) throw new HttpError(404, "User not found");

    let valid = false;
    if (user.password.startsWith("$2")) {
      valid = await verifyPassword(currentPassword, user.password);
    } else {
      valid = user.password === currentPassword;
    }
    if (!valid) throw new HttpError(401, "Current password is incorrect");

    const hashed = await hashPassword(newPassword);
    await db
      .update(users)
      .set({ password: hashed })
      .where(eq(users.id, id));

    // Changing the password revokes ALL remembered ("trusted") devices, matching
    // the forgot-password reset flow: a prior device-trust token must not keep
    // skipping the 2FA challenge after the owner rotates their password.
    await db.delete(trustedDevices).where(eq(trustedDevices.userId, id));

    await writeAuditLog({
      req,
      userId: id,
      action: "password_changed",
      entityType: "user",
      entityId: id,
    });

    res.json({ success: true });
  })
);

router.delete(
  "/users/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const authUserId = (req as any).auth.userId;
    if (authUserId !== id) {
      throw new HttpError(403, "You can only delete your own account.");
    }
    const user = await db.query.users.findFirst({
      where: eq(users.id, id),
    });
    if (!user) throw new HttpError(404, "User not found");

    await softDeleteById({
      table: users,
      id,
      actorUserId: authUserId,
      req,
      entityType: "user",
      beforeJson: { ...user, password: undefined },
    });
    res.json({ success: true });
  })
);

async function findLabCreatorId(labName: string): Promise<string | null> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.name, labName),
  });
  if (org?.createdByUserId) return org.createdByUserId;
  const labAdmins = await db.select().from(users).where(eq(users.role, "admin"));
  const matching = labAdmins
    .filter((u) => u.practiceName?.toLowerCase().trim() === labName.toLowerCase().trim())
    .sort((a, b) => {
      const aT = a.createdAt ? new Date(a.createdAt).getTime() : Infinity;
      const bT = b.createdAt ? new Date(b.createdAt).getTime() : Infinity;
      return aT - bT;
    });
  return matching.length > 0 ? matching[0].id : null;
}

router.get(
  "/lab-creator",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    if (!user.practiceName) {
      return res.json({ isLabCreator: false });
    }
    const creatorId = await findLabCreatorId(user.practiceName);
    return res.json({ isLabCreator: creatorId === user.id });
  })
);

router.delete(
  "/delete-lab",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    if (!user.practiceName) {
      throw new HttpError(400, "You are not associated with any lab.");
    }
    const labName = user.practiceName;
    const creatorId = await findLabCreatorId(labName);
    if (!creatorId || creatorId !== user.id) {
      throw new HttpError(403, "Only the admin who created this lab can delete it.");
    }
    const labNameLower = labName.toLowerCase().trim();
    const allLabUsers = await db.select().from(users);
    const labMembers = allLabUsers.filter(
      (u) => u.practiceName?.toLowerCase().trim() === labNameLower
    );
    const memberIds = labMembers.map((m) => m.id);
    if (memberIds.length > 0) {
      await db
        .update(users)
        .set({ practiceName: null })
        .where(inArray(users.id, memberIds));
    }
    await writeAuditLog({
      req,
      userId: user.id,
      action: "lab_deleted",
      entityType: "organization",
      entityId: labNameLower,
      details: { labName, membersRemoved: memberIds.length },
    });
    res.json({ success: true, membersRemoved: memberIds.length });
  })
);

router.get(
  "/sessions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const currentSessionId = (req as any).auth.sessionId as string;
    const rows = await db
      .select()
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, userId),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, new Date())
        )
      );
    const currentRow = rows.find((r) => r.id === currentSessionId);
    const currentIp = currentRow?.ipAddress ?? null;
    const now = Date.now();
    const SUSPICIOUS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const sessions = rows
      .map((row) => {
        const isCurrent = row.id === currentSessionId;
        const ageMs = row.createdAt ? now - row.createdAt.getTime() : Infinity;
        const isSuspicious =
          !isCurrent &&
          row.ipAddress !== null &&
          currentIp !== null &&
          row.ipAddress !== currentIp &&
          ageMs < SUSPICIOUS_WINDOW_MS;
        return {
          id: row.id,
          deviceName: row.deviceName,
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
          createdAt: row.createdAt ? row.createdAt.toISOString() : null,
          expiresAt: row.expiresAt.toISOString(),
          current: isCurrent,
          isSuspicious,
        };
      })
      .sort((a, b) => {
        if (a.current && !b.current) return -1;
        if (!a.current && b.current) return 1;
        if (a.isSuspicious && !b.isSuspicious) return -1;
        if (!a.isSuspicious && b.isSuspicious) return 1;
        return (b.createdAt || "").localeCompare(a.createdAt || "");
      });
    return res.json({ success: true, sessions });
  })
);

router.delete(
  "/sessions/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const currentSessionId = (req as any).auth.sessionId as string;
    const { id } = req.params;
    const row = await db.query.userSessions.findFirst({
      where: and(eq(userSessions.id, id), eq(userSessions.userId, userId)),
    });
    if (!row) {
      throw new HttpError(404, "Session not found.");
    }
    if (row.revokedAt === null) {
      await db
        .update(userSessions)
        .set({ revokedAt: new Date() })
        .where(eq(userSessions.id, id));
    }
    await writeAuditLog({
      req,
      userId,
      action: "session_revoked",
      entityType: "session",
      entityId: id,
      details: { revokedSelf: id === currentSessionId },
    });
    if (id === currentSessionId) {
      clearAuthCookies(req, res);
    }
    return res.json({ success: true, revokedCurrent: id === currentSessionId });
  })
);

router.post(
  "/sessions/revoke-others",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const currentSessionId = (req as any).auth.sessionId as string;
    const now = new Date();
    const result = await db
      .update(userSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(userSessions.userId, userId),
          isNull(userSessions.revokedAt),
          ne(userSessions.id, currentSessionId)
        )
      )
      .returning({ id: userSessions.id });
    await writeAuditLog({
      req,
      userId,
      action: "sessions_revoked_others",
      entityType: "user",
      entityId: userId,
      details: { revokedCount: result.length },
    });
    return res.json({ success: true, revokedCount: result.length });
  })
);

// Returns the caller's lab teammates with their current `workStatus`,
// so the profile panel can show "who's around right now". Scoped to
// every lab the caller is an active member of — only members of those
// labs are returned, never users from other tenants.
router.get(
  "/lab-team",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const callerMemberships = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.status, "active")
        )
      );
    const labIds = [...new Set(callerMemberships.map((m) => m.labId))];
    if (labIds.length === 0) {
      return res.json({ team: [], callerRole: null, pendingInvites: [] });
    }
    // Build per-lab admin sets so access checks are always lab-scoped.
    const callerAdminLabIds = new Set(
      callerMemberships
        .filter((m) => m.role === "admin" || m.role === "owner")
        .map((m) => m.labId)
    );
    // callerRole: prefer the caller's role in any admin lab they belong to,
    // falling back to their role in the first lab.
    const primaryLabId = labIds[0];
    const callerPrimaryMembership =
      callerMemberships.find((m) => callerAdminLabIds.has(m.labId)) ??
      callerMemberships.find((m) => m.labId === primaryLabId);
    // Optional org-scoped filter — lets the mobile client fetch team for one
    // specific lab without receiving members from all the caller's labs.
    const orgIdParam = typeof req.query.orgId === "string" ? req.query.orgId : null;
    const teamLabIds = orgIdParam && labIds.includes(orgIdParam) ? [orgIdParam] : labIds;

    // When the request is scoped to a specific org, callerRole must reflect the
    // caller's role in THAT org only. Without this, a user who is owner in lab A
    // but admin in lab B would receive callerRole:"owner" for a lab B request,
    // incorrectly exposing the owner-transfer affordance on the client.
    const callerRole = orgIdParam && labIds.includes(orgIdParam)
      ? (callerMemberships.find((m) => m.labId === orgIdParam)?.role ?? null)
      : (callerPrimaryMembership?.role ?? null);

    const teamMemberships = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          inArray(organizationMemberships.labId, teamLabIds),
          inArray(organizationMemberships.status, ["active", "suspended"])
        )
      );
    const teamUserIds = [...new Set(teamMemberships.map((m) => m.userId))];
    if (teamUserIds.length === 0) {
      return res.json({ team: [], callerRole, pendingInvites: [] });
    }
    // Fetch pending invites only for the labs where the caller is actually admin/owner.
    const adminLabIdList = [...callerAdminLabIds];
    const [teammateRows, labRows, pendingInviteRows] = await Promise.all([
      db.select().from(users).where(inArray(users.id, teamUserIds)),
      db.select().from(organizations).where(inArray(organizations.id, labIds)),
      adminLabIdList.length > 0
        ? db
            .select()
            .from(organizationInvites)
            .where(
              and(
                inArray(organizationInvites.labId, adminLabIdList),
                eq(organizationInvites.status, "pending")
              )
            )
        : Promise.resolve([]),
    ]);
    const labsById = new Map(labRows.map((o) => [o.id, o]));
    const membershipByUser = new Map<string, typeof teamMemberships>();
    for (const m of teamMemberships) {
      const arr = membershipByUser.get(m.userId) ?? [];
      arr.push(m);
      membershipByUser.set(m.userId, arr);
    }
    const team = teammateRows
      .filter((u) => !u.deletedAt && u.isActive)
      .map((u) => {
        const memberships = membershipByUser.get(u.id) ?? [];
        const labNames = memberships
          .map((m) => labsById.get(m.labId)?.displayName || labsById.get(m.labId)?.name)
          .filter(Boolean);
        // Prefer the membership in a lab where the caller has admin rights so
        // that remove operations always target the correct lab membership.
        const adminScopedMembership =
          memberships.find((m) => callerAdminLabIds.has(m.labId)) ??
          memberships[0];
        const role = adminScopedMembership?.role ?? u.role;
        return {
          id: u.id,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          initials: u.initials,
          email: u.email,
          phone: u.phone,
          role,
          membershipId: adminScopedMembership?.id ?? null,
          isOwner: role === "owner",
          workStatus: u.workStatus ?? "available",
          labNames,
          isSelf: u.id === userId,
          status: adminScopedMembership?.status ?? "active",
        };
      })
      .sort((a, b) => {
        if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
        return (a.firstName || a.username).localeCompare(
          b.firstName || b.username
        );
      });
    const pendingInvites = pendingInviteRows.map((inv) => ({
      id: inv.id,
      email: inv.email,
      roleToAssign: inv.roleToAssign,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
    }));
    return res.json({ team, callerRole, pendingInvites });
  })
);

router.patch(
  "/me/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    // "available" = at work, "break" = on a short break, "lunch" = at lunch,
    // "out_of_office" = off site / signed off for the day. UI labels
    // these as "At work", "On break", "On lunch", and "Out of office".
    const validStatuses = ["available", "break", "lunch", "out_of_office"];
    const { workStatus } = req.body;
    if (!validStatuses.includes(workStatus)) {
      throw new HttpError(
        400,
        "Invalid status. Must be one of: available, break, lunch, out_of_office."
      );
    }
    const userId = (req as any).auth.userId;
    const [updated] = await db
      .update(users)
      .set({ workStatus })
      .where(eq(users.id, userId))
      .returning();
    return ok(res, safeUser(updated));
  })
);

router.post(
  "/users/:id/profile-photo",
  requireAuth,
  profilePhotoUpload.single("photo"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const authUserId = (req as any).auth.userId;
    if (authUserId !== id) {
      throw new HttpError(403, "Unauthorized");
    }
    if (!req.file) {
      throw new HttpError(400, "No file provided");
    }

    const profilePhotosDir = path.join(process.cwd(), "uploads", "profile-photos");
    if (!fs.existsSync(profilePhotosDir)) {
      fs.mkdirSync(profilePhotosDir, { recursive: true });
    }

    const filename = `${id}-${Date.now()}.jpg`;
    const outputPath = path.join(profilePhotosDir, filename);

    await sharp(req.file.buffer)
      .resize(200, 200, { fit: "cover" })
      .jpeg({ quality: 85 })
      .toFile(outputPath);

    const photoUrl = `/uploads/profile-photos/${filename}`;

    const [updated] = await db
      .update(users)
      .set({ profilePhotoUrl: photoUrl })
      .where(eq(users.id, id))
      .returning();

    res.json({ success: true, profilePhotoUrl: photoUrl, user: safeUser(updated) });
  })
);

// ── Notification preferences ────────────────────────────────────────────────
// Persisted per-user in system_settings with key `notif_prefs:{userId}`.
// The schema is a flat object of boolean channel flags.

const DEFAULT_NOTIF_PREFS = {
  emailCaseAssigned: true,
  emailCaseStatusChanged: true,
  emailInvoiceDue: true,
  emailInvoicePaid: true,
  emailDailySummary: false,
  emailWeeklySummary: true,
  smsCaseAssigned: false,
  smsCaseStatusChanged: false,
  smsInvoiceDue: false,
  pushCaseAssigned: true,
  pushCaseStatusChanged: true,
  pushInvoiceDue: true,
  pushChatMessage: true,
};

const notifPrefsSchema = z.object({
  emailCaseAssigned: z.boolean().optional(),
  emailCaseStatusChanged: z.boolean().optional(),
  emailInvoiceDue: z.boolean().optional(),
  emailInvoicePaid: z.boolean().optional(),
  emailDailySummary: z.boolean().optional(),
  emailWeeklySummary: z.boolean().optional(),
  smsCaseAssigned: z.boolean().optional(),
  smsCaseStatusChanged: z.boolean().optional(),
  smsInvoiceDue: z.boolean().optional(),
  pushCaseAssigned: z.boolean().optional(),
  pushCaseStatusChanged: z.boolean().optional(),
  pushInvoiceDue: z.boolean().optional(),
  pushChatMessage: z.boolean().optional(),
});

router.get(
  "/notification-preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const key = `notif_prefs:${userId}`;
    const row = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, key))
      .then((r) => r[0] ?? null);
    const stored = row ? (() => { try { return JSON.parse(row.value ?? "{}"); } catch { return {}; } })() : {};
    const preferences = { ...DEFAULT_NOTIF_PREFS, ...stored };
    return res.json({ success: true, preferences });
  })
);

router.patch(
  "/notification-preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const parsed = notifPrefsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "Invalid notification preferences");
    }
    const key = `notif_prefs:${userId}`;
    const existing = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, key))
      .then((r) => r[0] ?? null);
    const current = existing ? (() => { try { return JSON.parse(existing.value ?? "{}"); } catch { return {}; } })() : {};
    const updated = { ...DEFAULT_NOTIF_PREFS, ...current, ...parsed.data };
    await db
      .insert(systemSettings)
      .values({ key, value: JSON.stringify(updated), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: JSON.stringify(updated), updatedAt: new Date() },
      });
    return res.json({ success: true, preferences: updated });
  })
);

export default router;
