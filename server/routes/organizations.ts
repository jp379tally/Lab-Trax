import { Router } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  organizationConnections,
  labInvites,
  joinRequests,
  labMemberships,
  organizations,
  users,
} from "../../shared/schema";
import { writeAuditLog } from "../lib/audit";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middleware/async-handler";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

function orgDisplayName(org: { displayName?: string | null; name: string }): string {
  return org.displayName || org.name;
}

function orgAddress(org: { addressLine1?: string | null; city?: string | null; state?: string | null; zip?: string | null }): string | null {
  const parts = [org.addressLine1, org.city, org.state, org.zip].filter(Boolean) as string[];
  return parts.length ? parts.join(", ") : null;
}

async function syncUserToOrg(
  userId: string,
  org: { displayName?: string | null; name: string; phone?: string | null; addressLine1?: string | null; city?: string | null; state?: string | null; zip?: string | null },
  role?: string
) {
  const updateSet: Record<string, any> = {
    practiceName: orgDisplayName(org),
    practiceAddress: orgAddress(org),
    practicePhone: org.phone ?? null,
  };
  if (role !== undefined) {
    updateSet.role = role === "owner" || role === "admin" ? "admin" : "user";
  }
  await db.update(users).set(updateSet).where(eq(users.id, userId));
}

async function syncAllMembersToOrg(org: any) {
  const memberships = await db.query.labMemberships.findMany({
    where: and(eq(labMemberships.labId, org.id), eq(labMemberships.status, "active")),
  });
  for (const m of memberships) {
    await syncUserToOrg(m.userId, org, m.role);
  }
}

async function clearUserOrgSync(userId: string) {
  const remaining = await db.query.labMemberships.findMany({
    where: and(eq(labMemberships.userId, userId), eq(labMemberships.status, "active")),
  });
  if (remaining.length === 0) {
    await db.update(users)
      .set({ practiceName: null, practiceAddress: null, practicePhone: null, role: "user" })
      .where(eq(users.id, userId));
  } else {
    const primary = remaining[0];
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, primary.labId) });
    if (org) await syncUserToOrg(userId, org, primary.role);
  }
}

const createOrgSchema = z.object({
  type: z.enum(["lab", "provider"]),
  name: z.string().min(1),
  displayName: z.string().optional(),
  billingEmail: z.string().email().optional(),
  phone: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
});

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createOrgSchema.parse(req.body);

    const [organization] = await db
      .insert(organizations)
      .values({
        ...input,
        createdByUserId: (req as any).auth.userId,
      })
      .returning();

    await db.insert(labMemberships).values({
      labId: organization.id,
      userId: (req as any).auth.userId,
      role: "owner",
      status: "active",
    });

    await syncUserToOrg((req as any).auth.userId, organization, "owner");

    await writeAuditLog({
      req,
      organizationId: organization.id,
      action: "organization_created",
      entityType: "organization",
      entityId: organization.id,
      afterJson: organization,
    });

    return ok(res, organization, 201);
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const memberships =
      await db.query.labMemberships.findMany({
        where: eq(
          labMemberships.userId,
          (req as any).auth.userId
        ),
      });
    const orgIds = memberships
      .filter((m: any) => m.status === "active")
      .map((m: any) => m.labId);
    const orgs = orgIds.length
      ? await db
          .select()
          .from(organizations)
          .where(and(inArray(organizations.id, orgIds), isNull(organizations.deletedAt)))
      : [];
    return ok(res, orgs);
  })
);

router.get(
  "/my-invites",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const invites = await db.query.labInvites.findMany({
      where: and(
        eq(labInvites.invitedUserId, userId),
        eq(labInvites.status, "pending")
      ),
    });
    const enriched = await Promise.all(
      invites.map(async (inv) => {
        const org = await db.query.organizations.findFirst({
          where: eq(organizations.id, inv.labId),
        });
        const creator = inv.createdByUserId
          ? await db.query.users.findFirst({
              where: eq(users.id, inv.createdByUserId),
            })
          : null;
        return {
          ...inv,
          organizationName: org?.displayName || org?.name || "Unknown Lab",
          inviterUsername: creator?.username || "Admin",
        };
      })
    );
    return ok(res, enriched);
  })
);

router.get(
  "/my-join-requests",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const requests = await db.query.joinRequests.findMany({
      where: eq(joinRequests.userId, userId),
    });
    return ok(res, requests);
  })
);

router.get(
  "/:organizationId",
  asyncHandler(async (req, res) => {
    await requireMembership(
      (req as any).auth.userId,
      req.params.organizationId
    );
    const organization = await db.query.organizations.findFirst({
      where: eq(organizations.id, req.params.organizationId),
    });
    if (!organization) throw new HttpError(404, "Organization not found.");
    return ok(res, organization);
  })
);

