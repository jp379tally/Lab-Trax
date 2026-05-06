import * as fs from "node:fs";
import * as path from "node:path";
import { Router } from "express";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  caseAttachments,
  caseEvents,
  caseLocations,
  caseNotes,
  caseRestorations,
  caseSubmissionQueue,
  cases,
  labCases,
  organizationConnections,
  organizationMemberships,
  users,
} from "@workspace/db";
import { writeAuditLog } from "../lib/audit";
import { caseMediaDir, extractMediaFileName } from "../lib/case-media";
import { deleteFromOneDrive } from "../lib/onedrive";
import { HttpError, ok } from "../lib/http";
import { resolveServerPriceWithSource } from "../lib/pricing";
import { ADMIN_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

async function assertCaseAccess(userId: string, caseId: string) {
  const access = await assertCaseAccessWithMemberships(userId, caseId);
  return access.case;
}

async function assertCaseAccessWithMemberships(userId: string, caseId: string) {
  const found = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
  });
  if (!found) throw new HttpError(404, "Case not found.");
  const labMembership = await requireMembership(
    userId,
    found.labOrganizationId
  ).catch(() => null);
  const providerMembership = await requireMembership(
    userId,
    found.providerOrganizationId
  ).catch(() => null);
  if (!labMembership && !providerMembership)
    throw new HttpError(403, "You do not have access to this case.");
  return { case: found, labMembership, providerMembership };
}

const ATTACHMENT_VISIBILITIES = [
  "shared_with_provider",
  "internal_lab_only",
] as const;

function visibleAttachmentsFor(
  attachments: any[],
  isLabMember: boolean
): any[] {
  if (isLabMember) return attachments;
  return attachments.filter(
    (a: any) => a.visibility !== "internal_lab_only"
  );
}

