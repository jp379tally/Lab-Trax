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
  buildPracticeStatementsForScope,
  buildPracticeStatementBundles,
  buildPracticeAccountSummaries,
  generateStatementPdfPreview,
  generateStatementsZipBufferForLab,
  getPracticeBillingRecipientsMap,
  isLikelyEmailAddress,
  normalizeEmailList,
  retryStatementSendRun,
  runBatchSendStatements,
  runMonthlyStatementsForLab,
  type InvoiceScope,
} from "../lib/statements";
import { pageRowsKeyset, parsePagination, type SortDirection } from "../lib/pagination";

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
    .catch((err: unknown): never =>
      wrapDbError(err, {
        duplicate: "A statement schedule for this lab already exists.",
        fallback: "Failed to create statement schedule. Please try again.",
      })
    );
  return created;
}

// ── Statement schedule CRUD ───────────────────────────────────────────────────

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
  statementFormat: z.enum(["per_doctor", "consolidated"]).default("per_doctor"),
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
        statementFormat: input.statementFormat,
        emailSubject:
          input.emailSubject === undefined
            ? undefined
            : input.emailSubject?.trim() || null,
        emailBody:
          input.emailBody === undefined
            ? undefined
            : (input.emailBody ?? "").length > 0
              ? input.emailBody
              : null,
        emailReplyTo:
          input.emailReplyTo === undefined
            ? undefined
            : input.emailReplyTo?.trim() || null,
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

// ── Statement send runs ───────────────────────────────────────────────────────

router.post(
  "/:orgId/statement-runs/:runId/retry",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    const runId = String(req.params.runId);
    await requireAnyRole(userId, orgId, ADMIN_ROLES);
    // Verify the run belongs to this lab before retrying.
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
  "/:orgId/statements/account-summaries",
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query);
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    await requireAnyRole(userId, orgId, BILLING_ROLES);
    const rows = await buildPracticeAccountSummaries(orgId);
    // Preserve the historical bare-array contract unless pagination is opted
    // into; filters and metadata belong to the new paginated contract.
    if (!pagination.active) return ok(res, rows);
    const query = z.object({
      search: z.string().optional(),
      aging: z.enum(["all", "open", "overdue"]).default("all"),
      sort: z.enum([
        "practiceName",
        "openInvoiceCount",
        "openInvoiceTotal",
        "totalOpenBalance",
        "overdueBalance",
        "totalBilled",
      ]).optional(),
      sortDir: z.enum(["asc", "desc"]).default("desc"),
    }).parse(req.query);
    const search = query.search?.trim().toLocaleLowerCase();
    const filtered = rows.filter((row) => {
      if (query.aging === "open" && row.totalOpenBalance <= 0) return false;
      if (query.aging === "overdue" && row.overdueBalance <= 0) return false;
      return !search || row.practiceName.toLocaleLowerCase().includes(search);
    });
    const newestFirst = [...filtered].sort((a, b) => {
      if (query.sort) {
        const left = a[query.sort];
        const right = b[query.sort];
        const compared = typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right));
        return (query.sortDir === "asc" ? compared : -compared) ||
          a.practiceId.localeCompare(b.practiceId);
      }
      const latestDate = (row: (typeof rows)[number]) =>
        row.unpaidStatements.reduce(
          (latest, statement) =>
            Math.max(latest, new Date(statement.date).getTime()),
          0,
        );
      return (
        latestDate(b) - latestDate(a) ||
        a.practiceName.localeCompare(b.practiceName) ||
        a.practiceId.localeCompare(b.practiceId)
      );
    });
    const totals = filtered.reduce(
      (sum, row) => ({
        billed: sum.billed + row.totalBilled,
        paid: sum.paid + row.totalPaid,
        open: sum.open + row.totalOpenBalance,
        overdue: sum.overdue + row.overdueBalance,
      }),
      { billed: 0, paid: 0, open: 0, overdue: 0 },
    );
    // One row per practice, so practiceId is the stable tiebreaker a cursor
    // anchors on. The selectable sort and its direction decide the rest.
    const latestStatementTime = (row: (typeof rows)[number]) =>
      row.unpaidStatements.reduce(
        (latest, statement) => Math.max(latest, new Date(statement.date).getTime()),
        0,
      );
    const sortDir: SortDirection = query.sortDir === "asc" ? "asc" : "desc";
    return ok(res, {
      ...pageRowsKeyset(
        newestFirst,
        pagination,
        query.sort
          ? {
              sortValues: (row) => {
                const value = row[query.sort!];
                return [typeof value === "number" ? value : String(value)];
              },
              id: (row) => row.practiceId,
              directions: [sortDir],
            }
          : {
              sortValues: (row) => [latestStatementTime(row), row.practiceName],
              id: (row) => row.practiceId,
              directions: ["desc", "asc"],
            },
      ),
      totals,
    });
  }),
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

// ── Shared schema helpers ─────────────────────────────────────────────────────

const INVOICE_SCOPES = [
  "open",
  "open_overdue_90",
  "all",
  "last_30_days",
  "over_90_days",
  "custom",
  "open_as_of",
] as const;

const isoDate = z.string().datetime().nullish();

