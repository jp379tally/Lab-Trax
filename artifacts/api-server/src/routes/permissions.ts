import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  labMemberPermissions,
  labPermissionDefinitions,
  organizationMemberships,
} from "@workspace/db";
import { CAPABILITY_KEYS } from "../lib/capabilities";
import { HttpError, ok, wrapDbError } from "../lib/http";
import { requireAnyRole, OWNER_ROLES } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import { writeAuditLog } from "../lib/audit";

const router = Router({ mergeParams: true });
router.use(requireAuth);

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const createDefinitionSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  capabilityKey: z.enum(CAPABILITY_KEYS),
});

const updateDefinitionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  capabilityKey: z.enum(CAPABILITY_KEYS).optional(),
});

const putMemberPermissionsSchema = z.object({
  permissionDefinitionIds: z.array(z.string()).max(50),
});

// ─── Permission definition CRUD ───────────────────────────────────────────────

/**
 * GET /organizations/:orgId/permission-definitions
 * List all permission definitions for a lab (owner-only).
 */
router.get(
  "/:orgId/permission-definitions",
  asyncHandler(async (req, res) => {
    const { orgId } = req.params as { orgId: string };
    const user = (req as any).user as { id: string; role?: string };
    await requireAnyRole(user.id, orgId, OWNER_ROLES);

    const defs = await db.query.labPermissionDefinitions.findMany({
      where: eq(labPermissionDefinitions.labId, orgId),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });

    return ok(res, defs);
  })
);

/**
 * POST /organizations/:orgId/permission-definitions
 * Create a new permission definition (owner-only).
 */
router.post(
  "/:orgId/permission-definitions",
  asyncHandler(async (req, res) => {
    const { orgId } = req.params as { orgId: string };
    const user = (req as any).user as { id: string; role?: string };
    await requireAnyRole(user.id, orgId, OWNER_ROLES);

    const parsed = createDefinitionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid request.");
    }

    const { name, description, capabilityKey } = parsed.data;

    const [created] = await db
      .insert(labPermissionDefinitions)
      .values({
        labId: orgId,
        name,
        description: description ?? null,
        capabilityKey,
        createdByUserId: user.id,
      })
      .returning()
      .catch(wrapDbError);

    return ok(res, created);
  })
);

/**
 * PATCH /organizations/:orgId/permission-definitions/:defId
 * Rename / re-describe a permission definition (owner-only).
 */
router.patch(
  "/:orgId/permission-definitions/:defId",
  asyncHandler(async (req, res) => {
    const { orgId, defId } = req.params as {
      orgId: string;
      defId: string;
    };
    const user = (req as any).user as { id: string; role?: string };
    await requireAnyRole(user.id, orgId, OWNER_ROLES);

    const parsed = updateDefinitionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid request.");
    }

    const existing = await db.query.labPermissionDefinitions.findFirst({
      where: and(
        eq(labPermissionDefinitions.id, defId),
        eq(labPermissionDefinitions.labId, orgId)
      ),
    });
    if (!existing) throw new HttpError(404, "Permission definition not found.");

    const updates: Partial<typeof existing> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.description !== undefined)
      updates.description = parsed.data.description;
    if (parsed.data.capabilityKey !== undefined)
      updates.capabilityKey = parsed.data.capabilityKey;
    updates.updatedAt = new Date();

    const [updated] = await db
      .update(labPermissionDefinitions)
      .set(updates)
      .where(
        and(
          eq(labPermissionDefinitions.id, defId),
          eq(labPermissionDefinitions.labId, orgId)
        )
      )
      .returning()
      .catch(wrapDbError);

    return ok(res, updated);
  })
);

/**
 * DELETE /organizations/:orgId/permission-definitions/:defId
 * Delete a permission definition and all its member assignments (owner-only).
 * Cascade is handled by the FK; no soft-delete needed (no case/financial data).
 */