const createCaseSchema = z.object({
  caseNumber: z.string().min(1),
  labOrganizationId: z.string(),
  providerOrganizationId: z.string(),
  patientFirstName: z.string().min(1),
  patientLastName: z.string().min(1),
  externalPatientId: z.string().optional(),
  doctorName: z.string().min(1),
  status: z
    .enum([
      "received",
      "in_design",
      "in_milling",
      "in_porcelain",
      "qc",
      "shipped",
      "delivered",
      "on_hold",
      "remake",
      "cancelled",
    ])
    .default("received"),
  priority: z.enum(["normal", "rush"]).default("normal"),
  dueDate: z.string().optional(),
  restorations: z
    .array(
      z.object({
        toothNumber: z.string().min(1),
        restorationType: z.string().min(1),
        material: z.string().optional(),
        shade: z.string().optional(),
        notes: z.string().optional(),
        quantity: z.coerce.number().int().positive().default(1),
        unitPrice: z.coerce.number().min(0).default(0),
      })
    )
    .optional(),
});

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createCaseSchema.parse(req.body);
    await requireMembership(
      (req as any).auth.userId,
      input.labOrganizationId
    );

    const [createdCase] = await db
      .insert(cases)
      .values({
        caseNumber: input.caseNumber,
        labOrganizationId: input.labOrganizationId,
        providerOrganizationId: input.providerOrganizationId,
        patientFirstName: input.patientFirstName,
        patientLastName: input.patientLastName,
        externalPatientId: input.externalPatientId ?? null,
        doctorName: input.doctorName,
        status: input.status,
        priority: input.priority,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        createdByUserId: (req as any).auth.userId,
      })
      .returning();

    if (input.restorations && input.restorations.length > 0) {
      const resolved = await Promise.all(
        input.restorations.map(async (r) => {
          let unit = r.unitPrice;
          const userSupplied = Number.isFinite(unit) && unit > 0;
          let priceSource: string | null = userSupplied ? "manual" : null;
          let priceSourceId: string | null = null;
          let priceSourceName: string | null = null;
          let priceKey: string | null = null;
          if (!userSupplied) {
            const fallback = await resolveServerPriceWithSource(
              {
                labOrganizationId: input.labOrganizationId,
                doctorName: input.doctorName,
                providerOrganizationId: input.providerOrganizationId,
              },
              r.material,
              r.restorationType
            );
            if (fallback) {
              unit = fallback.amount;
              priceSource = fallback.source;
              priceSourceId = fallback.sourceId;
              priceSourceName = fallback.sourceName;
              priceKey = fallback.key;
            }
          }
          return {
            caseId: createdCase.id,
            toothNumber: r.toothNumber,
            restorationType: r.restorationType,
            material: r.material ?? null,
            shade: r.shade ?? null,
            notes: r.notes ?? null,
            quantity: r.quantity,
            unitPrice: unit.toFixed(2),
            priceSource,
            priceSourceId,
            priceSourceName,
            priceKey,
          };
        })
      );
      await db.insert(caseRestorations).values(resolved);
    }

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: createdCase.id,
      eventType: "case_created",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: input.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        patientFirstName: input.patientFirstName,
        patientLastName: input.patientLastName,
        restorations: input.restorations?.length || 0,
      },
    });

    await writeAuditLog({
      req,
      organizationId: input.labOrganizationId,
      action: "case_created",
      entityType: "case",
      entityId: createdCase.id,
      afterJson: createdCase,
    });
    return ok(res, createdCase, 201);
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const organizationId = req.query.organizationId as string | undefined;
    const include = String(req.query.include ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const includeRestorations = include.includes("restorations");
    const membershipOrgIds = organizationId
      ? [organizationId]
      : (
          await db.query.organizationMemberships.findMany({
            where: eq(
              organizationMemberships.userId,
              (req as any).auth.userId
            ),
          })
        ).map((m: any) => m.labId);

    // Status map: mobile legacy → desktop format
    const MOBILE_TO_DESKTOP_STATUS: Record<string, string> = {
      INTAKE: "received",
      DESIGN: "in_design",
      MILLING: "in_milling",
      PORCELAIN: "in_porcelain",
      QC_CHECK: "qc",
      DELIVERY: "shipped",
      COMPLETE: "delivered",
      ON_HOLD: "on_hold",
      REMAKE: "remake",
    };

    const [rows, mobileRows] = await Promise.all([
      membershipOrgIds.length
        ? db.query.cases.findMany({
            where: or(
              inArray(cases.labOrganizationId, membershipOrgIds),
              inArray(cases.providerOrganizationId, membershipOrgIds)
            ),
            orderBy: [desc(cases.createdAt)],
          })
        : Promise.resolve([]),
      membershipOrgIds.length
        ? db
            .select()
            .from(labCases)
            .where(
              and(
                isNull(labCases.deletedAt),
                inArray(labCases.organizationId, membershipOrgIds)
              )
            )
        : Promise.resolve([]),
    ]);

    const caseIds = rows.map((r: any) => r.id);
    const restorations = caseIds.length
      ? await db.query.caseRestorations.findMany({
          where: inArray(caseRestorations.caseId, caseIds),
        })
      : [];
    const byCase = new Map<string, typeof restorations>();
    for (const r of restorations) {
      const list = byCase.get(r.caseId) ?? [];
      list.push(r);
      byCase.set(r.caseId, list);
    }
    const enriched: any[] = rows.map((row: any) => {
      const items = byCase.get(row.id) ?? [];
      const teeth = items.map((i: any) => i.toothNumber).join(", ");
      const types = Array.from(
        new Set(items.map((i: any) => i.restorationType).filter(Boolean))
      ).join(", ");
      const materials = Array.from(
        new Set(items.map((i: any) => i.material).filter(Boolean))
      ).join(", ");
      const price = items.reduce(
        (sum: number, i: any) =>
          sum + Number(i.quantity ?? 0) * Number(i.unitPrice ?? 0),
        0
      );
      return {
        ...row,
        restorationCount: items.length,
        restorationTypes: types || null,
        restorationMaterials: materials || null,
        teeth: teeth || null,
        totalPrice: price.toFixed(2),
        ...(includeRestorations ? { restorations: items } : {}),
      };
    });

    // Bridge mobile cases into the desktop list so users see everything
    // regardless of which platform they used to create the case.
    const desktopIdSet = new Set(rows.map((r: any) => r.id));
    for (const mr of mobileRows) {
      if (desktopIdSet.has(mr.id)) continue;
      try {
        const parsed = typeof mr.caseData === "string" ? JSON.parse(mr.caseData) : mr.caseData;
        if (!parsed || typeof parsed !== "object") continue;
        const patientName = String(parsed.patientName ?? "");
        const spaceIdx = patientName.indexOf(" ");
        const firstName = spaceIdx >= 0 ? patientName.slice(0, spaceIdx) : patientName;
        const lastName = spaceIdx >= 0 ? patientName.slice(spaceIdx + 1) : "";
        const rawStatus = String(parsed.status ?? "INTAKE").toUpperCase();
        const desktopStatus = MOBILE_TO_DESKTOP_STATUS[rawStatus] ?? "received";
        const createdAt = parsed.createdAt
          ? new Date(Number(parsed.createdAt)).toISOString()
          : new Date().toISOString();
        const updatedAt = parsed.updatedAt
          ? new Date(Number(parsed.updatedAt)).toISOString()
          : createdAt;
        enriched.push({
          id: mr.id,
          caseNumber: String(parsed.caseNumber ?? ""),
          labOrganizationId: mr.organizationId ?? null,
          providerOrganizationId: null,
          patientFirstName: firstName,
          patientLastName: lastName,
          doctorName: String(parsed.doctorName ?? ""),
          status: desktopStatus,
          priority: parsed.isRush ? "rush" : "normal",
          dueDate: parsed.dueDate ?? null,
          createdByUserId: mr.ownerId,
          createdAt,
          updatedAt,
          restorationCount: 0,
          restorationTypes: parsed.caseType ?? null,
          restorationMaterials: parsed.material ?? null,
          teeth: parsed.toothIndices ?? null,
          totalPrice: parsed.price != null ? String(parsed.price) : "0.00",
          _source: "mobile",
        });
      } catch {
        // skip malformed rows
      }
    }

    if (!enriched.length) return ok(res, []);
    return ok(res, enriched);
  })
);

