import { Router } from "express";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  auditLogs,
  caseRestorations,
  cases,
  labItemLabels,
  organizationConnections,
  organizationMemberships,
  organizations,
  pricingOverrides,
  pricingTiers,
  users,
} from "@workspace/db";
import { writeAuditLog } from "../lib/audit";
import { notDeleted, softDeleteById } from "../lib/soft-delete";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import {
  DEFAULT_TIER_ITEMS,
  DEFAULT_TIER_KEYS,
  fetchLabItemLabels,
  generateUniqueItemKey,
  resolveAllPricesForContext,
  resolveServerPrice,
  saveLabItemLabels,
} from "../lib/pricing";

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

/**
 * Resolve the caller's lab id. Accepts any active lab membership (not just
 * admin) — used by read-only endpoints like GET /pricing/item-labels.
 */
async function resolveLabIdForMember(
  req: any,
  requested?: string,
): Promise<string> {
  const userId = (req as any).auth.userId;
  const memberships = await db.query.organizationMemberships.findMany({
    where: eq(organizationMemberships.userId, userId),
  });
  const labIds = memberships
    .filter((m: any) => m.status === "active")
    .map((m: any) => m.labId as string);
  if (labIds.length === 0) {
    throw new HttpError(403, "You are not a member of any lab.");
  }
  if (requested) {
    if (!labIds.includes(requested)) {
      throw new HttpError(403, "You don't have access to that lab organization.");
    }
    return requested;
  }
  return labIds[0];
}

const pricesSchema = z.record(z.string(), z.coerce.number().min(0));

// Per-item percentage discounts, keyed by price key. Each value is 0-100.
const discountPercentsSchema = z.record(
  z.string(),
  z.coerce.number().min(0).max(100),
);

function sanitizePrices(input: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

/**
 * Clamp a per-item discount map to finite values in the 0-100 range. Entries
 * that aren't valid percentages are dropped.
 */
function sanitizeDiscountPercents(
  input: Record<string, unknown>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 100) out[k] = n;
  }
  return out;
}

/**
 * Coerce a default-discount-percent input to a stored value. Returns a numeric
 * string (decimal column) when a valid 0-100 percentage is supplied, or `null`
 * to clear the default discount.
 */
function sanitizeDiscountPercent(
  input: number | null | undefined,
): string | null {
  if (input === null || input === undefined) return null;
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n.toFixed(2);
}

// ---- Tiers ----

/**
 * Resolve every standard line-item's effective unit price for a given
 * case (per-doctor override → doctor tier → practice tier → lab default).
 * Used by the desktop invoice editor to power the "Item" dropdown so
 * picking "Zirconia Crown" auto-fills both the description and the
 * doctor-specific price.
 *
 * Authz: caller must be a member of either the case's lab OR provider
 * organization (matches `GET /invoices/:invoiceId`).
 */
router.get(
  "/resolve-items",
  asyncHandler(async (req, res) => {
    const caseId = String(req.query.caseId ?? "").trim();
    if (!caseId) throw new HttpError(400, "caseId is required.");
    const kase = await db.query.cases.findFirst({
      where: eq(cases.id, caseId),
    });
    if (!kase) throw new HttpError(404, "Case not found.");
    const userId = (req as any).auth.userId;
    const labMember = await requireMembership(
      userId,
      kase.labOrganizationId,
    ).catch(() => null);
    const providerMember = await requireMembership(
      userId,
      kase.providerOrganizationId,
    ).catch(() => null);
    if (!labMember && !providerMember) {
      throw new HttpError(403, "You do not have access to this case.");
    }
    const items = await resolveAllPricesForContext({
      labOrganizationId: kase.labOrganizationId,
      doctorName: kase.doctorName,
      providerOrganizationId: kase.providerOrganizationId,
    });
    return ok(res, { items });
  }),
);

