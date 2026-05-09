import { Router } from "express";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  labCases,
  organizationConnections,
  organizationInvites,
  organizationJoinRequests,
  organizationMemberships,
  organizations,
  users,
} from "@workspace/db";
import { generateInviteToken } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { HttpError, ok } from "../lib/http";
import { sendInviteEmail } from "../lib/mail";
import {
  assertCustomAccountNumberAvailable,
  generateProviderAccountNumber,
} from "../lib/provider-account-number";
import { ADMIN_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";

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
  isActive: z.boolean().optional(),
  // Doctor name is used (alongside the address) to derive the auto account
  // number when the lab admin doesn't supply one. It's optional and not
  // persisted on the org row directly — it just feeds the derivation.
  doctorName: z.string().optional(),
  // Optional caller-supplied account number override. When present, must be
  // unique within the parent lab.
  accountNumber: z.string().optional(),
  // Optional explicit parent lab; falls back to the caller's primary lab
  // membership if omitted. Provider orgs only.
  parentLabOrganizationId: z.string().optional(),
});

// PATCH does not allow changing the parent lab — that would silently move a
// practice between labs and re-key its account-number namespace.
const updateOrgSchema = createOrgSchema
  .omit({ type: true, parentLabOrganizationId: true, doctorName: true })
  .partial();

async function findCallerPrimaryLabId(userId: string): Promise<string | null> {
  const memberships = await db.query.organizationMemberships.findMany({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.status, "active")
    ),
  });
  if (memberships.length === 0) return null;
  const orgIds = memberships.map((m) => m.labId);
  const orgs = await db
    .select()
    .from(organizations)
    .where(inArray(organizations.id, orgIds));
  const labOrg = orgs.find((o) => o.type === "lab");
  return labOrg?.id ?? null;
}

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

async function repairLabCaseAffiliations(labId: string): Promise<void> {
  const [org, activeMembers] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(organizations.id, labId) }),
    db.select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.labId, labId),
          eq(organizationMemberships.status, "active")
        )
      ),
  ]);
  if (!org || activeMembers.length === 0) return;

  const memberUserIds = activeMembers.map((m) => m.userId);
  const caseRows = await db.select().from(labCases)
    .where(inArray(labCases.ownerId, memberUserIds));
  if (caseRows.length === 0) return;

  const orgAffiliationKey = `org:${labId}`;
  const orgAffiliationName = org.displayName || org.name || null;

  const repairPromises: Promise<any>[] = [];
  for (const row of caseRows) {
    if (!row.caseData) continue;
    let caseData: any;
    try {
      caseData = JSON.parse(row.caseData);
    } catch {
      continue;
    }
    const existingKey: string | undefined = caseData.affiliationKey;
    const needsRepair =
      !existingKey ||
      existingKey.startsWith("private:") ||
      (!existingKey.startsWith("org:") && !existingKey.startsWith("lab:"));
    if (!needsRepair) continue;

    const repairedData = {
      ...caseData,
      affiliationKey: orgAffiliationKey,
      affiliationName: orgAffiliationName,
    };
    repairPromises.push(
      db
        .insert(labCases)
        .values({
          id: row.id,
          ownerId: row.ownerId,
          caseData: JSON.stringify(repairedData),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: labCases.id,
          set: {
            caseData: JSON.stringify(repairedData),
            updatedAt: new Date(),
          },
        })
    );
  }
  if (repairPromises.length > 0) {
    await Promise.all(repairPromises);
  }
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
    const callerId = (req as any).auth.userId;

    let parentLabOrganizationId: string | null = null;
    let accountNumber: string | null = null;

    if (input.type === "provider") {
      // Resolve the parent lab. Either supplied explicitly (and the caller
      // must be an admin of that lab) or inferred from the caller's primary
      // lab membership.
      if (input.parentLabOrganizationId) {
        await requireAnyRole(
          callerId,
          input.parentLabOrganizationId,
          ADMIN_ROLES
        );
        parentLabOrganizationId = input.parentLabOrganizationId;
      } else {
        parentLabOrganizationId = await findCallerPrimaryLabId(callerId);
      }

      if (parentLabOrganizationId) {
        if (input.accountNumber && input.accountNumber.trim()) {
          accountNumber = await assertCustomAccountNumberAvailable(
            parentLabOrganizationId,
            input.accountNumber,
            null
          );
        } else {
          accountNumber = await generateProviderAccountNumber(
            parentLabOrganizationId,
            {
              addressLine1: input.addressLine1 ?? null,
              doctorName: input.doctorName ?? null,
              practiceName: input.displayName || input.name,
            }
          );
        }
      }
    }

    const {
      doctorName: _doctorName,
      accountNumber: _accountNumberInput,
      parentLabOrganizationId: _parentLabInput,
      ...persistableInput
    } = input;

    const [organization] = await db
      .insert(organizations)
      .values({
        ...persistableInput,
        parentLabOrganizationId,
        accountNumber,
        createdByUserId: callerId,
      })
      .returning();

    await db.insert(organizationMemberships).values({
      labId: organization.id,
      userId: callerId,
      role: "owner",
      status: "active",
      approvedByUserId: callerId,
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
    const inviterIds = [...new Set(invites.map((invite) => invite.invitedByUserId))].filter(
      (id): id is string => id !== null
    );

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
        invitedByUser: invitersById.get(invite.invitedByUserId as string)
          ? {
              id: invitersById.get(invite.invitedByUserId as string)!.id,
              username: invitersById.get(invite.invitedByUserId as string)!.username,
              email: invitersById.get(invite.invitedByUserId as string)!.email,
            }
          : null,
      }))
    );
  })
);