router.delete(
  "/:orgId/permission-definitions/:defId",
  asyncHandler(async (req, res) => {
    const { orgId, defId } = req.params as {
      orgId: string;
      defId: string;
    };
    const user = (req as any).user as { id: string; role?: string };
    await requireAnyRole(user.id, orgId, OWNER_ROLES);

    const existing = await db.query.labPermissionDefinitions.findFirst({
      where: and(
        eq(labPermissionDefinitions.id, defId),
        eq(labPermissionDefinitions.labId, orgId)
      ),
    });
    if (!existing) throw new HttpError(404, "Permission definition not found.");

    await db
      .delete(labPermissionDefinitions)
      .where(
        and(
          eq(labPermissionDefinitions.id, defId),
          eq(labPermissionDefinitions.labId, orgId)
        )
      )
      .catch(wrapDbError);

    return ok(res, { deleted: true });
  })
);

// ─── Member permission assignments ────────────────────────────────────────────

/**
 * GET /organizations/:orgId/members/self/permissions
 * Return the calling user's own custom permission grants (any member, read-only).
 * Returns full definition objects so the client can display names and descriptions
 * without a separate definitions fetch.
 */
router.get(
  "/:orgId/members/self/permissions",
  asyncHandler(async (req, res) => {
    const { orgId } = req.params as { orgId: string };
    const user = (req as any).user as { id: string; role?: string };

    // Verify the caller is an active member of this org.
    const membership = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.userId, user.id),
        eq(organizationMemberships.labId, orgId),
        eq(organizationMemberships.status, "active")
      ),
    });
    if (!membership)
      throw new HttpError(404, "Membership not found in this organization.");

    const grants = await db.query.labMemberPermissions.findMany({
      where: eq(labMemberPermissions.membershipId, membership.id),
    });

    type PermissionDefRow = typeof labPermissionDefinitions.$inferSelect;
    let definitions: PermissionDefRow[] = [];
    if (grants.length > 0) {
      definitions = await db.query.labPermissionDefinitions.findMany({
        where: and(
          eq(labPermissionDefinitions.labId, orgId),
          inArray(
            labPermissionDefinitions.id,
            grants.map((g) => g.permissionDefinitionId)
          )
        ),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      });
    }

    return ok(res, {
      membershipId: membership.id,
      permissions: definitions.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        capabilityKey: d.capabilityKey,
      })),
    });
  })
);

/**
 * GET /organizations/:orgId/members/:membershipId/permissions
 * List current permission definition IDs granted to a member (owner-only).
 */
router.get(
  "/:orgId/members/:membershipId/permissions",
  asyncHandler(async (req, res) => {
    const { orgId, membershipId } = req.params as {
      orgId: string;
      membershipId: string;
    };
    const user = (req as any).user as { id: string; role?: string };
    await requireAnyRole(user.id, orgId, OWNER_ROLES);

    // Verify the membership belongs to this org.
    const membership = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.id, membershipId),
        eq(organizationMemberships.labId, orgId),
        eq(organizationMemberships.status, "active")
      ),
    });
    if (!membership)
      throw new HttpError(404, "Membership not found in this organization.");

    const grants = await db.query.labMemberPermissions.findMany({
      where: eq(labMemberPermissions.membershipId, membershipId),
    });

    return ok(res, {
      membershipId,
      permissionDefinitionIds: grants.map((g) => g.permissionDefinitionId),
    });
  })
);

/**
 * PUT /organizations/:orgId/members/:membershipId/permissions
 * Replace the full set of granted permissions for a member (owner-only).
 * Send an empty array to revoke all. Writes an audit log entry recording the
 * before/after state.
 */