// ── On-demand batch send (email + SMS) ────────────────────────────────────────

const batchSendSchema = z.object({
  recipientType: z.enum(["practice", "doctor"]).default("practice"),
  practiceIds: z.array(z.string().max(128)).max(500).nullish(),
  doctorKeys: z.array(z.string().max(256)).max(1000).nullish(),
  invoiceScope: z.enum(INVOICE_SCOPES).default("open"),
  from: isoDate,
  to: isoDate,
  asOf: isoDate,
  channels: z
    .array(z.enum(["email", "sms"]))
    .min(1, "At least one channel is required"),
  emailSubject: z.string().max(998).nullish(),
  emailBody: z.string().max(20000).nullish(),
  emailHeader: z.string().max(998).nullish(),
  emailReplyTo: z.string().email().max(320).or(z.literal("")).nullish(),
  periodLabel: z.string().max(200).nullish(),
  doctorFilters: z.record(z.string(), z.array(z.string())).nullish(),
  /**
   * Per-send recipient override keyed by practice id. Bounded and validated
   * here so an invalid address blocks the send instead of silently dropping
   * a recipient. Never written back to saved practice contacts.
   */
  recipientEmails: z
    .record(
      z.string().max(128),
      z
        .array(
          z
            .string()
            .trim()
            .max(320)
            .refine((value) => isLikelyEmailAddress(value), {
              message: "Enter a valid email address.",
            })
        )
        .max(25)
    )
    .nullish(),
  /**
   * Practice id → send-run id of an issued bundle to re-send as it was
   * issued. Used by Retry failed / Send now so a retry mails the documents
   * the practice was already given instead of rebuilding from invoices that
   * may have changed since the failed attempt.
   */
  replayRuns: z.record(z.string().max(128), z.string().max(128)).nullish(),
});

router.post(
  "/:orgId/statements/batch-send",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    await requireAnyRole(userId, orgId, BILLING_ROLES);
    const input = batchSendSchema.parse(req.body);

    const result = await runBatchSendStatements({
      labOrganizationId: orgId,
      triggeredByUserId: userId,
      recipientType: input.recipientType,
      practiceIds: input.practiceIds ?? null,
      doctorKeys: input.doctorKeys ?? null,
      doctorFilters: input.doctorFilters ?? null,
      invoiceScope: input.invoiceScope as InvoiceScope,
      from: input.from ? new Date(input.from) : null,
      to: input.to ? new Date(input.to) : null,
      asOf: input.asOf ? new Date(input.asOf) : null,
      channels: input.channels as Array<"email" | "sms">,
      emailSubject: input.emailSubject ?? null,
      emailBody: input.emailBody ?? null,
      emailHeader: input.emailHeader ?? null,
      emailReplyTo: input.emailReplyTo || null,
      periodLabel: input.periodLabel ?? null,
      recipientEmails: input.recipientEmails
        ? Object.fromEntries(
            Object.entries(input.recipientEmails).map(([key, list]) => [
              key,
              normalizeEmailList(list),
            ])
          )
        : null,
      replayRuns: input.replayRuns ?? null,
    });

    if (!result.results.length) {
      throw new HttpError(
        400,
        "No invoices found for the selected recipients and scope."
      );
    }

    return ok(res, result);
  })
);

// ── Recipient preview (practice or doctor groups for a scope) ────────────────