// NOTE: must be declared before the dynamic GET /:organizationId route below,
// otherwise Express will match "/connections" as an organization id.
router.get(
  "/connections",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const labFilter = req.query.labOrganizationId as string | undefined;
    const providerFilter = req.query.providerOrganizationId as
      | string
      | undefined;

    const memberships = await db.query.organizationMemberships.findMany({
      where: and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active")
      ),
    });
    const memberOrgIds = memberships.map((m) => m.labId);
    if (memberOrgIds.length === 0) return ok(res, []);

    const allConnections =
      await db.query.organizationConnections.findMany({});
    let connections = allConnections.filter(
      (c) =>
        memberOrgIds.includes(c.labOrganizationId) ||
        memberOrgIds.includes(c.providerOrganizationId)
    );
    if (labFilter)
      connections = connections.filter(
        (c) => c.labOrganizationId === labFilter
      );
    if (providerFilter)
      connections = connections.filter(
        (c) => c.providerOrganizationId === providerFilter
      );

    const orgIds = [
      ...new Set(
        connections.flatMap((c) => [
          c.labOrganizationId,
          c.providerOrganizationId,
        ])
      ),
    ];
    const orgs = orgIds.length
      ? await db
          .select()
          .from(organizations)
          .where(inArray(organizations.id, orgIds))
      : [];
    const orgsById = new Map(orgs.map((o) => [o.id, o]));

    return ok(
      res,
      connections.map((c) => ({
        ...c,
        labOrganization: orgsById.get(c.labOrganizationId) ?? null,
        providerOrganization:
          orgsById.get(c.providerOrganizationId) ?? null,
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
    const input = updateOrgSchema.parse(req.body);

    const existing = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!existing) throw new HttpError(404, "Organization not found.");

    // If the caller is changing the account number, validate format and
    // lab-scoped uniqueness. We only allow this for orgs that have a parent
    // lab (i.e. provider orgs created under a lab); other orgs ignore the
    // field on PATCH.
    let nextAccountNumber: string | null | undefined = undefined;
    if (input.accountNumber !== undefined) {
      if (!existing.parentLabOrganizationId) {
        throw new HttpError(
          400,
          "Account numbers are only supported on provider practices created under a lab."
        );
      }
      const trimmed = (input.accountNumber ?? "").trim();
      if (!trimmed) {
        nextAccountNumber = null;
      } else if (trimmed === existing.accountNumber) {
        nextAccountNumber = existing.accountNumber;
      } else {
        nextAccountNumber = await assertCustomAccountNumberAvailable(
          existing.parentLabOrganizationId,
          trimmed,
          existing.id
        );
      }
    }

    const { accountNumber: _accountNumberInput, ...rest } = input;
    const updateValues: Record<string, unknown> = { ...rest };
    if (nextAccountNumber !== undefined) {
      updateValues.accountNumber = nextAccountNumber;
    }

    const [updated] = await db
      .update(organizations)
      .set(updateValues)
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

    try {
      const [organization, inviter] = await Promise.all([
        db.query.organizations.findFirst({
          where: eq(organizations.id, organizationId),
        }),
        db.query.users.findFirst({
          where: eq(users.id, (req as any).auth.userId),
        }),
      ]);
      const inviterName = inviter
        ? [inviter.firstName, inviter.lastName]
            .filter((part) => !!part && String(part).trim().length > 0)
            .join(" ")
            .trim() || inviter.username || inviter.email || null
        : null;
      const result = await sendInviteEmail({
        to: invite.email!,
        organizationName:
          organization?.displayName?.trim() ||
          organization?.name ||
          "your organization",
        roleToAssign: invite.roleToAssign!,
        token: invite.token!,
        inviterName,
        expiresAt: invite.expiresAt ?? null,
      });
      if (!result.sent) {
        req.log.warn(
          { inviteId: invite.id, reason: result.reason },
          "invite email not sent"
        );
      }
    } catch (err: any) {
      req.log.error(
        { err: err?.message || String(err), inviteId: invite.id },
        "invite email failed"
      );
    }

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
  "/invites/:inviteId/cancel",
  asyncHandler(async (req, res) => {
    const invite = await db.query.organizationInvites.findFirst({
      where: eq(organizationInvites.id, req.params.inviteId),
    });

    if (!invite) {
      throw new HttpError(404, "Invite not found.");
    }
    if (invite.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot cancel an invite that is already ${invite.status}.`
      );
    }

    await requireAnyRole(
      (req as any).auth.userId,
      invite.labId,
      ADMIN_ROLES
    );

    const [updatedInvite] = await db
      .update(organizationInvites)
      .set({ status: "revoked" })
      .where(eq(organizationInvites.id, invite.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: invite.labId,
      action: "organization_invite_cancelled",
      entityType: "organization_invite",
      entityId: invite.id,
      beforeJson: invite,
      afterJson: updatedInvite,
    });

    return ok(res, { ...updatedInvite, organizationId: updatedInvite.labId });
  })
);

router.post(
  "/invites/:inviteId/resend",
  asyncHandler(async (req, res) => {
    const invite = await db.query.organizationInvites.findFirst({
      where: eq(organizationInvites.id, req.params.inviteId),
    });

    if (!invite) {
      throw new HttpError(404, "Invite not found.");
    }
    if (invite.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot resend an invite that is already ${invite.status}.`
      );
    }
    if (!invite.email || !invite.roleToAssign) {
      throw new HttpError(410, "Invite is invalid or incomplete.");
    }

    await requireAnyRole(
      (req as any).auth.userId,
      invite.labId,
      ADMIN_ROLES
    );

    const expiresInDays = 7;
    const newToken = generateInviteToken();
    const newExpiresAt = new Date(
      Date.now() + expiresInDays * 24 * 60 * 60 * 1000
    );

    const [updatedInvite] = await db
      .update(organizationInvites)
      .set({
        token: newToken,
        expiresAt: newExpiresAt,
        invitedByUserId: (req as any).auth.userId,
      })
      .where(eq(organizationInvites.id, invite.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: invite.labId,
      action: "organization_invite_resent",
      entityType: "organization_invite",
      entityId: invite.id,
      beforeJson: invite,
      afterJson: updatedInvite,
    });

    try {
      const [organization, inviter] = await Promise.all([
        db.query.organizations.findFirst({
          where: eq(organizations.id, invite.labId),
        }),
        db.query.users.findFirst({
          where: eq(users.id, (req as any).auth.userId),
        }),
      ]);
      const inviterName = inviter
        ? [inviter.firstName, inviter.lastName]
            .filter((part) => !!part && String(part).trim().length > 0)
            .join(" ")
            .trim() || inviter.username || inviter.email || null
        : null;
      const result = await sendInviteEmail({
        to: updatedInvite.email!,
        organizationName:
          organization?.displayName?.trim() ||
          organization?.name ||
          "your organization",
        roleToAssign: updatedInvite.roleToAssign!,
        token: updatedInvite.token!,
        inviterName,
        expiresAt: updatedInvite.expiresAt ?? null,
      });
      if (!result.sent) {
        req.log.warn(
          { inviteId: updatedInvite.id, reason: result.reason },
          "invite resend email not sent"
        );
      }
    } catch (err: any) {
      req.log.error(
        { err: err?.message || String(err), inviteId: updatedInvite.id },
        "invite resend email failed"
      );
    }

    return ok(res, { ...updatedInvite, organizationId: updatedInvite.labId });
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
    if (!currentEmail || !invite.email || invite.email.toLowerCase() !== currentEmail) {
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
    if (!invite.roleToAssign || !invite.email)
      throw new HttpError(410, "Invite is invalid or incomplete.");
    if (invite.expiresAt && new Date() > invite.expiresAt)
      throw new HttpError(410, "Invite has expired.");

    const userId = (req as any).auth.userId;
    const currentEmail = (req as any).user.email?.toLowerCase?.().trim?.();

    if (!currentEmail || invite.email.toLowerCase() !== currentEmail) {
      throw new HttpError(403, "This invite does not belong to your account.");
    }

    const assignedRole = invite.roleToAssign;

    await db
      .insert(organizationMemberships)
      .values({
        labId: invite.labId,
        userId,
        role: assignedRole,
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
          role: assignedRole,
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

    await syncUserToOrganization(userId, invite.labId, assignedRole);

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
        where: and(
          eq(organizationJoinRequests.labId, organizationId),
          eq(organizationJoinRequests.status, "pending")
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

    if (request.status === "approved") {
      const existingMembership =
        await db.query.organizationMemberships.findFirst({
          where: and(
            eq(organizationMemberships.labId, request.labId),
            eq(organizationMemberships.userId, request.userId)
          ),
        });
      return ok(res, { membership: existingMembership ?? null, request });
    }
    if (request.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot approve a request that is already ${request.status}.`
      );
    }

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

    await db
      .delete(organizationJoinRequests)
      .where(
        and(
          eq(organizationJoinRequests.labId, request.labId),
          eq(organizationJoinRequests.userId, request.userId),
          eq(organizationJoinRequests.status, "approved"),
          ne(organizationJoinRequests.id, request.id)
        )
      );

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

    repairLabCaseAffiliations(request.labId).catch(() => {});

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

    if (request.status === "rejected") {
      return ok(res, request);
    }
    if (request.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot reject a request that is already ${request.status}.`
      );
    }

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
  "/connections/:connectionId",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        tierName: z.string().max(80).nullable().optional(),
        status: z
          .enum(["pending", "active", "suspended", "rejected"])
          .optional(),
      })
      .parse(req.body);

    const connection = await db.query.organizationConnections.findFirst({
      where: eq(organizationConnections.id, req.params.connectionId),
    });
    if (!connection) throw new HttpError(404, "Connection not found.");

    // Only an admin in the lab side can change the assigned tier or status.
    await requireAnyRole(
      (req as any).auth.userId,
      connection.labOrganizationId,
      ADMIN_ROLES
    );

    const update: Partial<typeof organizationConnections.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.tierName !== undefined) {
      const tn =
        typeof input.tierName === "string" ? input.tierName.trim() : null;
      update.tierName = tn && tn.length > 0 ? tn : null;
    }
    if (input.status !== undefined) update.status = input.status;

    const [updated] = await db
      .update(organizationConnections)
      .set(update)
      .where(eq(organizationConnections.id, connection.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: connection.labOrganizationId,
      action: "organization_connection_updated",
      entityType: "organization_connection",
      entityId: connection.id,
      beforeJson: connection,
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
