import { Router } from "express";
import { and, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  caseRestorations,
  cases,
  invoices,
  organizationMemberships,
  organizations,
  users,
} from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { notDeleted, softDelete } from "../lib/soft-delete";
import { writeAuditLog, writeAuditLogTx } from "../lib/audit";
import { OWNER_ROLES, requireAnyRole, type MembershipRole } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth, requireVerifiedAccount } from "../middlewares/auth";
import { requireCreator } from "../lib/creator-auth";

const router = Router();
router.use(requireAuth);
router.use(requireVerifiedAccount);
router.use(requireCreator);

function uid(req: any): string {
  return req.auth.userId as string;
}

async function requireOwner(userId: string, orgId: string) {
  return requireAnyRole(userId, orgId, OWNER_ROLES);
}

const orgIdQuery = z.object({ organizationId: z.string().min(1) });

// ───────────────────────── Lab Profile ──────────────────────────────────────

router.get(
  "/lab-profile",
  asyncHandler(async (req, res) => {
    const { organizationId } = orgIdQuery.parse(req.query);
    await requireOwner(uid(req), organizationId);

    const org = await db.query.organizations.findFirst({
      where: and(eq(organizations.id, organizationId), notDeleted(organizations)),
    });
    if (!org) throw new HttpError(404, "Organization not found.");
    return ok(res, {
      id: org.id,
      name: org.name,
      displayName: org.displayName,
      billingEmail: org.billingEmail,
      phone: org.phone,
      addressLine1: org.addressLine1,
      addressLine2: org.addressLine2,
      city: org.city,
      state: org.state,
      zip: org.zip,
      type: org.type,
      licenseNumber: org.licenseNumber,
    });
  })
);

const updateLabProfileSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1).optional(),
  displayName: z.string().nullable().optional(),
  billingEmail: z
    .union([z.literal(""), z.string().email()])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  phone: z.string().nullable().optional(),
  addressLine1: z.string().nullable().optional(),
  addressLine2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
  licenseNumber: z.string().nullable().optional(),
});

router.patch(
  "/lab-profile",
  asyncHandler(async (req, res) => {
    const input = updateLabProfileSchema.parse(req.body);
    await requireOwner(uid(req), input.organizationId);

    const { organizationId, ...fields } = input;

    const org = await db.query.organizations.findFirst({
      where: and(eq(organizations.id, input.organizationId), notDeleted(organizations)),
    });
    if (!org) throw new HttpError(404, "Organization not found.");

    const [updated] = await db
      .update(organizations)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(organizations.id, organizationId))
      .returning();

    await writeAuditLog({
      req,
      userId: uid(req),
      organizationId,
      action: "owner_updated_lab_profile",
      entityType: "organization",
      entityId: organizationId,
      beforeJson: org,
    });

    return ok(res, {
      id: updated.id,
      name: updated.name,
      displayName: updated.displayName,
      billingEmail: updated.billingEmail,
      phone: updated.phone,
      addressLine1: updated.addressLine1,
      addressLine2: updated.addressLine2,
      city: updated.city,
      state: updated.state,
      zip: updated.zip,
      type: updated.type,
      licenseNumber: updated.licenseNumber,
    });
  })
);

// ───────────────────────── Team & Roles ─────────────────────────────────────

router.get(
  "/team",
  asyncHandler(async (req, res) => {
    const { organizationId } = orgIdQuery.parse(req.query);
    await requireOwner(uid(req), organizationId);

    const memberships = await db.query.organizationMemberships.findMany({
      where: and(
        eq(organizationMemberships.labId, organizationId),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt)
      ),
    });

    if (!memberships.length) return ok(res, []);

    const userIds = memberships.map((m) => m.userId);
    const userRows = await db.query.users.findMany({
      where: inArray(users.id, userIds),
    });
    const userMap = new Map(userRows.map((u) => [u.id, u]));

    const team = memberships.filter((m) => userMap.has(m.userId)).map((m) => {
      const u = userMap.get(m.userId);
      return {
        membershipId: m.id,
        userId: m.userId,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt,
        firstName: u?.firstName ?? null,
        lastName: u?.lastName ?? null,
        email: u?.email ?? null,
        username: u?.username ?? null,
      };
    });

    return ok(res, team);
  })
);