router.get(
  "/:orgId/statements/recipients",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    await requireAnyRole(userId, orgId, BILLING_ROLES);
    const mode =
      req.query.mode === "doctor"
        ? "doctor"
        : ("practice" as "practice" | "doctor");
    const scopeParam = String(req.query.scope ?? "open");
    const scope = (
      (INVOICE_SCOPES as readonly string[]).includes(scopeParam)
        ? scopeParam
        : "open"
    ) as InvoiceScope;
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    const asOfRaw = req.query.asOf ? String(req.query.asOf) : null;

    const practiceIdsRaw = req.query.practiceIds;
    const limitToPracticeOrgIds: string[] | null =
      mode === "doctor" && practiceIdsRaw
        ? (
            Array.isArray(practiceIdsRaw)
              ? practiceIdsRaw.flatMap((v) => String(v).split(","))
              : String(practiceIdsRaw).split(",")
          )
            .map((s) => s.trim())
            .filter(Boolean)
        : null;

    if (mode === "practice") {
      // Practice mode previews the exact bundles the send path produces, so
      // the review step's doctor documents and totals cannot drift from the
      // attachments that actually go out.
      const bundles = await buildPracticeStatementBundles(orgId, {
        scope,
        from: fromRaw ? new Date(fromRaw) : null,
        to: toRaw ? new Date(toRaw) : null,
        asOf: asOfRaw ? new Date(asOfRaw) : null,
      });
      const savedRecipients = await getPracticeBillingRecipientsMap(
        bundles
          .filter((bundle) => !!bundle.providerOrganizationId)
          .map((bundle) => ({
            id: bundle.providerOrganizationId!,
            billingEmail: bundle.practiceEmail,
          }))
      );
      const recipients = bundles.map((bundle) => ({
        key: bundle.practiceId,
        name: bundle.practiceName,
        email: bundle.practiceEmail,
        phone: bundle.phone,
        statementEmailOptOut: bundle.statementEmailOptOut,
        invoiceCount: bundle.invoiceCount,
        openBalance: bundle.openBalance,
        totalBilled: bundle.totalBilled,
        // Saved billing recipients (primary + billing-tagged additional).
        // Correspondence-only contacts are intentionally excluded.
        recipientEmails: bundle.providerOrganizationId
          ? (savedRecipients.get(bundle.providerOrganizationId) ?? [])
          : normalizeEmailList([bundle.practiceEmail]),
        doctors: bundle.documents.map((doc) => ({
          key: doc.documentKey,
          name: doc.label,
          email: null,
          phone: null,
          invoiceCount: doc.invoiceCount,
          totalBilled: doc.totalBilled,
          openBalance: doc.openBalance,
        })),
      }));
      return ok(res, { recipients });
    }

    const statements = await buildPracticeStatementsForScope(orgId, {
      scope,
      recipientType: mode,
      from: fromRaw ? new Date(fromRaw) : null,
      to: toRaw ? new Date(toRaw) : null,
      asOf: asOfRaw ? new Date(asOfRaw) : null,
      limitToPracticeOrgIds: limitToPracticeOrgIds?.length
        ? limitToPracticeOrgIds
        : null,
    });

    const recipients = statements.map((s) => ({
      key: s.practiceId,
      name: s.practiceName,
      email: s.practiceEmail,
      phone: s.phone ?? null,
      statementEmailOptOut: s.statementEmailOptOut,
      invoiceCount: s.invoiceCount,
      openBalance: s.openBalance,
      totalBilled: s.totalBilled,
      recipientEmails: normalizeEmailList([s.practiceEmail]),
      doctors: s.doctors ?? [],
    }));
    return ok(res, { recipients });
  })
);

// ── Single-practice PDF preview (returns raw PDF, no email sent) ─────────────

const previewPdfSchema = z.object({
  recipientType: z.enum(["practice", "doctor"]).default("practice"),
  /**
   * The single recipient key to preview.  In practice mode this is the
   * provider organization id; in doctor mode it is the composite
   * "<orgId>::<doctorName>" key that the recipients endpoint returns.
   */
  recipientKey: z.string().max(512),
  invoiceScope: z.enum(INVOICE_SCOPES).default("open"),
  from: isoDate,
  to: isoDate,
  asOf: isoDate,
  periodLabel: z.string().max(200).nullish(),
  invoiceIds: z.array(z.string().max(128)).max(500).nullish(),
  /**
   * Practice mode: preview one doctor document from the practice bundle
   * (doctor name, or the unassigned sentinel) rather than a consolidated
   * practice statement.
   */
  documentKey: z.string().max(256).nullish(),
  doctorFilters: z.record(z.string(), z.array(z.string())).nullish(),
});

router.post(
  "/:orgId/statements/preview-pdf",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const orgId = String(req.params.orgId);
    await requireAnyRole(userId, orgId, BILLING_ROLES);
    const input = previewPdfSchema.parse(req.body);

    let pdfBuffer: Buffer;
    let practiceName: string;
    try {
      ({ pdfBuffer, practiceName } = await generateStatementPdfPreview({
        labOrganizationId: orgId,
        recipientType: input.recipientType,
        recipientKey: input.recipientKey,
        invoiceScope: input.invoiceScope as InvoiceScope,
        from: input.from ? new Date(input.from) : null,
        to: input.to ? new Date(input.to) : null,
        asOf: input.asOf ? new Date(input.asOf) : null,
        periodLabel: input.periodLabel ?? null,
        invoiceIds: input.invoiceIds ?? null,
        documentKey: input.documentKey ?? null,
        doctorFilters: input.doctorFilters ?? null,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No invoices found")) throw new HttpError(404, msg);
      throw err;
    }

    const safeName = practiceName.replace(/[^a-z0-9-_]+/gi, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="preview-${safeName}.pdf"`
    );
    res.setHeader("Content-Length", String(pdfBuffer.length));
    res.end(pdfBuffer);
  })
);

// ── On-demand batch download (ZIP of statement PDFs) ─────────────────────────

const batchDownloadSchema = z.object({
  recipientType: z.enum(["practice", "doctor"]).default("practice"),
  practiceIds: z.array(z.string().max(128)).max(500).nullish(),
  doctorKeys: z.array(z.string().max(256)).max(1000).nullish(),
  doctorFilters: z.record(z.string(), z.array(z.string())).nullish(),
  invoiceScope: z.enum(INVOICE_SCOPES).default("open"),
  from: isoDate,
  to: isoDate,
  asOf: isoDate,
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
      recipientType: input.recipientType,
      practiceIds: input.practiceIds ?? null,
      doctorKeys: input.doctorKeys ?? null,
      doctorFilters: input.doctorFilters ?? null,
      invoiceScope: input.invoiceScope as InvoiceScope,
      from: input.from ? new Date(input.from) : null,
      to: input.to ? new Date(input.to) : null,
      asOf: input.asOf ? new Date(input.asOf) : null,
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