router.get(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const access = await assertCaseAccessWithMemberships(
      (req as any).auth.userId,
      req.params.caseId
    );
    const found = access.case;
    const [restorations, notes, attachments, events, locations] =
      await Promise.all([
        db.query.caseRestorations.findMany({
          where: eq(caseRestorations.caseId, found.id),
        }),
        db.query.caseNotes.findMany({
          where: eq(caseNotes.caseId, found.id),
          orderBy: [desc(caseNotes.createdAt)],
        }),
        db.query.caseAttachments.findMany({
          where: eq(caseAttachments.caseId, found.id),
          orderBy: [desc(caseAttachments.createdAt)],
        }),
        db.query.caseEvents.findMany({
          where: eq(caseEvents.caseId, found.id),
          orderBy: [desc(caseEvents.occurredAt)],
        }),
        db.query.caseLocations.findMany({
          where: eq(caseLocations.caseId, found.id),
        }),
      ]);

    const uploaderIds = Array.from(
      new Set(attachments.map((a: any) => a.uploadedByUserId).filter(Boolean))
    );
    const uploaderRows = uploaderIds.length
      ? await db.query.users.findMany({ where: inArray(users.id, uploaderIds) })
      : [];
    const uploaderById = new Map(uploaderRows.map((u: any) => [u.id, u]));
    const enrichedAttachments = attachments.map((a: any) => {
      const u = uploaderById.get(a.uploadedByUserId) as any | undefined;
      const name = u
        ? [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          u.username ||
          u.email ||
          null
        : null;
      return { ...a, uploaderName: name };
    });

    const isLabMember = !!access.labMembership;
    const labRole = access.labMembership?.role as string | undefined;
    const viewerCanManageAttachments =
      isLabMember && !!labRole && (ADMIN_ROLES as string[]).includes(labRole);

    return ok(res, {
      ...found,
      restorations,
      notes,
      attachments: visibleAttachmentsFor(enrichedAttachments, isLabMember),
      events,
      locations,
      viewerIsLabMember: isLabMember,
      viewerCanManageAttachments,
    });
  })
);