router.patch(
  "/:organizationId",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireAnyRole(
      (req as any).auth.userId,
      organizationId,
      ADMIN_ROLES
    );
    const input = createOrgSchema.partial().parse(req.body);

    const existing = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!existing) throw new HttpError(404, "Organization not found.");

    const [updated] = await db
      .update(organizations)
      .set(input)
      .where(eq(organizations.id, organizationId))
      .returning();

    await syncAllMembersToOrg(updated);

    await writeAuditLog({
      req,
      organizationId,
      action: "organization_updated",
      entityType: "organization",
      entityId: organizationId,
      beforeJson: existing,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

router.get(
  "/:organizationId/members",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireMembership(
      (req as any).auth.userId,
      organizationId
    );

    const memberships =
      await db.query.labMemberships.findMany({
        where: eq(
          labMemberships.labId,
          organizationId
        ),
      });
    const userIds = memberships.map((m: any) => m.userId);
    const allUsers = userIds.length
      ? await db.query.users.findMany({
          where: inArray(users.id, userIds),
        })
      : [];

    return ok(
      res,
      memberships.map((membership: any) => {
        const u = allUsers.find((user) => user.id === membership.userId);
        return {
          ...membership,
          user: u
            ? {
                id: u.id,
                username: u.username,
                email: u.email,
                firstName: u.firstName,
                lastName: u.lastName,
                initials: u.initials,
              }
            : null,
        };
      })
    );
  })
);

const inviteSchema = z.object({
  invitedUserId: z.string().min(1),
  invitedPhone: z.string().optional(),
  role: z.enum(["admin", "user", "billing", "read_only"]),
});

router.post(
  "/:organizationId/invites",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireAnyRole(
      (req as any).auth.userId,
      organizationId,
      ADMIN_ROLES
    );

    let input: z.infer<typeof inviteSchema>;
    if (req.body.email) {
      const targetUser = await db.query.users.findFirst({
        where: eq(users.email, req.body.email.toLowerCase()),
      });
      input = inviteSchema.parse({
        invitedUserId: targetUser?.id || req.body.email,
        invitedPhone: req.body.phone,
        role: req.body.roleToAssign || req.body.role || "user",
      });
    } else {
      input = inviteSchema.parse(req.body);
    }

    const [invite] = await db
      .insert(labInvites)
      .values({
        labId: organizationId,
        invitedUserId: input.invitedUserId,
        invitedPhone: input.invitedPhone ?? null,
        role: input.role,
        createdByUserId: (req as any).auth.userId,
      })
      .returning();

    await writeAuditLog({
      req,
      organizationId,
      action: "lab_invite_created",
      entityType: "lab_invite",
      entityId: invite.id,
      afterJson: invite,
    });
    return ok(res, invite, 201);
  })
);

router.get(
  "/:organizationId/invites",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireAnyRole(
      (req as any).auth.userId,
      organizationId,
      ADMIN_ROLES
    );
    const invites = await db.query.labInvites.findMany({
      where: eq(labInvites.labId, organizationId),
    });
    return ok(res, invites);
  })
);

router.post(
  "/invites/:inviteId/accept",
  asyncHandler(async (req, res) => {
    const invite = await db.query.labInvites.findFirst({
      where: and(
        eq(labInvites.id, req.params.inviteId),
        eq(labInvites.status, "pending")
      ),
    });
    if (!invite) throw new HttpError(404, "Invite not found or already used.");

    const userId = (req as any).auth.userId;
    if (invite.invitedUserId && invite.invitedUserId !== userId) {
      throw new HttpError(403, "This invitation was sent to a different user.");
    }

    await db
      .insert(labMemberships)
      .values({
        labId: invite.labId,
        userId,
        role: invite.role,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [
          labMemberships.labId,
          labMemberships.userId,
        ],
        set: {
          role: invite.role,
          status: "active",
        },
      });

    await db
      .update(labInvites)
      .set({
        status: "accepted",
        respondedAt: new Date(),
      })
      .where(eq(labInvites.id, invite.id));

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, invite.labId),
    });
    if (org) {
      await syncUserToOrg(userId, org, invite.role);
    }

    await writeAuditLog({
      req,
      organizationId: invite.labId,
      action: "lab_invite_accepted",
      entityType: "lab_invite",
      entityId: invite.id,
    });

    return ok(res, { accepted: true });
  })
);