const changeRoleSchema = z.object({
  organizationId: z.string().min(1),
  role: z.enum(["owner", "admin", "user", "billing", "read_only"]),
});

router.patch(
  "/team/:userId/role",
  asyncHandler(async (req, res) => {
    const input = changeRoleSchema.parse(req.body);
    await requireOwner(uid(req), input.organizationId);

    const targetUserId = String(req.params.userId);
    const callerId = uid(req);

    const membership = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.labId, input.organizationId),
        eq(organizationMemberships.userId, targetUserId),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt)
      ),
    });
    if (!membership) throw new HttpError(404, "Member not found.");

    // Prevent demoting the sole owner.
    if (membership.role === "owner" && input.role !== "owner") {
      const ownerCount = await db.query.organizationMemberships.findMany({
        where: and(
          eq(organizationMemberships.labId, input.organizationId),
          eq(organizationMemberships.status, "active"),
          eq(organizationMemberships.role, "owner"),
          isNull(organizationMemberships.deletedAt)
        ),
      });
      if (ownerCount.length <= 1) {
        throw new HttpError(
          400,
          "Cannot demote the only owner. Transfer ownership to another member first."
        );
      }
    }

    const [updated] = await db
      .update(organizationMemberships)
      .set({ role: input.role as MembershipRole, updatedAt: new Date() })
      .where(eq(organizationMemberships.id, membership.id))
      .returning();

    await writeAuditLog({
      req,
      userId: callerId,
      organizationId: input.organizationId,
      action: "owner_changed_member_role",
      entityType: "lab_membership",
      entityId: membership.id,
      metadataJson: {
        targetUserId,
        previousRole: membership.role,
        newRole: input.role,
      },
    });

    return ok(res, { membershipId: updated.id, userId: targetUserId, role: updated.role });
  })
);

// ───────────────────────── Remove Team Member ────────────────────────────────

const removeTeamMemberSchema = z.object({
  organizationId: z.string().min(1),
});

router.delete(
  "/team/:userId",
  asyncHandler(async (req, res) => {
    const input = removeTeamMemberSchema.parse(req.body);
    const callerId = uid(req);
    await requireOwner(callerId, input.organizationId);

    const targetUserId = String(req.params.userId);

    if (targetUserId === callerId) {
      throw new HttpError(400, "You cannot remove yourself. Transfer ownership first.");
    }

    const membership = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.labId, input.organizationId),
        eq(organizationMemberships.userId, targetUserId),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt)
      ),
    });
    if (!membership) throw new HttpError(404, "Member not found.");

    // Sole-owner guard: cannot remove the only owner
    if (membership.role === "owner") {
      const ownerCount = await db.query.organizationMemberships.findMany({
        where: and(
          eq(organizationMemberships.labId, input.organizationId),
          eq(organizationMemberships.status, "active"),
          eq(organizationMemberships.role, "owner"),
          isNull(organizationMemberships.deletedAt)
        ),
      });
      if (ownerCount.length <= 1) {
        throw new HttpError(
          400,
          "Cannot remove the only owner. Transfer ownership to another member first."
        );
      }
    }

    await softDelete({
      table: organizationMemberships,
      where: eq(organizationMemberships.id, membership.id),
      actorUserId: callerId,
      req,
      organizationId: input.organizationId,
      entityType: "lab_membership",
      entityId: membership.id,
      metadataJson: { targetUserId, reason: "owner_removed_member" },
    });

    await writeAuditLog({
      req,
      userId: callerId,
      organizationId: input.organizationId,
      action: "owner_removed_team_member",
      entityType: "lab_membership",
      entityId: membership.id,
      metadataJson: { targetUserId, previousRole: membership.role },
    });

    return ok(res, { removed: true, userId: targetUserId });
  })
);

// ───────────────────────── Transfer Ownership ────────────────────────────────

const transferOwnershipSchema = z.object({
  organizationId: z.string().min(1),
  newOwnerUserId: z.string().min(1),
  confirmationPhrase: z.string().min(1),
});

