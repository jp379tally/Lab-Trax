import { Router } from "express";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  auditLogs,
  caseRestorations,
  cases,
  organizationConnections,
  organizationMemberships,
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
  resolveAllPricesForContext,
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

function sanitizePrices(input: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
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

    // Only allow saving labels for known price keys
    const knownKeys = new Set<string>(DEFAULT_TIER_ITEMS.map((i) => i.key));
    const filteredLabels: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.labels)) {
      if (knownKeys.has(k)) filteredLabels[k] = v;
    }

    await saveLabItemLabels(labId, filteredLabels);

    await writeAuditLog({
      req,
      organizationId: labId,
      action: "item_labels_updated",
      entityType: "organization",
      entityId: labId,
      metadataJson: { labels: filteredLabels },
    });

    const configured = await fetchLabItemLabels(labId);
    const merged: Record<string, string> = {};
    for (const item of DEFAULT_TIER_ITEMS) {
      merged[item.key] = configured[item.key] ?? item.label;
    }

    return ok(res, { labOrganizationId: labId, labels: merged });
  })
);

export default router;