router.post(
  "/invites/:inviteId/reject",
  asyncHandler(async (req, res) => {
    const invite = await db.query.labInvites.findFirst({
      where: and(
        eq(labInvites.id, req.params.inviteId),
        eq(labInvites.status, "pending")
      ),
    });
    if (!invite) throw new HttpError(404, "Invite not found or already used.");

    const userId = (req as any).auth.userId;
    if (invite.invitedUserId && invite.invitedUserId !== userId) {
      throw new HttpError(403, "This invitation was sent to a different user.");
    }

    await db
      .update(labInvites)
      .set({
        status: "rejected",
        respondedAt: new Date(),
      })
      .where(eq(labInvites.id, invite.id));

    await writeAuditLog({
      req,
      organizationId: invite.labId,
      action: "lab_invite_rejected",
      entityType: "lab_invite",
      entityId: invite.id,
    });

    return ok(res, { rejected: true });
  })
);

const joinRequestSchema = z.object({
  requestedRole: z
    .enum(["admin", "user", "billing", "read_only"])
    .default("user"),
  message: z.string().max(1000).optional(),
});

router.post(
  "/:organizationId/join-requests",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    const input = joinRequestSchema.parse(req.body);

    const alreadyMember =
      await db.query.labMemberships.findFirst({
        where: and(
          eq(labMemberships.labId, organizationId),
          eq(
            labMemberships.userId,
            (req as any).auth.userId
          )
        ),
      });
    if (alreadyMember)
      throw new HttpError(
        409,
        "You already have a membership record for this organization."
      );

    const existingPending =
      await db.query.joinRequests.findFirst({
        where: and(
          eq(joinRequests.labId, organizationId),
          eq(joinRequests.userId, (req as any).auth.userId),
          eq(joinRequests.status, "pending")
        ),
      });
    if (existingPending)
      throw new HttpError(
        409,
        "You already have a pending join request for this lab."
      );

    const [request] = await db
      .insert(joinRequests)
      .values({
        labId: organizationId,
        userId: (req as any).auth.userId,
        requestedRole: input.requestedRole,
        message: input.message ?? null,
      })
      .returning();

    await writeAuditLog({
      req,
      organizationId,
      action: "join_request_created",
      entityType: "join_request",
      entityId: request.id,
      afterJson: request,
    });
    return ok(res, request, 201);
  })
);

router.get(
  "/:organizationId/join-requests",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireAnyRole(
      (req as any).auth.userId,
      organizationId,
      ADMIN_ROLES
    );
    const requests =
      await db.query.joinRequests.findMany({
        where: eq(
          joinRequests.labId,
          organizationId
        ),
      });
    return ok(res, requests);
  })
);

router.post(
  "/join-requests/:joinRequestId/approve",
  asyncHandler(async (req, res) => {
    const request =
      await db.query.joinRequests.findFirst({
        where: eq(
          joinRequests.id,
          req.params.joinRequestId
        ),
      });
    if (!request) throw new HttpError(404, "Join request not found.");

    await requireAnyRole(
      (req as any).auth.userId,
      request.labId,
      ADMIN_ROLES
    );

    const roleToAssign = req.body.role || request.requestedRole;

    const [membership] = await db
      .insert(labMemberships)
      .values({
        labId: request.labId,
        userId: request.userId,
        role: roleToAssign,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [
          labMemberships.labId,
          labMemberships.userId,
        ],
        set: {
          role: roleToAssign,
          status: "active",
        },
      })
      .returning();

    const [updatedRequest] = await db
      .update(joinRequests)
      .set({
        status: "approved",
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(joinRequests.id, request.id))
      .returning();

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, request.labId),
    });
    if (org) {
      await syncUserToOrg(request.userId, org, roleToAssign);
    }

    await writeAuditLog({
      req,
      organizationId: request.labId,
      action: "join_request_approved",
      entityType: "join_request",
      entityId: request.id,
      afterJson: updatedRequest,
    });
    return ok(res, { membership, request: updatedRequest });
  })
);