router.get(
  "/tiers",
  asyncHandler(async (req, res) => {
    const labId = await resolveLabId(
      req,
      req.query.labOrganizationId as string | undefined
    );
    const rows = await db.query.pricingTiers.findMany({
      where: and(
        eq(pricingTiers.labOrganizationId, labId),
        notDeleted(pricingTiers),
      ),
    });
    const customKeySet = new Set<string>();
    for (const t of rows) {
      for (const k of Object.keys((t.pricesJson ?? {}) as Record<string, unknown>)) {
        if (!(DEFAULT_TIER_KEYS as readonly string[]).includes(k)) customKeySet.add(k);
      }
    }
    const allKeys = [...DEFAULT_TIER_KEYS, ...Array.from(customKeySet)];
    return ok(res, {
      labOrganizationId: labId,
      keys: allKeys,
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
        eq(pricingTiers.name, input.name),
        notDeleted(pricingTiers),
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

    const oldName = tier.name;
    const newName = (input.name ?? tier.name).trim();
    const willRename =
      input.name !== undefined &&
      newName.length > 0 &&
      newName.toLowerCase() !== oldName.trim().toLowerCase();

    // Cascade tier renames so per-doctor overrides and practice
    // connections that referenced the old name keep pointing at this
    // tier — otherwise admins would silently lose every doctor and
    // practice they had carefully placed on the tier.
    const [updated, overridesCascade, connectionsCascade] = await db.transaction(
      async (tx) => {
        const [u] = await tx
          .update(pricingTiers)
          .set(update as any)
          .where(eq(pricingTiers.id, tier.id))
          .returning();

        let overridesUpdated: Array<{ id: string }> = [];
        let connectionsUpdated: Array<{ id: string }> = [];
        if (willRename) {
          overridesUpdated = await tx
            .update(pricingOverrides)
            .set({ tierName: newName, updatedAt: new Date() })
            .where(
              and(
                eq(pricingOverrides.labOrganizationId, tier.labOrganizationId),
                sql`lower(trim(${pricingOverrides.tierName})) = lower(trim(${oldName}))`,
                notDeleted(pricingOverrides),
              ),
            )
            .returning({ id: pricingOverrides.id });
          connectionsUpdated = await tx
            .update(organizationConnections)
            .set({ tierName: newName, updatedAt: new Date() })
            .where(
              and(
                eq(
                  organizationConnections.labOrganizationId,
                  tier.labOrganizationId,
                ),
                sql`lower(trim(${organizationConnections.tierName})) = lower(trim(${oldName}))`,
              ),
            )
            .returning({ id: organizationConnections.id });
          // Cascade to the lab's defaultDoctorTierName setting so it
          // keeps pointing at the renamed tier instead of going stale.
          await tx
            .update(organizations)
            .set({ defaultDoctorTierName: newName, updatedAt: new Date() })
            .where(
              and(
                eq(organizations.id, tier.labOrganizationId),
                sql`lower(trim(${organizations.defaultDoctorTierName})) = lower(trim(${oldName}))`,
              ),
            );
        }
        return [u, overridesUpdated, connectionsUpdated] as const;
      },
    );

    await writeAuditLog({
      req,
      organizationId: tier.labOrganizationId,
      action: "pricing_tier_updated",
      entityType: "pricing_tier",
      entityId: tier.id,
      beforeJson: tier,
      afterJson: {
        ...updated,
        cascadedOverrides: overridesCascade.length,
        cascadedConnections: connectionsCascade.length,
      },
    });

    return ok(res, {
      id: updated.id,
      labOrganizationId: updated.labOrganizationId,
      name: updated.name,
      prices: updated.pricesJson ?? {},
      cascadedOverrides: overridesCascade.length,
      cascadedConnections: connectionsCascade.length,
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
      where: and(
        eq(pricingOverrides.labOrganizationId, labId),
        notDeleted(pricingOverrides),
      ),
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
        defaultDiscountPercent:
          r.discountPercent === null || r.discountPercent === undefined
            ? null
            : Number(r.discountPercent),
        discountPercents: r.discountPercentsJson ?? {},
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
        practiceName: z.string().max(160).nullable().optional(),
        providerOrganizationId: z.string().nullable().optional(),
        tierName: z.string().max(80).nullable().optional(),
        prices: pricesSchema.optional(),
        defaultDiscountPercent: z.coerce
          .number()
          .min(0)
          .max(100)
          .nullable()
          .optional(),
        discountPercents: discountPercentsSchema.optional(),
        notes: z.string().max(500).nullable().optional(),
      })
      .parse(req.body);

    const labId = await resolveLabId(req, input.labOrganizationId);
    await requireAnyRole((req as any).auth.userId, labId, ADMIN_ROLES);

    const existing = await db.query.pricingOverrides.findFirst({
      where: and(
        eq(pricingOverrides.labOrganizationId, labId),
        eq(pricingOverrides.doctorName, input.doctorName),
        notDeleted(pricingOverrides),
      ),
    });
    if (existing) {
      throw new HttpError(
        409,
        "An override for that doctor already exists. Edit the existing one instead."
      );
    }

    // If no tier was explicitly supplied, fall back to the lab's configured
    // default doctor tier so new doctors are automatically placed on a tier.
    let resolvedTierName = input.tierName?.trim() || null;
    if (!resolvedTierName) {
      const labOrg = await db.query.organizations.findFirst({
        where: eq(organizations.id, labId),
      });
      resolvedTierName = labOrg?.defaultDoctorTierName?.trim() || null;
    }

    const [created] = await db
      .insert(pricingOverrides)
      .values({
        labOrganizationId: labId,
        doctorName: input.doctorName,
        practiceName: input.practiceName ?? null,
        providerOrganizationId: input.providerOrganizationId ?? null,
        tierName: resolvedTierName,
        pricesJson: sanitizePrices(input.prices ?? {}),
        discountPercent: sanitizeDiscountPercent(input.defaultDiscountPercent),
        discountPercentsJson: sanitizeDiscountPercents(
          input.discountPercents ?? {},
        ),
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
        tierName: created.tierName,
        prices: created.pricesJson ?? {},
        defaultDiscountPercent:
          created.discountPercent === null ||
          created.discountPercent === undefined
            ? null
            : Number(created.discountPercent),
        discountPercents: created.discountPercentsJson ?? {},
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
        defaultDiscountPercent: z.coerce
          .number()
          .min(0)
          .max(100)
          .nullable()
          .optional(),
        discountPercents: discountPercentsSchema.optional(),
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
    if (input.defaultDiscountPercent !== undefined)
      update.discountPercent = sanitizeDiscountPercent(
        input.defaultDiscountPercent,
      );
    if (input.discountPercents !== undefined)
      update.discountPercentsJson = sanitizeDiscountPercents(
        input.discountPercents,
      );
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
      tierName: updated.tierName,
      prices: updated.pricesJson ?? {},
      defaultDiscountPercent:
        updated.discountPercent === null ||
        updated.discountPercent === undefined
          ? null
          : Number(updated.discountPercent),
      discountPercents: updated.discountPercentsJson ?? {},
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

// ---- Pricing Settings ----

/**
 * GET /pricing/settings
 * Returns lab-level pricing settings. Any active lab admin may call this.
 */
router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    const labId = await resolveLabId(
      req,
      req.query.labOrganizationId as string | undefined,
    );
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, labId),
    });
    return ok(res, {
      labOrganizationId: labId,
      defaultDoctorTierName: org?.defaultDoctorTierName ?? null,
    });
  }),
);

/**
 * PATCH /pricing/settings
 * Update lab-level pricing settings. Admin-only.
 */
router.patch(
  "/settings",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        labOrganizationId: z.string().optional(),
        defaultDoctorTierName: z.string().max(80).nullable().optional(),
      })
      .parse(req.body);
    const labId = await resolveLabId(req, input.labOrganizationId);
    await requireAnyRole((req as any).auth.userId, labId, ADMIN_ROLES);

    const tierName =
      typeof input.defaultDoctorTierName === "string"
        ? input.defaultDoctorTierName.trim() || null
        : null;

    if (tierName) {
      const tierExists = await db.query.pricingTiers.findFirst({
        where: and(
          eq(pricingTiers.labOrganizationId, labId),
          sql`lower(trim(${pricingTiers.name})) = lower(trim(${tierName}))`,
          notDeleted(pricingTiers),
        ),
      });
      if (!tierExists) {
        throw new HttpError(422, "That tier doesn't exist in your lab.");
      }
    }

    await db
      .update(organizations)
      .set({ defaultDoctorTierName: tierName, updatedAt: new Date() })
      .where(eq(organizations.id, labId));

    await writeAuditLog({
      req,
      organizationId: labId,
      action: "pricing_settings_updated",
      entityType: "organization",
      entityId: labId,
      metadataJson: { defaultDoctorTierName: tierName },
    });

    return ok(res, {
      labOrganizationId: labId,
      defaultDoctorTierName: tierName,
    });
  }),
);

