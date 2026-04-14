import crypto from "node:crypto";
import { Router } from "express";
import { and, eq, gt, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  joinRequests,
  labMemberships,
  labInvites,
  organizationConnections,
  organizations,
  userSessions,
  users,
  labCases,
  cases,
  caseNotes,
  caseAttachments,
  caseLocations,
  caseEvents,
  caseSubmissionQueue,
  invoices,
  payments,
  auditLogs,
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
        await db.insert(joinRequests).values({
          labId: org.id,
          userId: user.id,
          requestedRole: input.role === "admin" ? "admin" : "user",
          status: "pending",
        });
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
      await db.insert(labMemberships).values({
        labId: org.id,
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
      await db.query.labMemberships.findMany({
        where: eq(
          labMemberships.userId,
          (req as any).auth.userId
        ),
      });
    const orgIds = memberships.map((m: any) => m.labId);
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
        organizationId: m.labId,
        organization: orgs.find((org) => org.id === m.labId) ?? null,
      })),
    });
  })
);

router.get(
  "/users",
  requireAuth,
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
    const isSelf = authUserId === id;
    let isLabAdmin = false;

    if (!isSelf) {
      const adminMemberships = await db.query.labMemberships.findMany({
        where: and(
          eq(labMemberships.userId, authUserId),
          eq(labMemberships.status, "active"),
        ),
      });
      const adminOrgIds = adminMemberships
        .filter(m => ["owner", "admin"].includes(m.role))
        .map(m => m.labId);

      if (adminOrgIds.length > 0) {
        const targetMembership = await db.query.labMemberships.findFirst({
          where: and(
            eq(labMemberships.userId, id),
            eq(labMemberships.status, "active"),
            inArray(labMemberships.labId, adminOrgIds),
          ),
        });
        if (targetMembership) {
          isLabAdmin = true;
        }
      }
    }
    if (!isSelf && !isLabAdmin) {
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

    await db.transaction(async (tx) => {
      await tx.delete(userSessions).where(eq(userSessions.userId, id));
      await tx.delete(labCases).where(eq(labCases.ownerId, id));
      await tx.delete(labMemberships).where(eq(labMemberships.userId, id));
      await tx.delete(joinRequests).where(eq(joinRequests.userId, id));
      await tx.update(labInvites).set({ invitedUserId: null }).where(eq(labInvites.invitedUserId, id));
      await tx.execute(sql`UPDATE lab_invites SET created_by_user_id = NULL WHERE created_by_user_id = ${id}`);
      await tx.delete(organizationConnections).where(eq(organizationConnections.requestedByUserId, id));
      await tx.update(organizationConnections).set({ approvedByUserId: null }).where(eq(organizationConnections.approvedByUserId, id));
      await tx.update(organizations).set({ createdByUserId: null }).where(eq(organizations.createdByUserId, id));
      await tx.execute(sql`UPDATE join_requests SET reviewed_by_user_id = NULL WHERE reviewed_by_user_id = ${id}`);
      await tx.execute(sql`UPDATE cases SET created_by_user_id = NULL WHERE created_by_user_id = ${id}`);
      await tx.execute(sql`UPDATE case_notes SET author_user_id = NULL WHERE author_user_id = ${id}`);
      await tx.execute(sql`UPDATE case_attachments SET uploaded_by_user_id = NULL WHERE uploaded_by_user_id = ${id}`);
      await tx.execute(sql`UPDATE case_locations SET moved_by_user_id = NULL WHERE moved_by_user_id = ${id}`);
      await tx.execute(sql`UPDATE case_submission_queue SET submitted_by_user_id = NULL WHERE submitted_by_user_id = ${id}`);
      await tx.execute(sql`UPDATE case_submission_queue SET reviewed_by_user_id = NULL WHERE reviewed_by_user_id = ${id}`);
      await tx.execute(sql`UPDATE case_events SET actor_user_id = NULL WHERE actor_user_id = ${id}`);
      await tx.execute(sql`UPDATE invoices SET created_by_user_id = NULL WHERE created_by_user_id = ${id}`);
      await tx.execute(sql`UPDATE invoices SET updated_by_user_id = NULL WHERE updated_by_user_id = ${id}`);
      await tx.execute(sql`UPDATE payments SET recorded_by_user_id = NULL WHERE recorded_by_user_id = ${id}`);
      await tx.execute(sql`UPDATE audit_logs SET user_id = NULL WHERE user_id = ${id}`);
      await tx.delete(users).where(eq(users.id, id));
    });

    try {
      await db.insert(auditLogs).values({
        userId: null,
        action: "user_deleted",
        entityType: "user",
        entityId: id,
        ipAddress: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        metadataJson: { deletedUsername: user.username, deletedEmail: user.email },
      });
    } catch {}
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

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.name, labName),
    });

    if (!org) {
      throw new HttpError(404, "Lab not found.");
    }

    if (org.deletedAt) {
      throw new HttpError(400, "Lab is already deleted.");
    }

    const now = new Date();
    const recoverableUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    await db
      .update(organizations)
      .set({
        deletedAt: now,
        recoverableUntil,
        deletedByUserId: user.id,
        isActive: false,
        updatedAt: now,
      })
      .where(eq(organizations.id, org.id));

    await writeAuditLog({
      req,
      userId: user.id,
      action: "lab_soft_deleted",
      entityType: "organization",
      entityId: org.id,
      metadataJson: { labName, organizationId: org.id, recoverableUntil },
    });
    res.json({ success: true, recoverableUntil: recoverableUntil.toISOString() });
  })
);

