import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  auditLogs,
  organizationMemberships,
  pricingOverrides,
  pricingTiers,
  users,
} from "@workspace/db";
import { writeAuditLog } from "../lib/audit";
import { softDeleteById } from "../lib/soft-delete";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import { DEFAULT_TIER_KEYS } from "../lib/pricing";

const router = Router();
router.use(requireAuth);

async function userAdminLabIds(userId: string): Promise<string[]> {
  const memberships = await db.query.organizationMemberships.findMany({
    where: eq(organizationMemberships.userId, userId),
  });
  return memberships
    .filter(
      (m: any) =>
        m.status === "active" &&
        (m.role === "owner" || m.role === "admin")
    )
    .map((m: any) => m.labId as string);
}

async function resolveLabId(req: any, requested?: string): Promise<string> {
  const labIds = await userAdminLabIds((req as any).auth.userId);
  if (labIds.length === 0) {
    throw new HttpError(403, "You are not a lab administrator.");
  }
  if (requested) {
    if (!labIds.includes(requested)) {
      throw new HttpError(403, "You don't admin that lab organization.");
    }
    return requested;
  }
  return labIds[0];
}

const pricesSchema = z.record(z.string(), z.coerce.number().min(0));

function sanitizePrices(input: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

// ---- Tiers ----

router.get(
  "/tiers",
  asyncHandler(async (req, res) => {
    const labId = await resolveLabId(
      req,
      req.query.labOrganizationId as string | undefined
    );
    const rows = await db.query.pricingTiers.findMany({
      where: eq(pricingTiers.labOrganizationId, labId),
    });
    return ok(res, {
      labOrganizationId: labId,
      keys: DEFAULT_TIER_KEYS,
      tiers: rows.map((t: any) => ({
        id: t.id,
        labOrganizationId: t.labOrganizationId,
        name: t.name,
        prices: t.pricesJson ?? {},
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    });
  })
);

router.post(
  "/tiers",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        labOrganizationId: z.string().optional(),
        name: z.string().min(1).max(80),
        prices: pricesSchema.optional(),
      })
      .parse(req.body);
    const labId = await resolveLabId(req, input.labOrganizationId);
    await requireAnyRole((req as any).auth.userId, labId, ADMIN_ROLES);

    const existing = await db.query.pricingTiers.findFirst({
      where: and(
        eq(pricingTiers.labOrganizationId, labId),
        eq(pricingTiers.name, input.name)
      ),
    });
    if (existing) {
      throw new HttpError(409, "A tier with that name already exists.");
    }

    const [created] = await db
      .insert(pricingTiers)
      .values({
        labOrganizationId: labId,
        name: input.name,
        pricesJson: sanitizePrices(input.prices ?? {}),
        createdByUserId: (req as any).auth.userId,
      })
      .returning();

    await writeAuditLog({
      req,
      organizationId: labId,
      action: "pricing_tier_created",
      entityType: "pricing_tier",
      entityId: created.id,
      afterJson: created,
    });

    return ok(
      res,
      {
        id: created.id,
        labOrganizationId: created.labOrganizationId,
        name: created.name,
        prices: created.pricesJson ?? {},
      },
      201
    );
  })
);

router.patch(
  "/tiers/:id",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        name: z.string().min(1).max(80).optional(),
        prices: pricesSchema.optional(),
      })
      .parse(req.body);
    const tier = await db.query.pricingTiers.findFirst({
      where: eq(pricingTiers.id, (req.params.id as string)),
    });
    if (!tier) throw new HttpError(404, "Tier not found.");
    await requireAnyRole((req as any).auth.userId, tier.labOrganizationId, ADMIN_ROLES);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) update.name = input.name;
    if (input.prices !== undefined)
      update.pricesJson = sanitizePrices(input.prices);

    const [updated] = await db
      .update(pricingTiers)
      .set(update as any)
      .where(eq(pricingTiers.id, tier.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: tier.labOrganizationId,
      action: "pricing_tier_updated",
      entityType: "pricing_tier",
      entityId: tier.id,
      beforeJson: tier,
      afterJson: updated,
    });

    return ok(res, {
      id: updated.id,
      labOrganizationId: updated.labOrganizationId,
      name: updated.name,
      prices: updated.pricesJson ?? {},
    });
  })
);

