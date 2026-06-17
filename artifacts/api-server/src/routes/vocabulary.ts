import { Router, type Request, type Response } from "express";
import { and, asc, count, eq, ilike, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { cases, caseRestorations, labCases, labVocabulary, organizationMemberships } from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

const VOCAB_DEFAULTS: Record<string, string[]> = {
  material: [
    "Zirconia",
    "PFM",
    "E.max",
    "Full Cast",
    "Composite",
    "Acrylic",
    "Metal",
    "PMMA",
    "Other",
  ],
  shade: [
    "A1", "A2", "A3", "A3.5", "A4",
    "B1", "B2", "B3", "B4",
    "C1", "C2", "C3", "C4",
    "D2", "D3", "D4",
    "BL1", "BL2", "BL3", "BL4",
  ],
  restoration_type: [
    "Crown",
    "Bridge",
    "Veneer",
    "Implant Crown",
    "Inlay",
    "Onlay",
    "Full Denture",
    "Partial Denture",
    "Night Guard",
    "Retainer",
    "Sports Guard",
    "Snore Guard",
    "Other",
  ],
};

export { VOCAB_DEFAULTS };

const VALID_KINDS = ["material", "shade", "restoration_type"] as const;

async function requireLabMembership(userId: string, labOrganizationId: string) {
  const mem = await db.query.organizationMemberships.findFirst({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.labId, labOrganizationId),
      eq(organizationMemberships.status, "active"),
    ),
  });
  if (!mem) throw new HttpError(403, "You are not a member of this organization.");
  return mem;
}

async function requireLabAdmin(userId: string, labOrganizationId: string) {
  const mem = await requireLabMembership(userId, labOrganizationId);
  if (mem.role !== "admin" && mem.role !== "owner") {
    throw new HttpError(403, "Admin role required.");
  }
  return mem;
}

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const kind = String(req.query["kind"] ?? "");
    const labOrganizationId = String(req.query["labOrganizationId"] ?? "");
    if (!kind) throw new HttpError(400, "kind is required.");
    if (!VALID_KINDS.includes(kind as any)) {
      throw new HttpError(400, `kind must be one of: ${VALID_KINDS.join(", ")}.`);
    }
    if (!labOrganizationId) throw new HttpError(400, "labOrganizationId is required.");

    const userId = (req as any).auth.userId as string;
    await requireLabMembership(userId, labOrganizationId);

    const dbRows = await db
      .select()
      .from(labVocabulary)
      .where(
        and(
          eq(labVocabulary.labOrganizationId, labOrganizationId),
          eq(labVocabulary.kind, kind),
        ),
      )
      .orderBy(asc(labVocabulary.createdAt));

    const defaults = (VOCAB_DEFAULTS[kind] ?? []).map((value) => ({
      id: `default:${kind}:${value}`,
      kind,
      value,
      isDefault: true,
    }));

    const dbItems = dbRows.map((r) => ({
      id: r.id,
      kind: r.kind,
      value: r.value,
      isDefault: false,
    }));

    const defaultValuesLower = new Set(defaults.map((d) => d.value.toLowerCase()));
    const uniqueDbItems = dbItems.filter(
      (item) => !defaultValuesLower.has(item.value.toLowerCase()),
    );

    return ok(res, [...defaults, ...uniqueDbItems]);
  }),
);

const CreateVocabularyInputSchema = z.object({
  kind: z.enum(VALID_KINDS),
  value: z.string().min(1).max(200),
  labOrganizationId: z.string().min(1),
});

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = CreateVocabularyInputSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid request.");

    const { kind, value, labOrganizationId } = parsed.data;
    const trimmedValue = value.trim();
    if (!trimmedValue) throw new HttpError(400, "value must not be blank.");

    const userId = (req as any).auth.userId as string;
    await requireLabMembership(userId, labOrganizationId);

    const defaults = VOCAB_DEFAULTS[kind] ?? [];
    const defaultMatch = defaults.find(
      (d) => d.toLowerCase() === trimmedValue.toLowerCase(),
    );
    if (defaultMatch) {
      return ok(res, {
        id: `default:${kind}:${defaultMatch}`,
        kind,
        value: defaultMatch,
        isDefault: true,
      });
    }

    const existing = await db.query.labVocabulary.findFirst({
      where: and(
        eq(labVocabulary.labOrganizationId, labOrganizationId),
        eq(labVocabulary.kind, kind),
        ilike(labVocabulary.value, trimmedValue),
      ),
    });

    if (existing) {
      return ok(res, {
        id: existing.id,
        kind: existing.kind,
        value: existing.value,
        isDefault: false,
      });
    }

    const [inserted] = await db
      .insert(labVocabulary)
      .values({
        labOrganizationId,
        kind,
        value: trimmedValue,
        createdByUserId: userId,
      })
      .returning();

    return ok(res, {
      id: inserted.id,
      kind: inserted.kind,
      value: inserted.value,
      isDefault: false,
    }, 201);
  }),
);

