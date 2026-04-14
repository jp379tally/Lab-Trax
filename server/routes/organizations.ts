import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  organizationConnections,
  organizationInvites,
  organizationJoinRequests,
  organizationMemberships,
  organizations,
  users,
} from "../../shared/schema";
import { generateInviteToken } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middleware/async-handler";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

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

function mapMembershipRoleToUserRole(role?: string | null): "admin" | "user" {
  return role === "owner" || role === "admin" ? "admin" : "user";
}

function getOrganizationDisplayName(organization: any): string {
  return organization.displayName || organization.name;
}

function getOrganizationAddress(organization: any): string | null {
  const address = [
    organization.addressLine1,
    organization.addressLine2,
    organization.city,
    organization.state,
    organization.zip,
  ]
    .filter(Boolean)
    .join(", ");

  return address || null;
}

async function syncUserToOrganization(
  userId: string,
  organizationId: string,
  membershipRole?: string | null
) {
  const organization = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });

  if (!organization) {
    return null;
  }

  await db
    .update(users)
    .set({
      practiceName: getOrganizationDisplayName(organization),
      practiceAddress: getOrganizationAddress(organization),
      practicePhone: organization.phone || null,
      role: mapMembershipRoleToUserRole(membershipRole),
    })
    .where(eq(users.id, userId));

  return organization;
}

async function syncUsersToOrganization(organizationId: string, organization?: any) {
  const resolvedOrganization =
    organization ||
    (await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    }));

  if (!resolvedOrganization) {
    return;
  }

  const memberships = await db.query.organizationMemberships.findMany({
    where: and(
      eq(organizationMemberships.labId, organizationId),
      eq(organizationMemberships.status, "active")
    ),
  });

  for (const membership of memberships) {
    await db
      .update(users)
      .set({
        practiceName: getOrganizationDisplayName(resolvedOrganization),
        practiceAddress: getOrganizationAddress(resolvedOrganization),
        practicePhone: resolvedOrganization.phone || null,
        role: mapMembershipRoleToUserRole(membership.role),
      })
      .where(eq(users.id, membership.userId));
  }
}

async function syncUserFromActiveMemberships(userId: string) {
  const memberships = await db.query.organizationMemberships.findMany({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.status, "active")
    ),
  });

  if (memberships.length === 0) {
    await db
      .update(users)
      .set({
        practiceName: null,
        practiceAddress: null,
        practicePhone: null,
        role: "user",
      })
      .where(eq(users.id, userId));
    return;
  }

  const primaryMembership = memberships[0];
  await syncUserToOrganization(
    userId,
    primaryMembership.labId,
    primaryMembership.role
  );
}

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

    await db.insert(organizationMemberships).values({
      labId: organization.id,
      userId: (req as any).auth.userId,
      role: "owner",
      status: "active",
      approvedByUserId: (req as any).auth.userId,
      joinedAt: new Date(),
    });

    await syncUserToOrganization(
      (req as any).auth.userId,
      organization.id,
      "owner"
    );

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
      await db.query.organizationMemberships.findMany({
        where: eq(
          organizationMemberships.userId,
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
          .where(inArray(organizations.id, orgIds))
      : [];
    return ok(res, orgs);
  })
);