router.get(
  "/deleted-labs",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const now = new Date();

    const membershipRows = await db
      .select({
        org: organizations,
        role: labMemberships.role,
      })
      .from(labMemberships)
      .innerJoin(organizations, eq(labMemberships.labId, organizations.id))
      .where(
        and(
          eq(labMemberships.userId, user.id),
          eq(labMemberships.status, "active"),
          isNotNull(organizations.deletedAt)
        )
      );

    const deletedLabs = membershipRows
      .filter(
        (row) =>
          ["owner", "admin"].includes(row.role) &&
          row.org.recoverableUntil &&
          new Date(row.org.recoverableUntil) > now
      )
      .map((row) => ({
        id: row.org.id,
        name: row.org.name,
        displayName: row.org.displayName,
        deletedAt: row.org.deletedAt,
        recoverableUntil: row.org.recoverableUntil,
        role: row.role,
      }));

    res.json({ deletedLabs });
  })
);

router.post(
  "/restore-lab/:labId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const { labId } = req.params;
    const now = new Date();

    const membership = await db.query.labMemberships.findFirst({
      where: and(
        eq(labMemberships.userId, user.id),
        eq(labMemberships.labId, labId),
        eq(labMemberships.status, "active")
      ),
    });

    if (!membership || !["owner", "admin"].includes(membership.role)) {
      throw new HttpError(403, "Forbidden.");
    }

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, labId),
    });

    if (!org) {
      throw new HttpError(404, "Lab not found.");
    }

    if (!org.deletedAt) {
      throw new HttpError(400, "Lab is not deleted.");
    }

    if (org.recoverableUntil && new Date(org.recoverableUntil) < now) {
      throw new HttpError(400, "Recovery window has expired.");
    }

    await db
      .update(organizations)
      .set({
        deletedAt: null,
        recoverableUntil: null,
        deletedByUserId: null,
        isActive: true,
        updatedAt: now,
      })
      .where(eq(organizations.id, labId));

    await writeAuditLog({
      req,
      userId: user.id,
      action: "lab_restored",
      entityType: "organization",
      entityId: org.id,
      metadataJson: { labName: org.name },
    });

    res.json({ success: true, lab: { id: org.id, name: org.name } });
  })
);

export default router;
