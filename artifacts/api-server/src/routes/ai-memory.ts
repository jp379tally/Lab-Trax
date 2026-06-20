import { Router, type Request, type Response } from "express";
import { and, asc, desc, eq, ilike, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { aiMemory, aiMemoryCandidates, organizationMemberships } from "@workspace/db";
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

// ─── Auto-learned candidates ────────────────────────────────────────────────
// Candidates are AI-extracted proposals awaiting admin review. They never feed
// the AI prompt and never become `ai_memory` until approved.

function serializeCandidate(r: typeof aiMemoryCandidates.$inferSelect) {
  return {
    id: r.id,
    labOrganizationId: r.labOrganizationId,
    kind: r.kind,
    key: r.key,
    value: r.value,
    status: r.status,
    sourceUserId: r.sourceUserId ?? null,
    reviewedByUserId: r.reviewedByUserId ?? null,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// GET /candidates — list pending candidates for a lab (lab admin only)
router.get(
  "/candidates",
  asyncHandler(async (req: Request, res: Response) => {
    const labOrganizationId = String(req.query["labOrganizationId"] ?? "");
    if (!labOrganizationId) {
      throw new HttpError(400, "labOrganizationId is required.");
    }

    const userId = (req as any).auth.userId as string;
    await requireLabAdmin(userId, labOrganizationId);

    const statusParam = String(req.query["status"] ?? "pending");
    const status = (["pending", "approved", "rejected"] as const).includes(
      statusParam as any,
    )
      ? (statusParam as "pending" | "approved" | "rejected")
      : "pending";

    const rows = await db
      .select()
      .from(aiMemoryCandidates)
      .where(
        and(
          eq(aiMemoryCandidates.labOrganizationId, labOrganizationId),
          eq(aiMemoryCandidates.status, status),
        ),
      )
      .orderBy(asc(aiMemoryCandidates.kind), desc(aiMemoryCandidates.createdAt));

    return ok(res, rows.map(serializeCandidate));
  }),
);

// POST /candidates/:id/approve — approve a candidate (lab admin only).
// Copies it into `ai_memory` (source 'learned') and marks the candidate
// approved. Idempotent against a pre-existing memory key (returns the existing
// entry). Returns the resulting memory entry.
router.post(
  "/candidates/:id/approve",
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    if (!id) throw new HttpError(400, "id is required.");

    const userId = (req as any).auth.userId as string;

    const candidate = await db.query.aiMemoryCandidates.findFirst({
      where: eq(aiMemoryCandidates.id, id),
    });
    if (!candidate) throw new HttpError(404, "Candidate not found.");

    await requireLabAdmin(userId, candidate.labOrganizationId);

    if (candidate.status !== "pending") {
      throw new HttpError(409, "This candidate has already been reviewed.");
    }

    // Optional admin edits before approving.
    const parsed = z
      .object({
        key: z.string().min(1).max(200).optional(),
        value: z.string().min(1).max(2000).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, "Invalid request.");

    const key = (parsed.data.key ?? candidate.key).trim();
    const value = (parsed.data.value ?? candidate.value).trim();
    if (!key) throw new HttpError(400, "key must not be blank.");
    if (!value) throw new HttpError(400, "value must not be blank.");

    // Atomic: the candidate is only marked approved if the memory write
    // succeeds in the same transaction. The conditional update (status =
    // 'pending') also makes this safe against concurrent double-approval.
    const result = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(aiMemoryCandidates)
        .set({
          status: "approved",
          reviewedByUserId: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiMemoryCandidates.id, id),
            eq(aiMemoryCandidates.status, "pending"),
          ),
        )
        .returning({ id: aiMemoryCandidates.id });
      if (claimed.length === 0) {
        throw new HttpError(409, "This candidate has already been reviewed.");
      }

      const existing = await tx.query.aiMemory.findFirst({
        where: and(
          eq(aiMemory.labOrganizationId, candidate.labOrganizationId),
          eq(aiMemory.kind, candidate.kind),
          ilike(aiMemory.key, key),
          isNull(aiMemory.deletedAt),
        ),
      });
      if (existing) {
        return { entry: existing, created: false };
      }

      const [inserted] = await tx
        .insert(aiMemory)
        .values({
          labOrganizationId: candidate.labOrganizationId,
          kind: candidate.kind,
          key,
          value,
          source: "learned",
          createdByUserId: userId,
        })
        .returning();

      return { entry: inserted, created: true };
    });

    return ok(res, serialize(result.entry), result.created ? 201 : 200);
  }),
);

// POST /candidates/:id/reject — reject a candidate (lab admin only)
router.post(
  "/candidates/:id/reject",
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    if (!id) throw new HttpError(400, "id is required.");

    const userId = (req as any).auth.userId as string;

    const candidate = await db.query.aiMemoryCandidates.findFirst({
      where: eq(aiMemoryCandidates.id, id),
    });
    if (!candidate) throw new HttpError(404, "Candidate not found.");

    await requireLabAdmin(userId, candidate.labOrganizationId);

    if (candidate.status !== "pending") {
      throw new HttpError(409, "This candidate has already been reviewed.");
    }

    // Conditional on status='pending' to close a concurrent approve/reject race.
    const [updated] = await db
      .update(aiMemoryCandidates)
      .set({
        status: "rejected",
        reviewedByUserId: userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiMemoryCandidates.id, id),
          eq(aiMemoryCandidates.status, "pending"),
        ),
      )
      .returning();
    if (!updated) {
      throw new HttpError(409, "This candidate has already been reviewed.");
    }

    return ok(res, serializeCandidate(updated));
  }),
);

export default router;