const UpdateVocabularyInputSchema = z.object({
  value: z.string().min(1).max(200),
});

router.patch(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    if (!id) throw new HttpError(400, "id is required.");

    const parsed = UpdateVocabularyInputSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid request.");

    const trimmedValue = parsed.data.value.trim();
    if (!trimmedValue) throw new HttpError(400, "value must not be blank.");

    const userId = (req as any).auth.userId as string;

    const existing = await db.query.labVocabulary.findFirst({
      where: eq(labVocabulary.id, id),
    });
    if (!existing) throw new HttpError(404, "Vocabulary item not found.");

    await requireLabAdmin(userId, existing.labOrganizationId);

    // Reject if the new value matches a default (case-insensitive)
    const defaults = VOCAB_DEFAULTS[existing.kind] ?? [];
    const defaultMatch = defaults.find(
      (d) => d.toLowerCase() === trimmedValue.toLowerCase(),
    );
    if (defaultMatch) {
      throw new HttpError(409, "That value already exists as a built-in default.");
    }

    // Reject if another custom item already has that value (case-insensitive)
    const collision = await db.query.labVocabulary.findFirst({
      where: and(
        eq(labVocabulary.labOrganizationId, existing.labOrganizationId),
        eq(labVocabulary.kind, existing.kind),
        ilike(labVocabulary.value, trimmedValue),
        ne(labVocabulary.id, id),
      ),
    });
    if (collision) {
      throw new HttpError(409, "A vocabulary item with that value already exists.");
    }

    const [updated] = await db
      .update(labVocabulary)
      .set({ value: trimmedValue })
      .where(eq(labVocabulary.id, id))
      .returning();

    return ok(res, {
      id: updated.id,
      kind: updated.kind,
      value: updated.value,
      isDefault: false,
    });
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    if (!id) throw new HttpError(400, "id is required.");

    const userId = (req as any).auth.userId as string;

    const existing = await db.query.labVocabulary.findFirst({
      where: eq(labVocabulary.id, id),
    });
    if (!existing) throw new HttpError(404, "Vocabulary item not found.");

    await requireLabAdmin(userId, existing.labOrganizationId);

    // Count how many case restorations in this lab reference this vocabulary value.
    const kindToCol = {
      material: caseRestorations.material,
      shade: caseRestorations.shade,
      restoration_type: caseRestorations.restorationType,
    } as const;

    const col = kindToCol[existing.kind as keyof typeof kindToCol];
    const [usageRow] = await db
      .select({ usageCount: count() })
      .from(caseRestorations)
      .innerJoin(cases, eq(caseRestorations.caseId, cases.id))
      .where(
        and(
          eq(cases.labOrganizationId, existing.labOrganizationId),
          ilike(col, existing.value),
        ),
      );

    const canonicalUsageCount = usageRow?.usageCount ?? 0;

    // Legacy mobile cases store their restorations as a JSON blob in
    // `lab_cases.caseData` and have no `case_restorations` rows, so the
    // canonical count above misses them. Scan the blob for the same field.
    const legacyFieldByKind = {
      material: "material",
      shade: "shade",
      restoration_type: "restorationType",
    } as const;
    const legacyField = legacyFieldByKind[existing.kind as keyof typeof legacyFieldByKind];
    const targetValue = existing.value.toLowerCase();

    const legacyRows = await db
      .select({ caseData: labCases.caseData })
      .from(labCases)
      .where(
        and(
          eq(labCases.organizationId, existing.labOrganizationId),
          isNull(labCases.deletedAt),
        ),
      );

    let legacyUsageCount = 0;
    for (const row of legacyRows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.caseData);
      } catch {
        continue;
      }
      const restorations = (parsed as { restorations?: unknown })?.restorations;
      if (!Array.isArray(restorations)) continue;
      for (const r of restorations) {
        const fieldValue = (r as Record<string, unknown> | null)?.[legacyField];
        if (
          typeof fieldValue === "string" &&
          fieldValue.toLowerCase() === targetValue
        ) {
          legacyUsageCount += 1;
        }
      }
    }

    const usageCount = canonicalUsageCount + legacyUsageCount;
    const force = req.query["force"] === "true";

    if (usageCount > 0 && !force) {
      res.status(409).json({
        ok: false,
        error: `This term is used in ${usageCount} case restoration(s). Pass force=true to delete anyway.`,
        usageCount,
      });
      return;
    }

    await db.delete(labVocabulary).where(eq(labVocabulary.id, id));

    return ok(res, { deleted: true, usageCount });
  }),
);

export default router;