// ---- Billed analytics (server-side aggregation) ----

/**
 * Aggregate restoration revenue across the lab(s) the caller administers.
 *
 * Replaces the previous client-side aggregation that loaded every case
 * (and every restoration on every case) into the desktop renderer just
 * to bucket them by (restorationType, material). With a non-trivial case
 * history that response was several MB and took multiple seconds to
 * render. SQL `GROUP BY` does the work on the database in a single round
 * trip and ships back a few KB of summary rows.
 *
 * Optional filters: from/to (case createdAt window), providerOrganizationId,
 * doctorName (case-insensitive prefix). All filters compose with AND.
 */
router.get(
  "/billed",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        labOrganizationId: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        providerOrganizationId: z.string().optional(),
        doctorName: z.string().optional(),
      })
      .parse({
        labOrganizationId: req.query.labOrganizationId,
        from: req.query.from,
        to: req.query.to,
        providerOrganizationId: req.query.providerOrganizationId,
        doctorName: req.query.doctorName,
      });

    const labId = await resolveLabId(req, input.labOrganizationId);
    await requireAnyRole((req as any).auth.userId, labId, ADMIN_ROLES);

    const conditions = [
      eq(cases.labOrganizationId, labId),
      notDeleted(cases),
    ];
    if (input.from) {
      const d = new Date(input.from);
      if (!Number.isNaN(d.getTime())) conditions.push(gte(cases.createdAt, d));
    }
    if (input.to) {
      const d = new Date(input.to);
      if (!Number.isNaN(d.getTime())) conditions.push(lte(cases.createdAt, d));
    }
    if (input.providerOrganizationId) {
      conditions.push(
        eq(cases.providerOrganizationId, input.providerOrganizationId),
      );
    }
    if (input.doctorName) {
      const needle = input.doctorName.trim().toLowerCase();
      if (needle.length > 0) {
        conditions.push(sql`lower(${cases.doctorName}) like ${"%" + needle + "%"}`);
      }
    }

    const rows = await db
      .select({
        restorationType: caseRestorations.restorationType,
        material: caseRestorations.material,
        priceKey: caseRestorations.priceKey,
        unitsBilled: sql<number>`coalesce(sum(${caseRestorations.quantity}), 0)`,
        caseCount: sql<number>`count(distinct ${caseRestorations.caseId})`,
        totalRevenue: sql<number>`coalesce(sum(${caseRestorations.quantity} * ${caseRestorations.unitPrice}), 0)`,
        minPrice: sql<number>`min(case when ${caseRestorations.unitPrice} > 0 then ${caseRestorations.unitPrice} else null end)`,
        maxPrice: sql<number>`max(${caseRestorations.unitPrice})`,
      })
      .from(caseRestorations)
      .innerJoin(cases, eq(cases.id, caseRestorations.caseId))
      .where(and(...conditions))
      .groupBy(
        caseRestorations.restorationType,
        caseRestorations.material,
        caseRestorations.priceKey,
      );

    const aggregated = rows.map((r) => {
      const units = Number(r.unitsBilled) || 0;
      const revenue = Number(r.totalRevenue) || 0;
      return {
        restorationType: (r.restorationType ?? "Other") || "Other",
        material: (r.material ?? "").trim() || "—",
        priceKey: r.priceKey ?? null,
        unitsBilled: units,
        caseCount: Number(r.caseCount) || 0,
        totalRevenue: revenue,
        avgPrice: units > 0 ? revenue / units : 0,
        minPrice: r.minPrice == null ? 0 : Number(r.minPrice),
        maxPrice: Number(r.maxPrice) || 0,
      };
    });

    return ok(res, {
      labOrganizationId: labId,
      rows: aggregated,
    });
  }),
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
      cascadedOverrides:
        typeof after?.cascadedOverrides === "number"
          ? after.cascadedOverrides
          : null,
      cascadedConnections:
        typeof after?.cascadedConnections === "number"
          ? after.cascadedConnections
          : null,
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