router.post(
  "/transfer-ownership",
  asyncHandler(async (req, res) => {
    const input = transferOwnershipSchema.parse(req.body);
    const callerId = uid(req);
    await requireOwner(callerId, input.organizationId);

    await db.transaction(async (tx) => {
      const [org] = await tx.select().from(organizations).where(
        and(eq(organizations.id, input.organizationId), notDeleted(organizations))
      ).for("update");
      if (!org || !org.isActive) throw new HttpError(404, "Organization not found.");
      if (input.confirmationPhrase.trim() !== (org.displayName || org.name).trim()) {
        throw new HttpError(400, "Confirmation phrase does not match the organization name. Please type the name exactly.");
      }
      // Lock both memberships in a stable order and recheck authorization while
      // locked. Preflight authorization alone cannot protect a concurrent handoff.
      const members = await tx.select().from(organizationMemberships).where(and(
        eq(organizationMemberships.labId, input.organizationId),
        inArray(organizationMemberships.userId, [callerId, input.newOwnerUserId]),
        eq(organizationMemberships.status, "active"),
        notDeleted(organizationMemberships)
      )).orderBy(organizationMemberships.id).for("update");
      const caller = members.find((m) => m.userId === callerId);
      if (caller?.role !== "owner") throw new HttpError(403, "Only an active owner can transfer ownership.");
      const newOwnerMembership = members.find((m) => m.userId === input.newOwnerUserId);
      if (!newOwnerMembership) throw new HttpError(404, "The selected user is not an active member of this organization.");
      if (newOwnerMembership.userId === callerId) throw new HttpError(400, "You are already the owner.");
      const [targetUser] = await tx.select({ id: users.id }).from(users).where(and(
        eq(users.id, input.newOwnerUserId), eq(users.isActive, true), notDeleted(users)
      )).for("update");
      if (!targetUser) throw new HttpError(400, "The selected user is not active.");
      // Promote new owner
      await tx
        .update(organizationMemberships)
        .set({ role: "owner", updatedAt: new Date() })
        .where(eq(organizationMemberships.id, newOwnerMembership.id));

      // Demote current caller to admin
      await tx
        .update(organizationMemberships)
        .set({ role: "admin", updatedAt: new Date() })
        .where(
          and(
            eq(organizationMemberships.labId, input.organizationId),
            eq(organizationMemberships.userId, callerId),
            eq(organizationMemberships.status, "active"),
            isNull(organizationMemberships.deletedAt)
          )
        );
      await writeAuditLogTx(tx, {
      req,
      userId: callerId,
      organizationId: input.organizationId,
      action: "owner_transferred_ownership",
      entityType: "organization",
      entityId: input.organizationId,
      metadataJson: {
        previousOwnerUserId: callerId,
        newOwnerUserId: input.newOwnerUserId,
      },
      });
    });

    return ok(res, { transferred: true, newOwnerUserId: input.newOwnerUserId });
  })
);

// ───────────────────────── Delete Lab Summary ────────────────────────────────

