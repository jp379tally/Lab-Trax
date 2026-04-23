import crypto from "node:crypto";
import { Router } from "express";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  organizationJoinRequests,
  organizationMemberships,
  organizations,
  userSessions,
  users,
} from "../../shared/schema";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  makeSessionHash,
} from "../lib/auth";
import { hashPassword, verifyPassword } from "../lib/crypto";
import { HttpError, ok } from "../lib/http";
import { asyncHandler } from "../middleware/async-handler";
import { requireAuth } from "../middleware/auth";
import { writeAuditLog } from "../lib/audit";

const router = Router();

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
    wantsUpdates: user.wantsUpdates,
  };
}

function mapMembershipRoleToUserRole(role?: string | null): "admin" | "user" {
  return role === "owner" || role === "admin" ? "admin" : "user";
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

  const organizationIds = [...new Set(memberships.map((membership) => membership.organizationId))];
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
        const organization = organizationsById.get(membership.organizationId);
        return organization?.type === "lab";
      }) ?? activeMemberships[0];

    const primaryOrganization = primaryMembership
      ? organizationsById.get(primaryMembership.organizationId)
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
      role: primaryMembership
        ? mapMembershipRoleToUserRole(primaryMembership.role)
        : base.role,
    };
  });
}

const registerSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  userType: z.string().optional(),
  role: z.string().optional(),
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
});

router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const shouldCreateOrganization =
      !!input.createOrganization &&
      !!input.practiceName?.trim() &&
      (input.userType === "lab" || input.userType === "provider");
    const normalizedUserRole = shouldCreateOrganization
      ? "admin"
      : input.role || "user";
    const normalizedPracticeName = shouldCreateOrganization
      ? input.practiceName?.trim() || null
      : null;

    const existing = await db.query.users.findFirst({
      where: eq(users.username, input.username.trim()),
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

    const initials = deriveUserInitials({
      firstName: input.firstName,
      lastName: input.lastName,
      username: input.username,
    });

    const hashed = await hashPassword(input.password);

    const [user] = await db
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
      })
      .returning();

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

    let responseMessage = "Account created.";
    let pendingJoinRequest = false;
    let organizationInfo: any = null;

    if (input.joinOrganizationId) {
      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, input.joinOrganizationId));
      if (org) {
        await db.insert(organizationJoinRequests).values({
          organizationId: org.id,
          requestedByUserId: user.id,
          requestedRole: input.role === "admin" ? "admin" : "user",
          message: `${user.username} would like to join ${org.displayName || org.name}.`,
          status: "pending",
        });
        organizationInfo = { id: org.id, name: org.displayName || org.name };
        pendingJoinRequest = true;
        responseMessage = `Your request to join ${org.displayName || org.name} has been sent to the lab admin.`;
      }
    } else if (shouldCreateOrganization) {
      const orgType = input.userType === "provider" ? "provider" : "lab";
      const [org] = await db
        .insert(organizations)
        .values({
          type: orgType,
          name: input.practiceName.trim(),
          displayName: input.practiceName.trim(),
          addressLine1: input.practiceAddress || null,
          phone: input.practicePhone || null,
          billingEmail: input.email || null,
          createdByUserId: user.id,
        })
        .returning();
      await db.insert(organizationMemberships).values({
        organizationId: org.id,
        userId: user.id,
        role: "owner",
        status: "active",
        approvedByUserId: user.id,
        joinedAt: new Date(),
      });
      organizationInfo = { id: org.id, name: org.displayName || org.name };
      responseMessage = `${org.displayName || org.name} created and linked to your account.`;
    }

    const [hydratedUser] = await hydrateUsersWithActiveMemberships([user]);

    return res.json({
      success: true,
      accessToken,
      refreshToken: rawRefreshToken,
      user: hydratedUser || safeUser(user),
      message: responseMessage,
      pendingJoinRequest,
      organization: organizationInfo,
    });
  })
);

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  deviceName: z.string().max(180).optional(),
});

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);

    const allUsers = await db.select().from(users);
    const user = allUsers.find(
      (u) => u.username.toLowerCase() === input.username.trim().toLowerCase()
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

    return res.json({
      success: true,
      accessToken,
      refreshToken: rawRefreshToken,
      user: hydratedUser || safeUser(user),
    });
  })
);

const refreshSchema = z.object({ refreshToken: z.string().min(1) });
router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const payload = verifyRefreshToken(refreshToken);
    const session = await db.query.userSessions.findFirst({
      where: and(
        eq(userSessions.id, payload.sid),
        eq(userSessions.userId, payload.sub),
        eq(userSessions.tokenHash, makeSessionHash(refreshToken)),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, new Date())
      ),
    });

    if (!session)
      throw new HttpError(401, "Refresh token is invalid or expired.");
    const accessToken = signAccessToken(payload.sub, payload.sid);
    return ok(res, { accessToken });
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
        where: eq(
          organizationMemberships.userId,
          (req as any).auth.userId
        ),
      });
    const orgIds = memberships.map((m: any) => m.organizationId);
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
        organizationId: m.organizationId,
        organization: orgs.find((org) => org.id === m.organizationId) ?? null,
      })),
    });
  })
);

router.get(
  "/users",
  asyncHandler(async (_req, res) => {
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
      role,
      firstName,
      lastName,
    } = req.body;
    const updates: Partial<typeof user> = {};
    if (practiceName !== undefined) updates.practiceName = practiceName;
    if (practiceAddress !== undefined) updates.practiceAddress = practiceAddress;
    if (practicePhone !== undefined) updates.practicePhone = practicePhone;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (firstName !== undefined) updates.firstName = firstName;
    if (lastName !== undefined) updates.lastName = lastName;
    if (role !== undefined && (role === "admin" || role === "user"))
      updates.role = role;
    if (firstName !== undefined || lastName !== undefined) {
      updates.initials = deriveUserInitials({
        firstName: firstName !== undefined ? firstName : user.firstName,
        lastName: lastName !== undefined ? lastName : user.lastName,
        username: user.username,
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

    await db.delete(users).where(eq(users.id, id));
    await writeAuditLog({
      req,
      userId: id,
      action: "user_deleted",
      entityType: "user",
      entityId: id,
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
    res.json({ isLabCreator: creatorId === user.id });
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

export default router;
