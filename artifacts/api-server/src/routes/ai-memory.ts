import { Router, type Request, type Response } from "express";
import { and, asc, eq, ilike, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { aiMemory, organizationMemberships } from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import { softDelete } from "../lib/soft-delete";

const router = Router();
router.use(requireAuth);

const VALID_KINDS = ["glossary", "preference", "fact"] as const;

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

function serialize(r: typeof aiMemory.$inferSelect) {
  return {
    id: r.id,
    labOrganizationId: r.labOrganizationId,
    kind: r.kind,
    key: r.key,
    value: r.value,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// GET /  — list memory entries for a lab (any active member)
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const labOrganizationId = String(req.query["labOrganizationId"] ?? "");
    if (!labOrganizationId) {
      throw new HttpError(400, "labOrganizationId is required.");
    }
    const kindFilter = String(req.query["kind"] ?? "");
    if (kindFilter && !VALID_KINDS.includes(kindFilter as (typeof VALID_KINDS)[number])) {
      throw new HttpError(400, `kind must be one of: ${VALID_KINDS.join(", ")}.`);
    }

    const userId = (req as any).auth.userId as string;
    await requireLabMembership(userId, labOrganizationId);

    const whereClauses = [
      eq(aiMemory.labOrganizationId, labOrganizationId),
      isNull(aiMemory.deletedAt),
    ];
    if (kindFilter) {
      whereClauses.push(eq(aiMemory.kind, kindFilter));
    }

    const rows = await db
      .select()
      .from(aiMemory)
      .where(and(...whereClauses))
      .orderBy(asc(aiMemory.kind), asc(aiMemory.key));

    return ok(res, rows.map(serialize));
  }),
);

const CreateMemoryInputSchema = z.object({
  labOrganizationId: z.string().min(1),
  kind: z.enum(VALID_KINDS),
  key: z.string().min(1).max(200),
  value: z.string().min(1).max(2000),
});

// POST /  — create a memory entry (lab admin only)
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = CreateMemoryInputSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid request.");

    const { labOrganizationId, kind } = parsed.data;
    const key = parsed.data.key.trim();
    const value = parsed.data.value.trim();
    if (!key) throw new HttpError(400, "key must not be blank.");
    if (!value) throw new HttpError(400, "value must not be blank.");

    const userId = (req as any).auth.userId as string;
    await requireLabAdmin(userId, labOrganizationId);

    const existing = await db.query.aiMemory.findFirst({
      where: and(
        eq(aiMemory.labOrganizationId, labOrganizationId),
        eq(aiMemory.kind, kind),
        ilike(aiMemory.key, key),
        isNull(aiMemory.deletedAt),
      ),
    });
    if (existing) {
      throw new HttpError(409, "A memory entry with that key already exists.");
    }

    const [inserted] = await db
      .insert(aiMemory)
      .values({
        labOrganizationId,
        kind,
        key,
        value,
        source: "manual",
        createdByUserId: userId,
      })
      .returning();

    return ok(res, serialize(inserted), 201);
  }),
);

const UpdateMemoryInputSchema = z.object({
  key: z.string().min(1).max(200).optional(),
  value: z.string().min(1).max(2000).optional(),
});

// PATCH /:id  — update a memory entry (lab admin only)
router.patch(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    if (!id) throw new HttpError(400, "id is required.");

    const parsed = UpdateMemoryInputSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid request.");

    const userId = (req as any).auth.userId as string;

    const existing = await db.query.aiMemory.findFirst({
      where: and(eq(aiMemory.id, id), isNull(aiMemory.deletedAt)),
    });
    if (!existing) throw new HttpError(404, "Memory entry not found.");

    await requireLabAdmin(userId, existing.labOrganizationId);

    const nextKey = parsed.data.key !== undefined ? parsed.data.key.trim() : existing.key;
    const nextValue =
      parsed.data.value !== undefined ? parsed.data.value.trim() : existing.value;
    if (!nextKey) throw new HttpError(400, "key must not be blank.");
    if (!nextValue) throw new HttpError(400, "value must not be blank.");

    if (nextKey.toLowerCase() !== existing.key.toLowerCase()) {
      const collision = await db.query.aiMemory.findFirst({
        where: and(
          eq(aiMemory.labOrganizationId, existing.labOrganizationId),
          eq(aiMemory.kind, existing.kind),
          ilike(aiMemory.key, nextKey),
          ne(aiMemory.id, id),
          isNull(aiMemory.deletedAt),
        ),
      });
      if (collision) {
        throw new HttpError(409, "A memory entry with that key already exists.");
      }
    }

    const [updated] = await db
      .update(aiMemory)
      .set({ key: nextKey, value: nextValue, updatedAt: new Date() })
      .where(eq(aiMemory.id, id))
      .returning();

    return ok(res, serialize(updated));
  }),
);

// DELETE /:id  — soft-delete a memory entry (lab admin only)
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    if (!id) throw new HttpError(400, "id is required.");

    const userId = (req as any).auth.userId as string;

    const existing = await db.query.aiMemory.findFirst({
      where: and(eq(aiMemory.id, id), isNull(aiMemory.deletedAt)),
    });
    if (!existing) throw new HttpError(404, "Memory entry not found.");

    await requireLabAdmin(userId, existing.labOrganizationId);

    await softDelete({
      table: aiMemory,
      where: eq(aiMemory.id, id),
      actorUserId: userId,
      req,
      organizationId: existing.labOrganizationId,
      entityType: "ai_memory",
      entityId: id,
      beforeJson: serialize(existing),
    });

    return ok(res, { deleted: true });
  }),
);

export default router;