router.post(
  "/join-requests/:joinRequestId/reject",
  asyncHandler(async (req, res) => {
    const request =
      await db.query.joinRequests.findFirst({
        where: eq(
          joinRequests.id,
          req.params.joinRequestId
        ),
      });
    if (!request) throw new HttpError(404, "Join request not found.");
    await requireAnyRole(
      (req as any).auth.userId,
      request.labId,
      ADMIN_ROLES
    );

    const [updated] = await db
      .update(joinRequests)
      .set({
        status: "rejected",
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(joinRequests.id, request.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: request.labId,
      action: "join_request_rejected",
      entityType: "join_request",
      entityId: request.id,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

const connectionSchema = z.object({
  labOrganizationId: z.string().uuid(),
  providerOrganizationId: z.string().uuid(),
});

router.post(
  "/connections",
  asyncHandler(async (req, res) => {
    const input = connectionSchema.parse(req.body);
    const isLabMember = await requireMembership(
      (req as any).auth.userId,
      input.labOrganizationId
    ).catch(() => null);
    const isProviderMember = await requireMembership(
      (req as any).auth.userId,
      input.providerOrganizationId
    ).catch(() => null);
    if (!isLabMember && !isProviderMember)
      throw new HttpError(
        403,
        "You must belong to one side of the connection request."
      );

    const [connection] = await db
      .insert(organizationConnections)
      .values({
        labOrganizationId: input.labOrganizationId,
        providerOrganizationId: input.providerOrganizationId,
        requestedByOrgId: isLabMember
          ? input.labOrganizationId
          : input.providerOrganizationId,
        requestedByUserId: (req as any).auth.userId,
      })
      .onConflictDoNothing()
      .returning();

    return ok(
      res,
      connection ?? { alreadyExists: true },
      connection ? 201 : 200
    );
  })
);

router.post(
  "/connections/:connectionId/approve",
  asyncHandler(async (req, res) => {
    const connection =
      await db.query.organizationConnections.findFirst({
        where: eq(
          organizationConnections.id,
          req.params.connectionId
        ),
      });
    if (!connection)
      throw new HttpError(404, "Connection not found.");

    const targetOrgId =
      connection.requestedByOrgId === connection.labOrganizationId
        ? connection.providerOrganizationId
        : connection.labOrganizationId;
    await requireAnyRole(
      (req as any).auth.userId,
      targetOrgId,
      ADMIN_ROLES
    );

    const [updated] = await db
      .update(organizationConnections)
      .set({
        status: "active",
        approvedByUserId: (req as any).auth.userId,
        approvedAt: new Date(),
      })
      .where(eq(organizationConnections.id, connection.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: targetOrgId,
      action: "organization_connection_approved",
      entityType: "organization_connection",
      entityId: connection.id,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

router.patch(
  "/memberships/:membershipId",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        role: z
          .enum(["owner", "admin", "user", "billing", "read_only"])
          .optional(),
        status: z
          .enum(["active", "suspended"])
          .optional(),
      })
      .parse(req.body);

    const membership =
      await db.query.labMemberships.findFirst({
        where: eq(
          labMemberships.id,
          req.params.membershipId
        ),
      });
    if (!membership) throw new HttpError(404, "Membership not found.");
    await requireAnyRole(
      (req as any).auth.userId,
      membership.labId,
      ADMIN_ROLES
    );

    const [updated] = await db
      .update(labMemberships)
      .set(input)
      .where(eq(labMemberships.id, membership.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: membership.labId,
      action: "membership_updated",
      entityType: "lab_membership",
      entityId: membership.id,
      beforeJson: membership,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

router.post(
  "/:organizationId/leave",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const { organizationId } = req.params;

    const membership = await db.query.labMemberships.findFirst({
      where: and(
        eq(labMemberships.labId, organizationId),
        eq(labMemberships.userId, userId),
        eq(labMemberships.status, "active")
      ),
    });
    if (!membership) throw new HttpError(404, "No active membership in this lab.");

    await db.delete(labMemberships).where(eq(labMemberships.id, membership.id));
    await clearUserOrgSync(userId);

    await writeAuditLog({
      req,
      organizationId,
      action: "membership_removed",
      entityType: "lab_membership",
      entityId: membership.id,
      beforeJson: membership,
    });
    return ok(res, { removed: true });
  })
);

router.delete(
  "/memberships/:membershipId",
  asyncHandler(async (req, res) => {
    const membership =
      await db.query.labMemberships.findFirst({
        where: eq(
          labMemberships.id,
          req.params.membershipId
        ),
      });
    if (!membership) throw new HttpError(404, "Membership not found.");

    const isOwnMembership =
      membership.userId === (req as any).auth.userId;
    if (!isOwnMembership) {
      await requireAnyRole(
        (req as any).auth.userId,
        membership.labId,
        ADMIN_ROLES
      );
    }

    await db
      .delete(labMemberships)
      .where(eq(labMemberships.id, membership.id));

    await clearUserOrgSync(membership.userId);

    await writeAuditLog({
      req,
      organizationId: membership.labId,
      action: "membership_removed",
      entityType: "lab_membership",
      entityId: membership.id,
      beforeJson: membership,
    });
    return ok(res, { removed: true });
  })
);

export default router;