router.get(
  "/:caseId/attachments",
  asyncHandler(async (req, res) => {
    const access = await assertCaseAccessWithMemberships(
      (req as any).auth.userId,
      req.params.caseId
    );
    const found = access.case;
    const attachments = await db.query.caseAttachments.findMany({
      where: eq(caseAttachments.caseId, found.id),
      orderBy: [desc(caseAttachments.createdAt)],
    });
    const uploaderIds = Array.from(
      new Set(attachments.map((a: any) => a.uploadedByUserId).filter(Boolean))
    );
    const uploaderRows = uploaderIds.length
      ? await db.query.users.findMany({ where: inArray(users.id, uploaderIds) })
      : [];
    const uploaderById = new Map(uploaderRows.map((u: any) => [u.id, u]));
    const enriched = attachments.map((a: any) => {
      const u = uploaderById.get(a.uploadedByUserId) as any | undefined;
      const name = u
        ? [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          u.username ||
          u.email ||
          null
        : null;
      return { ...a, uploaderName: name };
    });
    const isLabMember = !!access.labMembership;
    return ok(res, visibleAttachmentsFor(enriched, isLabMember));
  })
);

const updateAttachmentSchema = z.object({
  visibility: z.enum(ATTACHMENT_VISIBILITIES),
});

router.patch(
  "/:caseId/attachments/:attachmentId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );
    const input = updateAttachmentSchema.parse(req.body);
    const attachment = await db.query.caseAttachments.findFirst({
      where: and(
        eq(caseAttachments.id, req.params.attachmentId),
        eq(caseAttachments.caseId, found.id)
      ),
    });
    if (!attachment) throw new HttpError(404, "Attachment not found.");
    if (attachment.visibility === input.visibility) {
      return ok(res, attachment);
    }
    const [updated] = await db
      .update(caseAttachments)
      .set({ visibility: input.visibility })
      .where(eq(caseAttachments.id, attachment.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "case_attachment_visibility_changed",
      entityType: "case_attachment",
      entityId: attachment.id,
      beforeJson: attachment,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

// Best-effort removal of the underlying file backing a case attachment.
// The DB row's `storageKey` is the public URL the file was uploaded to
// (e.g. https://host/uploads/case-media/<filename>). We only ever delete
// inside `uploads/case-media/` and resolve paths defensively so a crafted
// storageKey can't escape the media directory.
function removeAttachmentFile(
  req: any,
  storageKey: string | null | undefined
): void {
  if (!storageKey) return;
  try {
    const fileName = extractMediaFileName(storageKey);
    if (!fileName) return;
    const resolved = path.resolve(caseMediaDir, fileName);
    if (
      resolved !== caseMediaDir &&
      (resolved + path.sep).startsWith(caseMediaDir + path.sep)
    ) {
      fs.rmSync(resolved, { force: true });
    }
  } catch (err: any) {
    req.log?.warn?.(
      { err: err?.message || String(err), storageKey },
      "Failed to remove underlying attachment file"
    );
  }
}

async function removeAttachmentFromOneDrive(
  req: any,
  storageKey: string | null | undefined
): Promise<void> {
  if (!storageKey) return;
  try {
    const fileName = extractMediaFileName(storageKey);
    if (!fileName) return;
    const result = await deleteFromOneDrive(fileName);
    if (result === "deleted" || result === "missing") {
      req.log?.info?.(
        { fileName, result },
        "Removed mirrored attachment from OneDrive"
      );
    }
  } catch (err: any) {
    req.log?.warn?.(
      { err: err?.message || String(err), storageKey },
      "Failed to remove mirrored attachment from OneDrive"
    );
  }
}

router.delete(
  "/:caseId/attachments/:attachmentId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const attachment = await db.query.caseAttachments.findFirst({
      where: and(
        eq(caseAttachments.id, req.params.attachmentId),
        eq(caseAttachments.caseId, found.id)
      ),
    });
    if (!attachment) throw new HttpError(404, "Attachment not found.");

    await db
      .delete(caseAttachments)
      .where(eq(caseAttachments.id, attachment.id));

    // Remove the file from disk after the DB row is gone. Failures are
    // logged but don't surface to the caller — the DB delete already
    // succeeded and a stray file is preferable to an inconsistent state.
    removeAttachmentFile(req, attachment.storageKey);

    // If a OneDrive backup mirror is configured, also remove the
    // mirrored copy. Same best-effort policy: log and continue on any
    // failure so the DB delete is never reverted.
    void removeAttachmentFromOneDrive(req, attachment.storageKey);

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "case_attachment_deleted",
      entityType: "case_attachment",
      entityId: attachment.id,
      beforeJson: attachment,
    });
    return ok(res, { deleted: true });
  })
);

