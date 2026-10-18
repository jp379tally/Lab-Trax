/**
 * Lab Catalog routes — read a lab's effective Case Type → Subtype →
 * Material tree (static taxonomy + lab customizations merged at read
 * time), manage custom entries, toggle/reorder built-in entries, and
 * surface `lab_vocabulary` "material" rows that look mis-filed.
 *
 * See `../lib/lab-catalog.ts` for the merge/validation/delete-guard logic
 * this file wraps.
 */
import { Router } from "express";
import { z } from "zod";
import { db, labCatalogEntries } from "@workspace/db";
import { eq } from "drizzle-orm";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import {
  computeLegacyVocabularyReview,
  createCustomCatalogEntry,
  deleteCustomCatalogEntry,
  getEffectiveCatalogTree,
  updateCustomCatalogEntry,
  upsertBuiltinOverride,
} from "../lib/lab-catalog";

const router = Router();
router.use(requireAuth);

function uid(req: any): string {
  return (req as any).user?.id ?? "";
}

/**
 * Entry type is restricted to "subtype" | "material" at the schema level —
 * this alone is what makes case types immutable through these routes: a
 * request can never even name `entryType: "case_type"`, so there is no
 * separate runtime branch to bypass.
 */
const entryTypeSchema = z.enum(["subtype", "material"]);

async function findEntryOr404(id: string) {
  const existing = await db.query.labCatalogEntries.findFirst({
    where: eq(labCatalogEntries.id, id),
  });
  if (!existing) throw new HttpError(404, "Catalog entry not found.");
  return existing;
}

// ────────────────────────────── Effective tree ──────────────────────────────

const treeQuerySchema = z.object({
  labOrganizationId: z.string().min(1),
  includeInactive: z.string().optional(),
});

router.get(
  "/tree",
  asyncHandler(async (req, res) => {
    const query = treeQuerySchema.parse(req.query);
    await requireMembership(uid(req), query.labOrganizationId);
    const includeInactive = query.includeInactive !== "false";
    const tree = await getEffectiveCatalogTree(query.labOrganizationId, {
      includeInactive,
    });
    return ok(res, tree);
  }),
);

// ────────────────────────────── Custom entries ──────────────────────────────

const createEntrySchema = z.object({
  labOrganizationId: z.string().min(1),
  entryType: entryTypeSchema,
  caseType: z.string().min(1),
  parentKey: z.string().min(1).optional(),
  label: z.string().min(1).max(100),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  priceKeyOverride: z.string().min(1).nullable().optional(),
});

router.post(
  "/entries",
  asyncHandler(async (req, res) => {
    const input = createEntrySchema.parse(req.body);
    await requireAnyRole(uid(req), input.labOrganizationId, ADMIN_ROLES);
    const row = await createCustomCatalogEntry({
      labOrganizationId: input.labOrganizationId,
      entryType: input.entryType,
      caseType: input.caseType,
      parentKey: input.parentKey ?? null,
      label: input.label,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
      priceKeyOverride: input.priceKeyOverride,
      createdByUserId: uid(req),
    });
    return ok(res, row, 201);
  }),
);

const updateEntrySchema = z.object({
  label: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  priceKeyOverride: z.string().min(1).nullable().optional(),
});

router.patch(
  "/entries/:id",
  asyncHandler(async (req, res) => {
    const existing = await findEntryOr404(String(req.params["id"]));
    await requireAnyRole(uid(req), existing.labOrganizationId, ADMIN_ROLES);
    const input = updateEntrySchema.parse(req.body);
    const row = await updateCustomCatalogEntry(existing, input);
    return ok(res, row);
  }),
);

router.delete(
  "/entries/:id",
  asyncHandler(async (req, res) => {
    const existing = await findEntryOr404(String(req.params["id"]));
    await requireAnyRole(uid(req), existing.labOrganizationId, ADMIN_ROLES);
    const force = req.query["force"] === "true";
    const result = await deleteCustomCatalogEntry(existing, force);

    // Mirror lab_vocabulary's delete-guard response shape exactly (flat
    // `usageCount`, `error` key) rather than the generic HttpError envelope,
    // so both endpoints are consistent for client error handling.
    if (!result.deleted) {
      res.status(409).json({
        ok: false,
        error: `This entry is used in ${result.usageCount} case restoration(s). Pass force=true to delete anyway.`,
        usageCount: result.usageCount,
      });
      return;
    }

    return ok(res, result);
  }),
);

// ────────────────────────────── Built-in overrides ──────────────────────────

const builtinOverrideSchema = z.object({
  labOrganizationId: z.string().min(1),
  entryType: entryTypeSchema,
  caseType: z.string().min(1),
  parentKey: z.string().min(1).optional(),
  key: z.string().min(1),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  priceKeyOverride: z.string().min(1).nullable().optional(),
});

router.patch(
  "/builtin-overrides",
  asyncHandler(async (req, res) => {
    const input = builtinOverrideSchema.parse(req.body);
    await requireAnyRole(uid(req), input.labOrganizationId, ADMIN_ROLES);
    const row = await upsertBuiltinOverride({
      labOrganizationId: input.labOrganizationId,
      entryType: input.entryType,
      caseType: input.caseType,
      parentKey: input.parentKey ?? null,
      key: input.key,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
      priceKeyOverride: input.priceKeyOverride,
      createdByUserId: uid(req),
    });
    return ok(res, row);
  }),
);

// ────────────────────────── Legacy-vocabulary review ────────────────────────

const reviewQuerySchema = z.object({ labOrganizationId: z.string().min(1) });

router.get(
  "/legacy-vocabulary-review",
  asyncHandler(async (req, res) => {
    const query = reviewQuerySchema.parse(req.query);
    await requireAnyRole(uid(req), query.labOrganizationId, ADMIN_ROLES);
    const candidates = await computeLegacyVocabularyReview(
      query.labOrganizationId,
    );
    return ok(res, candidates);
  }),
);

export default router;
