import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { auditLogs, cases, organizations } from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole } from "../lib/rbac";
import { notDeleted } from "../lib/soft-delete";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

const mergeSchema = z.object({
  sourceDoctorName: z.string().trim().min(1),
  sourceProviderOrganizationId: z.string().min(1),
  targetDoctorName: z.string().trim().min(1),
  targetProviderOrganizationId: z.string().min(1),
});

router.post(
  "/merge",
  asyncHandler(async (req, res) => {
    const input = mergeSchema.parse(req.body);
    const userId = (req as any).auth.userId as string;

    if (
      input.sourceDoctorName === input.targetDoctorName &&
      input.sourceProviderOrganizationId === input.targetProviderOrganizationId
    ) {
      throw new HttpError(
        400,
        "Source and target doctors are the same — nothing to merge."
      );
    }

    const [sourcePractice, targetPractice] = await Promise.all([
      db.query.organizations.findFirst({
        where: eq(organizations.id, input.sourceProviderOrganizationId),
      }),
      db.query.organizations.findFirst({
        where: eq(organizations.id, input.targetProviderOrganizationId),
      }),
    ]);

    if (!sourcePractice || sourcePractice.deletedAt) {
      throw new HttpError(404, "Source practice not found.");
    }
    if (!targetPractice || targetPractice.deletedAt) {
      throw new HttpError(404, "Target practice not found.");
    }

    const labId = sourcePractice.parentLabOrganizationId;
    if (!labId || labId !== targetPractice.parentLabOrganizationId) {
      throw new HttpError(
        400,
        "Both practices must belong to the same lab to merge their doctors."
      );
    }

    // Caller must be a lab admin of the lab that owns both practices.
    await requireAnyRole(userId, labId, ADMIN_ROLES);

    // Verify the target doctor group exists — i.e. there is at least one
    // non-soft-deleted case under (targetDoctorName, targetProviderOrgId).
    // Without this check, a merge could silently rename cases into an
    // arbitrary doctor name that was never created.
    const [targetExisting] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(
        and(
          eq(cases.labOrganizationId, labId),
          eq(cases.providerOrganizationId, input.targetProviderOrganizationId),
          sql`lower(${cases.doctorName}) = lower(${input.targetDoctorName})`,
          notDeleted(cases)
        )
      )
      .limit(1);

    if (!targetExisting) {
      throw new HttpError(
        404,
        "Target doctor not found in the selected practice. Pick an existing doctor to merge into."
      );
    }

    // Run the case-rename and the audit-log insert in one transaction so a
    // failure on either side rolls back cleanly and we never end up with
    // moved cases but no audit trail (or vice versa).
    const casesMoved = await db.transaction(async (tx) => {
      const updated = await tx
        .update(cases)
        .set({
          doctorName: input.targetDoctorName,
          providerOrganizationId: input.targetProviderOrganizationId,
        })
        .where(
          and(
            eq(cases.labOrganizationId, labId),
            eq(cases.providerOrganizationId, input.sourceProviderOrganizationId),
            sql`lower(${cases.doctorName}) = lower(${input.sourceDoctorName})`,
            notDeleted(cases)
          )
        )
        .returning({ id: cases.id });

      await tx.insert(auditLogs).values({
        userId,
        organizationId: labId,
        action: "doctor_merged",
        entityType: "doctor",
        entityId: null,
        ipAddress: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        beforeJson: {
          doctorName: input.sourceDoctorName,
          providerOrganizationId: input.sourceProviderOrganizationId,
          practiceName: sourcePractice.displayName || sourcePractice.name,
        },
        afterJson: {
          doctorName: input.targetDoctorName,
          providerOrganizationId: input.targetProviderOrganizationId,
          practiceName: targetPractice.displayName || targetPractice.name,
        },
        metadataJson: {
          casesMoved: updated.length,
        },
      });

      return updated.length;
    });

    return ok(res, {
      casesMoved,
      sourceDoctorName: input.sourceDoctorName,
      sourceProviderOrganizationId: input.sourceProviderOrganizationId,
      targetDoctorName: input.targetDoctorName,
      targetProviderOrganizationId: input.targetProviderOrganizationId,
    });
  })
);

export default router;