router.delete(
  "/tiers/:id",
  asyncHandler(async (req, res) => {
    const tier = await db.query.pricingTiers.findFirst({
      where: eq(pricingTiers.id, (req.params.id as string)),
    });
    if (!tier) throw new HttpError(404, "Tier not found.");
    await requireAnyRole((req as any).auth.userId, tier.labOrganizationId, ADMIN_ROLES);

    await softDeleteById({
      table: pricingTiers,
      id: tier.id,
      actorUserId: (req as any).auth.userId,
      req,
      organizationId: tier.labOrganizationId,
      entityType: "pricing_tier",
      beforeJson: tier,
    });

    return ok(res, { deleted: true, id: tier.id });
  })
);

// ---- Per-doctor / per-practice overrides ----

router.get(
  "/overrides",
  asyncHandler(async (req, res) => {
    const labId = await resolveLabId(
      req,
      req.query.labOrganizationId as string | undefined
    );
    const rows = await db.query.pricingOverrides.findMany({
      where: eq(pricingOverrides.labOrganizationId, labId),
    });
    return ok(res, {
      labOrganizationId: labId,
      keys: DEFAULT_TIER_KEYS,
      overrides: rows.map((r: any) => ({
        id: r.id,
        labOrganizationId: r.labOrganizationId,
        doctorName: r.doctorName,
        practiceName: r.practiceName,
        providerOrganizationId: r.providerOrganizationId,
        tierName: r.tierName,
        prices: r.pricesJson ?? {},
        notes: r.notes,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  })
);

router.post(
  "/overrides",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        labOrganizationId: z.string().optional(),
        doctorName: z.string().min(1).max(120),
        practiceName: z.string().max(160).optional(),
        providerOrganizationId: z.string().optional(),
        tierName: z.string().max(80).optional(),
        prices: pricesSchema.optional(),
        notes: z.string().max(500).optional(),
      })
      .parse(req.body);

    const labId = await resolveLabId(req, input.labOrganizationId);
    await requireAnyRole((req as any).auth.userId, labId, ADMIN_ROLES);

    const existing = await db.query.pricingOverrides.findFirst({
      where: and(
        eq(pricingOverrides.labOrganizationId, labId),
        eq(pricingOverrides.doctorName, input.doctorName)
      ),
    });
    if (existing) {
      throw new HttpError(
        409,
        "An override for that doctor already exists. Edit the existing one instead."
      );
    }

    const [created] = await db
      .insert(pricingOverrides)
      .values({
        labOrganizationId: labId,
        doctorName: input.doctorName,
        practiceName: input.practiceName ?? null,
        providerOrganizationId: input.providerOrganizationId ?? null,
        tierName: input.tierName?.trim() || null,
        pricesJson: sanitizePrices(input.prices ?? {}),
        notes: input.notes ?? null,
        createdByUserId: (req as any).auth.userId,
      })
      .returning();

    await writeAuditLog({
      req,
      organizationId: labId,
      action: "pricing_override_created",
      entityType: "pricing_override",
      entityId: created.id,
      afterJson: created,
    });

    return ok(
      res,
      {
        id: created.id,
        labOrganizationId: created.labOrganizationId,
        doctorName: created.doctorName,
        practiceName: created.practiceName,
        providerOrganizationId: created.providerOrganizationId,
        prices: created.pricesJson ?? {},
        notes: created.notes,
      },
      201
    );
  })
);

router.patch(
  "/overrides/:id",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        doctorName: z.string().min(1).max(120).optional(),
        practiceName: z.string().max(160).nullable().optional(),
        providerOrganizationId: z.string().nullable().optional(),
        tierName: z.string().max(80).nullable().optional(),
        prices: pricesSchema.optional(),
        notes: z.string().max(500).nullable().optional(),
      })
      .parse(req.body);
    const row = await db.query.pricingOverrides.findFirst({
      where: eq(pricingOverrides.id, (req.params.id as string)),
    });
    if (!row) throw new HttpError(404, "Override not found.");
    await requireAnyRole((req as any).auth.userId, row.labOrganizationId, ADMIN_ROLES);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (input.doctorName !== undefined) update.doctorName = input.doctorName;
    if (input.practiceName !== undefined)
      update.practiceName = input.practiceName;
    if (input.providerOrganizationId !== undefined)
      update.providerOrganizationId = input.providerOrganizationId;
    if (input.tierName !== undefined) {
      const tn =
        typeof input.tierName === "string" ? input.tierName.trim() : null;
      update.tierName = tn && tn.length > 0 ? tn : null;
    }
    if (input.prices !== undefined)
      update.pricesJson = sanitizePrices(input.prices);
    if (input.notes !== undefined) update.notes = input.notes;

    const [updated] = await db
      .update(pricingOverrides)
      .set(update as any)
      .where(eq(pricingOverrides.id, row.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: row.labOrganizationId,
      action: "pricing_override_updated",
      entityType: "pricing_override",
      entityId: row.id,
      beforeJson: row,
      afterJson: updated,
    });

    return ok(res, {
      id: updated.id,
      labOrganizationId: updated.labOrganizationId,
      doctorName: updated.doctorName,
      practiceName: updated.practiceName,
      providerOrganizationId: updated.providerOrganizationId,
      prices: updated.pricesJson ?? {},
      notes: updated.notes,
    });
  })
);