router.get(
  "/invites/pending-for-me",
  asyncHandler(async (req, res) => {
    const currentEmail = (req as any).user.email?.toLowerCase?.().trim?.();
    if (!currentEmail) {
      return ok(res, []);
    }

    const invites = await db.query.organizationInvites.findMany({
      where: and(
        eq(organizationInvites.email, currentEmail),
        eq(organizationInvites.status, "pending")
      ),
    });

    const organizationIds = [...new Set(invites.map((invite) => invite.labId))];
    const inviterIds = [...new Set(invites.map((invite) => invite.invitedByUserId))];

    const inviteOrganizations = organizationIds.length
      ? await db
          .select()
          .from(organizations)
          .where(inArray(organizations.id, organizationIds))
      : [];
    const inviters = inviterIds.length
      ? await db.select().from(users).where(inArray(users.id, inviterIds))
      : [];

    const organizationsById = new Map(
      inviteOrganizations.map((organization) => [organization.id, organization])
    );
    const invitersById = new Map(inviters.map((inviter) => [inviter.id, inviter]));

    return ok(
      res,
      invites.map((invite) => ({
        ...invite,
        organizationId: invite.labId,
        organization: organizationsById.get(invite.labId) ?? null,
        invitedByUser: invitersById.get(invite.invitedByUserId)
          ? {
              id: invitersById.get(invite.invitedByUserId)!.id,
              username: invitersById.get(invite.invitedByUserId)!.username,
              email: invitersById.get(invite.invitedByUserId)!.email,
            }
          : null,
      }))
    );
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

    await syncUsersToOrganization(organizationId, updated);

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
      await db.query.organizationMemberships.findMany({
        where: eq(
          organizationMemberships.labId,
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
      memberships.map((membership: any) => ({
        ...membership,
        user: allUsers.find((user) => user.id === membership.userId)
          ? {
              id: allUsers.find((user) => user.id === membership.userId)!.id,
              username: allUsers.find((user) => user.id === membership.userId)!
                .username,
              email: allUsers.find((user) => user.id === membership.userId)!
                .email,
              firstName: allUsers.find((user) => user.id === membership.userId)!
                .firstName,
              lastName: allUsers.find((user) => user.id === membership.userId)!
                .lastName,
              initials: allUsers.find((user) => user.id === membership.userId)!
                .initials,
            }
          : null,
      }))
    );
  })
);

const inviteSchema = z.object({
  email: z.string().email(),
  phone: z.string().optional(),
  roleToAssign: z.enum(["owner", "admin", "user", "billing", "read_only"]),
  expiresInDays: z.coerce.number().int().min(1).max(30).default(7),
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
    const input = inviteSchema.parse(req.body);

    const existingInvite = await db.query.organizationInvites.findFirst({
      where: and(
        eq(organizationInvites.labId, organizationId),
        eq(organizationInvites.email, input.email.toLowerCase()),
        eq(organizationInvites.status, "pending")
      ),
    });

    if (existingInvite) {
      throw new HttpError(409, "A pending invite already exists for that email address.");
    }

    const [invite] = await db
      .insert(organizationInvites)
      .values({
        labId: organizationId,
        email: input.email.toLowerCase(),
        phone: input.phone ?? null,
        roleToAssign: input.roleToAssign,
        token: generateInviteToken(),
        invitedByUserId: (req as any).auth.userId,
        expiresAt: new Date(
          Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000
        ),
      })
      .returning();

    await writeAuditLog({
      req,
      organizationId,
      action: "organization_invite_created",
      entityType: "organization_invite",
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
    const invites = await db.query.organizationInvites.findMany({
      where: eq(organizationInvites.labId, organizationId),
    });
    return ok(res, invites.map((inv) => ({ ...inv, organizationId: inv.labId })));
  })
);

router.post(
  "/invites/:inviteId/decline",
  asyncHandler(async (req, res) => {
    const invite = await db.query.organizationInvites.findFirst({
      where: and(
        eq(organizationInvites.id, req.params.inviteId),
        eq(organizationInvites.status, "pending")
      ),
    });

    if (!invite) {
      throw new HttpError(404, "Invite not found or already handled.");
    }

    const currentEmail = (req as any).user.email?.toLowerCase?.().trim?.();
    if (!currentEmail || invite.email.toLowerCase() !== currentEmail) {
      throw new HttpError(403, "This invite does not belong to your account.");
    }

    const [updatedInvite] = await db
      .update(organizationInvites)
      .set({
        status: "declined",
      })
      .where(eq(organizationInvites.id, invite.id))
      .returning();

    await writeAuditLog({
      req,
      labId: invite.labId,
      action: "organization_invite_declined",
      entityType: "organization_invite",
      entityId: invite.id,
      afterJson: updatedInvite,
    });

    return ok(res, updatedInvite);
  })
);

router.post(
  "/invites/:token/accept",
  asyncHandler(async (req, res) => {
    const invite = await db.query.organizationInvites.findFirst({
      where: and(
        eq(organizationInvites.token, req.params.token),
        eq(organizationInvites.status, "pending")
      ),
    });
    if (!invite) throw new HttpError(404, "Invite not found or already used.");
    if (new Date() > invite.expiresAt)
      throw new HttpError(410, "Invite has expired.");

    const userId = (req as any).auth.userId;
    const currentEmail = (req as any).user.email?.toLowerCase?.().trim?.();

    if (!currentEmail || invite.email.toLowerCase() !== currentEmail) {
      throw new HttpError(403, "This invite does not belong to your account.");
    }

    await db
      .insert(organizationMemberships)
      .values({
        labId: invite.labId,
        userId,
        role: invite.roleToAssign,
        status: "active",
        invitedByUserId: invite.invitedByUserId,
        approvedByUserId: invite.invitedByUserId,
        joinedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          organizationMemberships.labId,
          organizationMemberships.userId,
        ],
        set: {
          role: invite.roleToAssign,
          status: "active",
          invitedByUserId: invite.invitedByUserId,
          joinedAt: new Date(),
        },
      });

    await db
      .update(organizationInvites)
      .set({
        status: "accepted",
        acceptedByUserId: userId,
        acceptedAt: new Date(),
      })
      .where(eq(organizationInvites.id, invite.id));

    await syncUserToOrganization(userId, invite.labId, invite.roleToAssign);

    await writeAuditLog({
      req,
      labId: invite.labId,
      action: "organization_invite_accepted",
      entityType: "organization_invite",
      entityId: invite.id,
    });

    return ok(res, { accepted: true });
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
      await db.query.organizationMemberships.findFirst({
        where: and(
          eq(organizationMemberships.labId, organizationId),
          eq(
            organizationMemberships.userId,
            (req as any).auth.userId
          )
        ),
      });
    if (alreadyMember)
      throw new HttpError(
        409,
        "You already have a membership record for this organization."
      );

    const existingPendingRequest =
      await db.query.organizationJoinRequests.findFirst({
        where: and(
          eq(organizationJoinRequests.labId, organizationId),
          eq(
            organizationJoinRequests.userId,
            (req as any).auth.userId
          ),
          eq(organizationJoinRequests.status, "pending")
        ),
      });

    if (existingPendingRequest) {
      throw new HttpError(409, "You already have a pending join request.");
    }

    const [request] = await db
      .insert(organizationJoinRequests)
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
      action: "organization_join_requested",
      entityType: "organization_join_request",
      entityId: request.id,
      afterJson: request,
    });
    return ok(res, request, 201);
  })
);

