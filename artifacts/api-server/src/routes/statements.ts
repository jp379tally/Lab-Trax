import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { statementSchedules, statementSendRuns } from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, BILLING_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import { retryStatementSendRun, runMonthlyStatementsForLab } from "../lib/statements";

const router = Router();
router.use(requireAuth);

async function loadOrCreateSchedule(labOrganizationId: string) {
  const existing = await db.query.statementSchedules.findFirst({
    where: eq(statementSchedules.labOrganizationId, labOrganizationId),
  });
  if (existing) return existing;
  const [created] = await db
    .insert(statementSchedules)
    .values({ labOrganizationId, enabled: false, dayOfMonth: 1 })
    .returning();
  return created;
}

router.get(
  "/:orgId/statement-schedule",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    await requireAnyRole(userId, orgId, BILLING_ROLES);
    const sched = await loadOrCreateSchedule(orgId);
    return ok(res, sched);
  })
);

const updateSchema = z.object({
  enabled: z.boolean(),
  dayOfMonth: z.coerce.number().int().min(1).max(31),
  emailSubject: z.string().max(998).nullish(),
  emailBody: z.string().max(20000).nullish(),
  emailReplyTo: z
    .string()
    .max(320)
    .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()), {
      message: "Reply-to must be a valid email address",
    })
    .nullish(),
});

router.put(
  "/:orgId/statement-schedule",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    await requireAnyRole(userId, orgId, ADMIN_ROLES);
    const input = updateSchema.parse(req.body);
    await loadOrCreateSchedule(orgId);
    const [updated] = await db
      .update(statementSchedules)
      .set({
        enabled: input.enabled,
        dayOfMonth: input.dayOfMonth,
        emailSubject:
          input.emailSubject === undefined
            ? undefined
            : (input.emailSubject?.trim() || null),
        emailBody:
          input.emailBody === undefined
            ? undefined
            : (input.emailBody ?? "").length > 0
              ? input.emailBody
              : null,
        emailReplyTo:
          input.emailReplyTo === undefined
            ? undefined
            : (input.emailReplyTo?.trim() || null),
        updatedByUserId: userId,
        updatedAt: new Date(),
      })
      .where(eq(statementSchedules.labOrganizationId, orgId))
      .returning();
    return ok(res, updated);
  })
);

router.post(
  "/:orgId/statement-schedule/run-now",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    await requireAnyRole(userId, orgId, ADMIN_ROLES);
    const result = await runMonthlyStatementsForLab({
      labOrganizationId: orgId,
      triggeredBy: "manual",
      triggeredByUserId: userId,
    });
    if (!result.results.length) {
      throw new HttpError(
        400,
        "No invoices found in the prior month — nothing to send."
      );
    }
    return ok(res, result);
  })
);

router.post(
  "/:orgId/statement-runs/:runId/retry",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    const runId = String(req.params.runId);
    await requireAnyRole(userId, orgId, ADMIN_ROLES);
    const run = await db.query.statementSendRuns.findFirst({
      where: and(
        eq(statementSendRuns.id, runId),
        eq(statementSendRuns.labOrganizationId, orgId)
      ),
    });
    if (!run) throw new HttpError(404, "Send entry not found");
    if (run.status === "sent") {
      throw new HttpError(400, "This statement has already been sent.");
    }
    const result = await retryStatementSendRun(runId);
    return ok(res, result);
  })
);

router.get(
  "/:orgId/statement-runs",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    await requireAnyRole(userId, orgId, BILLING_ROLES);
    const limit = Math.min(
      500,
      Math.max(1, parseInt(String(req.query.limit ?? "200"), 10) || 200)
    );
    const rows = await db
      .select()
      .from(statementSendRuns)
      .where(eq(statementSendRuns.labOrganizationId, orgId))
      .orderBy(desc(statementSendRuns.createdAt))
      .limit(limit);
    return ok(res, rows);
  })
);

export default router;
