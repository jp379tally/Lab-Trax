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

    const initials =
      input.firstName && input.lastName
        ? (input.firstName[0] + input.lastName[0]).toUpperCase()
        : input.username.slice(0, 2).toUpperCase();

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
        role: input.role || "user",
        licenseNumber: input.licenseNumber || null,
        practiceName: input.practiceName || null,
        doctorName: input.doctorName || null,
        practiceAddress: input.practiceAddress || null,
        practicePhone: input.practicePhone || null,
        phoneContactName: input.phoneContactName || null,
        accountNumber: input.accountNumber || null,
        wantsUpdates: input.wantsUpdates || false,
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
        await db
          .update(users)
          .set({ practiceName: org.displayName || org.name })
          .where(eq(users.id, user.id));
        organizationInfo = { id: org.id, name: org.displayName || org.name };
        pendingJoinRequest = true;
        responseMessage = `Your request to join ${org.displayName || org.name} has been sent to the lab admin.`;
      }
    } else if (
      input.createOrganization &&
      input.practiceName?.trim() &&
      (input.userType === "lab" || input.userType === "provider")
    ) {
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
      });
      organizationInfo = { id: org.id, name: org.displayName || org.name };
      responseMessage = `${org.displayName || org.name} created and linked to your account.`;
    }

    return res.json({
      success: true,
      accessToken,
      refreshToken: rawRefreshToken,
      user: safeUser(user),
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

    return res.json({
      success: true,
      accessToken,
      refreshToken: rawRefreshToken,
      user: safeUser(user),
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

    return res.json({
      success: true,
      user: safeUser(user),
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
    res.json({
      users: allUsers.map((u) => safeUser(u)),
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

export default router;