router.get(
  "/delete-lab-summary",
  asyncHandler(async (req, res) => {
    const { organizationId } = orgIdQuery.parse(req.query);
    await requireOwner(uid(req), organizationId);

    const org = await db.query.organizations.findFirst({
      where: and(eq(organizations.id, organizationId), notDeleted(organizations)),
    });
    if (!org) throw new HttpError(404, "Organization not found.");

    const membershipRows = await db
      .select({ count: sql<number>`COUNT(*)::int`, userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.labId, organizationId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt)
        )
      )
      .groupBy(organizationMemberships.userId);

    const activeMemberCount = membershipRows.length;
    const memberUserIds = membershipRows.map((r) => r.userId);

    const MEMBER_NAME_LIMIT = 5;
    let memberNames: string[] = [];
    let memberNamesOverflow = 0;
    if (memberUserIds.length > 0) {
      const userRows = await db.query.users.findMany({
        where: inArray(users.id, memberUserIds),
        columns: { id: true, firstName: true, lastName: true, username: true },
      });
      const nameList = userRows.map((u) => {
        const full = [u.firstName, u.lastName].filter(Boolean).join(" ");
        return full || u.username || u.id;
      });
      memberNames = nameList.slice(0, MEMBER_NAME_LIMIT);
      memberNamesOverflow = Math.max(0, nameList.length - MEMBER_NAME_LIMIT);
    }

    const [casesRow] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(cases)
      .where(
        and(
          eq(cases.labOrganizationId, organizationId),
          notDeleted(cases),
          sql`${cases.status} NOT IN ('complete', 'cancelled')`
        )
      );

    const [invoicesRow] = await db
      .select({
        count: sql<number>`COUNT(*)::int`,
        total: sql<string>`COALESCE(SUM(${invoices.balanceDue}), 0)::text`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.labOrganizationId, organizationId),
          notDeleted(invoices),
          sql`${invoices.status} NOT IN ('paid', 'void')`
        )
      );

    return ok(res, {
      activeMembers: activeMemberCount,
      memberNames,
      memberNamesOverflow,
      openCases: casesRow?.count ?? 0,
      unpaidInvoices: invoicesRow?.count ?? 0,
      unpaidInvoicesTotal: invoicesRow?.total ?? "0",
    });
  })
);

// ───────────────────────── Delete Lab ────────────────────────────────────────

const deleteLabSchema = z.object({
  organizationId: z.string().min(1),
  confirmationPhrase: z.string().min(1),
});

router.post(
  "/delete-lab",
  asyncHandler(async (req, res) => {
    const input = deleteLabSchema.parse(req.body);
    const callerId = uid(req);
    await requireOwner(callerId, input.organizationId);

    const org = await db.query.organizations.findFirst({
      where: and(eq(organizations.id, input.organizationId), notDeleted(organizations)),
    });
    if (!org) throw new HttpError(404, "Organization not found.");

    const expectedPhrase = (org.displayName || org.name || "").trim();
    if (input.confirmationPhrase.trim() !== expectedPhrase) {
      throw new HttpError(
        400,
        "Confirmation phrase does not match the lab name. Please type the lab name exactly."
      );
    }

    // Soft-delete all active memberships first
    await softDelete({
      table: organizationMemberships,
      where: and(
        eq(organizationMemberships.labId, input.organizationId),
        eq(organizationMemberships.status, "active")
      ) as SQL<unknown>,
      actorUserId: callerId,
      req,
      organizationId: input.organizationId,
      entityType: "lab_membership",
      metadataJson: { reason: "lab_deleted" },
    });

    // Soft-delete the organization
    await softDelete({
      table: organizations,
      where: eq(organizations.id, input.organizationId),
      actorUserId: callerId,
      req,
      organizationId: input.organizationId,
      entityType: "organization",
      entityId: input.organizationId,
      metadataJson: { orgName: org.name },
    });

    return ok(res, { deleted: true });
  })
);

// ───────────────────────── Revenue Report ────────────────────────────────────

const revenueReportQuery = z.object({
  organizationId: z.string().min(1),
  period: z.enum(["month", "quarter", "year"]).default("month"),
  groupBy: z.enum(["month", "practice", "restoration_type"]).default("month"),
  from: z.string().optional(),
  to: z.string().optional(),
});

