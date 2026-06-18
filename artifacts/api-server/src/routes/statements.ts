import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { statementSchedules, statementSendRuns } from "@workspace/db";
import { HttpError, ok, wrapDbError } from "../lib/http";
import { ADMIN_ROLES, BILLING_ROLES, requireAnyRole } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth, requireVerifiedAccount } from "../middlewares/auth";
import {
  generateStatementsZipBufferForLab,
  retryStatementSendRun,
  runBatchSendStatements,
  runMonthlyStatementsForLab,
  type InvoiceScope,
} from "../lib/statements";

const router = Router();
router.use(requireAuth);
router.use(requireVerifiedAccount);

async function loadOrCreateSchedule(labOrganizationId: string) {
  const existing = await db.query.statementSchedules.findFirst({
    where: eq(statementSchedules.labOrganizationId, labOrganizationId),
  });
  if (existing) return existing;
  const [created] = await db
    .insert(statementSchedules)
    .values({ labOrganizationId, enabled: false, dayOfMonth: 1 })
    .returning()
    .catch((err: unknown): never => wrapDbError(err, {
      duplicate: "A statement schedule for this lab already exists.",
      fallback: "Failed to create statement schedule. Please try again.",
    }));
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
  // 0 = "last day of month"; 1–31 = specific day (clamped to month length).
  dayOfMonth: z.coerce.number().int().min(0).max(31),
  emailSubject: z.string().max(998).nullish(),
  emailBody: z.string().max(20000).nullish(),
  emailReplyTo: z
    .string()
    .max(320)
    .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()), {
      message: "Reply-to must be a valid email address",
    })
    .nullish(),
  // null / omitted = send to all practices; non-empty array = only these IDs.
  includedOrgIds: z.array(z.string().max(128)).max(500).nullish(),
});

router.put(
  "/:orgId/statement-schedule",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    await requireAnyRole(userId, orgId, ADMIN_ROLES);
    const input = updateSchema.parse(req.body);
    await loadOrCreateSchedule(orgId);
    // Normalise includedOrgIds: null / undefined / empty array → null (= all)
    const includedOrgIds =
      input.includedOrgIds && input.includedOrgIds.length > 0
        ? input.includedOrgIds
        : null;

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
        includedOrgIds,
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

// ── On-demand batch send (email + SMS) ────────────────────────────────────────

const batchSendSchema = z.object({
  practiceIds: z.array(z.string().max(128)).max(500).nullish(),
  invoiceScope: z.enum(["open", "open_overdue_90", "all"]).default("open"),
  channels: z
    .array(z.enum(["email", "sms"]))
    .min(1, "At least one channel is required"),
  emailSubject: z.string().max(998).nullish(),
  emailBody: z.string().max(20000).nullish(),
  periodLabel: z.string().max(200).nullish(),
});

router.post(
  "/:orgId/statements/batch-send",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    await requireAnyRole(userId, orgId, ADMIN_ROLES);
    const input = batchSendSchema.parse(req.body);

    const result = await runBatchSendStatements({
      labOrganizationId: orgId,
      triggeredByUserId: userId,
      practiceIds: input.practiceIds ?? null,
      invoiceScope: input.invoiceScope as InvoiceScope,
      channels: input.channels as Array<"email" | "sms">,
      emailSubject: input.emailSubject ?? null,
      emailBody: input.emailBody ?? null,
      periodLabel: input.periodLabel ?? null,
    });

    if (!result.results.length) {
      throw new HttpError(
        400,
        "No invoices found for the selected practices and scope."
      );
    }

    return ok(res, result);
  })
);

// ── On-demand batch download (ZIP of statement PDFs) ─────────────────────────

const batchDownloadSchema = z.object({
  practiceIds: z.array(z.string().max(128)).max(500).nullish(),
  invoiceScope: z.enum(["open", "open_overdue_90", "all"]).default("open"),
  periodLabel: z.string().max(200).nullish(),
});

router.post(
  "/:orgId/statements/batch-download",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    await requireAnyRole(userId, orgId, BILLING_ROLES);
    const input = batchDownloadSchema.parse(req.body);

    const { zipBuffer, filename } = await generateStatementsZipBufferForLab({
      labOrganizationId: orgId,
      practiceIds: input.practiceIds ?? null,
      invoiceScope: input.invoiceScope as InvoiceScope,
      periodLabel: input.periodLabel ?? null,
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );
    res.setHeader("Content-Length", String(zipBuffer.length));
    res.end(zipBuffer);
  })
);

export default router;
