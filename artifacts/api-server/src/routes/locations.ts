import { Router, type Request, type Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { labLocations, organizationMemberships } from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

const BUILT_IN_STATIONS: { code: string; name: string }[] = [
  { code: "received", name: "Received" },
  { code: "in_design", name: "In Design" },
  { code: "scan", name: "Scan" },
  { code: "in_milling", name: "In Milling" },
  { code: "post_mill", name: "Post Mill" },
  { code: "sintering_furnace", name: "Sintering Furnace" },
  { code: "model_room", name: "Model Room" },
  { code: "in_porcelain", name: "Porcelain" },
  { code: "qc", name: "Quality Check" },
  { code: "complete", name: "Complete" },
  { code: "shipped", name: "Shipping" },
  { code: "on_hold", name: "On Hold" },
  { code: "delivered", name: "Delivered" },
  { code: "remake", name: "Remake" },
];

async function requireLabMembership(userId: string, organizationId: string) {
  const mem = await db.query.organizationMemberships.findFirst({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.labId, organizationId),
      eq(organizationMemberships.status, "active"),
    ),
  });
  if (!mem) throw new HttpError(403, "You are not a member of this organization.");
  return mem;
}

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const organizationId = String(req.query["organizationId"] ?? "");
    const activeOnly = req.query["activeOnly"] === "true";
    if (!organizationId) throw new HttpError(400, "organizationId is required.");

    const userId = (req as any).auth.userId as string;
    await requireLabMembership(userId, organizationId);

    // First check unfiltered count to decide whether to seed
    const allRows = await db
      .select()
      .from(labLocations)
      .where(eq(labLocations.labOrganizationId, organizationId))
      .orderBy(asc(labLocations.sortOrder), asc(labLocations.createdAt));

    let rows = allRows;

    if (allRows.length === 0) {
      const seedValues = BUILT_IN_STATIONS.map((s, i) => ({
        labOrganizationId: organizationId,
        name: s.name,
        code: s.code,
        isActive: true,
        sortOrder: i,
      }));
      const inserted = await db
        .insert(labLocations)
        .values(seedValues)
        .onConflictDoNothing()
        .returning();
      rows = inserted.length > 0 ? inserted : await db
        .select()
        .from(labLocations)
        .where(eq(labLocations.labOrganizationId, organizationId))
        .orderBy(asc(labLocations.sortOrder), asc(labLocations.createdAt));
    }

    if (activeOnly) {
      rows = rows.filter((r) => r.isActive);
    }

    return ok(res, rows);
  }),
);

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const body = z
      .object({
        organizationId: z.string().min(1),
        name: z.string().min(1),
        code: z.string().min(1),
        isActive: z.boolean().optional().default(true),
        sortOrder: z.number().int().optional().default(0),
      })
      .parse(req.body);

    await requireAnyRole(userId, body.organizationId, ADMIN_ROLES);

    const [created] = await db
      .insert(labLocations)
      .values({
        labOrganizationId: body.organizationId,
        name: body.name.trim(),
        code: body.code.trim(),
        isActive: body.isActive,
        sortOrder: body.sortOrder,
      })
      .returning();

    return ok(res, created, 201);
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const id = String(req.params["id"] ?? "");

    const existing = await db.query.labLocations.findFirst({
      where: eq(labLocations.id, id),
    });
    if (!existing) throw new HttpError(404, "Location not found.");

    await requireAnyRole(userId, existing.labOrganizationId, ADMIN_ROLES);

    const body = z
      .object({
        name: z.string().min(1).optional(),
        code: z.string().min(1).optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body);

    const patch: Partial<typeof labLocations.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.code !== undefined) patch.code = body.code.trim();
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;

    const [updated] = await db
      .update(labLocations)
      .set(patch)
      .where(eq(labLocations.id, id))
      .returning();

    return ok(res, updated);
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const id = String(req.params["id"] ?? "");

    const existing = await db.query.labLocations.findFirst({
      where: eq(labLocations.id, id),
    });
    if (!existing) throw new HttpError(404, "Location not found.");

    await requireAnyRole(userId, existing.labOrganizationId, ADMIN_ROLES);

    await db.delete(labLocations).where(eq(labLocations.id, id));

    return ok(res, { deleted: true });
  }),
);

export default router;