router.get(
  "/revenue-report",
  asyncHandler(async (req, res) => {
    const input = revenueReportQuery.parse(req.query);
    await requireOwner(uid(req), input.organizationId);

    const now = new Date();
    let fromDate: Date;
    let toDate: Date = now;

    if (input.from) {
      fromDate = new Date(input.from);
    } else {
      switch (input.period) {
        case "year":
          fromDate = new Date(now.getFullYear(), 0, 1);
          break;
        case "quarter": {
          const q = Math.floor(now.getMonth() / 3);
          fromDate = new Date(now.getFullYear(), q * 3, 1);
          break;
        }
        default:
          fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
      }
    }
    if (input.to) toDate = new Date(input.to);

    const effectiveDate = sql<Date>`COALESCE(${invoices.issuedAt}, ${invoices.createdAt})`;
    const baseWhere = and(
      eq(invoices.labOrganizationId, input.organizationId),
      notDeleted(invoices),
      sql`${invoices.status} != 'draft'`,
      sql`${invoices.status} != 'void'`,
      gte(effectiveDate, fromDate),
      lte(effectiveDate, toDate)
    );

    if (input.groupBy === "practice") {
      const rows = await db
        .select({
          practiceOrgId: invoices.providerOrganizationId,
          revenue: sql<string>`COALESCE(SUM(${invoices.total}), 0)::text`,
          invoiceCount: sql<number>`COUNT(*)::int`,
        })
        .from(invoices)
        .where(baseWhere)
        .groupBy(invoices.providerOrganizationId)
        .orderBy(desc(sql`SUM(${invoices.total})`));

      const practiceIds = rows
        .map((r) => r.practiceOrgId)
        .filter(Boolean) as string[];
      const practiceMap = new Map<string, string>();
      if (practiceIds.length) {
        const orgs = await db.query.organizations.findMany({
          where: inArray(organizations.id, practiceIds),
        });
        for (const o of orgs) {
          practiceMap.set(o.id, o.displayName || o.name);
        }
      }

      const items = rows.map((r) => ({
        label: r.practiceOrgId
          ? (practiceMap.get(r.practiceOrgId) ?? "Unknown Practice")
          : "No Practice",
        practiceOrgId: r.practiceOrgId ?? null,
        revenue: r.revenue,
        invoiceCount: r.invoiceCount,
      }));

      const totalRevenue = items.reduce((s, r) => s + parseFloat(r.revenue), 0);
      return ok(res, { groupBy: "practice", items, totalRevenue: totalRevenue.toFixed(2) });
    }

    if (input.groupBy === "restoration_type") {
      const rows = await db
        .select({
          restorationType: caseRestorations.restorationType,
          revenue: sql<string>`COALESCE(SUM(${caseRestorations.unitPrice} * ${caseRestorations.quantity}), 0)::text`,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(caseRestorations)
        .innerJoin(cases, eq(caseRestorations.caseId, cases.id))
        .innerJoin(invoices, eq(invoices.caseId, cases.id))
        .where(
          and(
            eq(invoices.labOrganizationId, input.organizationId),
            notDeleted(invoices),
            sql`${invoices.status} != 'draft'`,
            sql`${invoices.status} != 'void'`,
            gte(effectiveDate, fromDate),
            lte(effectiveDate, toDate)
          )
        )
        .groupBy(caseRestorations.restorationType)
        .orderBy(desc(sql`SUM(${caseRestorations.unitPrice} * ${caseRestorations.quantity})`));

      const items = rows.map((r) => ({
        label: r.restorationType ?? "Unknown",
        revenue: r.revenue,
        count: r.count,
      }));

      const totalRevenue = items.reduce((s, r) => s + parseFloat(r.revenue), 0);
      return ok(res, { groupBy: "restoration_type", items, totalRevenue: totalRevenue.toFixed(2) });
    }

    // Default: group by month
    const rows = await db
      .select({
        month: sql<string>`TO_CHAR(DATE_TRUNC('month', COALESCE(${invoices.issuedAt}, ${invoices.createdAt})), 'YYYY-MM')`,
        revenue: sql<string>`COALESCE(SUM(${invoices.total}), 0)::text`,
        invoiceCount: sql<number>`COUNT(*)::int`,
      })
      .from(invoices)
      .where(baseWhere)
      .groupBy(sql`DATE_TRUNC('month', COALESCE(${invoices.issuedAt}, ${invoices.createdAt}))`)
      .orderBy(sql`DATE_TRUNC('month', COALESCE(${invoices.issuedAt}, ${invoices.createdAt}))`);

    const items = rows.map((r) => ({
      label: r.month,
      revenue: r.revenue,
      invoiceCount: r.invoiceCount,
    }));

    const totalRevenue = items.reduce((s, r) => s + parseFloat(r.revenue), 0);
    return ok(res, { groupBy: "month", items, totalRevenue: totalRevenue.toFixed(2) });
  })
);

export default router;