router.get(
  "/join-requests/mine/pending",
  asyncHandler(async (req, res) => {
    const currentUserId = (req as any).auth.userId;
    const requests = await db.query.organizationJoinRequests.findMany({
      where: and(
        eq(organizationJoinRequests.userId, currentUserId),
        eq(organizationJoinRequests.status, "pending")
      ),
    });

    const organizationIds = [...new Set(requests.map((request) => request.labId))];
    const requestOrganizations = organizationIds.length
      ? await db
          .select()
          .from(organizations)
          .where(inArray(organizations.id, organizationIds))
      : [];
    const organizationsById = new Map(
      requestOrganizations.map((organization) => [organization.id, organization])
    );

    return ok(
      res,
      requests.map((request) => ({
        ...request,
        organizationId: request.labId,
        requestedByUserId: request.userId,
        organization: organizationsById.get(request.labId) ?? null,
      }))
    );
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
      await db.query.organizationJoinRequests.findMany({
        where: eq(
          organizationJoinRequests.labId,
          organizationId
        ),
      });
    return ok(res, requests.map((r) => ({
      ...r,
      organizationId: r.labId,
      requestedByUserId: r.userId,
    })));
  })
);

router.post(
  "/join-requests/:joinRequestId/approve",
  asyncHandler(async (req, res) => {
    const request =
      await db.query.organizationJoinRequests.findFirst({
        where: eq(
          organizationJoinRequests.id,
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
      .insert(organizationMemberships)
      .values({
        labId: request.labId,
        userId: request.userId,
        role: roleToAssign,
        status: "active",
        approvedByUserId: (req as any).auth.userId,
        joinedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          organizationMemberships.labId,
          organizationMemberships.userId,
        ],
        set: {
          role: roleToAssign,
          status: "active",
          approvedByUserId: (req as any).auth.userId,
          joinedAt: new Date(),
        },
      })
      .returning();

    const [updatedRequest] = await db
      .update(organizationJoinRequests)
      .set({
        status: "approved",
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(organizationJoinRequests.id, request.id))
      .returning();

    await syncUserToOrganization(
      request.userId,
      request.labId,
      roleToAssign
    );

    await writeAuditLog({
      req,
      labId: request.labId,
      action: "organization_join_approved",
      entityType: "organization_join_request",
      entityId: request.id,
      afterJson: updatedRequest,
    });
    return ok(res, { membership, request: updatedRequest });
  })
);

router.delete(
  "/join-requests/:joinRequestId",
  asyncHandler(async (req, res) => {
    const request =
      await db.query.organizationJoinRequests.findFirst({
        where: eq(
          organizationJoinRequests.id,
          req.params.joinRequestId
        ),
      });
    if (!request) throw new HttpError(404, "Join request not found.");

    if (request.userId !== (req as any).auth.userId) {
      throw new HttpError(403, "You can only cancel your own join request.");
    }

    if (request.status !== "pending") {
      throw new HttpError(409, "Only pending join requests can be cancelled.");
    }

    const [updated] = await db
      .update(organizationJoinRequests)
      .set({
        status: "cancelled",
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(organizationJoinRequests.id, request.id))
      .returning();

    await writeAuditLog({
      req,
      labId: request.labId,
      action: "organization_join_cancelled",
      entityType: "organization_join_request",
      entityId: request.id,
      afterJson: updated,
    });

    return ok(res, updated);
  })
);

router.post(
  "/join-requests/:joinRequestId/reject",
  asyncHandler(async (req, res) => {
    const request =
      await db.query.organizationJoinRequests.findFirst({
        where: eq(
          organizationJoinRequests.id,
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
      .update(organizationJoinRequests)
      .set({
        status: "rejected",
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(organizationJoinRequests.id, request.id))
      .returning();

    await writeAuditLog({
      req,
      labId: request.labId,
      action: "organization_join_rejected",
      entityType: "organization_join_request",
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
        userId: (req as any).auth.userId,
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
          .enum(["active", "pending", "invited", "suspended"])
          .optional(),
      })
      .parse(req.body);

    const membership =
      await db.query.organizationMemberships.findFirst({
        where: eq(
          organizationMemberships.id,
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
      .update(organizationMemberships)
      .set(input)
      .where(eq(organizationMemberships.id, membership.id))
      .returning();

    await writeAuditLog({
      req,
      labId: membership.labId,
      action: "membership_updated",
      entityType: "organization_membership",
      entityId: membership.id,
      beforeJson: membership,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

router.delete(
  "/memberships/:membershipId",
  asyncHandler(async (req, res) => {
    const membership =
      await db.query.organizationMemberships.findFirst({
        where: eq(
          organizationMemberships.id,
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
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.id, membership.id));

    await syncUserFromActiveMemberships(membership.userId);

    await writeAuditLog({
      req,
      labId: membership.labId,
      action: "membership_removed",
      entityType: "organization_membership",
      entityId: membership.id,
      beforeJson: membership,
    });
    return ok(res, { removed: true });
  })
);

export default router;
