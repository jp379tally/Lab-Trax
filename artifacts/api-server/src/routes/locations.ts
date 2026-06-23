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

// Canonical case-status enum values. Keep in sync with the `status` enum in
// `cases.ts` (updateCaseSchema / VALID_BULK_STATUSES). A custom station's
// mapped `status` must be one of these so locating a case writes a status the
// case PATCH handler accepts.
const VALID_CASE_STATUSES = [
  "received",
  "in_design",
  "scan",
  "in_milling",
  "post_mill",
  "sintering_furnace",
  "model_room",
  "in_porcelain",
  "qc",
  "complete",
  "shipped",
  "delivered",
  "on_hold",
  "remake",
  "cancelled",
] as const;

const caseStatusSchema = z.enum(VALID_CASE_STATUSES);

// Built-in stations: `status === code` since their codes are already valid
// case-status enum values. This preserves the previous behaviour exactly.
const BUILT_IN_STATIONS: { code: string; name: string; status: string }[] = [
  { code: "received", name: "Received", status: "received" },
  { code: "in_design", name: "In Design", status: "in_design" },
  { code: "scan", name: "Scan", status: "scan" },
  { code: "in_milling", name: "In Milling", status: "in_milling" },
  { code: "post_mill", name: "Post Mill", status: "post_mill" },
  { code: "sintering_furnace", name: "Sintering Furnace", status: "sintering_furnace" },
  { code: "model_room", name: "Model Room", status: "model_room" },
  { code: "in_porcelain", name: "Porcelain", status: "in_porcelain" },
  { code: "qc", name: "Quality Check", status: "qc" },
  { code: "complete", name: "Complete", status: "complete" },
  { code: "shipped", name: "Shipping", status: "shipped" },
  { code: "on_hold", name: "On Hold", status: "on_hold" },
  { code: "delivered", name: "Delivered", status: "delivered" },
  { code: "remake", name: "Remake", status: "remake" },
];

/**
 * Derive a stable, unique `code` for a station from its display name when the
 * caller doesn't supply one. The UI no longer asks for a free-form code (it
 * picks a mapped stage instead), but `code` is still a NOT NULL unique column,
 * so the server generates one. Falls back to the mapped status, then a random
 * suffix, and disambiguates collisions within the lab.
 */
function slugifyCode(name: string, fallback: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || fallback;
}

async function generateUniqueCode(
  organizationId: string,
  name: string,
  status: string,
): Promise<string> {
  const existing = await db
    .select({ code: labLocations.code })
    .from(labLocations)
    .where(eq(labLocations.labOrganizationId, organizationId));
  const taken = new Set(existing.map((r) => r.code.toLowerCase()));
  const base = slugifyCode(name, status);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

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
        status: s.status,
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
        // The mapped workflow stage that locating a case at this station
        // writes to the case's `status`. Required and validated against the
        // case-status enum so custom stations can never produce an invalid
        // status (the original bug).
        status: caseStatusSchema,
        // `code` is now optional — the UI picks a stage instead of typing a
        // free-form code. When omitted the server derives a unique one.
        code: z.string().min(1).optional(),
        isActive: z.boolean().optional().default(true),
        sortOrder: z.number().int().optional().default(0),
      })
      .parse(req.body);

    await requireAnyRole(userId, body.organizationId, ADMIN_ROLES);

    const code = body.code?.trim()
      ? body.code.trim()
      : await generateUniqueCode(body.organizationId, body.name, body.status);

    const [created] = await db
      .insert(labLocations)
      .values({
        labOrganizationId: body.organizationId,
        name: body.name.trim(),
        code,
        status: body.status,
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
        status: caseStatusSchema.optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body);

    const patch: Partial<typeof labLocations.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.code !== undefined) patch.code = body.code.trim();
    if (body.status !== undefined) patch.status = body.status;
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