const updateCaseSchema = z.object({
  status: z
    .enum([
      "received",
      "in_design",
      "in_milling",
      "in_porcelain",
      "qc",
      "shipped",
      "delivered",
      "on_hold",
      "remake",
      "cancelled",
    ])
    .optional(),
  priority: z.enum(["normal", "rush"]).optional(),
  dueDate: z.string().optional(),
  doctorName: z.string().optional(),
  patientFirstName: z.string().optional(),
  patientLastName: z.string().optional(),
});

router.patch(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const input = updateCaseSchema.parse(req.body);

    const updates: any = {};
    if (input.status !== undefined) updates.status = input.status;
    if (input.priority !== undefined) updates.priority = input.priority;
    if (input.dueDate !== undefined)
      updates.dueDate = new Date(input.dueDate);
    if (input.doctorName !== undefined) updates.doctorName = input.doctorName;
    if (input.patientFirstName !== undefined)
      updates.patientFirstName = input.patientFirstName;
    if (input.patientLastName !== undefined)
      updates.patientLastName = input.patientLastName;

    const [updated] = await db
      .update(cases)
      .set(updates)
      .where(eq(cases.id, found.id))
      .returning();

    if (input.status && input.status !== found.status) {
      const user = (req as any).user;
      await db.insert(caseEvents).values({
        caseId: found.id,
        eventType: "status_changed",
        actorUserId: (req as any).auth.userId,
        actorOrganizationId: found.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          fromStatus: found.status,
          toStatus: input.status,
        },
      });
    }

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "case_updated",
      entityType: "case",
      entityId: found.id,
      beforeJson: found,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

router.delete(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );

    await db.delete(cases).where(eq(cases.id, found.id));
    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "case_deleted",
      entityType: "case",
      entityId: found.id,
    });
    return ok(res, { deleted: true });
  })
);

router.post(
  "/:caseId/notes",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    const input = z
      .object({
        noteText: z.string().min(1),
        visibility: z
          .enum(["internal_lab_only", "shared_with_provider"])
          .default("shared_with_provider"),
      })
      .parse(req.body);

    const labMember = await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    ).catch(() => null);
    const authorOrgId = labMember
      ? found.labOrganizationId
      : found.providerOrganizationId;

    const [note] = await db
      .insert(caseNotes)
      .values({
        caseId: found.id,
        authorUserId: (req as any).auth.userId,
        authorOrganizationId: authorOrgId,
        noteText: input.noteText,
        visibility: input.visibility,
      })
      .returning();

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "note_added",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: authorOrgId,
      actorInitials: user?.initials || "SYS",
      metadataJson: { visibility: input.visibility, noteId: note.id },
    });

    return ok(res, note, 201);
  })
);