// ---- Price Resolution ----

/**
 * GET /pricing/resolve
 * Resolve the canonical unit price for a specific item in the caller's lab.
 * Checks per-doctor overrides, practice-level pricing tiers, and lab defaults
 * in that priority order — the same logic used when the API generates invoices.
 * Any active lab member may call this endpoint.
 */
router.get(
  "/resolve",
  asyncHandler(async (req, res) => {
    const schema = z.object({
      labOrganizationId: z.string(),
      doctorName: z.string().optional(),
      caseType: z.string().optional(),
      material: z.string().optional(),
    });
    const input = schema.parse(req.query);
    // Verify caller is a member of that lab (throws 403 if not)
    await resolveLabIdForMember(req, input.labOrganizationId);

    const price = await resolveServerPrice(
      { labOrganizationId: input.labOrganizationId, doctorName: input.doctorName },
      input.material,
      input.caseType,
    );
    return ok(res, { price });
  }),
);

// ---- Item Labels ----

/**
 * GET /pricing/item-labels
 * Returns the merged label map for the caller's lab: configured labels
 * for any keys the admin has set, with static defaults filled in for
 * the rest.  Caller must be a lab member (not just admin).
 */
router.get(
  "/item-labels",
  asyncHandler(async (req, res) => {
    const labOrganizationId = (req.query.labOrganizationId as string) || undefined;
    const labId = await resolveLabIdForMember(req, labOrganizationId);

    const configured = await fetchLabItemLabels(labId);

    // Merge with static defaults so the response always contains every key
    const merged: Record<string, string> = {};
    for (const item of DEFAULT_TIER_ITEMS) {
      merged[item.key] = configured[item.key] ?? item.label;
    }
    // Also surface any admin-configured custom item labels (e.g. billable
    // items added via POST /pricing/add-item) so the desktop can render them
    // with their entered name instead of a title-cased slug.
    for (const [k, v] of Object.entries(configured)) {
      if (!(k in merged)) merged[k] = v;
    }

    return ok(res, { labOrganizationId: labId, labels: merged });
  })
);

