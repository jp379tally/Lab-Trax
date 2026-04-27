import { Router } from "express";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  caseAttachments,
  caseEvents,
  caseLocations,
  caseNotes,
  caseRestorations,
  caseSubmissionQueue,
  cases,
  organizationConnections,
  organizationMemberships,
} from "../../shared/schema";
import { writeAuditLog } from "../lib/audit";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middleware/async-handler";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

async function assertCaseAccess(userId: string, caseId: string) {
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
  return found;
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
      await db.insert(caseRestorations).values(
        input.restorations.map((r) => ({
          caseId: createdCase.id,
          toothNumber: r.toothNumber,
          restorationType: r.restorationType,
          material: r.material ?? null,
          shade: r.shade ?? null,
          notes: r.notes ?? null,
          quantity: r.quantity,
          unitPrice: r.unitPrice.toFixed(2),
        }))
      );
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

    const rows = membershipOrgIds.length
      ? await db.query.cases.findMany({
          where: or(
            inArray(cases.labOrganizationId, membershipOrgIds),
            inArray(cases.providerOrganizationId, membershipOrgIds)
          ),
          orderBy: [desc(cases.createdAt)],
        })
      : [];

    return ok(res, rows);
  })
);

router.get(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      (req.params.caseId as string)
    );
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

    return ok(res, {
      ...found,
      restorations,
      notes,
      attachments,
      events,
      locations,
    });
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
      (req.params.caseId as string)
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
      (req.params.caseId as string)
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
      (req.params.caseId as string)
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
      (req.params.caseId as string)
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

router.post(
  "/:caseId/restorations",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      (req.params.caseId as string)
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
        unitPrice: input.unitPrice.toFixed(2),
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
      (req.params.caseId as string)
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
      (req.params.caseId as string)
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
        where: eq(caseSubmissionQueue.id, (req.params.submissionId as string)),
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
        where: eq(caseSubmissionQueue.id, (req.params.submissionId as string)),
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
