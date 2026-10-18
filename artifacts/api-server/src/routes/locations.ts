import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  caseEvents,
  caseLocations,
  cases,
  labCases,
  labLocations,
  organizationMemberships,
} from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import { BUILT_IN_LAB_STATIONS } from "../lib/lab-locations";
import { canonicalStatusToLegacy } from "../lib/case-status";
import { acquireCaseLocationStatusLock } from "../lib/case-location-status";

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
/**
 * Derive a workflow status from a station name by matching against known
 * built-in station names/codes. Falls back to "received" when no match found.
 * Used when the caller doesn't supply a status (the UI no longer exposes it).
 */
function deriveStatusFromName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const match = BUILT_IN_LAB_STATIONS.find(
    (s) =>
      s.name.toLowerCase() === normalized ||
      s.code === normalized ||
      s.status === normalized
  );
  return match?.status ?? "received";
}

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
      const seedValues = BUILT_IN_LAB_STATIONS.map((s, i) => ({
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
        // `status` is now optional — when omitted the server derives it from
        // the station name. When supplied it is validated against the
        // case-status enum so custom stations can never produce an invalid
        // status.
        status: caseStatusSchema.optional(),
        // `code` is optional — the server derives a unique slug when omitted.
        code: z.string().min(1).optional(),
        isActive: z.boolean().optional().default(true),
        sortOrder: z.number().int().optional().default(0),
      })
      .parse(req.body);

    await requireAnyRole(userId, body.organizationId, ADMIN_ROLES);

    const status = body.status ?? deriveStatusFromName(body.name);
    const code = body.code?.trim()
      ? body.code.trim()
      : await generateUniqueCode(body.organizationId, body.name, status);

    const [created] = await db
      .insert(labLocations)
      .values({
        labOrganizationId: body.organizationId,
        name: body.name.trim(),
        code,
        status,
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

    const updated = await db.transaction(async (tx) => {
      await acquireCaseLocationStatusLock(tx);
      const [location] = await tx
        .update(labLocations)
        .set(patch)
        .where(eq(labLocations.id, id))
        .returning();

      if (body.status !== undefined) {
        await tx
          .update(cases)
          .set({
            status: body.status,
            casePanBarcode: body.status === "complete" ? null : undefined,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(cases.labOrganizationId, existing.labOrganizationId),
              eq(cases.labLocationId, id),
            ),
          );

        const legacyRows = await tx
          .select({ id: labCases.id, caseData: labCases.caseData })
          .from(labCases)
          .where(eq(labCases.organizationId, existing.labOrganizationId))
          .for("update");
        const legacyStatus = canonicalStatusToLegacy(body.status);
        for (const row of legacyRows) {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(row.caseData);
          } catch {
            continue;
          }
          if (parsed.labLocationId !== id) continue;
          parsed.status = legacyStatus;
          if (body.status === "complete") parsed.assignedBarcode = null;
          await tx
            .update(labCases)
            .set({ caseData: JSON.stringify(parsed), updatedAt: new Date() })
            .where(eq(labCases.id, row.id));
        }
      }
      return location;
    });

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

    const actorInitials = (req as any).user?.initials || "SYS";
    await db.transaction(async (tx) => {
      await acquireCaseLocationStatusLock(tx);
      const [lockedLocation] = await tx
        .select()
        .from(labLocations)
        .where(eq(labLocations.id, id))
        .for("update");
      if (!lockedLocation) throw new HttpError(404, "Location not found.");

      const attachedCases = await tx
        .select({ id: cases.id })
        .from(cases)
        .where(
          and(
            eq(cases.labOrganizationId, lockedLocation.labOrganizationId),
            eq(cases.labLocationId, id),
          ),
        )
        .for("update");
      const movedAt = new Date();
      for (const attached of attachedCases) {
        await tx
          .update(cases)
          .set({ labLocationId: null, updatedAt: movedAt })
          .where(eq(cases.id, attached.id));
        const [history] = await tx
          .insert(caseLocations)
          .values({
            caseId: attached.id,
            locationCode: "unassigned",
            locationName: "Unassigned",
            movedByUserId: userId,
            movedAt,
            notes: "Station deleted",
          })
          .returning();
        await tx.insert(caseEvents).values({
          caseId: attached.id,
          eventType: "location_changed",
          actorUserId: userId,
          actorOrganizationId: lockedLocation.labOrganizationId,
          actorInitials,
          occurredAt: movedAt,
          metadataJson: {
            locationId: history.id,
            labLocationId: null,
            locationCode: "unassigned",
            locationName: "Unassigned",
            previousLabLocationId: id,
            previousLocationCode: lockedLocation.code,
            previousLocationName: lockedLocation.name,
            fromLocationId: id,
            fromLocation: lockedLocation.name,
            toLocationId: null,
            toLocation: "Unassigned",
          },
        });
      }

      const legacyRows = await tx
        .select({ id: labCases.id, caseData: labCases.caseData })
        .from(labCases)
        .where(eq(labCases.organizationId, lockedLocation.labOrganizationId))
        .for("update");
      for (const row of legacyRows) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(row.caseData);
        } catch {
          continue;
        }
        if (parsed.labLocationId !== id) continue;
        parsed.labLocationId = null;
        const locationHistory = Array.isArray(parsed.locationHistory)
          ? parsed.locationHistory
          : [];
        locationHistory.push({
          id: randomUUID(),
          previous: {
            id,
            code: lockedLocation.code,
            name: lockedLocation.name,
          },
          destination: {
            id: null,
            code: "unassigned",
            name: "Unassigned",
          },
          movedAt: movedAt.toISOString(),
          movedByUserId: userId,
          actorInitials,
        });
        parsed.locationHistory = locationHistory;
        await tx
          .update(labCases)
          .set({ caseData: JSON.stringify(parsed), updatedAt: movedAt })
          .where(eq(labCases.id, row.id));
      }

      await tx.delete(labLocations).where(eq(labLocations.id, id));
    });

    return ok(res, { deleted: true });
  }),
);

export default router;