router.post(
  "/:caseId/location-changes",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const input = z
      .object({
        locationCode: z.string().min(1),
        locationName: z.string().min(1),
        notes: z.string().optional(),
      })
      .parse(req.body);

    const [location] = await db
      .insert(caseLocations)
      .values({
        caseId: found.id,
        locationCode: input.locationCode,
        locationName: input.locationName,
        movedByUserId: (req as any).auth.userId,
        notes: input.notes ?? null,
      })
      .returning();

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "location_changed",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        locationCode: input.locationCode,
        locationName: input.locationName,
      },
    });

    return ok(res, location, 201);
  })
);

router.patch(
  "/restorations/pricing",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        restorationType: z.string().min(1),
        material: z.string().nullable().optional(),
        unitPrice: z.coerce.number().min(0),
      })
      .parse(req.body);

    const memberships = await db.query.organizationMemberships.findMany({
      where: eq(organizationMemberships.userId, (req as any).auth.userId),
    });
    const labOrgIds = memberships
      .filter(
        (m: any) =>
          m.status === "active" &&
          (m.role === "owner" || m.role === "admin" || m.role === "billing")
      )
      .map((m: any) => m.labId);

    if (labOrgIds.length === 0) {
      throw new HttpError(403, "You don't have permission to update pricing.");
    }

    const accessibleCases = await db.query.cases.findMany({
      where: inArray(cases.labOrganizationId, labOrgIds),
    });
    const accessibleCaseIds = accessibleCases.map((c) => c.id);
    if (accessibleCaseIds.length === 0) {
      return ok(res, { updated: 0 });
    }

    const candidates = await db.query.caseRestorations.findMany({
      where: and(
        inArray(caseRestorations.caseId, accessibleCaseIds),
        eq(caseRestorations.restorationType, input.restorationType)
      ),
    });
    const matchMaterial = (input.material ?? "").trim();
    const matching = candidates.filter((r) => {
      const m = (r.material ?? "").trim();
      if (!matchMaterial) return !m;
      return m === matchMaterial;
    });

    if (matching.length === 0) {
      return ok(res, { updated: 0 });
    }

    await db
      .update(caseRestorations)
      .set({
        unitPrice: input.unitPrice.toFixed(2),
        priceSource: "manual",
        priceSourceId: null,
        priceSourceName: null,
        priceKey: null,
      })
      .where(
        inArray(
          caseRestorations.id,
          matching.map((r) => r.id)
        )
      );

    await writeAuditLog({
      req,
      action: "restoration_pricing_updated",
      entityType: "case_restoration",
      entityId: input.restorationType,
      metadataJson: {
        restorationType: input.restorationType,
        material: input.material ?? null,
        unitPrice: input.unitPrice.toFixed(2),
        updated: matching.length,
      },
    });

    return ok(res, { updated: matching.length });
  })
);