/**
 * PUT /pricing/item-labels
 * Upsert the label map for the caller's lab. Admin-only.
 * Body: { labOrganizationId?, labels: { [priceKey]: string } }
 */
router.put(
  "/item-labels",
  asyncHandler(async (req, res) => {
    const schema = z.object({
      labOrganizationId: z.string().optional(),
      labels: z.record(z.string(), z.string().max(200)),
    });
    const input = schema.parse(req.body);
    const labId = await resolveLabId(req, input.labOrganizationId);

    await saveLabItemLabels(labId, input.labels);

    await writeAuditLog({
      req,
      organizationId: labId,
      action: "item_labels_updated",
      entityType: "organization",
      entityId: labId,
      metadataJson: { labels: input.labels },
    });

    const configured = await fetchLabItemLabels(labId);
    const merged: Record<string, string> = {};
    for (const item of DEFAULT_TIER_ITEMS) {
      merged[item.key] = configured[item.key] ?? item.label;
    }
    for (const [k, v] of Object.entries(configured)) {
      if (!(k in merged)) merged[k] = v;
    }

    return ok(res, { labOrganizationId: labId, labels: merged });
  })
);

/**
 * POST /pricing/add-item
 * Define a custom billable item (name, description, price) and apply it to
 * one or more pricing tiers in a single call. Admin-only, lab-scoped.
 *
 * Generates a stable, deduped custom price key from the name, upserts the
 * label + description into `lab_item_labels`, and writes the price into each
 * selected tier's `pricesJson`. Each affected tier records a
 * `pricing_tier_updated` audit entry so the change shows up in tier history.
 */
