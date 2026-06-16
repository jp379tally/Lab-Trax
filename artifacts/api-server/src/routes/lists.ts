import { Router } from "express";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, labLocations } from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";

const router = Router();

function uid(req: any): string {
  return (req as any).user?.id ?? "";
}

const orgIdQuery = z.object({ organizationId: z.string().min(1) });

router.get(
  "/locations",
  asyncHandler(async (req, res) => {
    const { organizationId } = orgIdQuery.parse(req.query);
    await requireAnyRole(uid(req), organizationId, ADMIN_ROLES);
    const rows = await db.query.labLocations.findMany({
      where: eq(labLocations.organizationId, organizationId),
      orderBy: [asc(labLocations.sortOrder), asc(labLocations.name)],
    });
    return ok(res, rows);
  })
);

const createLocationSchema = z.object({
  organizationId: z.string().min(1),
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  sortOrder: z.number().int().optional().default(0),
  isActive: z.boolean().optional().default(true),
});

router.post(
  "/locations",
  asyncHandler(async (req, res) => {
    const input = createLocationSchema.parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, ADMIN_ROLES);
    const code = input.code.trim().toUpperCase();
    const existing = await db.query.labLocations.findFirst({
      where: (t, { and, eq: deq }) =>
        and(deq(t.organizationId, input.organizationId), deq(t.code, code)),
    });
    if (existing) {
      throw new HttpError(409, `A location with code "${code}" already exists.`);
    }
    const [row] = await db
      .insert(labLocations)
      .values({
        organizationId: input.organizationId,
        code,
        name: input.name.trim(),
        sortOrder: input.sortOrder ?? 0,
        isActive: input.isActive ?? true,
      })
      .returning();
    return ok(res, row, 201);
  })
);

router.patch(
  "/locations/:id",
  asyncHandler(async (req, res) => {
    const loc = await db.query.labLocations.findFirst({
      where: eq(labLocations.id, String(req.params["id"])),
    });
    if (!loc) throw new HttpError(404, "Location not found.");
    await requireAnyRole(uid(req), loc.organizationId, ADMIN_ROLES);
    const input = z
      .object({
        code: z.string().min(1).max(20).optional(),
        name: z.string().min(1).max(100).optional(),
        sortOrder: z.number().int().optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);
    if (input.code !== undefined) {
      const newCode = input.code.trim().toUpperCase();
      if (newCode !== loc.code) {
        const clash = await db.query.labLocations.findFirst({
          where: (t, { and, eq: deq }) =>
            and(deq(t.organizationId, loc.organizationId), deq(t.code, newCode)),
        });
        if (clash) {
          throw new HttpError(409, `A location with code "${newCode}" already exists.`);
        }
      }
      input.code = input.code.trim().toUpperCase();
    }
    const [row] = await db
      .update(labLocations)
      .set({
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(labLocations.id, loc.id))
      .returning();
    return ok(res, row);
  })
);

router.delete(
  "/locations/:id",
  asyncHandler(async (req, res) => {
    const loc = await db.query.labLocations.findFirst({
      where: eq(labLocations.id, String(req.params["id"])),
    });
    if (!loc) throw new HttpError(404, "Location not found.");
    await requireAnyRole(uid(req), loc.organizationId, ADMIN_ROLES);
    await db.delete(labLocations).where(eq(labLocations.id, loc.id));
    return ok(res, { deleted: true });
  })
);

export default router;