router.post(
  "/:caseId/restorations",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const input = z
      .object({
        toothNumber: z.string().min(1),
        restorationType: z.string().min(1),
        material: z.string().optional(),
        shade: z.string().optional(),
        notes: z.string().optional(),
        quantity: z.coerce.number().int().positive().default(1),
        unitPrice: z.coerce.number().min(0).default(0),
      })
      .parse(req.body);

    let unit = input.unitPrice;
    const userSupplied = Number.isFinite(unit) && unit > 0;
    let priceSource: string | null = userSupplied ? "manual" : null;
    let priceSourceId: string | null = null;
    let priceSourceName: string | null = null;
    let priceKey: string | null = null;
    if (!userSupplied) {
      const fallback = await resolveServerPriceWithSource(
        {
          labOrganizationId: found.labOrganizationId,
          doctorName: found.doctorName,
          providerOrganizationId: found.providerOrganizationId,
        },
        input.material,
        input.restorationType
      );
      if (fallback) {
        unit = fallback.amount;
        priceSource = fallback.source;
        priceSourceId = fallback.sourceId;
        priceSourceName = fallback.sourceName;
        priceKey = fallback.key;
      }
    }

    const [restoration] = await db
      .insert(caseRestorations)
      .values({
        caseId: found.id,
        toothNumber: input.toothNumber,
        restorationType: input.restorationType,
        material: input.material ?? null,
        shade: input.shade ?? null,
        notes: input.notes ?? null,
        quantity: input.quantity,
        unitPrice: unit.toFixed(2),
        priceSource,
        priceSourceId,
        priceSourceName,
        priceKey,
      })
      .returning();

    return ok(res, restoration, 201);
  })
);

router.post(
  "/:caseId/submissions",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.providerOrganizationId
    );
    const input = z
      .object({
        submissionType: z.enum(["note", "photo", "video", "document"]),
        payloadJson: z.record(z.any()),
      })
      .parse(req.body);

    const [submission] = await db
      .insert(caseSubmissionQueue)
      .values({
        caseId: found.id,
        submittedByUserId: (req as any).auth.userId,
        submittedByOrganizationId: found.providerOrganizationId,
        submissionType: input.submissionType,
        payloadJson: input.payloadJson,
      })
      .returning();

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "provider_submission_received",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.providerOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        submissionId: submission.id,
        submissionType: submission.submissionType,
      },
    });

    return ok(res, submission, 201);
  })
);

router.get(
  "/:caseId/submissions",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );
    const submissions =
      await db.query.caseSubmissionQueue.findMany({
        where: eq(caseSubmissionQueue.caseId, found.id),
        orderBy: [desc(caseSubmissionQueue.createdAt)],
      });
    return ok(res, submissions);
  })
);

router.post(
  "/submissions/:submissionId/approve",
  asyncHandler(async (req, res) => {
    const submission =
      await db.query.caseSubmissionQueue.findFirst({
        where: eq(caseSubmissionQueue.id, req.params.submissionId),
      });
    if (!submission) throw new HttpError(404, "Submission not found.");
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      submission.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );

    const [approved] = await db
      .update(caseSubmissionQueue)
      .set({
        status: "approved",
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(caseSubmissionQueue.id, submission.id))
      .returning();

    if (
      submission.submissionType === "note" &&
      typeof (submission.payloadJson as any)?.noteText === "string"
    ) {
      await db.insert(caseNotes).values({
        caseId: submission.caseId,
        authorUserId: submission.submittedByUserId,
        authorOrganizationId: submission.submittedByOrganizationId,
        noteText: (submission.payloadJson as any).noteText,
        visibility: "shared_with_provider",
      });
    }

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: submission.caseId,
      eventType: "provider_submission_approved",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        submissionId: submission.id,
        submissionType: submission.submissionType,
      },
    });

    return ok(res, approved);
  })
);

router.post(
  "/submissions/:submissionId/reject",
  asyncHandler(async (req, res) => {
    const submission =
      await db.query.caseSubmissionQueue.findFirst({
        where: eq(caseSubmissionQueue.id, req.params.submissionId),
      });
    if (!submission) throw new HttpError(404, "Submission not found.");
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      submission.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );
    const input = z
      .object({ reviewNotes: z.string().max(1000).optional() })
      .parse(req.body ?? {});

    const [rejected] = await db
      .update(caseSubmissionQueue)
      .set({
        status: "rejected",
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
        reviewNotes: input.reviewNotes ?? null,
      })
      .where(eq(caseSubmissionQueue.id, submission.id))
      .returning();

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: submission.caseId,
      eventType: "provider_submission_rejected",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: { submissionId: submission.id },
    });

    return ok(res, rejected);
  })
);

export default router;
