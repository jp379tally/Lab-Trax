import { Router } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
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

// `providerOrganizationId` may legitimately be null/missing — when a
// doctor's cases were created without a practice attached they show up as
// "Unknown practice" in the UI. We accept empty string OR null and
// normalize to null below so we can still merge those rows.
const optionalOrgId = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined || v === null) return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  });

const mergeSchema = z.object({
  sourceDoctorName: z.string().trim().min(1),
  sourceProviderOrganizationId: optionalOrgId,
  targetDoctorName: z.string().trim().min(1),
  targetProviderOrganizationId: optionalOrgId,
  // Required so we can scope the case-rename when one or both sides have
  // no practice attached. Verified against the caller's lab membership.
  labOrganizationId: z.string().min(1),
});

router.post(
  "/merge",
  asyncHandler(async (req, res) => {
    const input = mergeSchema.parse(req.body);
    const userId = (req as any).auth.userId as string;

    if (
      input.sourceDoctorName.toLowerCase() ===
        input.targetDoctorName.toLowerCase() &&
      input.sourceProviderOrganizationId === input.targetProviderOrganizationId
    ) {
      throw new HttpError(
        400,
        "Source and target doctors are the same — nothing to merge."
      );
    }

    const labId = input.labOrganizationId;

    // Caller must be a lab admin of the lab that owns both practices.
    await requireAnyRole(userId, labId, ADMIN_ROLES);

    // Look up practices when provided; allow null on either side.
    const sourcePractice = input.sourceProviderOrganizationId
      ? await db.query.organizations.findFirst({
          where: eq(organizations.id, input.sourceProviderOrganizationId),
        })
      : null;
    const targetPractice = input.targetProviderOrganizationId
      ? await db.query.organizations.findFirst({
          where: eq(organizations.id, input.targetProviderOrganizationId),
        })
      : null;

    if (input.sourceProviderOrganizationId) {
      if (!sourcePractice || sourcePractice.deletedAt) {
        throw new HttpError(404, "Source practice not found.");
      }
      if (sourcePractice.parentLabOrganizationId !== labId) {
        throw new HttpError(
          400,
          "Source practice does not belong to this lab."
        );
      }
    }
    // The cases.providerOrganizationId column is NOT NULL, so a merge
    // target must always have a real practice to assign cases into.
    if (!input.targetProviderOrganizationId) {
      throw new HttpError(
        400,
        "Target doctor has no practice — pick a target whose practice is on file."
      );
    }
    if (!targetPractice || targetPractice.deletedAt) {
      throw new HttpError(404, "Target practice not found.");
    }
    if (targetPractice.parentLabOrganizationId !== labId) {
      throw new HttpError(
        400,
        "Target practice does not belong to this lab."
      );
    }
    const targetProviderId = input.targetProviderOrganizationId;

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
          eq(cases.providerOrganizationId, targetProviderId),
          sql`lower(${cases.doctorName}) = lower(${input.targetDoctorName})`,
          notDeleted(cases)
        )
      )
      .limit(1);

    if (!targetExisting) {
      throw new HttpError(
        404,
        "Target doctor not found. Pick an existing doctor to merge into."
      );
    }

    const sourceProviderClause = input.sourceProviderOrganizationId
      ? eq(
          cases.providerOrganizationId,
          input.sourceProviderOrganizationId
        )
      : isNull(cases.providerOrganizationId);

    // Run the case-rename and the audit-log insert in one transaction so a
    // failure on either side rolls back cleanly and we never end up with
    // moved cases but no audit trail (or vice versa).
    const casesMoved = await db.transaction(async (tx) => {
      const updated = await tx
        .update(cases)
        .set({
          doctorName: input.targetDoctorName,
          providerOrganizationId: targetProviderId,
        })
        .where(
          and(
            eq(cases.labOrganizationId, labId),
            sourceProviderClause,
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
          practiceName:
            sourcePractice?.displayName ||
            sourcePractice?.name ||
            "(no practice)",
        },
        afterJson: {
          doctorName: input.targetDoctorName,
          providerOrganizationId: input.targetProviderOrganizationId,
          practiceName:
            targetPractice?.displayName ||
            targetPractice?.name ||
            "(no practice)",
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