router.put(
  "/:orgId/members/:membershipId/permissions",
  asyncHandler(async (req, res) => {
    const { orgId, membershipId } = req.params as {
      orgId: string;
      membershipId: string;
    };
    const user = (req as any).user as { id: string; role?: string };
    await requireAnyRole(user.id, orgId, OWNER_ROLES);

    const parsed = putMemberPermissionsSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid request.");

    const { permissionDefinitionIds } = parsed.data;

    // Verify the membership belongs to this org.
    const membership = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.id, membershipId),
        eq(organizationMemberships.labId, orgId),
        eq(organizationMemberships.status, "active")
      ),
    });
    if (!membership)
      throw new HttpError(404, "Membership not found in this organization.");

    // Verify all supplied definition IDs belong to this lab.
    if (permissionDefinitionIds.length > 0) {
      const defs = await db.query.labPermissionDefinitions.findMany({
        where: and(
          eq(labPermissionDefinitions.labId, orgId),
          inArray(labPermissionDefinitions.id, permissionDefinitionIds)
        ),
      });
      if (defs.length !== permissionDefinitionIds.length) {
        throw new HttpError(
          400,
          "One or more permission definitions do not belong to this lab."
        );
      }
    }

    // Capture the before-state for audit log.
    const beforeGrants = await db.query.labMemberPermissions.findMany({
      where: eq(labMemberPermissions.membershipId, membershipId),
    });
    const beforeIds = beforeGrants.map((g) => g.permissionDefinitionId);

    // Replace: delete existing grants then insert new ones in a transaction.
    await db.transaction(async (tx) => {
      await tx
        .delete(labMemberPermissions)
        .where(eq(labMemberPermissions.membershipId, membershipId));

      if (permissionDefinitionIds.length > 0) {
        await tx.insert(labMemberPermissions).values(
          permissionDefinitionIds.map((defId) => ({
            membershipId,
            permissionDefinitionId: defId,
            grantedByUserId: user.id,
          }))
        );
      }
    });

    // Compute added/removed for the audit log.
    const afterSet = new Set(permissionDefinitionIds);
    const beforeSet = new Set(beforeIds);
    const granted = permissionDefinitionIds.filter((id) => !beforeSet.has(id));
    const revoked = beforeIds.filter((id) => !afterSet.has(id));

    await writeAuditLog({
      req,
      userId: user.id,
      organizationId: orgId,
      action: "set_member_permissions",
      entityType: "lab_member_permission",
      entityId: membershipId,
      beforeJson: { permissionDefinitionIds: beforeIds },
      afterJson: { permissionDefinitionIds },
      details: { granted, revoked },
    });

    return ok(res, {
      membershipId,
      permissionDefinitionIds,
    });
  })
);

/**
 * DELETE /organizations/:orgId/members/:membershipId/permissions/:defId
 * Revoke a single permission grant from a member (owner-only).
 * Writes an audit log entry for the individual revocation.
 */
router.delete(
  "/:orgId/members/:membershipId/permissions/:defId",
  asyncHandler(async (req, res) => {
    const { orgId, membershipId, defId } = req.params as {
      orgId: string;
      membershipId: string;
      defId: string;
    };
    const user = (req as any).user as { id: string; role?: string };
    await requireAnyRole(user.id, orgId, OWNER_ROLES);

    // Verify the membership belongs to this org.
    const membership = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.id, membershipId),
        eq(organizationMemberships.labId, orgId),
        eq(organizationMemberships.status, "active")
      ),
    });
    if (!membership)
      throw new HttpError(404, "Membership not found in this organization.");

    // Verify the permission definition belongs to this lab.
    const def = await db.query.labPermissionDefinitions.findFirst({
      where: and(
        eq(labPermissionDefinitions.id, defId),
        eq(labPermissionDefinitions.labId, orgId)
      ),
    });
    if (!def) throw new HttpError(404, "Permission definition not found.");

    // Delete the specific grant (no-op if not granted — idempotent).
    await db
      .delete(labMemberPermissions)
      .where(
        and(
          eq(labMemberPermissions.membershipId, membershipId),
          eq(labMemberPermissions.permissionDefinitionId, defId)
        )
      )
      .catch(wrapDbError);

    await writeAuditLog({
      req,
      userId: user.id,
      organizationId: orgId,
      action: "revoke_member_permission",
      entityType: "lab_member_permission",
      entityId: membershipId,
      details: {
        membershipId,
        permissionDefinitionId: defId,
        permissionName: def.name,
        capabilityKey: def.capabilityKey,
      },
    });

    return ok(res, { revoked: true, permissionDefinitionId: defId });
  })
);

export default router;