router.delete(
  "/overrides/:id",
  asyncHandler(async (req, res) => {
    const row = await db.query.pricingOverrides.findFirst({
      where: eq(pricingOverrides.id, (req.params.id as string)),
    });
    if (!row) throw new HttpError(404, "Override not found.");
    await requireAnyRole((req as any).auth.userId, row.labOrganizationId, ADMIN_ROLES);

    await softDeleteById({
      table: pricingOverrides,
      id: row.id,
      actorUserId: (req as any).auth.userId,
      req,
      organizationId: row.labOrganizationId,
      entityType: "pricing_override",
      beforeJson: row,
    });

    return ok(res, { deleted: true, id: row.id });
  })
);

// ---- Audit history ----

async function fetchHistory(
  req: any,
  entityType: "pricing_tier" | "pricing_override",
  entityId: string,
  labOrganizationId: string
) {
  await requireAnyRole((req as any).auth.userId, labOrganizationId, ADMIN_ROLES);

  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      createdAt: auditLogs.createdAt,
      beforeJson: auditLogs.beforeJson,
      afterJson: auditLogs.afterJson,
      userId: auditLogs.userId,
      userFirstName: users.firstName,
      userLastName: users.lastName,
      userUsername: users.username,
      userEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(
      and(
        eq(auditLogs.entityType, entityType),
        eq(auditLogs.entityId, entityId),
        eq(auditLogs.organizationId, labOrganizationId)
      )
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);

  return rows.map((r: any) => {
    const before = (r.beforeJson as any) ?? null;
    const after = (r.afterJson as any) ?? null;
    const beforePrices =
      (before && (before.pricesJson ?? before.prices)) ?? null;
    const afterPrices =
      (after && (after.pricesJson ?? after.prices)) ?? null;
    return {
      id: r.id,
      action: r.action,
      createdAt: r.createdAt,
      userId: r.userId,
      userName:
        [r.userFirstName, r.userLastName].filter(Boolean).join(" ").trim() ||
        r.userUsername ||
        r.userEmail ||
        null,
      beforePrices,
      afterPrices,
      beforeName: before?.name ?? null,
      afterName: after?.name ?? null,
      beforeDoctorName: before?.doctorName ?? null,
      afterDoctorName: after?.doctorName ?? null,
      beforePracticeName: before?.practiceName ?? null,
      afterPracticeName: after?.practiceName ?? null,
      beforeNotes: before?.notes ?? null,
      afterNotes: after?.notes ?? null,
    };
  });
}

router.get(
  "/tiers/:id/history",
  asyncHandler(async (req, res) => {
    const tier = await db.query.pricingTiers.findFirst({
      where: eq(pricingTiers.id, req.params.id as string),
    });
    if (!tier) throw new HttpError(404, "Tier not found.");
    const entries = await fetchHistory(
      req,
      "pricing_tier",
      tier.id,
      tier.labOrganizationId
    );
    return ok(res, { entries });
  })
);

router.get(
  "/overrides/:id/history",
  asyncHandler(async (req, res) => {
    const row = await db.query.pricingOverrides.findFirst({
      where: eq(pricingOverrides.id, req.params.id as string),
    });
    if (!row) throw new HttpError(404, "Override not found.");
    const entries = await fetchHistory(
      req,
      "pricing_override",
      row.id,
      row.labOrganizationId
    );
    return ok(res, { entries });
  })
);

export default router;