router.post(
  "/add-item",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        labOrganizationId: z.string().optional(),
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(500).nullable().optional(),
        price: z.coerce.number().min(0),
        tierIds: z.array(z.string().min(1)).min(1),
      })
      .parse(req.body);

    const labId = await resolveLabId(req, input.labOrganizationId);
    await requireAnyRole((req as any).auth.userId, labId, ADMIN_ROLES);

    // Resolve the selected tiers and confirm they all belong to this lab and
    // are not soft-deleted.
    const tierIds = Array.from(new Set(input.tierIds));
    const selectedTiers = await db.query.pricingTiers.findMany({
      where: and(
        eq(pricingTiers.labOrganizationId, labId),
        inArray(pricingTiers.id, tierIds),
        notDeleted(pricingTiers),
      ),
    });
    if (selectedTiers.length !== tierIds.length) {
      throw new HttpError(
        404,
        "One or more selected tiers were not found in this lab.",
      );
    }

    // Build the set of keys already in use across this lab so the generated
    // key is stable and collision-free.
    const existingKeys = new Set<string>(DEFAULT_TIER_KEYS as readonly string[]);
    const allTiers = await db.query.pricingTiers.findMany({
      where: and(
        eq(pricingTiers.labOrganizationId, labId),
        notDeleted(pricingTiers),
      ),
    });
    for (const t of allTiers) {
      for (const k of Object.keys(
        (t.pricesJson ?? {}) as Record<string, unknown>,
      )) {
        existingKeys.add(k);
      }
    }
    const existingLabels = await fetchLabItemLabels(labId);
    for (const k of Object.keys(existingLabels)) existingKeys.add(k);

    const name = input.name.trim();
    const description = input.description?.trim() || null;
    const priceKey = generateUniqueItemKey(name, existingKeys);

    // Persist the label + description for the new key.
    await db
      .insert(labItemLabels)
      .values({ labOrganizationId: labId, priceKey, label: name, description })
      .onConflictDoUpdate({
        target: [labItemLabels.labOrganizationId, labItemLabels.priceKey],
        set: { label: name, description, updatedAt: new Date() },
      });

    // Write the price into each selected tier, recording an audit entry per
    // tier so existing tier history surfaces the change.
    for (const tier of selectedTiers) {
      const before = tier;
      const nextPrices = {
        ...((tier.pricesJson ?? {}) as Record<string, number>),
        [priceKey]: input.price,
      };
      const [updated] = await db
        .update(pricingTiers)
        .set({ pricesJson: nextPrices, updatedAt: new Date() })
        .where(eq(pricingTiers.id, tier.id))
        .returning();

      await writeAuditLog({
        req,
        organizationId: labId,
        action: "pricing_tier_updated",
        entityType: "pricing_tier",
        entityId: tier.id,
        beforeJson: before,
        afterJson: updated,
      });
    }

    return ok(
      res,
      {
        labOrganizationId: labId,
        priceKey,
        name,
        description,
        price: input.price,
        tierIds,
        updatedTiers: selectedTiers.length,
      },
      201,
    );
  }),
);

export default router;
