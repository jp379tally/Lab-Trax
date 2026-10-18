import { Router } from "express";
import { salesInvoiceScope, salesIssuedDate } from "../lib/sales-invoice-scope";
import multer from "multer";
import { normalizePhoneE164 } from "../lib/account-link-sms";
import { archiveReversedSettlements } from "../lib/settlement-history";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { and, asc, desc, eq, gte, lte, ne, or, sql, sum } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { normalizeInvoiceFilterPrecedence } from "@workspace/api-client-react";
import {
  auditLogs,
  bankAccounts,
  bankTransactionInvoices,
  bankTransactions,
  caseEvents,
  caseNotes,
  caseRestorations,
  cases,
  invoiceAttachments,
  invoiceCredits,
  invoiceLineItems,
  invoices,
  labCases,
  organizationAdditionalEmails,
  practiceStatements,
  practiceStatementSends,
  statementPaymentSessions,
  statementSchedules,
  systemSettings,
  organizationMemberships,
  organizations,
  doctorProfiles,
  payments,
  users,
  transactionCategories,
} from "@workspace/db";
import { getProviderOrgIdsForUserAndLinks } from "../lib/cross-lab-doctor";
import { ensureDefaultCategories } from "../lib/default-categories";
import { inArray, isNotNull, isNull } from "drizzle-orm";
import { ensureInvoiceDeposit } from "../lib/invoice-deposits";
import { releaseBatchesForChildren, releaseBatchForChild } from "../lib/deposit-batches";
import { writeAuditLog, writeAuditLogTx } from "../lib/audit";
import { calculateLineTotal, sumMoney } from "../lib/case";
import { HttpError, ok, wrapDbError } from "../lib/http";
import { createTransport, getMailerConfig } from "../lib/mailer";
import { classifySmtpError } from "../lib/smtp-error";
import {
  generateStatementPdfBuffer,
  buildPracticeStatementsForScope,
  attachStatementContacts,
  readLogoBuffer,
  periodMonthFor,
  persistStatementPdf,
  coerceStatementBundleManifest,
  type PracticeStatementData,
} from "../lib/statements";
import { coerceStatementTemplate } from "../lib/statement-template";
import {
  deriveLiveStatementFigures,
  type StatementInvoiceState,
} from "../lib/statement-figures";
import { ADMIN_ROLES, BILLING_ROLES, hasCapability, requireAnyRole, requireMembership, type MembershipRole } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth, requireVerifiedAccount } from "../middlewares/auth";
import {
  buildLineItemDescription,
  resolveAllPricesForContext,
  resolveItemLabel,
  resolveServerPriceWithSource,
  type ResolvedItemRow,
} from "../lib/pricing";
import { resolveRestorationPriceKey } from "../lib/restoration-pricing";
import { buildBridgeAwareLineItems } from "../lib/invoice-line-grouping";
import { isPfmOrFcmMaterial } from "../lib/material-mapping";
import { invoiceDueDate } from "../lib/invoice-due-date";
import { calendarDateToUtcNoon } from "@workspace/calendar-date";
import { deliverPaymentNotifications } from "../lib/payment-notifications";
import {
  assertProviderOrganizationCapability,
  assertLinkedProviderCapability,
  requireProviderCapability,
} from "../lib/provider-capabilities";
import { assertNoActiveCardReversalForInvoices } from "../lib/payment-reversal-guards";
import { ensureDoctorProfileIdentity } from "../lib/doctor-profile-identity";
import { assertRecoveryReleased, finalizedInvoiceSql, RECOVERY_DRAFT_STATUS } from "../lib/recovery-billing-hold";
import {
  pageRowsKeyset,
  parsePagination,
  sortTime,
  type Keyset,
  type SortDirection,
} from "../lib/pagination";

const router = Router();
const INVOICE_DATE_DRIFT_FIX_AT = new Date("2026-09-11T14:41:49.000Z");
const INVOICE_STATUS_FILTER_VALUES = new Set([
  "draft",
  RECOVERY_DRAFT_STATUS,
  "open",
  "partially_paid",
  "paid",
  "void",
  "frozen",
  "zero_balance",
]);
const INVOICE_LEGACY_STATUS_VALUES = new Set([
  ...INVOICE_STATUS_FILTER_VALUES,
  "all",
  "closed",
  "overdue",
]);

function isInvoiceDraftStatus(status: unknown): boolean {
  return status === "draft" || status === RECOVERY_DRAFT_STATUS;
}
const INVOICE_VIEW_VALUES = new Set(["open", "outstanding"]);
const INVOICE_AGING_VALUES = new Set([
  "all",
  "0_30",
  "31_60",
  "61_90",
  "90_plus",
  "custom",
]);
const INVOICE_SORT_VALUES = new Set(["issued", "due", "practice"]);
const INVOICE_SORT_DIRECTION_VALUES = new Set(["asc", "desc"]);

type InvoiceReadScope = {
  orgIds: string[];
  memberships: Array<{
    labId: string;
    status?: string | null;
  }>;
};

/**
 * Resolve the organizations an invoice reader may see.
 *
 * Lab memberships remain limited to their own lab. Provider users expand to
 * linked provider organizations whose billing capability is available, while
 * mixed identities keep their lab access and use the same per-organization
 * capability filtering.
 */
async function getInvoiceReadScope(callerId: string): Promise<InvoiceReadScope> {
  const memberships = await db.query.organizationMemberships.findMany({
    where: and(
      eq(organizationMemberships.userId, callerId),
      isNull(organizationMemberships.deletedAt),
    ),
  });
  const baseOrgIds = memberships
    .filter((membership: any) => membership.status === "active")
    .map((membership: any) => membership.labId);
  const memberOrgs = baseOrgIds.length
    ? await db
        .select({ id: organizations.id, type: organizations.type })
        .from(organizations)
        .where(inArray(organizations.id, baseOrgIds))
    : [];
  const labSideOrgIds = memberOrgs
    .filter((organization) => organization.type === "lab")
    .map((organization) => organization.id);

  let orgIds = labSideOrgIds;
  const { providerOrgIds } = await getProviderOrgIdsForUserAndLinks(callerId);
  if (providerOrgIds.length) {
    const allowed = await Promise.all(
      providerOrgIds.map((id) =>
        assertProviderOrganizationCapability(id, "billing")
          .then(() => true)
          .catch((error) => {
            if (error instanceof HttpError && error.statusCode === 403) return false;
            throw error;
          }),
      ),
    );
    orgIds = Array.from(new Set([
      ...labSideOrgIds,
      ...providerOrgIds.filter((_, index) => allowed[index]),
    ]));
  }

  return { orgIds, memberships };
}

function invoiceIsInReadScope(
  invoice: {
    labOrganizationId: string;
    providerOrganizationId: string | null;
  },
  scope: InvoiceReadScope,
): boolean {
  return practiceIsInInvoiceReadScope(
    invoice.labOrganizationId,
    invoice.providerOrganizationId,
    scope,
  );
}

function practiceIsInInvoiceReadScope(
  labOrganizationId: string,
  providerOrganizationId: string | null,
  scope: InvoiceReadScope,
): boolean {
  return (
    scope.orgIds.includes(labOrganizationId) ||
    (providerOrganizationId != null &&
      scope.orgIds.includes(providerOrganizationId))
  );
}

function hasDirectLabMembership(
  labOrganizationId: string,
  scope: InvoiceReadScope,
): boolean {
  return scope.memberships.some(
    (membership) =>
      membership.labId === labOrganizationId &&
      membership.status === "active",
  );
}

async function requireInvoicePaymentAccess(
  callerId: string,
  invoice: {
    labOrganizationId: string;
    providerOrganizationId: string | null;
  },
): Promise<void> {
  const readScope = await getInvoiceReadScope(callerId);
  if (!invoiceIsInReadScope(invoice, readScope)) {
    throw new HttpError(403, "You do not have access to this invoice.");
  }

  // Lab billing members can manage their lab's invoices. Direct provider
  // billing members can manage invoices for their provider organization. The
  // read-scope check above keeps either role from reaching an invoice that the
  // canonical invoice routes exclude.
  const billingOrganizationIds = Array.from(
    new Set([
      invoice.labOrganizationId,
      invoice.providerOrganizationId,
    ].filter((organizationId): organizationId is string => organizationId != null)),
  );
  for (const organizationId of billingOrganizationIds) {
    try {
      await requireAnyRole(callerId, organizationId, BILLING_ROLES);
      return;
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 403) continue;
      throw error;
    }
  }

  throw new HttpError(403, "You do not have permission for this action.");
}

function isLikelyLegacyShiftedInvoiceDate(
  value: Date | null,
  invoiceCreatedAt: Date,
): boolean {
  return (
    invoiceCreatedAt < INVOICE_DATE_DRIFT_FIX_AT &&
    value != null &&
    (value.getUTCHours() !== 0 ||
      value.getUTCMinutes() !== 0 ||
      value.getUTCSeconds() !== 0 ||
      value.getUTCMilliseconds() !== 0)
  );
}

router.use(requireAuth);
router.use(requireVerifiedAccount);
// Provider members can reach selected invoice reads through this router.
// Basic plans cannot bypass the provider billing portal through those paths.
router.use(requireProviderCapability("billing"));
router.use(asyncHandler(async (req, _res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const body = req.body;
    const supplied = Array.isArray(body?.invoiceIds) ? body.invoiceIds
      : Array.isArray(body?.ids) ? body.ids : [];
    const ids = supplied.filter((id: unknown): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id));
    if (ids.length) {
      const rows = await db.query.invoices.findMany({ where: inArray(invoices.id, ids) });
      const scope = await getInvoiceReadScope((req as any).auth.userId);
      for (const row of rows) {
        if (invoiceIsInReadScope(row, scope)) assertRecoveryReleased(row);
      }
    }
  }
  next();
}));

// All ordinary invoice mutations/distribution are forbidden for a recovery
// hold, including legacy unfreeze and status endpoints. The dedicated recovery
// router performs the explicit admin charge + settlement review instead.
router.use("/:invoiceId", asyncHandler(async (req, _res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const id = z.string().parse(req.params.invoiceId);
    if (/^[0-9a-f-]{36}$/i.test(id)) {
      const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, id) });
      if (invoice) {
        const scope = await getInvoiceReadScope((req as any).auth.userId);
        if (!invoiceIsInReadScope(invoice, scope)) throw new HttpError(403, "You do not have access to this invoice.");
        assertRecoveryReleased(invoice);
      }
    }
  }
  next();
}));


const emailStatementSchema = z.object({
  labOrganizationId: z.string().min(1),
  practiceOrganizationId: z.string().min(1),
  invoiceIds: z.array(z.string().min(1)).min(1).max(500),
  to: z.string().email().optional(),
  cc: z.array(z.string().email()).max(10).optional(),
  subject: z.string().min(1).max(500),
  message: z.string().min(1).max(20000),
  filename: z.string().min(1).max(200),
  /** Deprecated client field. The server always regenerates the attachment. */
  pdfBase64: z.string().min(1).max(8 * 1024 * 1024).optional(),
});

router.post(
  "/statements/email",
  asyncHandler(async (req, res) => {
    const input = emailStatementSchema.parse(req.body);
    await requireAnyRole(
      (req as any).auth.userId,
      input.labOrganizationId,
      BILLING_ROLES,
    );

    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, input.practiceOrganizationId),
    });
    if (!practice) throw new HttpError(404, "Practice not found.");

    const recipient = (input.to ?? practice.billingEmail ?? "").trim();
    if (!recipient) {
      throw new HttpError(
        400,
        "This practice has no billing email on file. Add one first or enter a recipient.",
      );
    }

    // Collect billing-type additional emails from the practice to add as CC.
    const practiceAdditionalBillingEmails = await db
      .select({ email: organizationAdditionalEmails.email })
      .from(organizationAdditionalEmails)
      .where(
        and(
          eq(organizationAdditionalEmails.organizationId, input.practiceOrganizationId),
          eq(organizationAdditionalEmails.type, "billing"),
        ),
      );
    const additionalCc = practiceAdditionalBillingEmails.map((r) => r.email);
    const effectiveCc = [...(input.cc ?? []), ...additionalCc].filter(Boolean);

    const invoiceRows = await db.query.invoices.findMany({
      where: and(
        inArray(invoices.id, input.invoiceIds),
        eq(invoices.labOrganizationId, input.labOrganizationId),
        eq(invoices.providerOrganizationId, input.practiceOrganizationId),
      ),
    });
    if (invoiceRows.length === 0) {
      throw new HttpError(
        404,
        "None of the selected invoices belong to this practice.",
      );
    }

    const cfg = getMailerConfig();
    if (!cfg) {
      throw new HttpError(
        503,
        "Email is not configured on the server. Ask an administrator to set SMTP credentials.",
      );
    }

    const statement = (
      await buildPracticeStatementsForScope(input.labOrganizationId, {
        scope: "all",
        recipientType: "practice",
        practiceIds: [input.practiceOrganizationId],
        from: null,
        to: null,
      })
    )[0];
    if (!statement) {
      throw new HttpError(404, "No statement data found for this practice.");
    }
    const selected = new Set(input.invoiceIds);
    const selectedInvoices = statement.invoices.filter((invoice) => selected.has(invoice.id));
    if (!selectedInvoices.length) {
      throw new HttpError(404, "None of the selected invoices belong to this practice.");
    }
    const selectedData: PracticeStatementData = {
      ...statement,
      invoiceCount: selectedInvoices.length,
      totalBilled: selectedInvoices.reduce((sum, invoice) => sum + Number(invoice.total), 0),
      totalPaid: selectedInvoices.reduce(
        (sum, invoice) => sum + Math.max(0, Number(invoice.total) - Number(invoice.balanceDue)),
        0,
      ),
      openBalance: selectedInvoices.reduce((sum, invoice) => sum + Number(invoice.balanceDue), 0),
      invoices: selectedInvoices,
    };
    const labOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, input.labOrganizationId),
    });
    const schedule = await db.query.statementSchedules.findFirst({
      where: eq(
        statementSchedules.labOrganizationId,
        input.labOrganizationId,
      ),
      columns: { emailReplyTo: true },
    });
    const [savedTemplateRow] = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(
        eq(
          systemSettings.key,
          `tmpl_statement_email:${input.labOrganizationId}`,
        ),
      );
    let savedTemplateReplyTo: string | undefined;
    if (savedTemplateRow?.value) {
      try {
        const savedTemplate = JSON.parse(savedTemplateRow.value) as {
          emailReplyTo?: unknown;
        };
        if (typeof savedTemplate.emailReplyTo === "string") {
          savedTemplateReplyTo =
            savedTemplate.emailReplyTo.trim() || undefined;
        }
      } catch {
        // Ignore malformed legacy settings and use the schedule/default behavior.
      }
    }
    const pdfBuffer = await generateStatementPdfBuffer(
      labOrg?.displayName || labOrg?.name || "LabTrax",
      selectedData,
      `Statement as of ${new Date().toLocaleDateString("en-US")}`,
      await readLogoBuffer(input.labOrganizationId),
      (labOrg as any)?.logoPdfSize,
      "all",
      labOrg?.invoiceDueDayOfMonth ?? null,
      null,
      coerceStatementTemplate((labOrg as any)?.statementTemplate).defaultTextBlocks,
      input.labOrganizationId,
      coerceStatementTemplate((labOrg as any)?.statementTemplate),
    );

    const transporter = createTransport(cfg);
    try {
      await transporter.sendMail({
        from: cfg.from,
        to: recipient,
        cc: effectiveCc.length ? effectiveCc : undefined,
        replyTo:
          schedule?.emailReplyTo?.trim() ||
          savedTemplateReplyTo ||
          undefined,
        subject: input.subject,
        text: input.message,
        attachments: [
          {
            filename: input.filename.endsWith(".pdf")
              ? input.filename
              : `${input.filename}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
          },
        ],
      });
    } catch (err: any) {
      const classified = classifySmtpError(err);
      req.log?.error?.(
        {
          smtpCategory: classified.category,
          smtpResponseCode: classified.responseCode,
          smtpCode: classified.code,
        },
        "[STATEMENT EMAIL] sendMail failed",
      );
      throw new HttpError(502, classified.message);
    }

    const user = (req as any).user;
    const actorInitials = user?.initials || "SYS";
    const sentAt = new Date();
    const metadata = {
      practiceOrganizationId: practice.id,
      practiceName: practice.displayName || practice.name,
      to: recipient,
      cc: input.cc ?? [],
      subject: input.subject,
      invoiceIds: invoiceRows.map((i: any) => i.id),
      invoiceNumbers: invoiceRows.map((i: any) => i.invoiceNumber),
      filename: input.filename,
      sentAt: sentAt.toISOString(),
    };

    await writeAuditLog({
      req,
      organizationId: input.labOrganizationId,
      action: "statement_emailed",
      entityType: "organization",
      entityId: practice.id,
      metadataJson: metadata,
    });

    const caseIds = Array.from(
      new Set(
        invoiceRows
          .map((i: any) => i.caseId as string | null)
          .filter((id: string | null): id is string => !!id),
      ),
    );
    if (caseIds.length) {
      await db.insert(caseEvents).values(
        invoiceRows
          .filter((i: any) => i.caseId)
          .map((i: any) => ({
            caseId: i.caseId as string,
            eventType: "statement_emailed",
            actorUserId: (req as any).auth.userId,
            actorOrganizationId: input.labOrganizationId,
            actorInitials,
            metadataJson: {
              invoiceId: i.id,
              invoiceNumber: i.invoiceNumber,
              to: recipient,
              subject: input.subject,
              practiceOrganizationId: practice.id,
            },
          })),
      ).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to record statement_emailed timeline events.",
      }));
    }

    return ok(res, {
      sentAt: sentAt.toISOString(),
      to: recipient,
      cc: input.cc ?? [],
      invoiceCount: invoiceRows.length,
    });
  }),
);

const smsStatementSchema = z.object({
  labOrganizationId: z.string().min(1),
  practiceOrganizationId: z.string().min(1),
  invoiceIds: z.array(z.string().min(1)).min(1).max(500),
  to: z.string().min(7).max(40).optional(),
  message: z.string().min(1).max(1500),
});

router.post(
  "/statements/sms",
  asyncHandler(async (req, res) => {
    const input = smsStatementSchema.parse(req.body);
    await requireAnyRole(
      (req as any).auth.userId,
      input.labOrganizationId,
      BILLING_ROLES,
    );

    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, input.practiceOrganizationId),
    });
    if (!practice) throw new HttpError(404, "Practice not found.");

    const rawRecipient = (input.to ?? (practice as any).phone ?? "").trim();
    if (!rawRecipient) {
      throw new HttpError(
        400,
        "This practice has no phone number on file. Add one first or enter a number.",
      );
    }
    const recipient = normalizePhoneE164(rawRecipient);
    if (!recipient) {
      throw new HttpError(400, "Invalid phone number. Please use a 10-digit US number or E.164 format (e.g. +18503633336).");
    }

    const invoiceRows = await db.query.invoices.findMany({
      where: and(
        inArray(invoices.id, input.invoiceIds),
        eq(invoices.labOrganizationId, input.labOrganizationId),
        eq(invoices.providerOrganizationId, input.practiceOrganizationId),
      ),
    });
    if (invoiceRows.length === 0) {
      throw new HttpError(404, "None of the selected invoices belong to this practice.");
    }

    const { sendSms } = await import("../lib/sms.js");
    const result = await sendSms({ to: recipient, body: input.message });
    if (!result.ok && !result.skipped) {
      throw new HttpError(502, result.errorMessage ?? "SMS failed.");
    }

    const sentAt = new Date();
    await writeAuditLog({
      req,
      organizationId: input.labOrganizationId,
      action: "statement_texted",
      entityType: "organization",
      entityId: practice.id,
      metadataJson: {
        practiceOrganizationId: practice.id,
        practiceName: practice.displayName || practice.name,
        to: recipient,
        invoiceIds: invoiceRows.map((i: any) => i.id),
        invoiceNumbers: invoiceRows.map((i: any) => i.invoiceNumber),
        sentAt: sentAt.toISOString(),
      },
    });

    return ok(res, { sentAt: sentAt.toISOString(), to: recipient, invoiceCount: invoiceRows.length });
  }),
);

const emailInvoiceSchema = z.object({
  to: z.string().email().optional(),
  cc: z.array(z.string().email()).max(10).optional(),
  subject: z.string().min(1).max(500),
  message: z.string().min(1).max(20000),
  filename: z.string().min(1).max(200),
  pdfBase64: z.string().min(1).max(8 * 1024 * 1024),
  attachmentIds: z.array(z.string().min(1)).max(20).optional(),
});

router.post(
  "/:invoiceId/email",
  asyncHandler(async (req, res) => {
    const input = emailInvoiceSchema.parse(req.body);
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, req.params.invoiceId),
    });
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    await requireAnyRole(
      (req as any).auth.userId,
      invoice.labOrganizationId,
      BILLING_ROLES,
    );

    if (!invoice.providerOrganizationId)
      throw new HttpError(404, "This invoice has no associated practice.");
    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, invoice.providerOrganizationId),
    });
    if (!practice) throw new HttpError(404, "Practice not found.");

    const recipient = (input.to ?? practice.billingEmail ?? "").trim();
    if (!recipient) {
      throw new HttpError(
        400,
        "This practice has no billing email on file. Add one first or enter a recipient.",
      );
    }

    // Collect billing-type additional emails to include as CC.
    const invoiceAdditionalBillingEmails = await db
      .select({ email: organizationAdditionalEmails.email })
      .from(organizationAdditionalEmails)
      .where(
        and(
          eq(organizationAdditionalEmails.organizationId, invoice.providerOrganizationId),
          eq(organizationAdditionalEmails.type, "billing"),
        ),
      );
    const invoiceAdditionalCc = invoiceAdditionalBillingEmails.map((r) => r.email);
    const invoiceEffectiveCc = [...(input.cc ?? []), ...invoiceAdditionalCc].filter(Boolean);

    const cfg = getMailerConfig();
    if (!cfg) {
      throw new HttpError(
        503,
        "Email is not configured on the server. Ask an administrator to set SMTP credentials.",
      );
    }

    let pdfBuffer: Buffer;
    try {
      pdfBuffer = Buffer.from(input.pdfBase64, "base64");
    } catch {
      throw new HttpError(400, "Invalid PDF payload.");
    }
    if (pdfBuffer.length === 0) {
      throw new HttpError(400, "Invalid PDF payload.");
    }

    const extraAttachments: Array<{
      filename: string;
      content: Buffer;
      contentType: string;
    }> = [];
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      const rows = await db.query.invoiceAttachments.findMany({
        where: and(
          eq(invoiceAttachments.invoiceId, invoice.id),
          inArray(invoiceAttachments.id, input.attachmentIds),
          isNull(invoiceAttachments.deletedAt),
        ),
      });
      for (const row of rows) {
        const safeName = path.basename(row.storageKey);
        const filePath = path.resolve(invoiceAttachmentsDir, safeName);
        if (!filePath.startsWith(invoiceAttachmentsDir + path.sep)) continue;
        try {
          const buf = fs.readFileSync(filePath);
          extraAttachments.push({
            filename: row.fileName || row.storageKey,
            content: buf,
            contentType: row.fileType || "application/octet-stream",
          });
        } catch (err) {
          req.log?.warn?.(
            { err, attachmentId: row.id },
            "[INVOICE EMAIL] failed to read attachment from disk",
          );
        }
      }
    }

    const transporter = createTransport(cfg);
    try {
      await transporter.sendMail({
        from: cfg.from,
        to: recipient,
        cc: invoiceEffectiveCc.length ? invoiceEffectiveCc : undefined,
        subject: input.subject,
        text: input.message,
        attachments: [
          {
            filename: input.filename.endsWith(".pdf")
              ? input.filename
              : `${input.filename}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
          },
          ...extraAttachments,
        ],
      });
    } catch (err: any) {
      const classified = classifySmtpError(err);
      req.log?.error?.(
        {
          smtpCategory: classified.category,
          smtpResponseCode: classified.responseCode,
          smtpCode: classified.code,
        },
        "[INVOICE EMAIL] sendMail failed",
      );
      throw new HttpError(502, classified.message);
    }

    const user = (req as any).user;
    const actorInitials = user?.initials || "SYS";
    const sentAt = new Date();
    const metadata = {
      practiceOrganizationId: practice.id,
      practiceName: practice.displayName || practice.name,
      to: recipient,
      cc: input.cc ?? [],
      subject: input.subject,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      filename: input.filename,
      sentAt: sentAt.toISOString(),
    };

    await writeAuditLog({
      req,
      organizationId: invoice.labOrganizationId,
      action: "invoice_emailed",
      entityType: "invoice",
      entityId: invoice.id,
      metadataJson: metadata,
    });

    if (invoice.caseId) {
      await db.insert(caseEvents).values({
        caseId: invoice.caseId,
        eventType: "invoice_emailed",
        actorUserId: (req as any).auth.userId,
        actorOrganizationId: invoice.labOrganizationId,
        actorInitials,
        metadataJson: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          to: recipient,
          subject: input.subject,
          practiceOrganizationId: practice.id,
        },
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to record invoice_emailed timeline event.",
      }));
    }

    return ok(res, {
      sentAt: sentAt.toISOString(),
      to: recipient,
      cc: input.cc ?? [],
    });
  }),
);

const smsInvoiceSchema = z.object({
  to: z.string().min(7).max(40).optional(),
  message: z.string().min(1).max(1500),
});

router.post(
  "/:invoiceId/sms",
  asyncHandler(async (req, res) => {
    const input = smsInvoiceSchema.parse(req.body);
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, req.params.invoiceId),
    });
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    await requireAnyRole(
      (req as any).auth.userId,
      invoice.labOrganizationId,
      BILLING_ROLES,
    );

    if (!invoice.providerOrganizationId)
      throw new HttpError(404, "This invoice has no associated practice.");
    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, invoice.providerOrganizationId),
    });
    if (!practice) throw new HttpError(404, "Practice not found.");

    const rawRecipient = (input.to ?? (practice as any).phone ?? "").trim();
    if (!rawRecipient) {
      throw new HttpError(
        400,
        "This practice has no phone number on file. Add one first or enter a number.",
      );
    }
    const recipient = normalizePhoneE164(rawRecipient);
    if (!recipient) {
      throw new HttpError(400, "Invalid phone number. Please use a 10-digit US number or E.164 format (e.g. +18503633336).");
    }

    const { sendSms } = await import("../lib/sms.js");
    const result = await sendSms({ to: recipient, body: input.message });
    if (!result.ok && !result.skipped) {
      throw new HttpError(502, result.errorMessage ?? "SMS failed.");
    }

    const user = (req as any).user;
    const actorInitials = user?.initials || "SYS";
    const sentAt = new Date();

    await writeAuditLog({
      req,
      organizationId: invoice.labOrganizationId,
      action: "invoice_sms_sent",
      entityType: "invoice",
      entityId: invoice.id,
      metadataJson: {
        practiceOrganizationId: practice.id,
        practiceName: practice.displayName || practice.name,
        to: recipient,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        sentAt: sentAt.toISOString(),
      },
    });

    if (invoice.caseId) {
      await db.insert(caseEvents).values({
        caseId: invoice.caseId,
        eventType: "invoice_sms_sent",
        actorUserId: (req as any).auth.userId,
        actorOrganizationId: invoice.labOrganizationId,
        actorInitials,
        metadataJson: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          to: recipient,
          practiceOrganizationId: practice.id,
        },
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to record invoice_sms_sent timeline event.",
      }));
    }

    return ok(res, {
      sentAt: sentAt.toISOString(),
      to: recipient,
    });
  }),
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const memberships = await db.query.organizationMemberships.findMany({
      where: eq(organizationMemberships.userId, (req as any).auth.userId),
    });
    const labOrgIds = memberships
      .filter((m: any) => m.status === "active")
      .map((m: any) => m.labId);

    const input = z
      .object({
        invoiceNumber: z.string().min(1).max(100),
        labOrganizationId: z.string().min(1),
        providerOrganizationId: z.string().min(1),
        issuedAt: z.string().datetime().nullable().optional(),
        dueAt: z.string().datetime().nullable().optional(),
      })
      .parse(req.body);

    if (!labOrgIds.includes(input.labOrganizationId)) {
      throw new HttpError(403, "You do not have access to this organization.");
    }
    await requireAnyRole(
      (req as any).auth.userId,
      input.labOrganizationId,
      BILLING_ROLES
    );

    const invoiceLabOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, input.labOrganizationId),
      columns: { invoiceDueDayOfMonth: true },
    });

    const [invoice] = await db
      .insert(invoices)
      .values({
        invoiceNumber: input.invoiceNumber,
        labOrganizationId: input.labOrganizationId,
        providerOrganizationId: input.providerOrganizationId,
        status: "open",
        issuedAt: input.issuedAt ? new Date(input.issuedAt) : new Date(),
        dueAt: input.dueAt
          ? new Date(input.dueAt)
          : invoiceDueDate(input.issuedAt ? new Date(input.issuedAt) : new Date(), invoiceLabOrg?.invoiceDueDayOfMonth),
        createdByUserId: (req as any).auth.userId,
        updatedByUserId: (req as any).auth.userId,
      })
      .returning()
      .catch((err: unknown): never => wrapDbError(err));

    await writeAuditLog({
      req,
      organizationId: input.labOrganizationId,
      action: "invoice_created",
      entityType: "invoice",
      entityId: invoice.id,
      afterJson: invoice,
    });

    return ok(res, invoice, 201);
  })
);

function nextInvoiceNumber(caseNumber: string) {
  return `INV-${caseNumber}`;
}

// Build the invoice editor's `displayMetadataJson` blob from the originating
// case + its restorations + its notes. This pre-fills the patient name,
// bill-to (doctor), teeth list (comma-separated), shade, and case notes
// fields the same way they appear on the case card / case drawer — including
// when the case was originally AI-imported from a prescription, since the
// AI flow writes those values into the same `cases` and `case_restorations`
// columns we read here.
function buildInvoiceDisplayMetadataFromCase(
  caseRow: {
    patientFirstName: string | null;
    patientLastName: string | null;
    doctorName: string | null;
  },
  restorationRows: Array<{
    toothNumber: string | null;
    shade: string | null;
    material?: string | null;
    restorationType?: string | null;
    restorationSubtype?: string | null;
  }>,
  noteRows: Array<{ noteText: string | null }>,
) {
  const patientName = `${caseRow.patientFirstName ?? ""} ${caseRow.patientLastName ?? ""}`
    .replace(/\s+/g, " ")
    .trim();

  const seenTeeth = new Set<string>();
  const teethOrdered: string[] = [];
  for (const r of restorationRows) {
    const t = (r.toothNumber ?? "").trim();
    if (t && !seenTeeth.has(t)) {
      seenTeeth.add(t);
      teethOrdered.push(t);
    }
  }
  // Sort numerically when every tooth parses as a number, otherwise keep
  // restoration order so non-numeric notations (e.g. FDI "11", "UR1") are
  // not reordered into something nonsensical.
  const allNumeric = teethOrdered.every((t) => /^\d+$/.test(t));
  const teeth = allNumeric
    ? teethOrdered.slice().sort((a, b) => Number(a) - Number(b)).join(", ")
    : teethOrdered.join(", ");

  const seenShades = new Set<string>();
  const shadesOrdered: string[] = [];
  for (const r of restorationRows) {
    const s = (r.shade ?? "").trim();
    if (s && !seenShades.has(s)) {
      seenShades.add(s);
      shadesOrdered.push(s);
    }
  }
  const shade = shadesOrdered.join(", ");

  const seenMaterials = new Set<string>();
  const materialsOrdered: string[] = [];
  for (const r of restorationRows) {
    const m = (r.material ?? "").trim();
    if (m && !seenMaterials.has(m)) {
      seenMaterials.add(m);
      materialsOrdered.push(m);
    }
  }
  const material = materialsOrdered.join(", ");

  const seenCaseTypes = new Set<string>();
  const caseTypesOrdered: string[] = [];
  for (const r of restorationRows) {
    const ct = (r.restorationType ?? "").trim();
    if (ct && !seenCaseTypes.has(ct)) {
      seenCaseTypes.add(ct);
      caseTypesOrdered.push(ct);
    }
  }
  const caseType = caseTypesOrdered.join(", ");

  const seenCaseSubtypes = new Set<string>();
  const caseSubtypesOrdered: string[] = [];
  for (const r of restorationRows) {
    const cs = (r.restorationSubtype ?? "").trim();
    if (cs && !seenCaseSubtypes.has(cs)) {
      seenCaseSubtypes.add(cs);
      caseSubtypesOrdered.push(cs);
    }
  }
  const caseSubtype = caseSubtypesOrdered.join(", ");

  const caseNotesText = noteRows
    .map((n) => (n.noteText ?? "").trim())
    .filter(Boolean)
    .join("\n\n");

  return {
    patientName,
    billTo: (caseRow.doctorName ?? "").trim(),
    teeth,
    shade,
    material,
    caseType,
    caseSubtype,
    caseNotes: caseNotesText,
  };
}

// Pre-flight check: report which cases would be skipped due to an invoice
// number collision if the backfill were run now, without actually creating
// anything. Same auth requirement as the backfill itself.
router.get(
  "/lab-orgs/:labOrganizationId/backfill-preview",
  asyncHandler(async (req, res) => {
    const labOrganizationId = req.params.labOrganizationId;
    await requireAnyRole(
      (req as any).auth.userId,
      labOrganizationId,
      ADMIN_ROLES
    );

    const labCases = await db.query.cases.findMany({
      where: eq(cases.labOrganizationId, labOrganizationId),
    });

    const collisions: Array<{ caseId: string; caseNumber: string; invoiceNumber: string }> = [];

    for (const found of labCases) {
      const existingForCase = await db.query.invoices.findFirst({
        where: eq(invoices.caseId, found.id),
      });
      if (existingForCase) continue;

      const restorations = await db.query.caseRestorations.findMany({
        where: eq(caseRestorations.caseId, found.id),
      });
      if (!restorations.length) continue;

      const invoiceNumber = nextInvoiceNumber(found.caseNumber);
      const conflicting = await db.query.invoices.findFirst({
        where: and(
          eq(invoices.labOrganizationId, labOrganizationId),
          eq(invoices.invoiceNumber, invoiceNumber),
        ),
      });
      if (conflicting) {
        collisions.push({ caseId: found.id, caseNumber: found.caseNumber, invoiceNumber });
      }
    }

    return ok(res, { labOrganizationId, casesChecked: labCases.length, collisions });
  })
);

// Admin-only batch backfill: for a given lab org, find every case that does
// not yet have an invoice and generate one for it using the same per-case
// generation logic. Idempotent: relies on the unique index on
// invoices.invoice_number plus a per-case existence check, so re-running on
// the same lab is a no-op (no duplicate invoices, no status mutation, no
// double deposit). Skips cases with zero restorations and cases whose
// expected invoice number is already taken.
router.post(
  "/lab-orgs/:labOrganizationId/backfill",
  asyncHandler(async (req, res) => {
    const labOrganizationId = req.params.labOrganizationId;
    // Lab-admin only: this is a batch maintenance operation that mints
    // invoices across the entire lab, so we restrict it to owner/admin
    // even though normal per-case generation allows the broader billing
    // role set.
    await requireAnyRole(
      (req as any).auth.userId,
      labOrganizationId,
      ADMIN_ROLES
    );

    const labCases = await db.query.cases.findMany({
      where: eq(cases.labOrganizationId, labOrganizationId),
    });

    let created = 0;
    let skippedExisting = 0;
    let skippedNoRestorations = 0;
    let skippedNumberTaken = 0;
    const createdInvoiceIds: string[] = [];
    const skippedNumberTakenCases: Array<{ caseId: string; caseNumber: string; invoiceNumber: string }> = [];

    for (const found of labCases) {
      const existingForCase = await db.query.invoices.findFirst({
        where: eq(invoices.caseId, found.id),
      });
      if (existingForCase) {
        skippedExisting++;
        continue;
      }

      const restorations = await db.query.caseRestorations.findMany({
        where: eq(caseRestorations.caseId, found.id),
      });
      if (!restorations.length) {
        skippedNoRestorations++;
        continue;
      }

      const invoiceNumber = nextInvoiceNumber(found.caseNumber);
      const noteRows = await db.query.caseNotes.findMany({
        where: and(
          eq(caseNotes.caseId, found.id),
          eq(caseNotes.visibility, "shared_with_provider"),
        ),
        orderBy: [caseNotes.createdAt],
      });
      const displayMetadataJson = buildInvoiceDisplayMetadataFromCase(
        found,
        restorations,
        noteRows,
      );
      const doctorIdentity = await ensureDoctorProfileIdentity(db, {
        labOrganizationId: found.labOrganizationId,
        providerOrganizationId: found.providerOrganizationId ?? null,
        doctorName: found.doctorName,
      });
      const [invoice] = await db
        .insert(invoices)
        .values({
          invoiceNumber,
          caseId: found.id,
          labOrganizationId: found.labOrganizationId,
          providerOrganizationId: found.providerOrganizationId,
          doctorIdentity,
          status: "open",
          displayMetadataJson,
          issuedAt: calendarDateToUtcNoon(found.receivedAt),
          dueAt: invoiceDueDate(new Date()),
          createdByUserId: (req as any).auth.userId,
          updatedByUserId: (req as any).auth.userId,
        })
        .onConflictDoNothing({ target: [invoices.labOrganizationId, invoices.invoiceNumber] })
        .returning()
        .catch((err: unknown): never => wrapDbError(err));

      if (!invoice) {
        // Invoice number collided with a row not linked to this case (e.g.
        // a manual invoice created with the same number within the same lab).
        // Do nothing — we refuse to silently retitle or relink an existing invoice.
        skippedNumberTaken++;
        skippedNumberTakenCases.push({ caseId: found.id, caseNumber: found.caseNumber, invoiceNumber });
        continue;
      }

      const backfillLabelCache: Record<string, string> = {};
      for (const r of restorations) {
        const pk =
          (await resolveRestorationPriceKey({
            labOrganizationId: found.labOrganizationId,
            material: r.material,
            restorationType: r.restorationType,
            restorationSubtype: r.restorationSubtype,
          })) ?? r.restorationType;
        if (!(pk in backfillLabelCache)) {
          backfillLabelCache[pk] = await resolveItemLabel(found.labOrganizationId, pk);
        }
      }
      const itemsToInsert = await Promise.all(restorations.map(async (restoration, index) => {
        const pk =
          (await resolveRestorationPriceKey({
            labOrganizationId: found.labOrganizationId,
            material: restoration.material,
            restorationType: restoration.restorationType,
            restorationSubtype: restoration.restorationSubtype,
          })) ?? restoration.restorationType;
        const label = backfillLabelCache[pk] ?? restoration.restorationType;
        const toothInt = parseInt(restoration.toothNumber, 10);
        return {
          invoiceId: invoice.id,
          caseRestorationId: restoration.id,
          sourceType: "restoration",
          sourceKey: `restoration:${restoration.id}`,
          sourceRestorationIdsJson: [restoration.id],
          toothNumber: Number.isInteger(toothInt) && toothInt >= 1 && toothInt <= 32 ? toothInt : null,
          description: buildLineItemDescription(restoration.toothNumber, label),
          quantity: restoration.quantity,
          unitPrice: restoration.unitPrice,
          lineTotal: calculateLineTotal(
            restoration.quantity,
            restoration.unitPrice
          ),
          sortOrder: index,
        };
      }));
      await db.insert(invoiceLineItems).values(itemsToInsert).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to insert invoice line items during backfill.",
      }));

      const subtotal = sumMoney(itemsToInsert.map((item) => item.lineTotal));
      await db
        .update(invoices)
        .set({
          subtotal,
          total: subtotal,
          balanceDue: subtotal,
          updatedByUserId: (req as any).auth.userId,
          issuedAt: calendarDateToUtcNoon(found.receivedAt),
          status: "open",
        })
        .where(eq(invoices.id, invoice.id));

      const user = (req as any).user;
      await db.insert(caseEvents).values({
        caseId: found.id,
        eventType: "invoice_generated",
        actorUserId: (req as any).auth.userId,
        actorOrganizationId: found.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          source: "backfill",
        },
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to record invoice_generated timeline event.",
      }));

      created++;
      createdInvoiceIds.push(invoice.id);
    }

    const summary = {
      labOrganizationId,
      casesScanned: labCases.length,
      created,
      skippedExisting,
      skippedNoRestorations,
      skippedNumberTaken,
      skippedNumberTakenCases,
      createdInvoiceIds,
    };

    req.log?.info?.({ summary }, "[INVOICE BACKFILL] completed");

    await writeAuditLog({
      req,
      organizationId: labOrganizationId,
      action: "invoices_backfilled",
      entityType: "organization",
      entityId: labOrganizationId,
      metadataJson: summary,
    });

    return ok(res, summary);
  })
);

// Admin-only one-time job: patch displayMetadataJson on every invoice that is
// linked to a case (caseId is set) but is missing at least one of the newer
// metadata keys (caseType, caseSubtype, material). Re-runs
// buildInvoiceDisplayMetadataFromCase so the values come from the live
// case_restorations rows, exactly the same as when the invoice was first
// generated. Idempotent: invoices that already have all three keys are
// skipped. Tenant-scoped: only touches invoices belonging to the supplied lab.
router.post(
  "/lab-orgs/:labOrganizationId/backfill-display-metadata",
  asyncHandler(async (req, res) => {
    const labOrganizationId = req.params.labOrganizationId;
    await requireAnyRole(
      (req as any).auth.userId,
      labOrganizationId,
      ADMIN_ROLES,
    );

    // Fetch all case-linked invoices for this lab that are missing at least
    // one of caseType / caseSubtype / material in their displayMetadataJson.
    // We use a Postgres JSON operator to test for key presence.
    const staleInvoices = await db
      .select({
        id: invoices.id,
        caseId: invoices.caseId,
        displayMetadataJson: invoices.displayMetadataJson,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.labOrganizationId, labOrganizationId),
          isNotNull(invoices.caseId),
          or(
            sql`(${invoices.displayMetadataJson}->>'caseType') IS NULL`,
            sql`(${invoices.displayMetadataJson}->>'caseSubtype') IS NULL`,
            sql`(${invoices.displayMetadataJson}->>'material') IS NULL`,
          ),
        ),
      );

    let updated = 0;
    let skippedNoCase = 0;
    let skippedNoRestorations = 0;
    const updatedInvoiceIds: string[] = [];

    for (const inv of staleInvoices) {
      // caseId is guaranteed non-null by the WHERE clause, but TypeScript
      // doesn't know that — narrow it explicitly.
      if (!inv.caseId) {
        skippedNoCase++;
        continue;
      }

      const caseRow = await db.query.cases.findFirst({
        where: eq(cases.id, inv.caseId),
      });
      if (!caseRow) {
        skippedNoCase++;
        continue;
      }

      const restorations = await db.query.caseRestorations.findMany({
        where: eq(caseRestorations.caseId, inv.caseId),
      });
      if (!restorations.length) {
        skippedNoRestorations++;
        continue;
      }

      const noteRows = await db.query.caseNotes.findMany({
        where: and(
          eq(caseNotes.caseId, inv.caseId),
          eq(caseNotes.visibility, "shared_with_provider"),
        ),
        orderBy: [caseNotes.createdAt],
      });

      // Build a fresh metadata blob from the live restorations. This will
      // populate caseType, caseSubtype, and material (even if they turn out
      // to be empty strings for old cases with no restoration type data).
      const freshMeta = buildInvoiceDisplayMetadataFromCase(
        caseRow,
        restorations,
        noteRows,
      );

      // Merge into the existing blob so we never clobber keys that were
      // manually edited (e.g. a custom patientName or billTo override).
      const existingMeta =
        inv.displayMetadataJson &&
        typeof inv.displayMetadataJson === "object"
          ? (inv.displayMetadataJson as Record<string, unknown>)
          : {};

      const patchedMeta = {
        ...freshMeta,
        // Preserve any manually-edited free-text fields over the rebuilt values.
        ...(existingMeta["patientName"] !== undefined
          ? { patientName: existingMeta["patientName"] }
          : {}),
        ...(existingMeta["billTo"] !== undefined
          ? { billTo: existingMeta["billTo"] }
          : {}),
        ...(existingMeta["caseNotes"] !== undefined
          ? { caseNotes: existingMeta["caseNotes"] }
          : {}),
      };

      await db
        .update(invoices)
        .set({
          displayMetadataJson: patchedMeta,
          updatedByUserId: (req as any).auth.userId,
        })
        .where(eq(invoices.id, inv.id))
        .catch((err: unknown): never => wrapDbError(err));

      updated++;
      updatedInvoiceIds.push(inv.id);
    }

    const summary = {
      labOrganizationId,
      invoicesScanned: staleInvoices.length,
      updated,
      skippedNoCase,
      skippedNoRestorations,
      updatedInvoiceIds,
    };

    req.log?.info?.({ summary }, "[INVOICE DISPLAY-METADATA BACKFILL] completed");

    await writeAuditLog({
      req,
      organizationId: labOrganizationId,
      action: "invoices_display_metadata_backfilled",
      entityType: "organization",
      entityId: labOrganizationId,
      metadataJson: summary,
    });

    return ok(res, summary);
  }),
);

// Distinct, order-preserving, trimmed join of a column across rows.
function distinctJoinValues(values: Array<string | null>): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of values) {
    const v = (raw ?? "").trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      ordered.push(v);
    }
  }
  return ordered.join(", ");
}

// Maximum number of detail rows returned to the client for the shade/material
// gap report and backfill result. gapCount / remainingGapCount are always the
// true total (never capped) — only the `rows` list is truncated for very
// large labs, and `rowsTruncated` says so.
const SHADE_MATERIAL_GAP_ROW_CAP = 200;

type ShadeMaterialGapStatus = "fully_fixable" | "partially_fixable" | "not_fixable";

const SHADE_MATERIAL_GAP_STATUS_ORDER: Record<ShadeMaterialGapStatus, number> = {
  // Rows needing a human are surfaced first, then partial fixes (still need a
  // look after the run), then rows the tool will fully resolve on its own.
  not_fixable: 0,
  partially_fixable: 1,
  fully_fixable: 2,
};

interface ShadeMaterialGapRow {
  invoiceId: string;
  invoiceNumber: string;
  caseId: string | null;
  caseNumber: string | null;
  practiceName: string | null;
  patientName: string;
  currentShade: string;
  currentMaterial: string;
  shadeMissing: boolean;
  materialMissing: boolean;
  derivedShade: string | null;
  derivedMaterial: string | null;
  status: ShadeMaterialGapStatus;
}

// Internal-only row shape that carries the raw display-metadata object so the
// backfill can merge its writes without a second per-invoice fetch. Never
// sent to clients directly — see projectGapRowsForResponse.
type InternalShadeMaterialGapRow = ShadeMaterialGapRow & {
  rawMeta: Record<string, unknown>;
};

// Shared, lab-scoped shade/material gap detector used by BOTH the read-only
// report (GET /admin/shade-material-gaps) and the backfill mutation
// (POST /admin/shade-material-backfill), so the two endpoints can never
// disagree about what counts as a gap or what the tool would derive for it.
// Rules (unchanged from the original per-endpoint implementations):
//  - only case-linked, non-deleted invoices for this lab are considered
//  - restorations of type "missing" are ignored (nothing usable to derive)
//  - derived values are trimmed, de-duplicated, order-preserving joins
//  - a non-empty snapshot value is NEVER treated as fillable/overwritable
// Case and restoration data for every candidate invoice is fetched in one
// batch (not per-invoice) to keep this cheap for large labs.
async function computeShadeMaterialGaps(
  labOrganizationId: string,
): Promise<{ totalCaseLinked: number; gapCount: number; rows: InternalShadeMaterialGapRow[] }> {
  const invoiceRows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      caseId: invoices.caseId,
      providerOrganizationId: invoices.providerOrganizationId,
      displayMetadataJson: invoices.displayMetadataJson,
    })
    .from(invoices)
    .where(
      and(
        isNotNull(invoices.caseId),
        eq(invoices.labOrganizationId, labOrganizationId),
        isNull(invoices.deletedAt),
      ),
    )
    .orderBy(asc(invoices.invoiceNumber));

  const totalCaseLinked = invoiceRows.length;

  const withMeta = invoiceRows.map((inv) => {
    const rawMeta = (
      inv.displayMetadataJson && typeof inv.displayMetadataJson === "object"
        ? (inv.displayMetadataJson as Record<string, unknown>)
        : {}
    );
    const currentShade = typeof rawMeta.shade === "string" ? rawMeta.shade.trim() : "";
    const currentMaterial =
      typeof rawMeta.material === "string" ? rawMeta.material.trim() : "";
    return {
      ...inv,
      rawMeta,
      currentShade,
      currentMaterial,
      shadeMissing: currentShade === "",
      materialMissing: currentMaterial === "",
    };
  });

  const gapInvoices = withMeta.filter((inv) => inv.shadeMissing || inv.materialMissing);
  const gapCount = gapInvoices.length;

  // Batch-fetch everything the detail rows need across every gap invoice's
  // case, rather than querying per invoice.
  const caseIds = Array.from(
    new Set(gapInvoices.map((inv) => inv.caseId).filter((id): id is string => !!id)),
  );
  const practiceIds = Array.from(
    new Set(
      gapInvoices
        .map((inv) => inv.providerOrganizationId)
        .filter((id): id is string => !!id),
    ),
  );

  const [caseRows, restorationRows, orgRows] = await Promise.all([
    caseIds.length
      ? db
          .select({
            id: cases.id,
            caseNumber: cases.caseNumber,
            patientFirstName: cases.patientFirstName,
            patientLastName: cases.patientLastName,
          })
          .from(cases)
          .where(inArray(cases.id, caseIds))
      : Promise.resolve([]),
    caseIds.length
      ? db
          .select({
            caseId: caseRestorations.caseId,
            shade: caseRestorations.shade,
            material: caseRestorations.material,
            restorationType: caseRestorations.restorationType,
          })
          .from(caseRestorations)
          .where(inArray(caseRestorations.caseId, caseIds))
      : Promise.resolve([]),
    practiceIds.length
      ? db
          .select({ id: organizations.id, name: organizations.name })
          .from(organizations)
          .where(inArray(organizations.id, practiceIds))
      : Promise.resolve([]),
  ]);

  const caseById = new Map(caseRows.map((c) => [c.id, c]));
  const orgNameById = new Map(orgRows.map((o) => [o.id, o.name]));
  const restorationsByCase = new Map<string, typeof restorationRows>();
  for (const r of restorationRows) {
    const arr = restorationsByCase.get(r.caseId) ?? [];
    arr.push(r);
    restorationsByCase.set(r.caseId, arr);
  }

  const rows: InternalShadeMaterialGapRow[] = gapInvoices.map((inv) => {
    const caseRow = inv.caseId ? (caseById.get(inv.caseId) ?? null) : null;
    const billable =
      (inv.caseId ? restorationsByCase.get(inv.caseId) : undefined)?.filter(
        (r) => !/^missing$/i.test(r.restorationType ?? ""),
      ) ?? [];

    const derivedShadeJoin = distinctJoinValues(billable.map((r) => r.shade));
    const derivedMaterialJoin = distinctJoinValues(billable.map((r) => r.material));
    // Only ever fill in a value for a field that is actually missing —
    // non-empty snapshot values are never treated as fillable.
    const derivedShade = inv.shadeMissing && derivedShadeJoin ? derivedShadeJoin : null;
    const derivedMaterial =
      inv.materialMissing && derivedMaterialJoin ? derivedMaterialJoin : null;

    const shadeWillBeFixed = !inv.shadeMissing || !!derivedShade;
    const materialWillBeFixed = !inv.materialMissing || !!derivedMaterial;
    const status: ShadeMaterialGapStatus =
      shadeWillBeFixed && materialWillBeFixed
        ? "fully_fixable"
        : derivedShade || derivedMaterial
          ? "partially_fixable"
          : "not_fixable";

    const metaPatientName =
      typeof inv.rawMeta.patientName === "string" ? inv.rawMeta.patientName.trim() : "";
    const fallbackPatientName = caseRow
      ? `${caseRow.patientFirstName ?? ""} ${caseRow.patientLastName ?? ""}`
          .replace(/\s+/g, " ")
          .trim()
      : "";

    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      caseId: inv.caseId,
      caseNumber: caseRow?.caseNumber ?? null,
      practiceName: inv.providerOrganizationId
        ? (orgNameById.get(inv.providerOrganizationId) ?? null)
        : null,
      patientName: metaPatientName || fallbackPatientName,
      currentShade: inv.currentShade,
      currentMaterial: inv.currentMaterial,
      shadeMissing: inv.shadeMissing,
      materialMissing: inv.materialMissing,
      derivedShade,
      derivedMaterial,
      status,
      rawMeta: inv.rawMeta,
    };
  });

  rows.sort(
    (a, b) =>
      SHADE_MATERIAL_GAP_STATUS_ORDER[a.status] - SHADE_MATERIAL_GAP_STATUS_ORDER[b.status],
  );

  return { totalCaseLinked, gapCount, rows };
}

// Caps the detail rows for an API response and strips the internal-only
// rawMeta field. gapCount (computed separately) always reflects the true
// total; this only controls how many rows are echoed back to the client.
function projectGapRowsForResponse(rows: InternalShadeMaterialGapRow[]): {
  rows: ShadeMaterialGapRow[];
  rowsTruncated: boolean;
} {
  const rowsTruncated = rows.length > SHADE_MATERIAL_GAP_ROW_CAP;
  const capped = rowsTruncated ? rows.slice(0, SHADE_MATERIAL_GAP_ROW_CAP) : rows;
  return {
    rows: capped.map(({ rawMeta: _rawMeta, ...rest }) => rest),
    rowsTruncated,
  };
}

// Report: which case-linked invoices have an empty shade or material field,
// what the backfill tool would fill in for each, and whether it can resolve
// them fully, partially, or not at all. Admins use this to decide whether to
// re-run the shade/material backfill and to find invoices that need manual
// entry.
router.get(
  "/admin/shade-material-gaps",
  asyncHandler(async (req, res) => {
    const labOrganizationId = z.string().min(1).parse(req.query.labOrganizationId);
    await requireAnyRole((req as any).auth.userId, labOrganizationId, ADMIN_ROLES);

    const { totalCaseLinked, gapCount, rows } = await computeShadeMaterialGaps(labOrganizationId);
    const { rows: responseRows, rowsTruncated } = projectGapRowsForResponse(rows);

    return ok(res, {
      labOrganizationId,
      totalCaseLinked,
      gapCount,
      rows: responseRows,
      rowsTruncated,
    });
  }),
);

// Backfill shade/material snapshot for case-linked invoices that are missing
// them. Mirrors the logic in scripts/src/backfill-invoice-display-shade-material.ts
// but scoped to a single lab org. Never overwrites a non-empty snapshot value.
// Returns counts of updated vs skipped invoices, plus the invoices that are
// still incomplete after the run (some "updated" invoices only had ONE of
// shade/material derivable and remain in this remaining list).
router.post(
  "/admin/shade-material-backfill",
  asyncHandler(async (req, res) => {
    const { labOrganizationId } = z
      .object({ labOrganizationId: z.string().min(1) })
      .parse(req.body);

    await requireAnyRole((req as any).auth.userId, labOrganizationId, ADMIN_ROLES);

    const before = await computeShadeMaterialGaps(labOrganizationId);

    let updated = 0;
    let skippedNoDerivable = 0;

    for (const row of before.rows) {
      if (!row.derivedShade && !row.derivedMaterial) {
        skippedNoDerivable++;
        continue;
      }

      const nextMeta: Record<string, unknown> = { ...row.rawMeta };
      if (row.derivedShade) nextMeta.shade = row.derivedShade;
      if (row.derivedMaterial) nextMeta.material = row.derivedMaterial;

      await db
        .update(invoices)
        .set({ displayMetadataJson: nextMeta })
        .where(eq(invoices.id, row.invoiceId));

      updated++;
    }

    // Recompute with the same helper so "what's left" can never drift from
    // what the pre-run report would show on a fresh load.
    const after = await computeShadeMaterialGaps(labOrganizationId);
    const { rows: remainingRows, rowsTruncated: remainingRowsTruncated } =
      projectGapRowsForResponse(after.rows);

    req.log?.info?.(
      {
        labOrganizationId,
        gapInvoicesFound: before.gapCount,
        updated,
        skippedNoDerivable,
        remainingGapCount: after.gapCount,
      },
      "[SHADE-MATERIAL BACKFILL] completed",
    );

    return ok(res, {
      labOrganizationId,
      gapInvoicesFound: before.gapCount,
      updated,
      skippedNoDerivable,
      remainingGapCount: after.gapCount,
      remainingRows,
      remainingRowsTruncated,
    });
  }),
);

// Admin-only bulk reassignment: move all non-voided invoices from one
// provider organization to another within the same lab, in a single
// transaction with one audit log entry per invoice.
const bulkReassignSchema = z.object({
  labOrganizationId: z.string().min(1),
  fromProviderOrganizationId: z.string().min(1),
  toProviderOrganizationId: z.string().min(1),
});

router.post(
  "/bulk-reassign",
  asyncHandler(async (req, res) => {
    const input = bulkReassignSchema.parse(req.body);

    if (input.fromProviderOrganizationId === input.toProviderOrganizationId) {
      throw new HttpError(400, "Source and destination practice must be different.");
    }

    await requireAnyRole(
      (req as any).auth.userId,
      input.labOrganizationId,
      ADMIN_ROLES,
    );

    // Verify both provider orgs exist and belong to this lab
    const [fromOrg, toOrg] = await Promise.all([
      db.query.organizations.findFirst({
        where: eq(organizations.id, input.fromProviderOrganizationId),
      }),
      db.query.organizations.findFirst({
        where: eq(organizations.id, input.toProviderOrganizationId),
      }),
    ]);

    if (!fromOrg || fromOrg.deletedAt) throw new HttpError(404, "Source practice not found.");
    if (!toOrg || toOrg.deletedAt) throw new HttpError(404, "Destination practice not found.");

    if (fromOrg.type !== "provider" && fromOrg.type !== "practice") {
      throw new HttpError(400, "Source organization is not a practice or provider.");
    }
    if (toOrg.type !== "provider" && toOrg.type !== "practice") {
      throw new HttpError(400, "Destination organization is not a practice or provider.");
    }
    if (toOrg.isActive === false) {
      throw new HttpError(400, "Cannot reassign invoices to an inactive practice.");
    }

    // Enforce same-lab ownership using the same check as single-invoice reassignment.
    // A provider org's lab is its parentLabOrganizationId (or itself for legacy rows).
    const fromLabId = fromOrg.parentLabOrganizationId ?? fromOrg.id;
    const toLabId = toOrg.parentLabOrganizationId ?? toOrg.id;
    if (
      fromLabId !== input.labOrganizationId &&
      fromOrg.id !== input.labOrganizationId
    ) {
      throw new HttpError(400, "Source practice does not belong to the specified lab.");
    }
    if (
      toLabId !== input.labOrganizationId &&
      toOrg.id !== input.labOrganizationId
    ) {
      throw new HttpError(400, "Destination practice does not belong to the specified lab.");
    }

    // Find all non-voided, non-deleted invoices belonging to this lab + from-practice
    const toMove = await db.query.invoices.findMany({
      where: and(
        eq(invoices.labOrganizationId, input.labOrganizationId),
        eq(invoices.providerOrganizationId, input.fromProviderOrganizationId),
        ne(invoices.status, "void"),
        finalizedInvoiceSql(),
        isNull(invoices.deletedAt),
      ),
    });

    if (toMove.length === 0) {
      return ok(res, { movedCount: 0 });
    }

    const movedIds = toMove.map((inv) => inv.id);
    const actorUserId: string = (req as any).auth.userId;
    const actorIp: string | null = req.ip ?? null;
    const actorUserAgent: string | null = req.get("user-agent") ?? null;
    const fromName = fromOrg.displayName || fromOrg.name;
    const toName = toOrg.displayName || toOrg.name;
    const now = new Date();

    // Perform update + audit inserts atomically in one transaction
    await db.transaction(async (tx) => {
      for (const invoice of [...toMove].sort((a, b) =>
        (a.providerOrganizationId ?? "").localeCompare(b.providerOrganizationId ?? ""))) {
        if (invoice.providerOrganizationId) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.labOrganizationId}), hashtext(${invoice.providerOrganizationId}))`);
        }
      }
      await assertNoActiveCardReversalForInvoices(tx, movedIds);
      await tx
        .update(invoices)
        .set({
          providerOrganizationId: input.toProviderOrganizationId,
          updatedByUserId: actorUserId,
        })
        .where(
          and(
            inArray(invoices.id, movedIds),
            eq(invoices.labOrganizationId, input.labOrganizationId),
          ),
        );

      // One audit log row per invoice, all within the same transaction
      await tx.insert(auditLogs).values(
        toMove.map((inv) => ({
          userId: actorUserId,
          organizationId: input.labOrganizationId,
          action: "invoice_bulk_reassigned",
          entityType: "invoice",
          entityId: inv.id,
          ipAddress: actorIp,
          userAgent: actorUserAgent,
          metadataJson: {
            invoiceNumber: inv.invoiceNumber,
            fromProviderOrganizationId: input.fromProviderOrganizationId,
            fromProviderOrganizationName: fromName,
            toProviderOrganizationId: input.toProviderOrganizationId,
            toProviderOrganizationName: toName,
          },
          createdAt: now,
        })),
      );
    });

    req.log?.info?.(
      {
        labOrganizationId: input.labOrganizationId,
        from: input.fromProviderOrganizationId,
        to: input.toProviderOrganizationId,
        count: toMove.length,
      },
      "[INVOICE BULK REASSIGN] completed",
    );

    return ok(res, { movedCount: toMove.length });
  }),
);

// ── Bulk invoice soft-delete ───────────────────────────────────────────────
// Accepts one of:
//   { labOrganizationId, invoiceIds: string[] }          — specific IDs
//   { labOrganizationId, practiceIds: string[] }         — all for practices
//   { labOrganizationId, all: true }                     — all for the lab
// For each invoice: void → soft-delete → hard-delete its line items.
const bulkInvoiceTargetSchema = z.object({
  // Optional: only used to scope the practiceIds / all paths. The invoiceIds
  // path resolves and authorizes each invoice by its OWN labOrganizationId so
  // a selection spanning more than one lab org is handled correctly.
  labOrganizationId: z.string().min(1).optional(),
  invoiceIds: z.array(z.string().min(1)).max(2000).optional(),
  practiceIds: z.array(z.string().min(1)).max(500).optional(),
  all: z.boolean().optional(),
});

type BulkInvoiceTargetInput = z.infer<typeof bulkInvoiceTargetSchema>;

// Bulk status change: a selection of invoice ids plus a single target status.
// The target is validated against the same status set the single-invoice PATCH
// accepts so bulk and single updates stay in lockstep.
const bulkInvoiceStatusSchema = z.object({
  // Optional hint only; each invoice is authorized by its OWN labOrganizationId.
  labOrganizationId: z.string().min(1).optional(),
  invoiceIds: z.array(z.string().min(1)).min(1).max(2000),
  status: z.enum(["open", "paid", "void"]),
});

type BulkInvoiceTarget = {
  id: string;
  invoiceNumber: string;
  providerOrganizationId: string | null;
  labOrganizationId: string;
};

/**
 * Resolve the set of non-deleted invoices a bulk delete/reset should affect,
 * enforcing BILLING_ROLES authorization for every lab org touched.
 *
 * The `invoiceIds` path resolves each invoice by its OWN labOrganizationId so
 * a selection that spans more than one lab org is handled correctly (the old
 * code scoped the whole batch to a single client-supplied labOrganizationId,
 * silently dropping every invoice belonging to a different org). The caller is
 * authorized once per distinct lab org in the resolved set — if they lack a
 * billing role for any touched org the whole request fails closed with 403.
 *
 * The `practiceIds` and `all` paths operate within a single lab org and still
 * require an explicit `labOrganizationId`.
 */
async function resolveBulkInvoiceTargets(
  input: BulkInvoiceTargetInput,
  actorUserId: string,
): Promise<BulkInvoiceTarget[]> {
  const columns = {
    id: true,
    invoiceNumber: true,
    providerOrganizationId: true,
    labOrganizationId: true,
  } as const;

  if (input.invoiceIds && input.invoiceIds.length > 0) {
    const targets = (await db.query.invoices.findMany({
      where: and(
        inArray(invoices.id, input.invoiceIds),
        isNull(invoices.deletedAt),
      ),
      columns,
    })) as BulkInvoiceTarget[];

    // Authorize the caller for every distinct lab org the selection touches.
    const orgIds = [...new Set(targets.map((inv) => inv.labOrganizationId))];
    for (const orgId of orgIds) {
      await requireAnyRole(actorUserId, orgId, BILLING_ROLES);
    }
    return targets;
  }

  if (!input.labOrganizationId) {
    throw new HttpError(400, "labOrganizationId is required.");
  }
  await requireAnyRole(actorUserId, input.labOrganizationId, BILLING_ROLES);

  const baseWhere = and(
    eq(invoices.labOrganizationId, input.labOrganizationId),
    isNull(invoices.deletedAt),
  );

  if (input.practiceIds && input.practiceIds.length > 0) {
    return (await db.query.invoices.findMany({
      where: and(
        baseWhere,
        inArray(invoices.providerOrganizationId, input.practiceIds),
      ),
      columns,
    })) as BulkInvoiceTarget[];
  }

  if (input.all) {
    return (await db.query.invoices.findMany({
      where: baseWhere,
      columns,
    })) as BulkInvoiceTarget[];
  }

  throw new HttpError(400, "Specify invoiceIds, practiceIds, or all:true.");
}

/**
 * A legacy mobile-origin invoice that a bulk delete should remove. These have
 * no row in the relational `invoices` table — they are synthesized from a
 * `lab_cases.case_data` JSON blob that carries an `invoiceId` (see
 * `toMobileInvoice` / the `mobile:<localInvoiceId>` synthetic id). Deleting one
 * means stripping the invoice reference out of the blob so it stops surfacing
 * in GET /api/invoices, while keeping the underlying case intact.
 */
type LegacyMobileInvoiceTarget = {
  labCaseId: string;
  labOrganizationId: string;
  localInvoiceId: string;
  caseNumber: string;
  parsedBlob: Record<string, unknown>;
};

/**
 * Resolve and authorize the legacy mobile invoices referenced by a set of
 * `mobile:<localInvoiceId>` ids. Mirrors the scoping of GET /api/invoices (the
 * caller's active lab memberships plus, for provider users, their linked
 * provider orgs) and fails closed with 403 if the caller lacks a billing role
 * for any lab org the selection touches. Performs no mutation — the caller
 * applies the deletion inside its own transaction so real + legacy deletes are
 * atomic together.
 */
async function resolveLegacyMobileInvoiceTargets(
  mobileInvoiceIds: string[],
  actorUserId: string,
): Promise<LegacyMobileInvoiceTarget[]> {
  const wantedLocalIds = new Set(
    mobileInvoiceIds
      .map((id) => id.slice(MOBILE_INVOICE_ID_PREFIX.length).trim())
      .filter((id) => id.length > 0),
  );
  if (wantedLocalIds.size === 0) return [];

  const memberships = await db.query.organizationMemberships.findMany({
    where: eq(organizationMemberships.userId, actorUserId),
  });
  let orgIds = memberships
    .filter((m: any) => m.status === "active")
    .map((m: any) => m.labId)
    .filter((id: any): id is string => !!id);
  const callerUser = await db.query.users.findFirst({
    where: eq(users.id, actorUserId),
  });
  if (callerUser?.userType === "provider") {
    await assertLinkedProviderCapability(actorUserId, "billing");
    const { providerOrgIds } =
      await getProviderOrgIdsForUserAndLinks(actorUserId);
    orgIds = Array.from(new Set([...orgIds, ...providerOrgIds]));
  }
  if (orgIds.length === 0) return [];

  const caseRows = await db
    .select()
    .from(labCases)
    .where(
      and(isNull(labCases.deletedAt), inArray(labCases.organizationId, orgIds)),
    );

  const targets: LegacyMobileInvoiceTarget[] = [];
  for (const lc of caseRows as any[]) {
    if (!lc.organizationId) continue;
    let parsed: any;
    try {
      parsed =
        typeof lc.caseData === "string" ? JSON.parse(lc.caseData) : lc.caseData;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const localInvoiceId =
      typeof parsed.invoiceId === "string" ? parsed.invoiceId : "";
    if (!localInvoiceId || !wantedLocalIds.has(localInvoiceId)) continue;
    targets.push({
      labCaseId: lc.id,
      labOrganizationId: lc.organizationId,
      localInvoiceId,
      caseNumber: typeof parsed.caseNumber === "string" ? parsed.caseNumber : "",
      parsedBlob: parsed as Record<string, unknown>,
    });
  }
  if (targets.length === 0) return [];

  // Authorize the caller for every distinct lab org the selection touches —
  // fail closed exactly like the canonical bulk path.
  const touchedOrgIds = [...new Set(targets.map((t) => t.labOrganizationId))];
  for (const orgId of touchedOrgIds) {
    await requireAnyRole(actorUserId, orgId, BILLING_ROLES);
  }

  return targets;
}

/**
 * Resolve and authorize ALL legacy mobile invoices belonging to a single lab
 * org — used by the `all: true` bulk-reset path so legacy invoices in scope
 * are covered just like canonical ones. (The `practiceIds` path can never
 * match a legacy invoice: they carry no providerOrganizationId, so no
 * practice selection includes them.)
 */
async function resolveAllLegacyMobileInvoiceTargetsForLab(
  labOrganizationId: string,
  actorUserId: string,
): Promise<LegacyMobileInvoiceTarget[]> {
  await requireAnyRole(actorUserId, labOrganizationId, BILLING_ROLES);

  const caseRows = await db
    .select()
    .from(labCases)
    .where(
      and(
        isNull(labCases.deletedAt),
        eq(labCases.organizationId, labOrganizationId),
      ),
    );

  const targets: LegacyMobileInvoiceTarget[] = [];
  for (const lc of caseRows as any[]) {
    if (!lc.organizationId) continue;
    let parsed: any;
    try {
      parsed =
        typeof lc.caseData === "string" ? JSON.parse(lc.caseData) : lc.caseData;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const localInvoiceId =
      typeof parsed.invoiceId === "string" ? parsed.invoiceId : "";
    if (!localInvoiceId) continue;
    targets.push({
      labCaseId: lc.id,
      labOrganizationId: lc.organizationId,
      localInvoiceId,
      caseNumber: typeof parsed.caseNumber === "string" ? parsed.caseNumber : "",
      parsedBlob: parsed as Record<string, unknown>,
    });
  }
  return targets;
}

router.delete(
  "/bulk",
  asyncHandler(async (req, res) => {
    const input = bulkInvoiceTargetSchema.parse(req.body);
    const actorUserId: string = (req as any).auth.userId;

    // Legacy mobile-origin invoices surface in the list with a synthetic
    // `mobile:<localInvoiceId>` id and have no row in the relational invoices
    // table. Split them out so a selection that mixes real + legacy invoices
    // deletes ALL of them, instead of the legacy ids silently resolving to zero
    // rows and the whole request reporting deletedCount: 0.
    const mobileInvoiceIds = (input.invoiceIds ?? []).filter((id) =>
      id.startsWith(MOBILE_INVOICE_ID_PREFIX),
    );
    const realInput: BulkInvoiceTargetInput = {
      ...input,
      invoiceIds: input.invoiceIds
        ? input.invoiceIds.filter(
            (id) => !id.startsWith(MOBILE_INVOICE_ID_PREFIX),
          )
        : undefined,
    };
    // Only run the relational resolver when there is a real selection. If the
    // caller sent ONLY mobile ids, realInput.invoiceIds is an empty array and
    // resolveBulkInvoiceTargets would fall through to the practiceIds/all/400
    // branches — skip it entirely.
    const hasRealSelection =
      (realInput.invoiceIds && realInput.invoiceIds.length > 0) ||
      (realInput.practiceIds && realInput.practiceIds.length > 0) ||
      realInput.all === true;

    // Authorize + resolve BOTH sets before any mutation so the request fails
    // closed (403) without partially deleting.
    const toDelete = hasRealSelection
      ? await resolveBulkInvoiceTargets(realInput, actorUserId)
      : [];
    const legacyTargets = await resolveLegacyMobileInvoiceTargets(
      mobileInvoiceIds,
      actorUserId,
    );

    if (toDelete.length === 0 && legacyTargets.length === 0) {
      return ok(res, { deletedCount: 0 });
    }

    const ids = toDelete.map((inv) => inv.id);
    const now = new Date();
    const actorIp: string | null = req.ip ?? null;
    const actorUserAgent: string | null = req.get("user-agent") ?? null;
    const totalAffected = toDelete.length + legacyTargets.length;

    await db.transaction(async (tx) => {
      if (toDelete.length > 0) {
        for (const invoice of [...toDelete].sort((a, b) =>
          (a.providerOrganizationId ?? "").localeCompare(b.providerOrganizationId ?? ""))) {
          if (invoice.providerOrganizationId) {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.labOrganizationId}), hashtext(${invoice.providerOrganizationId}))`);
          }
        }
        await assertNoActiveCardReversalForInvoices(tx, ids);
        // 1. Mark invoices as void first, clearing balanceDue atomically so the
        //    lab-side balance display never shows a stale amount on a voided row.
        await tx
          .update(invoices)
          .set({ status: "void", balanceDue: "0.00", voidedAt: now, voidedByUserId: actorUserId, voidReason: "bulk_delete", updatedByUserId: actorUserId })
          .where(and(inArray(invoices.id, ids), isNull(invoices.deletedAt)));

        // 2. Soft-delete the invoice rows
        await tx
          .update(invoices)
          .set({ deletedAt: now, deletedByUserId: actorUserId })
          .where(and(inArray(invoices.id, ids), isNull(invoices.deletedAt)));

        // 3. Hard-delete all line items (not a protected table)
        await tx.delete(invoiceLineItems).where(inArray(invoiceLineItems.invoiceId, ids));

        // 4. Audit log — one row per invoice, scoped to its OWN lab org
        await tx.insert(auditLogs).values(
          toDelete.map((inv) => ({
            userId: actorUserId,
            organizationId: inv.labOrganizationId,
            action: "bulk_invoice_delete",
            entityType: "invoice",
            entityId: inv.id,
            ipAddress: actorIp,
            userAgent: actorUserAgent,
            metadataJson: {
              invoiceNumber: inv.invoiceNumber,
              providerOrganizationId: inv.providerOrganizationId,
              totalAffected,
            },
            createdAt: now,
          })),
        );
      }

      if (legacyTargets.length > 0) {
        // Strip the invoice reference out of each legacy case blob so the
        // synthesized invoice stops surfacing in GET /api/invoices, while
        // keeping the underlying case intact. The prior invoiceId is preserved
        // as `deletedInvoiceId` for auditability / potential restore.
        for (const t of legacyTargets) {
          const [lockedCase] = await tx
            .select({ caseData: labCases.caseData })
            .from(labCases)
            .where(eq(labCases.id, t.labCaseId))
            .for("update");
          let currentBlob: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(lockedCase?.caseData ?? "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              currentBlob = parsed;
            }
          } catch {
            // Preserve existing behavior for malformed historical blobs.
          }
          const nextBlob = {
            ...currentBlob,
            invoiceId: null,
            deletedInvoiceId: t.localInvoiceId,
            invoiceDeletedAt: now.toISOString(),
            invoiceDeletedByUserId: actorUserId,
          };
          await tx
            .update(labCases)
            .set({ caseData: JSON.stringify(nextBlob) })
            .where(eq(labCases.id, t.labCaseId));
        }

        // Audit log — one row per legacy invoice, scoped to its OWN lab org.
        await tx.insert(auditLogs).values(
          legacyTargets.map((t) => ({
            userId: actorUserId,
            organizationId: t.labOrganizationId,
            action: "bulk_invoice_delete",
            entityType: "invoice",
            entityId: `${MOBILE_INVOICE_ID_PREFIX}${t.localInvoiceId}`,
            ipAddress: actorIp,
            userAgent: actorUserAgent,
            metadataJson: {
              legacyMobileInvoice: true,
              labCaseId: t.labCaseId,
              caseNumber: t.caseNumber,
              totalAffected,
            },
            createdAt: now,
          })),
        );
      }
    });

    req.log?.info?.(
      { count: toDelete.length, legacyCount: legacyTargets.length },
      "[INVOICE BULK DELETE] completed",
    );

    return ok(res, { deletedCount: totalAffected });
  }),
);

// ── Bulk invoice reset to $0 ───────────────────────────────────────────────
// Zeros all money fields, sets status→open, hard-deletes line items.
// Invoice rows are NOT soft-deleted — they stay visible with $0 balance.
router.post(
  "/bulk-reset",
  asyncHandler(async (req, res) => {
    const input = bulkInvoiceTargetSchema.parse(req.body);
    const actorUserId: string = (req as any).auth.userId;

    // Legacy mobile-origin invoices surface in the list with a synthetic
    // `mobile:<localInvoiceId>` id and have no row in the relational invoices
    // table. Split them out (mirrors DELETE /bulk above) so a selection that
    // mixes real + legacy invoices resets ALL of them, instead of the legacy
    // ids silently resolving to zero rows and keeping their balances.
    const mobileInvoiceIds = (input.invoiceIds ?? []).filter((id) =>
      id.startsWith(MOBILE_INVOICE_ID_PREFIX),
    );
    const realInput: BulkInvoiceTargetInput = {
      ...input,
      invoiceIds: input.invoiceIds
        ? input.invoiceIds.filter(
            (id) => !id.startsWith(MOBILE_INVOICE_ID_PREFIX),
          )
        : undefined,
    };
    const usedIdSelection =
      !!input.invoiceIds && input.invoiceIds.length > 0;
    const hasRealSelection =
      (realInput.invoiceIds && realInput.invoiceIds.length > 0) ||
      (realInput.practiceIds && realInput.practiceIds.length > 0) ||
      realInput.all === true;

    // Authorize + resolve BOTH sets before any mutation so the request fails
    // closed (403) without partially resetting.
    const resetCandidates = hasRealSelection
      ? await resolveBulkInvoiceTargets(realInput, actorUserId)
      : [];
    // Bulk reset must not bypass a draft's original issuance/review workflow,
    // including the lab-wide "all" path that never passes through row selection.
    const protectedDrafts = resetCandidates.length ? await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(
        inArray(invoices.id, resetCandidates.map((inv) => inv.id)),
        inArray(invoices.status, ["draft", RECOVERY_DRAFT_STATUS]),
      )) : [];
    const protectedDraftIds = new Set(protectedDrafts.map((inv) => inv.id));
    const toReset = resetCandidates.filter((inv) => !protectedDraftIds.has(inv.id));
    const skippedDraftCount = protectedDraftIds.size;

    // Legacy targets come from the explicit id selection, or — on the
    // `all: true` path — every legacy invoice in the lab org, matching how
    // the canonical resolver scopes `all`. The practiceIds path can never
    // include legacy invoices (they carry no providerOrganizationId).
    let legacyTargets: LegacyMobileInvoiceTarget[] = [];
    if (mobileInvoiceIds.length > 0) {
      legacyTargets = await resolveLegacyMobileInvoiceTargets(
        mobileInvoiceIds,
        actorUserId,
      );
    } else if (
      !usedIdSelection &&
      input.all === true &&
      input.labOrganizationId
    ) {
      legacyTargets = await resolveAllLegacyMobileInvoiceTargetsForLab(
        input.labOrganizationId,
        actorUserId,
      );
    }

    // How many requested ids matched nothing (already deleted, never existed,
    // or a legacy blob no longer carries the invoice reference). Only
    // meaningful on the id-selection path; lets the client explain skips
    // instead of showing a generic count mismatch.
    const skippedCount = usedIdSelection
      ? Math.max(
          0,
          new Set(input.invoiceIds).size -
            toReset.length -
            legacyTargets.length,
        )
      : 0;

    if (toReset.length === 0 && legacyTargets.length === 0) {
      return ok(res, { resetCount: 0, legacyResetCount: 0, skippedCount, skippedDraftCount });
    }

    const ids = toReset.map((inv) => inv.id);
    const now = new Date();
    const actorIp: string | null = req.ip ?? null;
    const actorUserAgent: string | null = req.get("user-agent") ?? null;
    const totalAffected = toReset.length + legacyTargets.length;

    await db.transaction(async (tx) => {
      if (toReset.length > 0) {
        for (const invoice of [...toReset].sort((a, b) =>
          (a.providerOrganizationId ?? "").localeCompare(b.providerOrganizationId ?? ""))) {
          if (invoice.providerOrganizationId) {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.labOrganizationId}), hashtext(${invoice.providerOrganizationId}))`);
          }
        }
        const lockedRows = await tx.select({ id: invoices.id, status: invoices.status })
          .from(invoices).where(inArray(invoices.id, ids)).orderBy(asc(invoices.id)).for("update");
        if (lockedRows.some((inv) => isInvoiceDraftStatus(inv.status))) {
          throw new HttpError(409, "A selected invoice is now a Draft. Refresh before resetting invoices.");
        }
        await assertNoActiveCardReversalForInvoices(tx, ids);
        // 1. Zero all money fields, set status → open
        await tx
          .update(invoices)
          .set({
            subtotal: "0",
            tax: "0",
            discount: "0",
            total: "0",
            balanceDue: "0",
            status: "open",
            updatedByUserId: actorUserId,
          })
          .where(and(inArray(invoices.id, ids), isNull(invoices.deletedAt)));

        // 2. Hard-delete all line items (not a protected table)
        await tx.delete(invoiceLineItems).where(inArray(invoiceLineItems.invoiceId, ids));

        // 3. Audit log — one row per invoice, scoped to its OWN lab org
        await tx.insert(auditLogs).values(
          toReset.map((inv) => ({
            userId: actorUserId,
            organizationId: inv.labOrganizationId,
            action: "bulk_invoice_reset",
            entityType: "invoice",
            entityId: inv.id,
            ipAddress: actorIp,
            userAgent: actorUserAgent,
            metadataJson: {
              invoiceNumber: inv.invoiceNumber,
              providerOrganizationId: inv.providerOrganizationId,
              totalAffected,
            },
            createdAt: now,
          })),
        );
      }

      if (legacyTargets.length > 0) {
        // Zero the invoice amounts inside each legacy case blob so the
        // synthesized invoice (see toMobileInvoice) reads $0.00 open. The
        // invoiceId reference is kept — the invoice stays visible at $0 —
        // and the pre-reset price is preserved once for auditability.
        for (const t of legacyTargets) {
          const [lockedCase] = await tx
            .select({ caseData: labCases.caseData })
            .from(labCases)
            .where(eq(labCases.id, t.labCaseId))
            .for("update");
          let currentBlob: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(lockedCase?.caseData ?? "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              currentBlob = parsed;
            }
          } catch {
            // Preserve existing behavior for malformed historical blobs.
          }
          const priorPrice = Number((currentBlob as any).price ?? 0);
          const nextBlob = {
            ...currentBlob,
            price: 0,
            invoiceStatus: "open",
            invoiceResetAt: now.toISOString(),
            invoiceResetByUserId: actorUserId,
            invoiceResetPriorPrice:
              (currentBlob as any).invoiceResetPriorPrice ?? priorPrice,
          };
          await tx
            .update(labCases)
            .set({ caseData: JSON.stringify(nextBlob) })
            .where(eq(labCases.id, t.labCaseId));
        }

        // Audit log — one row per legacy invoice, scoped to its OWN lab org.
        await tx.insert(auditLogs).values(
          legacyTargets.map((t) => ({
            userId: actorUserId,
            organizationId: t.labOrganizationId,
            action: "bulk_invoice_reset",
            entityType: "invoice",
            entityId: `${MOBILE_INVOICE_ID_PREFIX}${t.localInvoiceId}`,
            ipAddress: actorIp,
            userAgent: actorUserAgent,
            metadataJson: {
              legacyMobileInvoice: true,
              labCaseId: t.labCaseId,
              caseNumber: t.caseNumber,
              priorPrice: Number((t.parsedBlob as any).price ?? 0),
              totalAffected,
            },
            createdAt: now,
          })),
        );
      }
    });

    req.log?.info?.(
      { count: toReset.length, legacyCount: legacyTargets.length },
      "[INVOICE BULK RESET] completed",
    );

    return ok(res, {
      resetCount: totalAffected,
      legacyResetCount: legacyTargets.length,
      skippedCount,
      skippedDraftCount,
    });
  }),
);

// ── Bulk invoice status change ─────────────────────────────────────────────
// Applies a single target status to a selection of invoices. Mirrors the
// per-invoice PATCH side effects so bulk and single updates behave identically:
//   - one audit log row per invoice, scoped to its OWN lab org
//   - a case-history event (invoice_voided when target=void, else invoice_updated)
//   - paid-status ledgering: ensureInvoiceDeposit when entering "paid",
//     reverseInvoiceDepositIfAny when leaving "paid"
// Frozen invoices (their linked case was deleted) are skipped, never changed.
// All status writes + audit + case events run in a single transaction; if the
// caller lacks a billing role for any touched lab org the whole request fails
// closed with 403 and nothing is changed.
router.post(
  "/bulk-status",
  asyncHandler(async (req, res) => {
    const input = bulkInvoiceStatusSchema.parse(req.body);
    const actorUserId: string = (req as any).auth.userId;
    const targetStatus = input.status;

    const targets = await db.query.invoices.findMany({
      where: and(
        inArray(invoices.id, input.invoiceIds),
        isNull(invoices.deletedAt),
      ),
      columns: {
        id: true,
        invoiceNumber: true,
        providerOrganizationId: true,
        labOrganizationId: true,
        status: true,
        caseId: true,
        frozen: true,
        total: true,
      },
    });

    // approve_invoices capability: billing-role members pass via their existing
    // role; non-billing members may also change invoice status with an explicit
    // capability grant (owners and admins always pass via hasCapability).
    const orgIds = [...new Set(targets.map((inv) => inv.labOrganizationId))];
    for (const orgId of orgIds) {
      const _invMembership = await requireMembership(actorUserId, orgId);
      if (!BILLING_ROLES.includes(_invMembership.role as MembershipRole)) {
        const _allowed = await hasCapability(actorUserId, orgId, "approve_invoices");
        if (!_allowed) {
          throw new HttpError(403, "You do not have permission to approve invoices.");
        }
      }
    }

    // Frozen invoices (linked case deleted) cannot be changed — skip them.
    const updatable = targets.filter((inv) => !inv.frozen && !isInvoiceDraftStatus(inv.status));
    const skippedFrozenCount = targets.filter((inv) => inv.frozen).length;
    const skippedDraftCount = targets.filter((inv) => isInvoiceDraftStatus(inv.status)).length;
    const skippedReadOnlyCount = targets.length - updatable.length;

    if (updatable.length === 0) {
      return ok(res, {
        updatedCount: 0,
        skippedFrozenCount,
        skippedDraftCount,
        skippedReadOnlyCount,
        status: targetStatus,
      });
    }

    const ids = updatable.map((inv) => inv.id);
    const now = new Date();
    const actorIp: string | null = req.ip ?? null;
    const actorUserAgent: string | null = req.get("user-agent") ?? null;
    const actorInitials: string = (req as any).user?.initials || "SYS";

    await db.transaction(async (tx) => {
      for (const invoice of [...updatable].sort((a, b) =>
        (a.providerOrganizationId ?? "").localeCompare(b.providerOrganizationId ?? ""))) {
        if (invoice.providerOrganizationId) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.labOrganizationId}), hashtext(${invoice.providerOrganizationId}))`);
        }
      }
      const lockedRows = await tx.select({ id: invoices.id, status: invoices.status, frozen: invoices.frozen })
        .from(invoices).where(inArray(invoices.id, ids)).orderBy(asc(invoices.id)).for("update");
      if (lockedRows.some((inv) => isInvoiceDraftStatus(inv.status) || inv.frozen)) {
        throw new HttpError(409, "A selected invoice is now read-only. Refresh before changing invoice status.");
      }
      await assertNoActiveCardReversalForInvoices(tx, ids);
      // 1. Apply the new status.
      //    • void  → zero balanceDue atomically (a voided invoice must never
      //              carry an outstanding balance).
      //    • paid  → zero balanceDue (the invoice is fully settled by
      //              definition; a payment row may or may not exist).
      //    • other → recalculate balanceDue as (total − recorded payments) per
      //              invoice so that reversing a paid transition (paid → open)
      //              correctly restores the outstanding amount rather than
      //              leaving a stale $0.00 on an open invoice.
      if (targetStatus === "void") {
        await tx
          .update(invoices)
          .set({
            status: targetStatus,
            balanceDue: "0.00",
            voidedAt: now,
            voidedByUserId: actorUserId,
            voidReason: "Bulk status change",
            voidKind: "void",
            updatedByUserId: actorUserId,
          })
          .where(and(inArray(invoices.id, ids), isNull(invoices.deletedAt)));
      } else if (targetStatus === "paid") {
        await tx
          .update(invoices)
          .set({ status: targetStatus, balanceDue: "0.00", updatedByUserId: actorUserId })
          .where(and(inArray(invoices.id, ids), isNull(invoices.deletedAt)));
      } else {
        // Recalculate per-invoice balance so reversals (e.g. paid → open)
        // restore the correct outstanding amount: total − payments − unreversed credits.
        // Both payment rows and active invoice-credit rows reduce the outstanding
        // balance; omitting either produces an overstated receivable.
        const [paymentSums, creditSums] = await Promise.all([
          tx
            .select({ invoiceId: payments.invoiceId, total: sum(payments.amount) })
            .from(payments)
            .where(inArray(payments.invoiceId, ids))
            .groupBy(payments.invoiceId),
          tx
            .select({ invoiceId: invoiceCredits.invoiceId, total: sum(invoiceCredits.amount) })
            .from(invoiceCredits)
            .where(and(inArray(invoiceCredits.invoiceId, ids), isNull(invoiceCredits.reversedAt)))
            .groupBy(invoiceCredits.invoiceId),
        ]);
        const paidByInvoiceId = new Map(
          paymentSums.map((p) => [p.invoiceId, Number(p.total ?? 0)]),
        );
        const creditByInvoiceId = new Map(
          creditSums.map((c) => [c.invoiceId, Number(c.total ?? 0)]),
        );
        for (const inv of updatable) {
          const paid = paidByInvoiceId.get(inv.id) ?? 0;
          const credited = creditByInvoiceId.get(inv.id) ?? 0;
          const balanceDue = Math.max(0, Number(inv.total ?? 0) - paid - credited).toFixed(2);
          await tx
            .update(invoices)
            .set({ status: targetStatus, balanceDue, updatedByUserId: actorUserId })
            .where(and(eq(invoices.id, inv.id), isNull(invoices.deletedAt)));
        }
      }

      // 2. Audit log — one row per invoice, scoped to its OWN lab org.
      await tx.insert(auditLogs).values(
        updatable.map((inv) => ({
          userId: actorUserId,
          organizationId: inv.labOrganizationId,
          action: "bulk_invoice_status_change",
          entityType: "invoice",
          entityId: inv.id,
          ipAddress: actorIp,
          userAgent: actorUserAgent,
          metadataJson: {
            invoiceNumber: inv.invoiceNumber,
            providerOrganizationId: inv.providerOrganizationId,
            previousStatus: inv.status,
            newStatus: targetStatus,
            totalAffected: updatable.length,
          },
          createdAt: now,
        })),
      );

      // 3. Mirror onto the case History tab for invoices linked to a case.
      const withCase = updatable.filter((inv) => inv.caseId);
      if (withCase.length) {
        await tx.insert(caseEvents).values(
          withCase.map((inv) => ({
            caseId: inv.caseId as string,
            eventType:
              targetStatus === "void" ? "invoice_voided" : "invoice_updated",
            actorUserId,
            actorOrganizationId: inv.labOrganizationId,
            actorInitials,
            metadataJson: {
              invoiceId: inv.id,
              invoiceNumber: inv.invoiceNumber,
              previousStatus: inv.status,
              newStatus: targetStatus,
            },
          })),
        );
      }
    });

    // 4. Paid-status ledgering — mirror the single PATCH, run after commit.
    for (const inv of updatable) {
      if (targetStatus === "paid" && inv.status !== "paid") {
        await ensureInvoiceDeposit(
          {
            id: inv.id,
            invoiceNumber: inv.invoiceNumber,
            total: String(inv.total),
            labOrganizationId: inv.labOrganizationId,
          },
          actorUserId,
        );
      } else if (inv.status === "paid" && targetStatus !== "paid") {
        await reverseInvoiceDepositIfAny(
          inv.id,
          inv.labOrganizationId,
          actorUserId,
        );
      }
    }

    req.log?.info?.(
      { count: updatable.length, status: targetStatus },
      "[INVOICE BULK STATUS] completed",
    );

    return ok(res, {
      updatedCount: updatable.length,
      skippedFrozenCount,
      skippedDraftCount,
      skippedReadOnlyCount,
      status: targetStatus,
    });
  }),
);

router.post(
  "/cases/:caseId/generate-invoice",
  asyncHandler(async (req, res) => {
    const caseId = String(req.params.caseId ?? "");
    const userId = (req as any).auth.userId as string;

    // ── Canonical case path ──────────────────────────────────────────────────
    const found = await db.query.cases.findFirst({
      where: eq(cases.id, caseId),
    });

    if (found) {
      await requireAnyRole(userId, found.labOrganizationId, BILLING_ROLES);

      const restorations = await db.query.caseRestorations.findMany({
        where: eq(caseRestorations.caseId, found.id),
      });
      // Empty draft invoices are allowed: AI-imported / drag-and-dropped
      // cases often have no restorations yet but still need an invoice
      // skeleton to attach line items to later.
      const hasRestorations = restorations.length > 0;

      // Pre-fill the invoice editor's patient/doctor/teeth/shade/case-notes
      // fields from the originating case so an admin doesn't have to retype
      // anything the AI prescription analysis already extracted. Restrict
      // notes to provider-shared visibility — invoices are readable by the
      // practice (provider org members), so internal-lab-only notes must
      // never be persisted into invoice metadata or its downstream PDF/email.
      const noteRows = await db.query.caseNotes.findMany({
        where: and(
          eq(caseNotes.caseId, found.id),
          eq(caseNotes.visibility, "shared_with_provider"),
        ),
        orderBy: [caseNotes.createdAt],
      });
      const displayMetadataJson = buildInvoiceDisplayMetadataFromCase(
        found,
        restorations,
        noteRows,
      );
      const doctorIdentity = await ensureDoctorProfileIdentity(db, {
        labOrganizationId: found.labOrganizationId,
        providerOrganizationId: found.providerOrganizationId ?? null,
        doctorName: found.doctorName,
      });

      const bodyLayoutPresetId =
        typeof req.body?.layoutPresetId === "string" && req.body.layoutPresetId.trim()
          ? req.body.layoutPresetId.trim()
          : null;

      const [invoice] = await db
        .insert(invoices)
        .values({
          invoiceNumber: nextInvoiceNumber(found.caseNumber),
          caseId: found.id,
          labOrganizationId: found.labOrganizationId,
          providerOrganizationId: found.providerOrganizationId,
          doctorIdentity,
          status: "open",
          displayMetadataJson,
          ...(bodyLayoutPresetId ? { layoutPresetId: bodyLayoutPresetId } : {}),
          issuedAt: calendarDateToUtcNoon(found.receivedAt),
          dueAt: invoiceDueDate(new Date()),
          createdByUserId: userId,
          updatedByUserId: userId,
        })
        .onConflictDoNothing({ target: [invoices.labOrganizationId, invoices.invoiceNumber] })
        .returning()
        .catch((err: unknown): never => wrapDbError(err));

      const targetInvoice =
        invoice ??
        (await db.query.invoices.findFirst({
          where: and(
            eq(invoices.labOrganizationId, found.labOrganizationId),
            eq(invoices.invoiceNumber, nextInvoiceNumber(found.caseNumber)),
          ),
        }));
      if (!targetInvoice)
        throw new HttpError(500, "Invoice could not be generated.");
      if (!invoice && targetInvoice.caseId !== found.id) {
        // The insert hit a number conflict and we re-selected the existing
        // invoice by [labOrganizationId, invoiceNumber]. Invoice numbers are
        // derived from case numbers ("INV-<caseNumber>"), and case numbers are
        // reused across the legacy-mobile (lab_cases) and canonical (cases)
        // spaces — so a number match does NOT prove the existing invoice
        // belongs to THIS case.
        //
        // When the existing invoice has caseId=null it was (usually) created
        // via the legacy mobile path before this case was promoted to
        // canonical. Adopt it ONLY when its stored patient identity is blank or
        // matches the case we're invoicing — a legitimate same-case promotion —
        // and realign the case-derived fields (provider + display metadata) so
        // the linked invoice can never carry a *different* patient's billing
        // identity. Idempotent: a second call finds caseId=found.id and skips
        // this branch.
        //
        // If the existing invoice's patient is non-blank and disagrees with the
        // case, it belongs to a different patient (a reused-number collision).
        // Refuse rather than silently repurpose another patient's invoice —
        // doing so previously leaked one patient's name/bill-to/provider onto an
        // unrelated case's invoice.
        const staleMeta =
          (targetInvoice.displayMetadataJson as Record<string, unknown> | null) ??
          {};
        const stalePatient = String(staleMeta.patientName ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const currentPatient =
          `${found.patientFirstName ?? ""} ${found.patientLastName ?? ""}`
            .replace(/\s+/g, " ")
            .trim();
        const sameOrBlankPatient =
          stalePatient.length === 0 ||
          stalePatient.toLowerCase() === currentPatient.toLowerCase();

        if (targetInvoice.caseId === null && sameOrBlankPatient) {
          await db.transaction(async (tx) => {
            if (targetInvoice.providerOrganizationId) {
              await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${targetInvoice.labOrganizationId}), hashtext(${targetInvoice.providerOrganizationId}))`);
            }
            await assertNoActiveCardReversalForInvoices(tx, [targetInvoice.id]);
            await tx.select().from(invoices).where(eq(invoices.id, targetInvoice.id)).for("update");
            await tx.update(invoices).set({
              caseId: found.id,
              providerOrganizationId: found.providerOrganizationId,
              displayMetadataJson,
              updatedByUserId: userId,
            }).where(eq(invoices.id, targetInvoice.id));
          });
          (targetInvoice as any).caseId = found.id;
          (targetInvoice as any).providerOrganizationId =
            found.providerOrganizationId;
          (targetInvoice as any).displayMetadataJson = displayMetadataJson;
        } else if (targetInvoice.caseId === null) {
          req.log?.warn(
            {
              invoiceId: targetInvoice.id,
              invoiceNumber: targetInvoice.invoiceNumber,
              caseId: found.id,
              caseNumber: found.caseNumber,
              stalePatient,
              currentPatient,
            },
            "generate-invoice: refused to adopt orphaned invoice belonging to a different patient (reused invoice-number collision)",
          );
          throw new HttpError(
            409,
            `Invoice number "${targetInvoice.invoiceNumber}" is already used by a different patient's invoice (patient: ${stalePatient}, conflicting invoice ID: ${targetInvoice.id}). Void or renumber that invoice before generating one for this case.`,
          );
        } else {
          throw new HttpError(
            409,
            `Invoice number collision: "${targetInvoice.invoiceNumber}" is already used by a different case (conflicting invoice ID: ${targetInvoice.id}).`,
          );
        }
      }

      if (invoice && hasRestorations) {
        const genLabelCache: Record<string, string> = {};
        for (const r of restorations) {
          const pk =
            (await resolveRestorationPriceKey({
              labOrganizationId: found.labOrganizationId,
              material: r.material,
              restorationType: r.restorationType,
              restorationSubtype: r.restorationSubtype,
            })) ?? r.restorationType;
          if (!(pk in genLabelCache)) {
            genLabelCache[pk] = await resolveItemLabel(found.labOrganizationId, pk);
          }
        }
        const itemsToInsert = await Promise.all(restorations.map(async (restoration, index) => {
          const pk =
            (await resolveRestorationPriceKey({
              labOrganizationId: found.labOrganizationId,
              material: restoration.material,
              restorationType: restoration.restorationType,
              restorationSubtype: restoration.restorationSubtype,
            })) ?? restoration.restorationType;
          const label = genLabelCache[pk] ?? restoration.restorationType;
          const toothInt = parseInt(restoration.toothNumber, 10);
          return {
            invoiceId: targetInvoice.id,
            caseRestorationId: restoration.id,
            sourceType: "restoration",
            sourceKey: `restoration:${restoration.id}`,
            sourceRestorationIdsJson: [restoration.id],
            toothNumber: Number.isInteger(toothInt) && toothInt >= 1 && toothInt <= 32 ? toothInt : null,
            description: buildLineItemDescription(restoration.toothNumber, label),
            quantity: restoration.quantity,
            unitPrice: restoration.unitPrice,
            lineTotal: calculateLineTotal(restoration.quantity, restoration.unitPrice),
            sortOrder: index,
          };
        }));
        (targetInvoice as any).__generatedItems = itemsToInsert;
      }

      const updatedInvoice = await db.transaction(async (tx) => {
        if (targetInvoice.providerOrganizationId) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${targetInvoice.labOrganizationId}), hashtext(${targetInvoice.providerOrganizationId}))`);
        }
        if (!invoice) await assertNoActiveCardReversalForInvoices(tx, [targetInvoice.id]);
        const [authoritative] = await tx.select().from(invoices)
          .where(eq(invoices.id, targetInvoice.id)).for("update");
        if (!authoritative) throw new HttpError(404, "Invoice not found.");
        const generatedItems = (targetInvoice as any).__generatedItems as any[] | undefined;
        if (generatedItems?.length) await tx.insert(invoiceLineItems).values(generatedItems);
        const items = await tx.query.invoiceLineItems.findMany({
          where: eq(invoiceLineItems.invoiceId, authoritative.id),
          orderBy: [invoiceLineItems.sortOrder],
        });
        const subtotal = sumMoney(items.map((item) => item.lineTotal));
        const paidRows = await tx.select({ value: sum(payments.amount) }).from(payments)
          .where(eq(payments.invoiceId, authoritative.id));
        const paid = Number(paidRows[0]?.value ?? 0);
        const [updated] = await tx.update(invoices).set({
          subtotal,
          total: subtotal,
          balanceDue: Math.max(0, Number(subtotal) - paid).toFixed(2),
          updatedByUserId: userId,
          // Preserve an existing dueAt when re-generating; only default to
          // 10th-of-next-month when dueAt is not already set.
          issuedAt: calendarDateToUtcNoon(found.receivedAt),
          status: "open" as const,
          dueAt: authoritative.dueAt ?? invoiceDueDate(new Date()),
        }).where(eq(invoices.id, authoritative.id)).returning();
        const user = (req as any).user;
        await tx.insert(caseEvents).values({
        caseId: found.id,
        eventType: "invoice_generated",
        actorUserId: userId,
        actorOrganizationId: found.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          invoiceId: updated.id,
          invoiceNumber: updated.invoiceNumber,
        },
        });
        return updated;
      });

      return ok(res, updatedInvoice, invoice ? 201 : 200);
    }

    // ── Legacy mobile case path ──────────────────────────────────────────────
    // Mobile cases live in lab_cases (blob store), not the canonical cases
    // table. We still generate an invoice skeleton for them, but:
    //   • caseId is left null  (cases.id FK would reject the legacy ID)
    //   • providerOrganizationId is null  (legacy cases have no formal provider
    //     org; schema column is now nullable to allow this)
    //   • caseEvents insert is skipped  (caseEvents.caseId FK to cases.id)
    const legacyRow = await db.query.labCases.findFirst({
      where: and(eq(labCases.id, caseId), isNull(labCases.deletedAt)),
    });
    if (!legacyRow) throw new HttpError(404, "Case not found.");
    if (!legacyRow.organizationId) {
      throw new HttpError(422, "Legacy case has no associated lab organization.");
    }
    await requireAnyRole(userId, legacyRow.organizationId, BILLING_ROLES);

    let parsedBlob: any;
    try {
      parsedBlob =
        typeof legacyRow.caseData === "string"
          ? JSON.parse(legacyRow.caseData)
          : (legacyRow.caseData ?? {});
    } catch {
      throw new HttpError(422, "Legacy case data is malformed.");
    }

    const legacyCaseNumber = String(parsedBlob.caseNumber ?? caseId);
    const displayMetadataJson = {
      patientName: String(parsedBlob.patientName ?? ""),
      billTo: String(parsedBlob.doctorName ?? ""),
      teeth: String(parsedBlob.toothIndices ?? ""),
      shade: String(parsedBlob.shade ?? ""),
      caseNotes: "",
    };
    const doctorIdentity = await ensureDoctorProfileIdentity(db, {
      labOrganizationId: legacyRow.organizationId,
      providerOrganizationId: null,
      doctorName: String(parsedBlob.doctorName ?? ""),
    });

    const bodyLayoutPresetId =
      typeof req.body?.layoutPresetId === "string" && req.body.layoutPresetId.trim()
        ? req.body.layoutPresetId.trim()
        : null;

    const [legacyInvoice] = await db
      .insert(invoices)
      .values({
        invoiceNumber: nextInvoiceNumber(legacyCaseNumber),
        caseId: null,
        labOrganizationId: legacyRow.organizationId,
        providerOrganizationId: null,
        doctorIdentity,
        status: "open",
        displayMetadataJson,
        ...(bodyLayoutPresetId ? { layoutPresetId: bodyLayoutPresetId } : {}),
        issuedAt: new Date(),
        dueAt: invoiceDueDate(new Date()),
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .onConflictDoNothing({ target: [invoices.labOrganizationId, invoices.invoiceNumber] })
      .returning()
      .catch((err: unknown): never => wrapDbError(err));

    const targetLegacyInvoice =
      legacyInvoice ??
      (await db.query.invoices.findFirst({
        where: and(
          eq(invoices.labOrganizationId, legacyRow.organizationId),
          eq(invoices.invoiceNumber, nextInvoiceNumber(legacyCaseNumber)),
        ),
      }));
    if (!targetLegacyInvoice)
      throw new HttpError(500, "Invoice could not be generated.");
    if (!legacyInvoice && targetLegacyInvoice.caseId !== null) {
      throw new HttpError(
        409,
        `Invoice number collision: "${targetLegacyInvoice.invoiceNumber}" is already used by a different case (conflicting invoice ID: ${targetLegacyInvoice.id}).`,
      );
    }

    // For freshly created invoices, synthesize a line item from the mobile
    // blob's price so the desktop editor shows a line item that matches the
    // total (instead of opening an empty invoice with a $0 total).
    if (legacyInvoice) {
      const blobPrice = Number(parsedBlob.price ?? 0);
      if (Number.isFinite(blobPrice) && blobPrice > 0) {
        const desc = parsedBlob.caseType
          ? String(parsedBlob.caseType)
          : parsedBlob.patientName
            ? `Case for ${String(parsedBlob.patientName)}`
            : "Dental restoration";
        const lineTotalStr = calculateLineTotal(1, String(blobPrice));
        await db.insert(invoiceLineItems).values({
          invoiceId: targetLegacyInvoice.id,
          toothNumber: null,
          description: desc,
          quantity: 1,
          unitPrice: String(blobPrice),
          lineTotal: lineTotalStr,
          sortOrder: 0,
        }).catch((err: unknown): never => wrapDbError(err, {
          fallback: "Failed to insert legacy invoice line item.",
        }));
        const [updatedLegacy] = await db
          .update(invoices)
          .set({
            subtotal: lineTotalStr,
            total: lineTotalStr,
            balanceDue: lineTotalStr,
            issuedAt: new Date(),
            status: "open" as const,
            dueAt: invoiceDueDate(new Date()),
            updatedByUserId: userId,
          })
          .where(eq(invoices.id, targetLegacyInvoice.id))
          .returning();
        if (updatedLegacy) {
          return ok(res, updatedLegacy, 201);
        }
      }
    }

    return ok(res, targetLegacyInvoice, legacyInvoice ? 201 : 200);
  })
);

router.get(
  "/filter-facets",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const labOrganizationId =
      typeof req.query.labOrganizationId === "string" && req.query.labOrganizationId
        ? req.query.labOrganizationId
        : null;
    const practiceId =
      typeof req.query.practiceId === "string" && req.query.practiceId
        ? req.query.practiceId
        : null;

    const { orgIds } = await getInvoiceReadScope(callerId);

    if (orgIds.length === 0) {
      return ok(res, { practices: [], doctors: [] });
    }

    const invoiceScope = and(
      isNull(invoices.deletedAt),
      or(
        ...orgIds.flatMap((organizationId) => [
          eq(invoices.labOrganizationId, organizationId),
          eq(invoices.providerOrganizationId, organizationId),
        ]),
      ),
      labOrganizationId ? eq(invoices.labOrganizationId, labOrganizationId) : undefined,
      practiceId ? eq(invoices.providerOrganizationId, practiceId) : undefined,
    );
    const canonicalDoctorNameSql = sql<string>`trim(coalesce(
      ${invoices.displayMetadataJson}->>'billTo',
      ${invoices.displayMetadataJson}->>'doctorName',
      ''
    ))`;
    const [practiceRows, canonicalDoctorRows, mobileFacetRows] = await Promise.all([
      db
        .selectDistinct({
          id: organizations.id,
          name: sql<string>`coalesce(
            nullif(trim(${organizations.displayName}), ''),
            ${organizations.name}
          )`,
        })
        .from(invoices)
        .innerJoin(organizations, eq(organizations.id, invoices.providerOrganizationId))
        .where(invoiceScope),
      db
        .selectDistinct({ name: canonicalDoctorNameSql })
        .from(invoices)
        .where(and(invoiceScope, sql`${canonicalDoctorNameSql} <> ''`)),
      practiceId
        ? Promise.resolve([] as Array<{ caseData: string }>)
        : db
            .select({ caseData: labCases.caseData })
            .from(labCases)
            .where(
              and(
                isNull(labCases.deletedAt),
                inArray(labCases.organizationId, orgIds),
                labOrganizationId
                  ? eq(labCases.organizationId, labOrganizationId)
                  : undefined,
                sql`${labCases.caseData} like '%"invoiceId"%'`,
              ),
            ),
    ]);
    const mobileDoctorNames = mobileFacetRows.flatMap(({ caseData }) => {
      try {
        const parsed = JSON.parse(caseData);
        if (!parsed || typeof parsed !== "object") return [];
        const invoiceId = String(parsed.invoiceId ?? "").trim();
        const doctorName = String(parsed.doctorName ?? "").trim();
        return invoiceId && doctorName ? [doctorName] : [];
      } catch {
        return [];
      }
    });

    const practices = practiceRows
      .filter((practice) => practice.id && practice.name?.trim())
      .map((practice) => ({ id: practice.id, name: practice.name.trim() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const doctors = Array.from(
      new Set(
        [...canonicalDoctorRows.map((doctor) => doctor.name), ...mobileDoctorNames]
          .map((doctorName) => doctorName?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    ).sort((a, b) => a.localeCompare(b));

    return ok(res, { practices, doctors });
  }),
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query);
    const queryString = (name: string): string | null =>
      typeof req.query[name] === "string" && req.query[name]
        ? req.query[name] as string
        : null;
    const queryValues = (name: string): string[] =>
      queryString(name)
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? [];
    const invalidValues = (values: string[], allowed: Set<string>): string[] =>
      Array.from(new Set(values.filter((value) => !allowed.has(value))));
    const requestedViewValue = queryString("view");
    const requestedLegacyStatuses = queryValues("status");
    const requestedStatusValues = queryValues("statuses");
    const requestedAging = queryString("overdueBucket");
    const sortQueryValue = (name: string): string | null => {
      const value = req.query[name];
      if (Array.isArray(value)) {
        throw new HttpError(
          400,
          `Invalid invoice ${name} value(s): ${value.join(", ")}. Provide exactly one value.`,
        );
      }
      return typeof value === "string" ? value : null;
    };
    const requestedSort = sortQueryValue("sort");
    const requestedSortDir = sortQueryValue("sortDir");
    const requestedSortBy = sortQueryValue("sortBy");
    const requestedSortDirection = sortQueryValue("sortDirection");

    const invalidView = requestedViewValue && !INVOICE_VIEW_VALUES.has(requestedViewValue)
      ? [requestedViewValue]
      : [];
    const invalidLegacyStatuses = invalidValues(
      requestedLegacyStatuses,
      INVOICE_LEGACY_STATUS_VALUES,
    );
    const invalidStatuses = invalidValues(requestedStatusValues, INVOICE_STATUS_FILTER_VALUES);
    const invalidAging = requestedAging && !INVOICE_AGING_VALUES.has(requestedAging)
      ? [requestedAging]
      : [];
    const invalidSort = requestedSort !== null && !INVOICE_SORT_VALUES.has(requestedSort)
      ? [requestedSort]
      : [];
    const invalidSortDir =
      requestedSortDir !== null && !INVOICE_SORT_DIRECTION_VALUES.has(requestedSortDir)
        ? [requestedSortDir]
        : [];
    const invalidSortBy = requestedSortBy !== null && !INVOICE_SORT_VALUES.has(requestedSortBy)
      ? [requestedSortBy]
      : [];
    const invalidSortDirection =
      requestedSortDirection !== null &&
      !INVOICE_SORT_DIRECTION_VALUES.has(requestedSortDirection)
        ? [requestedSortDirection]
        : [];
    if (invalidView.length > 0) {
      throw new HttpError(
        400,
        `Invalid invoice view value(s): ${invalidView.join(", ")}. Supported values are: open, outstanding.`,
      );
    }
    if (invalidLegacyStatuses.length > 0) {
      throw new HttpError(
        400,
        `Invalid invoice status value(s): ${invalidLegacyStatuses.join(", ")}. Supported values are: open, partially_paid, paid, void, frozen, zero_balance, all, closed, overdue.`,
      );
    }
    if (invalidStatuses.length > 0) {
      throw new HttpError(
        400,
        `Invalid invoice statuses value(s): ${invalidStatuses.join(", ")}. Supported values are: open, partially_paid, paid, void, frozen, zero_balance.`,
      );
    }
    if (invalidAging.length > 0) {
      throw new HttpError(
        400,
        `Invalid invoice aging value(s): ${invalidAging.join(", ")}. Supported values are: all, 0_30, 31_60, 61_90, 90_plus, custom.`,
      );
    }
    if (invalidSort.length > 0) {
      throw new HttpError(
        400,
        `Invalid invoice sort value(s): ${invalidSort.join(", ")}. Supported values are: issued, due, practice.`,
      );
    }
    if (invalidSortDir.length > 0) {
      throw new HttpError(
        400,
        `Invalid invoice sortDir value(s): ${invalidSortDir.join(", ")}. Supported values are: asc, desc.`,
      );
    }
    if (invalidSortBy.length > 0) {
      throw new HttpError(
        400,
        `Invalid invoice sortBy value(s): ${invalidSortBy.join(", ")}. Supported values are: issued, due, practice.`,
      );
    }
    if (invalidSortDirection.length > 0) {
      throw new HttpError(
        400,
        `Invalid invoice sortDirection value(s): ${invalidSortDirection.join(", ")}. Supported values are: asc, desc.`,
      );
    }

    const parseDateFilter = (name: string): Date | null => {
      const value = req.query[name];
      if (value === undefined) return null;
      if (typeof value !== "string" || value.trim() === "") {
        throw new HttpError(400, `Invalid invoice date filter: ${name} must be a valid date.`);
      }

      const parsed = new Date(value);
      if (!Number.isFinite(parsed.getTime())) {
        throw new HttpError(400, `Invalid invoice date filter: ${name} must be a valid date.`);
      }

      // Date parses some impossible ISO calendar days by rolling them into the
      // following month. Reject those values while keeping the other formats
      // supported by the existing date parser.
      const isoDate = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
      if (isoDate) {
        const year = Number(isoDate[1]);
        const month = Number(isoDate[2]);
        const day = Number(isoDate[3]);
        const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        const daysInMonth = [
          31,
          isLeapYear ? 29 : 28,
          31,
          30,
          31,
          30,
          31,
          31,
          30,
          31,
          30,
          31,
        ][month - 1];
        if (!daysInMonth || day < 1 || day > daysInMonth) {
          throw new HttpError(400, `Invalid invoice date filter: ${name} must be a valid date.`);
        }
      }

      return parsed;
    };
    const assertDateRangeOrder = (
      fromName: string,
      toName: string,
      from: Date | null,
      to: Date | null,
    ) => {
      if (from && to && from.getTime() > to.getTime()) {
        throw new HttpError(
          400,
          `Invalid invoice date range: ${fromName} must be on or before ${toName}.`,
        );
      }
    };

    const dateFromFilter = parseDateFilter("dateFrom");
    const dateToFilter = parseDateFilter("dateTo");
    const issuedFrom = parseDateFilter("issuedFrom");
    const issuedTo = parseDateFilter("issuedTo");
    const dueDateFrom = parseDateFilter("dueDateFrom");
    const dueDateToInput = parseDateFilter("dueDateTo");
    assertDateRangeOrder("dateFrom", "dateTo", dateFromFilter, dateToFilter);
    assertDateRangeOrder("issuedFrom", "issuedTo", issuedFrom, issuedTo);
    assertDateRangeOrder("dueDateFrom", "dueDateTo", dueDateFrom, dueDateToInput);
    const dueDateTo = dueDateToInput
      ? new Date(dueDateToInput)
      : null;
    dueDateTo?.setHours(23, 59, 59, 999);

    const callerId = (req as any).auth.userId as string;
    const { orgIds, memberships } = await getInvoiceReadScope(callerId);

    // Diagnostic guardrail: if the user has zero active memberships, the
    // invoices list will be empty regardless of how much data exists in the
    // database. Surface that in the server log so future "I see nothing"
    // reports can be diagnosed from logs alone (response shape unchanged).
    if (orgIds.length === 0) {
      const totalMemberships = memberships.length;
      const nonActiveStatuses = Array.from(
        new Set(
          memberships
            .map((m: any) => m.status)
            .filter((s: any) => s && s !== "active")
        )
      );
      req.log.warn(
        {
          userId: (req as any).auth.userId,
          totalMemberships,
          nonActiveStatuses,
        },
        "GET /api/invoices returning [] because user has no active organization memberships"
      );
    }

    const caseIdFilter =
      typeof req.query.caseId === "string" && req.query.caseId
        ? req.query.caseId
        : null;
    const practiceIdFilter =
      typeof req.query.practiceId === "string" && req.query.practiceId
        ? req.query.practiceId
        : null;
    const practiceIdsFilter =
      typeof req.query.practiceIds === "string" && req.query.practiceIds
        ? req.query.practiceIds.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
    const labIdFilter =
      typeof req.query.labOrganizationId === "string" &&
      req.query.labOrganizationId
        ? req.query.labOrganizationId
        : null;
    const normalizedFilters = normalizeInvoiceFilterPrecedence({
      view: req.query.view,
      statuses: req.query.statuses,
      legacyStatus: req.query.status,
      aging: req.query.overdueBucket,
    });
    const requestedView = normalizedFilters.view === "all" ? null : normalizedFilters.view;
    const requestedStatuses = normalizedFilters.statuses;
    const statusFilter = normalizedFilters.legacyStatus;
    const statusList: string[] | null =
      normalizedFilters.selection.kind === "statuses" ? requestedStatuses : null;
    const searchFilter =
      typeof req.query.search === "string" ? req.query.search.trim().toLocaleLowerCase() : "";
    const overdueStatusFilter = statusFilter === "overdue" || statusFilter === "pastdue";
    const minAmount =
      typeof req.query.minAmount === "string" && req.query.minAmount
        ? Number(req.query.minAmount)
        : null;
    const maxAmount =
      typeof req.query.maxAmount === "string" && req.query.maxAmount
        ? Number(req.query.maxAmount)
        : null;
    const aiOnly = req.query.aiOnly === "true";
    const overdueBucket = normalizedFilters.aging && normalizedFilters.aging !== "all"
      ? normalizedFilters.aging
      : null;
    const doctorNameFilter =
      typeof req.query.doctorName === "string" && req.query.doctorName
        ? req.query.doctorName
        : null;
    const statusesFilter: string[] = normalizedFilters.selection.kind === "statuses"
      ? requestedStatuses
      : [];
    const sortFilter =
      req.query.sort === "practice" || req.query.sort === "issued" || req.query.sort === "due"
        ? req.query.sort
        : null;
    const desktopSortDirection = req.query.sortDir === "desc" ? -1 : 1;
    const sortBy =
      req.query.sortBy === "issued" || req.query.sortBy === "due" || req.query.sortBy === "practice"
        ? req.query.sortBy
        : null;
    const mobileSortDirection = req.query.sortDirection === "asc" ? 1 : -1;
    const viewFilter = requestedView;
    const includeFacets = req.query.includeFacets === "true";

    const [rows, mobileCaseRows] = await Promise.all([
      orgIds.length
        ? db.query.invoices.findMany({
            where: and(
              !pagination.active && caseIdFilter ? eq(invoices.caseId, caseIdFilter) : undefined,
              !pagination.active && practiceIdFilter
                ? eq(invoices.providerOrganizationId, practiceIdFilter)
                : undefined,
              !pagination.active && practiceIdsFilter && practiceIdsFilter.length
                ? inArray(invoices.providerOrganizationId, practiceIdsFilter)
                : undefined,
              !pagination.active && labIdFilter
                ? eq(invoices.labOrganizationId, labIdFilter)
                : undefined,
              !pagination.active && aiOnly ? eq(invoices.aiGenerated, true) : undefined,
              !pagination.active && doctorNameFilter
                ? sql`coalesce(
                    ${invoices.displayMetadataJson}->>'billTo',
                    ${invoices.displayMetadataJson}->>'doctorName'
                  ) = ${doctorNameFilter}`
                : undefined,
              isNull(invoices.deletedAt),
              or(
                ...orgIds.flatMap((orgId: string) => [
                  eq(invoices.labOrganizationId, orgId),
                  eq(invoices.providerOrganizationId, orgId),
                ])
              )
            ),
            orderBy: [desc(invoices.createdAt)],
          })
        : Promise.resolve([] as any[]),
      orgIds.length
        ? db
            .select()
            .from(labCases)
            .where(
              and(
                isNull(labCases.deletedAt),
                inArray(labCases.organizationId, orgIds)
              )
            )
        : Promise.resolve([] as any[]),
    ]);

    // Bridge mobile-origin invoices into the desktop list. Mobile cases store
    // an `invoiceId` reference inside `lab_cases.case_data` JSON but the
    // device-local invoice payload itself is only weakly synced to the server's
    // relational `invoices` table (see `generateServerInvoiceForCase` in the
    // mobile app-context). Until that sync is fully reliable, synthesize a
    // read-only invoice row per case-with-invoiceId so the desktop Invoices
    // page reflects what the mobile user actually sees. Server-real invoices
    // (matched by caseId) take precedence.
    const realCaseIds = new Set(
      rows.map((r: any) => r.caseId).filter((id: any): id is string => !!id)
    );
    // Also track real DB invoice numbers so we can suppress mobile-synthesized
    // duplicates when a matching INV-<caseNumber> row exists with caseId=null
    // (the legacy generate-invoice path sets caseId null for lab_cases rows).
    const realInvoiceNumbers = new Set(
      rows.map((r: any) => r.invoiceNumber).filter((n: any): n is string => !!n)
    );
    type SynthesizedInvoice = ReturnType<typeof toMobileInvoice>;
    const mobileInvoices: SynthesizedInvoice[] = [];
    for (const lc of mobileCaseRows as any[]) {
      if (caseIdFilter && lc.id !== caseIdFilter) continue;
      if (realCaseIds.has(lc.id)) continue;
      try {
        const parsed =
          typeof lc.caseData === "string"
            ? JSON.parse(lc.caseData)
            : lc.caseData;
        if (!parsed || typeof parsed !== "object") continue;
        // Skip synthesis when a real DB invoice already covers this case by
        // invoice number (handles the legacy path where caseId is null so
        // realCaseIds would never match, causing both rows to appear).
        const lcCaseNumber =
          typeof parsed.caseNumber === "string" ? parsed.caseNumber : "";
        if (lcCaseNumber && realInvoiceNumbers.has(`INV-${lcCaseNumber}`)) continue;
        const localInvoiceId =
          typeof parsed.invoiceId === "string" && parsed.invoiceId
            ? parsed.invoiceId
            : null;
        if (!localInvoiceId) continue;
        if (!lc.organizationId) continue;
        if (!orgIds.includes(lc.organizationId)) continue;
        if (
          !pagination.active &&
          doctorNameFilter &&
          parsed.doctorName !== doctorNameFilter
        ) continue;
        const mobileInvoice = toMobileInvoice(lc, parsed, localInvoiceId);
        // Legacy mobile invoices have no provider organization or AI marker.
        // Preserve the historical unpaged bridge, but paged responses must
        // apply every list filter before calculating totals and slicing.
        if (pagination.active) {
          if (labIdFilter && mobileInvoice.labOrganizationId !== labIdFilter) continue;
          if (practiceIdFilter || (practiceIdsFilter && practiceIdsFilter.length)) continue;
          const filterDate = new Date(mobileInvoice.issuedAt ?? mobileInvoice.createdAt);
          if (
            dateFromFilter &&
            !Number.isNaN(dateFromFilter.getTime()) &&
            filterDate < dateFromFilter
          ) continue;
          if (
            dateToFilter &&
            !Number.isNaN(dateToFilter.getTime()) &&
            filterDate > dateToFilter
          ) continue;
          if (aiOnly) continue;
        }
        mobileInvoices.push(mobileInvoice);
      } catch {
        // skip malformed rows
      }
    }

    // Diagnostic guardrail (Step 5b): the user has active memberships but the
    // database has zero matching invoices AND no mobile-origin invoices either.
    // That points at a data-source problem (mobile sync not running, lab is
    // brand new, etc.) rather than a scoping bug — surface it in the log so
    // future "I see nothing" reports can be triaged from logs alone.
    if (orgIds.length > 0 && rows.length === 0 && mobileInvoices.length === 0) {
      req.log.warn(
        {
          userId: (req as any).auth.userId,
          activeOrgIds: orgIds,
          mobileCaseRowsScanned: mobileCaseRows.length,
        },
        "GET /api/invoices returning [] despite active memberships: no rows in invoices table and no mobile-origin invoiceIds in lab_cases"
      );
    }

    // Lazy enrichment: for canonical invoice rows whose displayMetadataJson is
    // missing any of caseType, caseSubtype, or material, recompute from the
    // live cases + caseRestorations + caseNotes rows and write back so the
    // data is durable on subsequent fetches. Mirrors the semantics of the
    // admin POST /backfill-display-metadata route.
    const staleRows = rows.filter((r: any) => {
      if (!r.caseId) return false;
      const meta = r.displayMetadataJson;
      if (!meta || typeof meta !== "object") return true; // null/missing metadata
      const m = meta as Record<string, unknown>;
      // Stale if ANY of the three derived fields is absent or empty
      return (
        !m.caseType || m.caseType === "" ||
        !m.caseSubtype || m.caseSubtype === "" ||
        !m.material || m.material === ""
      );
    });

    if (staleRows.length > 0) {
      const staleCaseIds = Array.from(
        new Set(staleRows.map((r: any) => r.caseId as string))
      );

      // Batch-fetch case rows, restorations, and provider-shared notes in
      // parallel. Notes are scoped to shared_with_provider only — the same
      // visibility gate used in the admin backfill route — so internal-only
      // notes are never written into invoice metadata or returned to providers.
      const [staleCaseRows, staleRestorationRows, staleNoteRows] = await Promise.all([
        db
          .select({
            id: cases.id,
            patientFirstName: cases.patientFirstName,
            patientLastName: cases.patientLastName,
            doctorName: cases.doctorName,
          })
          .from(cases)
          .where(inArray(cases.id, staleCaseIds)),
        db
          .select({
            caseId: caseRestorations.caseId,
            toothNumber: caseRestorations.toothNumber,
            shade: caseRestorations.shade,
            material: caseRestorations.material,
            restorationType: caseRestorations.restorationType,
            restorationSubtype: caseRestorations.restorationSubtype,
          })
          .from(caseRestorations)
          .where(inArray(caseRestorations.caseId, staleCaseIds)),
        db
          .select({
            caseId: caseNotes.caseId,
            noteText: caseNotes.noteText,
          })
          .from(caseNotes)
          .where(
            and(
              inArray(caseNotes.caseId, staleCaseIds),
              eq(caseNotes.visibility, "shared_with_provider"),
            )
          )
          .orderBy(asc(caseNotes.createdAt)),
      ]);

      const caseRowsById = new Map(staleCaseRows.map((c) => [c.id, c]));
      const restsByCase = new Map<string, typeof staleRestorationRows>();
      const notesByCase = new Map<string, typeof staleNoteRows>();
      for (const r of staleRestorationRows) {
        const arr = restsByCase.get(r.caseId) ?? [];
        arr.push(r);
        restsByCase.set(r.caseId, arr);
      }
      for (const n of staleNoteRows) {
        const arr = notesByCase.get(n.caseId) ?? [];
        arr.push(n);
        notesByCase.set(n.caseId, arr);
      }

      // Compute fresh metadata and patch rows in-memory; fire write-backs non-blocking.
      // Merge order mirrors the admin backfill: freshMeta is the base, then
      // manually-edited free-text fields (patientName, billTo, caseNotes) from
      // any existing metadata are layered on top so hand-edits are preserved.
      const writebacks: Array<Promise<unknown>> = [];
      for (const row of staleRows as any[]) {
        const caseRow = caseRowsById.get(row.caseId);
        if (!caseRow) continue;
        const restorations = restsByCase.get(row.caseId) ?? [];
        const notes = notesByCase.get(row.caseId) ?? [];
        const freshMeta = buildInvoiceDisplayMetadataFromCase(caseRow, restorations, notes);
        const existingMeta =
          row.displayMetadataJson && typeof row.displayMetadataJson === "object"
            ? (row.displayMetadataJson as Record<string, unknown>)
            : {};
        // Preserve any manually-edited free-text fields over the rebuilt values.
        const patchedMeta = {
          ...freshMeta,
          ...(existingMeta["patientName"] !== undefined
            ? { patientName: existingMeta["patientName"] }
            : {}),
          ...(existingMeta["billTo"] !== undefined
            ? { billTo: existingMeta["billTo"] }
            : {}),
          ...(existingMeta["caseNotes"] !== undefined
            ? { caseNotes: existingMeta["caseNotes"] }
            : {}),
        };
        // Update in-memory so the response is correct immediately
        row.displayMetadataJson = patchedMeta;
        // Fire non-blocking write-back to make the fix durable
        writebacks.push(
          db
            .update(invoices)
            .set({ displayMetadataJson: patchedMeta })
            .where(eq(invoices.id, row.id))
        );
      }
      // Settle all write-backs; a write failure must never break the GET response
      if (writebacks.length > 0) {
        Promise.allSettled(writebacks).catch(() => {/* intentionally ignored */});
      }
    }

    const caseCompletedAtMap = new Map<string, string | null>();
    for (const lc of mobileCaseRows as any[]) {
      try {
        const parsed =
          typeof lc.caseData === "string" ? JSON.parse(lc.caseData) : lc.caseData;
        if (!parsed || typeof parsed !== "object") continue;
        const routeHistory: Array<{ station: string; timestamp: number }> =
          Array.isArray(parsed.routeHistory) ? parsed.routeHistory : [];
        const completeEntries = routeHistory.filter((e) => e.station === "COMPLETE");
        if (completeEntries.length === 0) {
          caseCompletedAtMap.set(lc.id, null);
          continue;
        }
        const lastEntry = completeEntries[completeEntries.length - 1];
        const d = new Date(lastEntry.timestamp);
        caseCompletedAtMap.set(lc.id, Number.isNaN(d.getTime()) ? null : d.toISOString());
      } catch {
        caseCompletedAtMap.set(lc.id, null);
      }
    }

    const orgIdsToFetch = Array.from(
      new Set([
        ...rows.flatMap((r: any) => [r.providerOrganizationId, r.labOrganizationId]),
        ...mobileInvoices.flatMap((r) => [r.providerOrganizationId, r.labOrganizationId]),
      ].filter((id): id is string => !!id))
    );
    const orgRows = orgIdsToFetch.length
      ? await db.select().from(organizations).where(inArray(organizations.id, orgIdsToFetch))
      : [];
    const orgsById = new Map(orgRows.map((o: any) => [o.id, o]));

    // Build a set of invoice IDs that have at least one linked bank transaction.
    // Only real (non-synthesized) invoice IDs are queried; mobile-synthesized rows
    // have no bank_transaction_invoices entries and default to hasDeposit: false.
    const realInvoiceIds = rows
      .map((r: any) => r.id)
      .filter((id: any): id is string => !!id);
    const depositedInvoiceIds = new Set<string>();
    // Invoice IDs that have at least one unpriced alloy sub-item. Mirrors the
    // `withPriced` logic in GET /:invoiceId: a child line (parentLineItemId !=
    // null) whose description starts with "Alloy" and whose unitPrice is 0.
    const unpricedAlloyInvoiceIds = new Set<string>();
    if (realInvoiceIds.length > 0) {
      const [depositRows, alloySubItems] = await Promise.all([
        db
          .select({ invoiceId: bankTransactionInvoices.invoiceId })
          .from(bankTransactionInvoices)
          .where(inArray(bankTransactionInvoices.invoiceId, realInvoiceIds)),
        db
          .select({
            invoiceId: invoiceLineItems.invoiceId,
            description: invoiceLineItems.description,
            unitPrice: invoiceLineItems.unitPrice,
          })
          .from(invoiceLineItems)
          .where(
            and(
              inArray(invoiceLineItems.invoiceId, realInvoiceIds),
              isNotNull(invoiceLineItems.parentLineItemId),
            )
          ),
      ]);
      for (const d of depositRows) {
        depositedInvoiceIds.add(d.invoiceId);
      }
      for (const sub of alloySubItems) {
        if (
          sub.description?.startsWith("Alloy") &&
          Number(sub.unitPrice ?? 0) === 0
        ) {
          unpricedAlloyInvoiceIds.add(sub.invoiceId);
        }
      }
    }

    const enrich = (r: any) => ({
      ...r,
      // Void invoices are treated as deposited so they don't block a practice
      // from reaching the "all paid + all deposited" green state.
      hasDeposit: r.status === "void" || depositedInvoiceIds.has(r.id),
      hasUnpricedAlloy: unpricedAlloyInvoiceIds.has(r.id),
      caseCompletedAt: r.caseId ? (caseCompletedAtMap.get(r.caseId) ?? null) : null,
      providerOrganization: r.providerOrganizationId && orgsById.get(r.providerOrganizationId)
        ? {
            id: r.providerOrganizationId,
            name:
              orgsById.get(r.providerOrganizationId)!.displayName ||
              orgsById.get(r.providerOrganizationId)!.name,
          }
        : null,
      labOrganization: r.labOrganizationId && orgsById.get(r.labOrganizationId)
        ? {
            id: r.labOrganizationId,
            name:
              orgsById.get(r.labOrganizationId)!.displayName ||
              orgsById.get(r.labOrganizationId)!.name,
          }
        : null,
    });
    let enriched = [...rows.map(enrich), ...mobileInvoices.map(enrich)].sort(
      (a: any, b: any) =>
        String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) ||
        String(b.id ?? "").localeCompare(String(a.id ?? ""))
    );
    const facets = includeFacets
      ? {
          practices: Array.from(
            new Map(
              enriched.flatMap((invoice: any) => {
                const id = String(invoice.providerOrganizationId ?? "");
                const name = String(invoice.providerOrganization?.name ?? "").trim();
                return id && name ? [[id, { id, name }] as const] : [];
              }),
            ).values(),
          ).sort((a, b) => a.name.localeCompare(b.name)),
          doctors: Array.from(
            new Set(
              enriched
                .map((invoice: any) => {
                  const metadata =
                    invoice.displayMetadataJson && typeof invoice.displayMetadataJson === "object"
                      ? invoice.displayMetadataJson
                      : invoice.displayMetadata && typeof invoice.displayMetadata === "object"
                        ? invoice.displayMetadata
                        : {};
                  return String(metadata.billTo ?? metadata.doctorName ?? "").trim();
                })
                .filter(Boolean),
            ),
          ).sort((a, b) => a.localeCompare(b)),
        }
      : undefined;
    const callerScoped = enriched;

    if (searchFilter) {
      enriched = enriched.filter((r: any) => {
        const metadata =
          r.displayMetadataJson && typeof r.displayMetadataJson === "object"
            ? r.displayMetadataJson
            : r.displayMetadata && typeof r.displayMetadata === "object"
              ? r.displayMetadata
              : {};
        return [
          r.invoiceNumber,
          r.providerOrganization?.name,
          metadata.patientName,
          metadata.billTo,
        ].some((value) => String(value ?? "").toLocaleLowerCase().includes(searchFilter));
      });
    }

    enriched = enriched.filter((r: any) => {
      const filterDateSource = r.issuedAt ?? r.createdAt;
      const filterDate = filterDateSource ? new Date(filterDateSource) : null;
      if (
        dateFromFilter &&
        !Number.isNaN(dateFromFilter.getTime()) &&
        (!filterDate || Number.isNaN(filterDate.getTime()) || filterDate < dateFromFilter)
      ) return false;
      if (
        dateToFilter &&
        !Number.isNaN(dateToFilter.getTime()) &&
        (!filterDate || Number.isNaN(filterDate.getTime()) || filterDate > dateToFilter)
      ) return false;
      if (issuedFrom || issuedTo) {
        if (!filterDate || Number.isNaN(filterDate.getTime())) return false;
        if (issuedFrom && filterDate < issuedFrom) return false;
        if (issuedTo && filterDate >= issuedTo) return false;
      }
      if (!pagination.active) return true;

      if (caseIdFilter && r.caseId !== caseIdFilter) return false;
      if (practiceIdFilter && r.providerOrganizationId !== practiceIdFilter) return false;
      if (practiceIdsFilter?.length && !practiceIdsFilter.includes(r.providerOrganizationId)) return false;
      if (labIdFilter && r.labOrganizationId !== labIdFilter) return false;
      if (aiOnly && !r.aiGenerated) return false;
      if (doctorNameFilter) {
        const metadata =
          r.displayMetadataJson && typeof r.displayMetadataJson === "object"
            ? r.displayMetadataJson
            : r.displayMetadata && typeof r.displayMetadata === "object"
              ? r.displayMetadata
              : {};
        const doctorName = String(metadata.billTo ?? metadata.doctorName ?? "").trim();
        if (doctorName !== doctorNameFilter) return false;
      }
      return true;
    });

    if (minAmount != null && Number.isFinite(minAmount)) {
      enriched = enriched.filter(
        (r: any) => Number(r.total ?? 0) >= minAmount,
      );
    }
    if (maxAmount != null && Number.isFinite(maxAmount)) {
      enriched = enriched.filter(
        (r: any) => Number(r.total ?? 0) <= maxAmount,
      );
    }
    if (overdueBucket) {
      if (overdueBucket === "custom") {
        const callerIsAdminOrOwner = memberships.some(
          (m: any) => m.status === "active" && (m.role === "admin" || m.role === "owner")
        );
        if (callerIsAdminOrOwner && (dueDateFrom || dueDateTo)) {
          enriched = enriched.filter((r: any) => {
            const issued = r.issuedAt ?? r.createdAt;
            if (!issued) return false;
            const issuedTime = new Date(issued).getTime();
            if (Number.isNaN(issuedTime)) return false;
            if (dueDateFrom && issuedTime < dueDateFrom.getTime()) return false;
            if (dueDateTo && issuedTime > dueDateTo.getTime()) return false;
            return true;
          });
        }
      } else {
        const now = Date.now();
        const bucketDays = (b: string): [number, number] => {
          switch (b) {
            case "0_30":
              return [0, 30];
            case "31_60":
              return [31, 60];
            case "61_90":
              return [61, 90];
            case "90_plus":
              return [91, Number.POSITIVE_INFINITY];
            default:
              return [0, Number.POSITIVE_INFINITY];
          }
        };
        const [minD, maxD] = bucketDays(overdueBucket);
        enriched = enriched.filter((r: any) => {
          if (r.frozen) return false;
          if (Number(r.balanceDue ?? 0) <= 0) return false;
          const due = r.dueAt ? new Date(r.dueAt).getTime() : null;
          if (!due || Number.isNaN(due)) return false;
          const ageDays = Math.floor((now - due) / (24 * 60 * 60 * 1000));
          return ageDays >= minD && ageDays <= maxD;
        });
      }
    }
    // Count tabs after every non-status filter, but before the selected status.
    // The Overdue tab is the established outstanding view (not a new status).
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isOpen = (r: any) => r.status === "open" || r.status === "partially_paid";
    const isOutstanding = (r: any) => {
      const due = r.dueAt ? new Date(r.dueAt) : null;
      return Boolean(isOpen(r) && due && !Number.isNaN(due.getTime()) && due < today);
    };
    const statusCounts = {
      all: enriched.length,
      open: enriched.filter(isOpen).length,
      overdue: enriched.filter(isOutstanding).length,
      paid: enriched.filter((r: any) => r.status === "paid").length,
      draft: enriched.filter((r: any) => r.status === "draft" || r.status === RECOVERY_DRAFT_STATUS).length,
      void: enriched.filter((r: any) => r.status === "void").length,
    };
    // All-time means no search/date/status restrictions, but still the exact
    // authorized tenant and explicitly selected practice/lab scope.
    const totalInvoices = callerScoped.filter((r: any) =>
      (!labIdFilter || r.labOrganizationId === labIdFilter) &&
      (!practiceIdFilter || r.providerOrganizationId === practiceIdFilter) &&
      (!practiceIdsFilter?.length || practiceIdsFilter.includes(r.providerOrganizationId)),
    ).length;

    if (viewFilter === "open") enriched = enriched.filter(isOpen);
    else if (viewFilter === "outstanding") enriched = enriched.filter(isOutstanding);
    if (statusList?.length) {
      enriched = enriched.filter((r: any) =>
        statusList.some((status) => {
          if (status === "zero_balance") return Number(r.balanceDue ?? r.total ?? 0) === 0;
          if (status === "frozen") return Boolean(r.frozen);
          if (status === "draft") return r.status === "draft" || r.status === RECOVERY_DRAFT_STATUS;
          return status === r.status || (status === "open" && r.status === "partially_paid");
        }),
      );
    }
    if (statusFilter === "closed") {
      enriched = enriched.filter((r: any) => r.status === "paid" || r.status === "void");
    }
    if (overdueStatusFilter) {
      const now = Date.now();
      enriched = enriched.filter((r: any) => {
        if (r.frozen || Number(r.balanceDue ?? 0) <= 0) return false;
        if (r.status !== "open" && r.status !== "partially_paid" && r.status !== "overdue") {
          return false;
        }
        const due = r.dueAt ?? r.dueDate;
        if (!due) return false;
        const dueTime = new Date(due).getTime();
        return Number.isFinite(dueTime) && now > dueTime;
      });
    }

    if (!pagination.active) return ok(res, enriched);

    const sortableDate = (value: unknown): string =>
      value instanceof Date ? value.toISOString() : String(value ?? "");
    enriched = enriched.filter((r: any) => {
      if (
        viewFilter !== "outstanding" &&
        statusesFilter.length &&
        !statusesFilter.some((status) => {
          if (status === "zero_balance") {
            return Number(r.balanceDue ?? r.total ?? 0) === 0;
          }
          if (status === "frozen") return Boolean(r.frozen);
          if (status === "draft") return r.status === "draft" || r.status === RECOVERY_DRAFT_STATUS;
          return r.status === status;
        })
      ) return false;

      return true;
    });

    // Every branch ends in an id comparison: a total order is what lets a
    // cursor anchor a batch on the last row the client received, so rows
    // sharing a sort value cannot drift between requests.
    const byId = (a: any, b: any) =>
      String(a.id ?? "").localeCompare(String(b.id ?? ""));
    enriched.sort((a: any, b: any) => {
      if (sortFilter === "practice") {
        return desktopSortDirection * String(a.providerOrganization?.name ?? "")
          .localeCompare(String(b.providerOrganization?.name ?? "")) || byId(a, b);
      }
      if (sortFilter === "issued") {
        return desktopSortDirection *
          sortableDate(a.issuedAt).localeCompare(sortableDate(b.issuedAt)) || byId(a, b);
      }
      if (sortFilter === "due") {
        return desktopSortDirection * sortableDate(a.dueAt ?? a.dueDate)
          .localeCompare(sortableDate(b.dueAt ?? b.dueDate)) || byId(a, b);
      }
      if (sortBy) {
        const aValue = sortBy === "practice"
          ? String(a.providerOrganization?.name ?? "")
          : sortableDate(sortBy === "issued" ? (a.issuedAt ?? a.createdAt) : a.dueAt);
        const bValue = sortBy === "practice"
          ? String(b.providerOrganization?.name ?? "")
          : sortableDate(sortBy === "issued" ? (b.issuedAt ?? b.createdAt) : b.dueAt);
        return mobileSortDirection * (
          aValue.localeCompare(bValue, undefined, { sensitivity: "base" }) ||
          String(a.id ?? "").localeCompare(String(b.id ?? ""))
        );
      }
      return sortableDate(b.createdAt ?? b.issuedAt)
        .localeCompare(sortableDate(a.createdAt ?? a.issuedAt)) || byId(a, b);
    });

    // Cursor anchor for whichever ordering the request selected.
    const invoiceKeyset: Keyset<any> = (() => {
      const desktopDir: SortDirection = desktopSortDirection === -1 ? "desc" : "asc";
      if (sortFilter === "practice") {
        return {
          sortValues: (row) => [String(row.providerOrganization?.name ?? "")],
          id: (row) => String(row.id ?? ""),
          directions: [desktopDir],
        };
      }
      if (sortFilter === "issued") {
        return {
          sortValues: (row) => [sortableDate(row.issuedAt)],
          id: (row) => String(row.id ?? ""),
          directions: [desktopDir],
        };
      }
      if (sortFilter === "due") {
        return {
          sortValues: (row) => [sortableDate(row.dueAt ?? row.dueDate)],
          id: (row) => String(row.id ?? ""),
          directions: [desktopDir],
        };
      }
      if (sortBy) {
        // The mobile sort applies its direction to the id tiebreaker too.
        const mobileDir: SortDirection = mobileSortDirection === -1 ? "desc" : "asc";
        return {
          sortValues: (row) => [
            sortBy === "practice"
              ? String(row.providerOrganization?.name ?? "")
              : sortableDate(sortBy === "issued" ? (row.issuedAt ?? row.createdAt) : row.dueAt),
          ],
          id: (row) => String(row.id ?? ""),
          directions: [mobileDir],
          idDirection: mobileDir,
        };
      }
      return {
        sortValues: (row) => [sortTime(row.createdAt ?? row.issuedAt)],
        id: (row) => String(row.id ?? ""),
        directions: ["desc"],
      };
    })();

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let openBalance = 0;
    let openCount = 0;
    let overdueBalance = 0;
    let overdueCount = 0;
    let sumTotal = 0;
    let sumBalance = 0;
    for (const invoice of enriched) {
      const total = Number(invoice.total ?? 0);
      const balance = Number(invoice.balanceDue ?? invoice.total ?? 0);
      sumTotal += total;
      sumBalance += balance;
      if (invoice.frozen) continue;
      openBalance += balance;
      if (balance !== 0) {
        openCount++;
        const due = invoice.dueAt ?? invoice.dueDate;
        if (due && new Date(due) < now) {
          overdueBalance += balance;
          overdueCount++;
        }
      }
    }
    let paidThisMonth = 0;
    let paidCount = 0;
    for (const invoice of callerScoped) {
      if (invoice.status !== "paid") continue;
      const timestamp = invoice.updatedAt || invoice.issuedAt || invoice.createdAt;
      if (timestamp && new Date(timestamp) >= monthStart) {
        paidThisMonth += Number(invoice.total ?? 0);
        paidCount++;
      }
    }
    return ok(res, {
      ...pageRowsKeyset(enriched, pagination, invoiceKeyset),
      ...(includeFacets ? { facets } : {}),
      summary: {
        openBalance,
        openCount,
        overdueBalance,
        overdueCount,
        sumTotal,
        sumBalance,
        paidThisMonth,
        paidCount,
        totalInvoices,
        statusCounts,
      },
    });
  })
);

// Per-practice summary used by the AccountSelector panel.
router.get(
  "/practice-summary",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const providerOrganizationId = String(req.query.providerOrganizationId ?? "");
    const labOrganizationId =
      typeof req.query.labOrganizationId === "string"
        ? req.query.labOrganizationId
        : null;
    if (!providerOrganizationId) {
      throw new HttpError(400, "providerOrganizationId is required.");
    }

    // Caller must be inside the canonical invoice read scope. A lab member
    // may filter to a practice within that lab; provider users may read their
    // own linked-provider practice scope.
    const readScope = await getInvoiceReadScope(callerId);
    if (
      !practiceIsInInvoiceReadScope(
        labOrganizationId ?? "",
        providerOrganizationId,
        readScope,
      )
    ) {
      throw new HttpError(403, "You do not have access to this practice.");
    }

    const rows = await db.query.invoices.findMany({
      where: and(
        eq(invoices.providerOrganizationId, providerOrganizationId),
        labOrganizationId
          ? eq(invoices.labOrganizationId, labOrganizationId)
          : undefined,
        isNull(invoices.deletedAt),
        finalizedInvoiceSql(),
      ),
    });

    const now = Date.now();
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const open = rows.filter(
      (r: any) =>
        !r.frozen &&
        r.status !== "void" &&
        r.status !== "paid" &&
        Number(r.balanceDue) > 0,
    );
    const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
    for (const r of open) {
      const bal = Number((r as any).balanceDue ?? 0);
      const due = (r as any).dueAt
        ? new Date((r as any).dueAt).getTime()
        : null;
      if (!due) {
        buckets.current += bal;
        continue;
      }
      const age = Math.floor((now - due) / (24 * 60 * 60 * 1000));
      if (age <= 0) buckets.current += bal;
      else if (age <= 30) buckets.d30 += bal;
      else if (age <= 60) buckets.d60 += bal;
      else if (age <= 90) buckets.d90 += bal;
      else buckets.d90plus += bal;
    }

    const credits = await db.query.invoiceCredits.findMany({
      where: and(
        eq(invoiceCredits.providerOrganizationId, providerOrganizationId),
        isNull(invoiceCredits.reversedAt),
      ),
    });

    const recent = rows
      .slice()
      .sort((a: any, b: any) =>
        String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
      )
      .slice(0, 10);

    return ok(res, {
      providerOrganizationId,
      totals: {
        invoiceCount: rows.length,
        openCount: open.length,
        totalBilled: sum(rows.map((r: any) => Number(r.total ?? 0))).toFixed(2),
        openBalance: sum(
          open.map((r: any) => Number(r.balanceDue ?? 0)),
        ).toFixed(2),
        creditsAvailable: sum(
          credits.map((c: any) => Number(c.amount ?? 0)),
        ).toFixed(2),
      },
      aging: {
        current: buckets.current.toFixed(2),
        days_1_30: buckets.d30.toFixed(2),
        days_31_60: buckets.d60.toFixed(2),
        days_61_90: buckets.d90.toFixed(2),
        days_90_plus: buckets.d90plus.toFixed(2),
      },
      recentInvoices: recent.map((r: any) => ({
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        total: r.total,
        balanceDue: r.balanceDue,
        status: r.status,
        issuedAt: r.issuedAt,
        dueAt: r.dueAt,
        aiGenerated: r.aiGenerated ?? false,
      })),
    });
  }),
);

function toMobileInvoice(lc: any, parsed: any, localInvoiceId: string) {
  // Mobile timestamps are usually epoch numbers (Date.now()), but older /
  // imported rows may carry ISO strings. Accept both, fall back to lab_cases
  // updated_at, then to "now" so a malformed timestamp never silently drops
  // the row (caught by the outer try/catch).
  const parseTs = (v: unknown): string | null => {
    if (v == null || v === "") return null;
    if (typeof v === "number" && Number.isFinite(v)) {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (typeof v === "string") {
      const asNum = Number(v);
      if (Number.isFinite(asNum) && /^\d+$/.test(v.trim())) {
        const d = new Date(asNum);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      }
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
  };
  const lcUpdatedAt =
    lc.updatedAt instanceof Date ? lc.updatedAt.toISOString() : null;
  const createdAt =
    parseTs(parsed.updatedAt) ??
    parseTs(parsed.createdAt) ??
    lcUpdatedAt ??
    new Date().toISOString();
  const price = Number(parsed.price ?? 0);
  const total = Number.isFinite(price) ? price.toFixed(2) : "0.00";
  const caseNumber = String(parsed.caseNumber ?? "");
  const invoiceNumber = caseNumber
    ? `INV-${caseNumber}`
    : `INV-${localInvoiceId.slice(-8)}`;
  // A bulk "Reset to $0" writes `invoiceStatus` into the blob so the
  // synthesized invoice reads as $0 open instead of the default "open".
  const VALID_STATUSES = [
    "open",
    "partially_paid",
    "paid",
    "void",
  ] as const;
  type SynthStatus = (typeof VALID_STATUSES)[number];
  const status: SynthStatus = VALID_STATUSES.includes(
    parsed.invoiceStatus as SynthStatus,
  )
    ? (parsed.invoiceStatus as SynthStatus)
    : "open";
  return {
    id: `mobile:${localInvoiceId}`,
    invoiceNumber,
    caseId: lc.id,
    labOrganizationId: lc.organizationId as string,
    providerOrganizationId: null as string | null,
    status,
    subtotal: total,
    tax: "0.00",
    discount: "0.00",
    total,
    balanceDue: total,
    issuedAt: createdAt,
    dueAt: parsed.dueDate ?? null,
    notes: parsed.notes ?? null,
    displayMetadataJson: {
      patientName: parsed.patientName ?? null,
      caseType: parsed.caseType ?? null,
      teeth: parsed.toothIndices ?? null,
      shade: parsed.shade ?? null,
      doctorName: parsed.doctorName ?? null,
      source: "mobile",
    },
    createdByUserId: lc.ownerId as string,
    updatedByUserId: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    deletedByUserId: null,
    _source: "mobile" as const,
  };
}

// ─────────────────────────── Receive Payments ───────────────────────────
//
// These two routes MUST be registered before the dynamic `GET /:invoiceId`
// below, otherwise Express captures `/open` and `/receive-payments` as
// `:invoiceId` and the handlers are never reached.

// Open invoices for a single provider (oldest-first) within a specific lab.
// Both query params are required so we can hard-enforce billing-role
// authorization on the target lab (no implicit cross-lab fallback).
router.get(
  "/open",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const query = z
      .object({
        providerOrganizationId: z.string().min(1),
        labOrganizationId: z.string().min(1),
      })
      .parse(req.query);

    // Strict 403 for any caller who is not an active billing/admin/owner
    // member of the target lab. Provider users and viewers cannot list a
    // lab's open invoices through this endpoint.
    await requireAnyRole(callerId, query.labOrganizationId, BILLING_ROLES);
    const { orgIds } = await getInvoiceReadScope(callerId);

    const rows = await db.query.invoices.findMany({
      where: and(
        isNull(invoices.deletedAt),
        eq(invoices.providerOrganizationId, query.providerOrganizationId),
        eq(invoices.labOrganizationId, query.labOrganizationId),
        orgIds.length
          ? or(
              ...orgIds.flatMap((organizationId) => [
                eq(invoices.labOrganizationId, organizationId),
                eq(invoices.providerOrganizationId, organizationId),
              ]),
            )
          : sql`false`,
        inArray(invoices.status, ["open", "partially_paid", "overdue"])
      ),
      orderBy: [asc(invoices.issuedAt), asc(invoices.createdAt)],
    });

    const open = rows
      .filter((r: any) => Number(r.balanceDue) > 0)
      .map((r: any) => {
        const issued = r.issuedAt
          ? new Date(r.issuedAt)
          : r.createdAt
          ? new Date(r.createdAt)
          : null;
        const ageDays = issued
          ? Math.max(0, Math.floor((Date.now() - issued.getTime()) / 86400000))
          : null;
        return {
          id: r.id,
          invoiceNumber: r.invoiceNumber,
          labOrganizationId: r.labOrganizationId,
          providerOrganizationId: r.providerOrganizationId,
          status: r.status,
          total: r.total,
          balanceDue: r.balanceDue,
          issuedAt: r.issuedAt,
          dueAt: r.dueAt,
          ageDays,
        };
      });
    return ok(res, open);
  })
);

const receivePaymentsSchema = z.object({
  labOrganizationId: z.string().min(1),
  providerOrganizationId: z.string().min(1),
  doctorName: z.string().trim().min(1).optional().nullable(),
  paymentDate: z.string().optional(),
  paymentMethod: z.enum(["card", "ach", "check", "cash", "other"]),
  referenceNumber: z.string().optional().nullable(),
  memo: z.string().optional().nullable(),
  // Optional: when omitted, the payment is held in the org's Undeposited
  // Funds account until the user runs "Make Deposits".
  depositBankAccountId: z.string().optional().nullable(),
  applications: z
    .array(
      z.object({
        invoiceId: z.string().min(1),
        amount: z.coerce.number().positive(),
      })
    )
    .min(1)
    .max(500),
});

// Keep the identity used by the duplicate-payment lookup stable while retaining
// the original input as the immutable display snapshot on the payment session.
function doctorIdentityFromReceiveName(name: string | null | undefined): string | null {
  const normalized = typeof name === "string"
    ? name.trim().replace(/\s+/g, " ").toLowerCase()
    : "";
  return normalized || null;
}

// Apply a single batch of payments across multiple open invoices for one
// provider, then post a single combined deposit to the chosen bank account
// (linked to every paid invoice via bank_transaction_invoices). Mirrors the
// QuickBooks "Receive Payment" workflow. Bypasses ensureInvoiceDeposit so the
// existing per-invoice auto-deposit path can't double-post.
router.post(
  "/receive-payments",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const input = receivePaymentsSchema.parse(req.body);
    await requireAnyRole(callerId, input.labOrganizationId, BILLING_ROLES);

    const totalToApply = input.applications.reduce(
      (s, a) => s + Number(a.amount || 0),
      0
    );
    if (!(totalToApply > 0)) {
      throw new HttpError(400, "Total payment amount must be greater than zero.");
    }

    const txnDate = input.paymentDate ? new Date(input.paymentDate) : new Date();
    if (Number.isNaN(txnDate.getTime())) {
      throw new HttpError(400, "Invalid payment date.");
    }

    // Resolve the deposit account: explicit override → Undeposited Funds.
    let depositAccount: any;
    if (input.depositBankAccountId) {
      depositAccount = await db.query.bankAccounts.findFirst({
        where: eq(bankAccounts.id, input.depositBankAccountId),
      });
      if (
        !depositAccount ||
        depositAccount.labOrganizationId !== input.labOrganizationId ||
        depositAccount.isArchived
      ) {
        throw new HttpError(
          400,
          "Deposit account must belong to this lab and be active."
        );
      }
    } else {
      // Auto-route to the org's Undeposited Funds account.
      depositAccount = await db.query.bankAccounts.findFirst({
        where: and(
          eq(bankAccounts.labOrganizationId, input.labOrganizationId),
          eq(bankAccounts.accountType, "undeposited_funds")
        ),
      });
      if (!depositAccount) {
        throw new HttpError(
          422,
          "No Undeposited Funds account found for this lab. Open the Finance register to create one automatically."
        );
      }
    }

    // Resolve the AR category ID outside the transaction so a failure here
    // never poisons the Postgres tx context (try-catch inside a tx leaves the
    // session in an aborted state where every subsequent tx.* call fails).
    let arCategoryId: string | null = null;
    try {
      const { accountsReceivable } = await ensureDefaultCategories(
        input.labOrganizationId,
      );
      arCategoryId = accountsReceivable.id;
    } catch {
      // Non-fatal: payment still posts without a category.
    }


    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${input.labOrganizationId}), hashtext(${input.providerOrganizationId}))`,
      );
      const invoiceIds = input.applications.map((a) => a.invoiceId);
      for (const invoiceId of [...new Set(invoiceIds)].sort()) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoiceId}))`);
      }
      const invRows = await tx
        .select()
        .from(invoices)
        .where(
          and(
            inArray(invoices.id, invoiceIds),
            isNull(invoices.deletedAt)
          )
        )
        .for("update");
      if (invRows.length !== invoiceIds.length) {
        throw new HttpError(404, "One or more invoices were not found.");
      }
      const ALLOWED_RECEIVE_STATUSES = new Set([
        "open",
        "partially_paid",
        "overdue",
      ]);
      for (const inv of invRows) {
        if (inv.labOrganizationId !== input.labOrganizationId) {
          throw new HttpError(
            400,
            `Invoice ${inv.invoiceNumber} does not belong to this lab.`
          );
        }
        if (inv.providerOrganizationId !== input.providerOrganizationId) {
          throw new HttpError(
            400,
            `Invoice ${inv.invoiceNumber} does not belong to this provider.`
          );
        }
        if (input.doctorName) {
          const metadata =
            inv.displayMetadataJson && typeof inv.displayMetadataJson === "object"
              ? inv.displayMetadataJson as Record<string, unknown>
              : null;
          const invoiceDoctor = metadata?.billTo ?? metadata?.doctorName;
          const normalizeDoctor = (value: unknown) =>
            typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
          if (normalizeDoctor(invoiceDoctor) !== normalizeDoctor(input.doctorName)) {
            throw new HttpError(
              400,
              `Invoice ${inv.invoiceNumber} does not belong to the selected doctor.`,
            );
          }
        }
        if (!ALLOWED_RECEIVE_STATUSES.has(inv.status)) {
          throw new HttpError(
            400,
            `Invoice ${inv.invoiceNumber} is ${inv.status} and cannot accept payments.`
          );
        }
      }

      const updatedInvoices: any[] = [];
      const insertedPayments: any[] = [];
      for (const app of input.applications) {
        const inv = invRows.find((i: any) => i.id === app.invoiceId)!;
        const balance = Number(inv.balanceDue);
        const apply = Number(app.amount);
        if (apply > balance + 0.005) {
          throw new HttpError(
            400,
            `Payment of ${apply.toFixed(2)} exceeds balance ${balance.toFixed(2)} on invoice ${inv.invoiceNumber}.`
          );
        }
        const [p] = await tx
          .insert(payments)
          .values({
            invoiceId: inv.id,
            amount: apply.toFixed(2),
            paymentMethod: input.paymentMethod,
            referenceNumber: input.referenceNumber ?? null,
            paidAt: txnDate,
            recordedByUserId: callerId,
          })
          .returning();
        insertedPayments.push(p);

        const newBalance = Math.max(0, balance - apply);
        const newStatus = newBalance < 0.005 ? "paid" : "partially_paid";
        const [updated] = await tx
          .update(invoices)
          .set({
            balanceDue: newBalance.toFixed(2),
            status: newStatus,
            updatedByUserId: callerId,
          })
          .where(eq(invoices.id, inv.id))
          .returning();
        updatedInvoices.push(updated);
      }

      // Resolve the provider org name for a meaningful payee label.
      let providerOrgName: string | null = null;
      if (input.providerOrganizationId) {
        const provOrg = await tx.query.organizations.findFirst({
          where: eq(organizations.id, input.providerOrganizationId),
          columns: { name: true, displayName: true },
        });
        providerOrgName = provOrg?.displayName || provOrg?.name || null;
      }
      // Fallback: derive practice name from the invoices being paid when no
      // providerOrganizationId was supplied on the input.
      if (!providerOrgName) {
        const fallbackOrgId = invRows.find(
          (inv: any) => inv.providerOrganizationId
        )?.providerOrganizationId;
        if (fallbackOrgId) {
          const fallbackOrg = await tx.query.organizations.findFirst({
            where: eq(organizations.id, fallbackOrgId),
            columns: { name: true, displayName: true },
          });
          providerOrgName =
            fallbackOrg?.displayName || fallbackOrg?.name || null;
        }
      }

      const refLabel = input.referenceNumber
        ? ` (#${input.referenceNumber})`
        : "";
      const payeeLabel = providerOrgName
        ? `${providerOrgName}${refLabel}`
        : `Customer payment${refLabel}`;
      const [deposit] = await tx
        .insert(bankTransactions)
        .values({
          labOrganizationId: input.labOrganizationId,
          bankAccountId: depositAccount.id,
          txnDate,
          type: "deposit",
          payee: payeeLabel,
          memo: input.memo || null,
          debitAmount: "0.00",
          creditAmount: totalToApply.toFixed(2),
          netAmount: totalToApply.toFixed(2),
          cleared: false,
          status: "posted",
          source: "invoice",
          categoryId: arCategoryId,
          createdByUserId: callerId,
        })
        .returning();
      for (const inv of updatedInvoices) {
        await tx.insert(bankTransactionInvoices).values({
          bankTransactionId: deposit.id,
          invoiceId: inv.id,
        });
      }

      // Backfill bankTransactionId on every payment row we just created so
      // the DELETE /finance/payments/:bankTransactionId endpoint can later
      // reverse the whole batch by looking up payments by this FK.
      if (insertedPayments.length > 0) {
        await tx
          .update(payments)
          .set({ bankTransactionId: deposit.id })
          .where(
            inArray(
              payments.id,
              insertedPayments.map((p: any) => p.id)
            )
          );
        for (const p of insertedPayments) {
          p.bankTransactionId = deposit.id;
        }
      }

      // Receive Payments predates the hosted statement-payment flow, but its
      // bank transaction must still have a durable session so Finance can
      // display the doctor and the duplicate warning can distinguish doctors
      // within one practice.  A null identity intentionally means the whole
      // practice (and is not an inferred doctor).
      const labOrg = await tx.query.organizations.findFirst({
        where: eq(organizations.id, input.labOrganizationId),
        columns: { name: true, displayName: true },
      });
      await tx.insert(statementPaymentSessions).values({
        labOrganizationId: input.labOrganizationId,
        providerOrganizationId: input.providerOrganizationId,
        doctorIdentity: doctorIdentityFromReceiveName(input.doctorName),
        doctorDisplayName: input.doctorName?.trim() || null,
        bankTransactionId: deposit.id,
        requestFingerprint: `receive-payment:${deposit.id}`,
        receiptNumber: `RP-${deposit.id}`,
        receivedAmount: totalToApply.toFixed(2),
        appliedAmount: totalToApply.toFixed(2),
        customerCreditAmount: "0.00",
        accountBalanceAfter: "0.00",
        paymentMethod: input.paymentMethod,
        checkNumber: input.referenceNumber?.trim() || null,
        memo: input.memo || null,
        paymentDate: txnDate,
        customerName: providerOrgName,
        labName: labOrg?.displayName || labOrg?.name || input.labOrganizationId,
        status: depositAccount.accountType === "undeposited_funds"
          ? "undeposited"
          : "deposited",
        createdByUserId: callerId,
      });

      return {
        payments: insertedPayments,
        invoices: updatedInvoices,
        depositTransactionId: deposit.id,
        totalApplied: totalToApply.toFixed(2),
      };
    });

    // case_events for paid invoices, outside the txn for simplicity
    for (const inv of result.invoices) {
      const original = await db.query.invoices.findFirst({
        where: eq(invoices.id, inv.id),
      });
      if (!original?.caseId) continue;
      const matchingPayment = result.payments.find(
        (p: any) => p.invoiceId === inv.id
      );
      try {
        await db.insert(caseEvents).values({
          caseId: original.caseId,
          eventType: "payment_received",
          actorUserId: callerId,
          actorOrganizationId: inv.labOrganizationId,
          actorInitials: "SYS",
          metadataJson: {
            invoiceId: inv.id,
            paymentId: matchingPayment?.id ?? null,
            amount: matchingPayment?.amount ?? null,
            batch: true,
          },
        });
      } catch (err) {
        req.log.warn({ err, invoiceId: inv.id }, "case_event insert failed");
      }
    }

    await deliverPaymentNotifications({
      origin: "lab",
      sourceType: "receive_payment",
      sourceId: result.depositTransactionId,
      labOrganizationId: input.labOrganizationId,
      providerOrganizationId: input.providerOrganizationId,
      amount: result.totalApplied,
      invoiceIds: result.invoices.map((invoice) => invoice.id),
      paymentMethod: input.paymentMethod,
    });

    return ok(res, result, 201);
  })
);

// Recent receive-payment sessions for a single provider, used by the desktop
// "Receive Payment" modal to warn about potential duplicate payments.
// Returns one entry per bank-transaction deposit (one batch = one deposit),
// sorted newest-first. paymentMethod / referenceNumber are pulled from any
// payments row linked to that deposit.
router.get(
  "/payments/recent",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const query = z
      .object({
        providerOrganizationId: z.string().min(1),
        labOrganizationId: z.string().min(1),
        doctorName: z.string().trim().min(1).optional(),
        withinDays: z.coerce.number().int().min(1).max(365).optional(),
      })
      .parse(req.query);

    await requireAnyRole(callerId, query.labOrganizationId, BILLING_ROLES);
    const { orgIds } = await getInvoiceReadScope(callerId);

    const withinDays = query.withinDays ?? 90;
    const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000);

    // Join bankTransactions → bankTransactionInvoices → invoices (to filter by
    // provider) → payments (to get paymentMethod / referenceNumber).
    // Multiple rows per bank transaction can appear when a batch covers several
    // invoices, so deduplicate in JS after the query.
    const rows = await db
      .select({
        id: bankTransactions.id,
        totalAmount: bankTransactions.creditAmount,
        paidAt: bankTransactions.txnDate,
        paymentMethod: payments.paymentMethod,
        referenceNumber: payments.referenceNumber,
      })
      .from(bankTransactions)
      .innerJoin(
        bankTransactionInvoices,
        eq(bankTransactionInvoices.bankTransactionId, bankTransactions.id),
      )
      .innerJoin(invoices, eq(invoices.id, bankTransactionInvoices.invoiceId))
      .leftJoin(payments, eq(payments.invoiceId, bankTransactionInvoices.invoiceId))
      .leftJoin(
        statementPaymentSessions,
        eq(statementPaymentSessions.bankTransactionId, bankTransactions.id),
      )
      .where(
        and(
          eq(bankTransactions.labOrganizationId, query.labOrganizationId),
          eq(bankTransactions.source, "invoice"),
          isNull(bankTransactions.deletedAt),
          eq(invoices.providerOrganizationId, query.providerOrganizationId),
          orgIds.length
            ? or(
                ...orgIds.flatMap((organizationId) => [
                  eq(invoices.labOrganizationId, organizationId),
                  eq(invoices.providerOrganizationId, organizationId),
                ]),
              )
            : sql`false`,
          query.doctorName
            ? eq(
                statementPaymentSessions.doctorIdentity,
                query.doctorName.trim().replace(/\s+/g, " ").toLowerCase(),
              )
            : undefined,
          gte(bankTransactions.txnDate, cutoff),
        ),
      )
      .orderBy(desc(bankTransactions.txnDate))
      .limit(200);

    // Deduplicate: keep the first row seen per bank-transaction id (it already
    // carries paymentMethod / referenceNumber from one of the linked payments).
    const seen = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!seen.has(row.id)) seen.set(row.id, row);
    }
    const recent = Array.from(seen.values()).slice(0, 50).map((r) => ({
      id: r.id,
      totalAmount: r.totalAmount,
      paidAt: r.paidAt,
      paymentMethod: r.paymentMethod ?? null,
      referenceNumber: r.referenceNumber ?? null,
    }));

    return ok(res, recent);
  }),
);

// Legacy mobile-created invoices surface in the list with a synthetic
// `mobile:<localInvoiceId>` id (see toMobileInvoice) — they have no row in the
// relational `invoices` table, so a direct lookup 404s. Resolve such an id to
// its canonical invoice when one now exists for the same case (e.g. it was
// generated on desktop after the list was loaded). When no canonical invoice
// exists, throw a clear, friendly error instead of a bare 404 so the editor can
// explain why the legacy invoice can't be opened.
const MOBILE_INVOICE_ID_PREFIX = "mobile:";

async function resolveMobileInvoiceId(
  callerId: string,
  mobileId: string
): Promise<string> {
  const localInvoiceId = mobileId.slice(MOBILE_INVOICE_ID_PREFIX.length).trim();
  if (!localInvoiceId) throw new HttpError(404, "Invoice not found.");

  // Start with the same organization/capability scope as GET /api/invoices.
  // The canonical invoice check below remains the access gate; the broader
  // candidate scan is needed to turn a known, but unauthorized, linked alias
  // into the same 403 as its canonical invoice instead of an early 404.
  const { orgIds } = await getInvoiceReadScope(callerId);
  if (orgIds.length === 0)
    throw new HttpError(404, "Invoice not found.");

  // Mobile cases are stored under their lab organization, while linked
  // provider access is represented by the provider organization on the
  // canonical invoice. Include the parent lab for each linked provider
  // organization so an alias can resolve before the canonical invoice's final
  // read-scope check applies the billing capability gate.
  const { providerOrgIds: linkedProviderOrgIds } =
    await getProviderOrgIdsForUserAndLinks(callerId);
  const candidateOrganizationIds = Array.from(
    new Set([...orgIds, ...linkedProviderOrgIds]),
  );
  const scopedOrganizations = await db
    .select({
      id: organizations.id,
      type: organizations.type,
      parentLabOrganizationId: organizations.parentLabOrganizationId,
    })
    .from(organizations)
    .where(inArray(organizations.id, candidateOrganizationIds));
  const caseOrganizationIds = new Set(candidateOrganizationIds);
  for (const organization of scopedOrganizations) {
    if (
      organization.type === "provider" &&
      organization.parentLabOrganizationId
    ) {
      caseOrganizationIds.add(organization.parentLabOrganizationId);
    }
  }

  const caseRows = await db
    .select()
    .from(labCases)
    .where(
      and(
        isNull(labCases.deletedAt),
        inArray(labCases.organizationId, Array.from(caseOrganizationIds)),
      )
    );

  let matched:
    | { labCaseId: string; orgId: string | null; caseNumber: string }
    | null = null;
  for (const lc of caseRows as any[]) {
    try {
      const parsed =
        typeof lc.caseData === "string" ? JSON.parse(lc.caseData) : lc.caseData;
      if (parsed && typeof parsed === "object" && parsed.invoiceId === localInvoiceId) {
        matched = {
          labCaseId: lc.id,
          orgId: lc.organizationId ?? null,
          caseNumber:
            typeof parsed.caseNumber === "string" ? parsed.caseNumber : "",
        };
        break;
      }
    } catch {
      // skip malformed rows
    }
  }

  if (!matched)
    throw new HttpError(
      404,
      "This invoice was created in an older version of the app and isn't available to open. Open the case to generate an editable invoice."
    );

  // A server invoice generated for a mobile case is linked either by caseId
  // (once the case is promoted to a canonical `cases` row that reused the
  // lab_case id) or, for un-promoted cases, by the `INV-<caseNumber>` invoice
  // number within the same lab (the generate-invoice path sets caseId=null).
  const canonical = await db.query.invoices.findFirst({
    where: and(
      isNull(invoices.deletedAt),
      or(
        eq(invoices.caseId, matched.labCaseId),
        matched.caseNumber && matched.orgId
          ? and(
              eq(invoices.invoiceNumber, `INV-${matched.caseNumber}`),
              eq(invoices.labOrganizationId, matched.orgId)
            )
          : undefined
      )
    ),
  });
  if (canonical) return canonical.id;

  // No canonical invoice yet — auto-generate one on the fly so the user lands
  // straight in the editor instead of hitting a dead-end message. Mirrors the
  // legacy mobile case path in POST /cases/:caseId/generate-invoice.
  if (!matched.orgId)
    throw new HttpError(422, "Legacy case has no associated lab organization.");

  // Enforce the same billing-role gate as the generate-invoice endpoint:
  // only billing-role members may create financial records.
  await requireAnyRole(callerId, matched.orgId, BILLING_ROLES);

  const lcRow = await db.query.labCases.findFirst({
    where: and(eq(labCases.id, matched.labCaseId), isNull(labCases.deletedAt)),
  });
  if (!lcRow)
    throw new HttpError(404, "Invoice not found.");

  let parsedBlob: any;
  try {
    parsedBlob =
      typeof lcRow.caseData === "string"
        ? JSON.parse(lcRow.caseData)
        : (lcRow.caseData ?? {});
  } catch {
    throw new HttpError(422, "Legacy case data is malformed.");
  }

  const legacyCaseNumber = matched.caseNumber || String(matched.labCaseId);
  const displayMetadataJson = {
    patientName: String(parsedBlob.patientName ?? ""),
    billTo: String(parsedBlob.doctorName ?? ""),
    teeth: String(parsedBlob.toothIndices ?? ""),
    shade: String(parsedBlob.shade ?? ""),
    caseNotes: "",
  };
  const doctorIdentity = await ensureDoctorProfileIdentity(db, {
    labOrganizationId: matched.orgId,
    providerOrganizationId: null,
    doctorName: String(parsedBlob.doctorName ?? ""),
  });

  const [newInvoice] = await db
    .insert(invoices)
    .values({
      invoiceNumber: nextInvoiceNumber(legacyCaseNumber),
      caseId: null,
      labOrganizationId: matched.orgId,
      providerOrganizationId: null,
      doctorIdentity,
      status: "open",
      displayMetadataJson,
      issuedAt: new Date(),
      dueAt: invoiceDueDate(new Date()),
      createdByUserId: callerId,
      updatedByUserId: callerId,
    })
    .onConflictDoNothing({ target: [invoices.labOrganizationId, invoices.invoiceNumber] })
    .returning();

  const targetInvoice =
    newInvoice ??
    (await db.query.invoices.findFirst({
      where: and(
        eq(invoices.labOrganizationId, matched.orgId),
        eq(invoices.invoiceNumber, nextInvoiceNumber(legacyCaseNumber)),
      ),
    }));
  if (!targetInvoice)
    throw new HttpError(500, "Invoice could not be generated.");

  // Synthesize a line item from the mobile blob's price only when the invoice
  // was freshly created (newInvoice truthy). When onConflictDoNothing fired,
  // a concurrent request already handled line-item synthesis — skip to avoid
  // duplicate rows and inconsistent totals.
  if (newInvoice) {
    const blobPrice = Number(parsedBlob.price ?? 0);
    if (Number.isFinite(blobPrice) && blobPrice > 0) {
      const desc = parsedBlob.caseType
        ? String(parsedBlob.caseType)
        : parsedBlob.patientName
          ? `Case for ${parsedBlob.patientName}`
          : "Dental restoration";
      const lineTotalStr = calculateLineTotal(1, String(blobPrice));
      await db.insert(invoiceLineItems).values({
        invoiceId: targetInvoice.id,
        toothNumber: null,
        description: desc,
        quantity: 1,
        unitPrice: String(blobPrice),
        lineTotal: lineTotalStr,
        sortOrder: 0,
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to insert mobile legacy invoice line item.",
      }));
      await db
        .update(invoices)
        .set({
          subtotal: lineTotalStr,
          total: lineTotalStr,
          balanceDue: lineTotalStr,
          issuedAt: new Date(),
          status: "open",
          dueAt: invoiceDueDate(new Date()),
          updatedByUserId: callerId,
        })
        .where(eq(invoices.id, targetInvoice.id));
    }
  }

  return targetInvoice.id;
}

// NOTE: must be registered BEFORE GET /:invoiceId or that catch-all matches
// "practice-statements" as an invoice id and returns 404.
router.get(
  "/practice-statements",
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query);
    const callerId = (req as any).auth.userId as string;
    const providerOrganizationId =
      typeof req.query.providerOrganizationId === "string"
        ? req.query.providerOrganizationId
        : null;
    const labOrganizationId =
      typeof req.query.labOrganizationId === "string"
        ? req.query.labOrganizationId
        : null;
    if (!providerOrganizationId && !labOrganizationId) {
      throw new HttpError(
        400,
        "Provide providerOrganizationId or labOrganizationId.",
      );
    }
    const { orgIds } = await getInvoiceReadScope(callerId);
    if (
      (!labOrganizationId || !orgIds.includes(labOrganizationId)) &&
      (!providerOrganizationId || !orgIds.includes(providerOrganizationId))
    ) {
      throw new HttpError(403, "You do not have access to these statements.");
    }
    const rows = await db.query.practiceStatements.findMany({
      where: and(
        providerOrganizationId
          ? eq(practiceStatements.providerOrganizationId, providerOrganizationId)
          : undefined,
        labOrganizationId
          ? eq(practiceStatements.labOrganizationId, labOrganizationId)
          : undefined,
      ),
      orderBy: [desc(practiceStatements.createdAt)],
    });
    // Attach the most recent successful email send per statement so clients
    // can show "Emailed <date> to <address>" and avoid double-sending.
    const stmtIds = rows.map((r) => r.id);
    const lastEmailByStatementId = new Map<
      string,
      { sentAt: Date; recipient: string }
    >();
    if (stmtIds.length > 0) {
      const sends = await db.query.practiceStatementSends.findMany({
        where: and(
          inArray(practiceStatementSends.statementId, stmtIds),
          eq(practiceStatementSends.channel, "email"),
          eq(practiceStatementSends.status, "sent"),
        ),
        orderBy: [desc(practiceStatementSends.sentAt)],
      });
      for (const send of sends) {
        if (!lastEmailByStatementId.has(send.statementId)) {
          lastEmailByStatementId.set(send.statementId, {
            sentAt: send.sentAt,
            recipient: send.recipient,
          });
        }
      }
    }
    const withLastEmail = rows.map((r) => {
      const last = lastEmailByStatementId.get(r.id) ?? null;
      return {
        ...r,
        lastEmailedAt: last?.sentAt ?? null,
        lastEmailedTo: last?.recipient ?? null,
      };
    });
    // Enrich with payment data: find the most recent payment across all
    // invoices in each statement so clients can show "Paid On" / "Payment Method".
    const allInvoiceIds = rows.flatMap(
      (r) => (r.invoiceIdsJson as string[]) ?? [],
    );
    const latestPaymentByInvoiceId = new Map<
      string,
      { paidAt: Date; paymentMethod: string }
    >();
    if (allInvoiceIds.length > 0) {
      const pmts = await db
        .select({
          invoiceId: payments.invoiceId,
          paidAt: payments.paidAt,
          paymentMethod: payments.paymentMethod,
        })
        .from(payments)
        .where(inArray(payments.invoiceId, allInvoiceIds))
        .orderBy(desc(payments.paidAt));
      for (const pmt of pmts) {
        if (!latestPaymentByInvoiceId.has(pmt.invoiceId)) {
          latestPaymentByInvoiceId.set(pmt.invoiceId, {
            paidAt: pmt.paidAt,
            paymentMethod: pmt.paymentMethod,
          });
        }
      }
    }
    // The stored totals are the immutable issued snapshot and are never
    // updated when a payment is recorded, so the reported paid / balance-due
    // figures are derived from the statement's own invoices as they stand now.
    const invoiceStateById = new Map<
      string,
      {
        labOrganizationId: string;
        providerOrganizationId: string | null;
        total: string;
        balanceDue: string;
        status: string;
      }
    >();
    if (allInvoiceIds.length > 0) {
      const invoiceStates = await db
        .select({
          id: invoices.id,
          labOrganizationId: invoices.labOrganizationId,
          providerOrganizationId: invoices.providerOrganizationId,
          total: invoices.total,
          balanceDue: invoices.balanceDue,
          status: invoices.status,
        })
        .from(invoices)
        .where(
          and(inArray(invoices.id, allInvoiceIds), isNull(invoices.deletedAt)),
        );
      for (const invoice of invoiceStates) {
        invoiceStateById.set(invoice.id, invoice);
      }
    }
    const withPayments = withLastEmail.map((r) => {
      const invoiceIds = (r.invoiceIdsJson as string[]) ?? [];
      const bundleManifest = coerceStatementBundleManifest(
        r.bundleManifestJson,
      );
      const statementData = { ...r };
      delete statementData.bundleManifestJson;
      let latestPaidAt: Date | null = null;
      let latestPaymentMethod: string | null = null;
      const scopedInvoices = new Map<string, StatementInvoiceState>();
      for (const invId of invoiceIds) {
        const pmt = latestPaymentByInvoiceId.get(invId);
        if (pmt && (latestPaidAt === null || pmt.paidAt > latestPaidAt)) {
          latestPaidAt = pmt.paidAt;
          latestPaymentMethod = pmt.paymentMethod;
        }
        const invoice = invoiceStateById.get(invId);
        if (
          invoice &&
          invoice.labOrganizationId === r.labOrganizationId &&
          invoice.providerOrganizationId === r.providerOrganizationId
        ) {
          scopedInvoices.set(invId, invoice);
        }
      }
      const live = deriveLiveStatementFigures(invoiceIds, scopedInvoices);
      return {
        ...statementData,
        // Return only the reader-facing attachment details. Storage keys,
        // invoice ids, and delivery recipients remain server-side.
        bundleAttachments: (bundleManifest?.attachments ?? []).map(
          (attachment, index) => ({
            index,
            doctorName: attachment.doctorName,
            label: attachment.label,
            fileName: attachment.fileName,
          }),
        ),
        paidAt: latestPaidAt,
        paymentMethod: latestPaymentMethod,
        // Live figures. `totalBilled` stays as issued: only settlement moves.
        totalPaid: live.totalPaid,
        balanceDue: live.balanceDue,
        currentTotalPaid: live.totalPaid,
        currentBalanceDue: live.balanceDue,
        // The generation-time snapshot, kept for the PDF and the immutable
        // issued record.
        snapshotTotalPaid: r.totalPaid,
        snapshotBalanceDue: r.balanceDue,
      };
    });
    // Keep enrichment based on the complete filtered set, then page the
    // deterministic newest-first result so totals and payment metadata do not
    // depend on the requested window.
    const ordered = withPayments.sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id.localeCompare(a.id),
    );
    return ok(
      res,
      pagination.active
        ? pageRowsKeyset(ordered, pagination, {
            sortValues: (row) => [sortTime(row.createdAt)],
            id: (row) => String(row.id),
            directions: ["desc"],
            idDirection: "desc",
          })
        : ordered,
    );
  }),
);

// NOTE: must be registered BEFORE GET /:invoiceId (see catch-all note above).
// Returns all payment records for a lab, joined to invoice + practice org so
// the Statements page can render a "Collected" drill-down panel without needing
// to load every invoice's payments individually.
router.get(
  "/payments-summary",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const labOrganizationId =
      typeof req.query.labOrganizationId === "string"
        ? req.query.labOrganizationId.trim()
        : null;
    if (!labOrganizationId) {
      throw new HttpError(400, "labOrganizationId is required.");
    }
    await requireAnyRole(callerId, labOrganizationId, BILLING_ROLES);
    const { orgIds } = await getInvoiceReadScope(callerId);

    const rows = await db
      .select({
        id: payments.id,
        amount: payments.amount,
        paidAt: payments.paidAt,
        practiceId: invoices.providerOrganizationId,
        practiceName: organizations.name,
        invoiceNumber: invoices.invoiceNumber,
        doctorIdentity: invoices.doctorIdentity,
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(
        organizations,
        eq(organizations.id, invoices.providerOrganizationId),
      )
      .where(
        and(
          eq(invoices.labOrganizationId, labOrganizationId),
          orgIds.length
            ? or(
                ...orgIds.flatMap((organizationId) => [
                  eq(invoices.labOrganizationId, organizationId),
                  eq(invoices.providerOrganizationId, organizationId),
                ]),
              )
            : sql`false`,
          isNull(invoices.deletedAt),
        ),
      )
      .orderBy(desc(payments.paidAt));

    return ok(res, rows);
  }),
);

router.get(
  "/:invoiceId",
  asyncHandler(async (req, res) => {
    let lookupId = req.params.invoiceId;
    if (lookupId.startsWith(MOBILE_INVOICE_ID_PREFIX)) {
      lookupId = await resolveMobileInvoiceId(
        (req as any).auth.userId,
        lookupId
      );
    }
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, lookupId),
    });
    if (!invoice) throw new HttpError(404, "Invoice not found.");

    const readScope = await getInvoiceReadScope((req as any).auth.userId);
    if (!invoiceIsInReadScope(invoice, readScope))
      throw new HttpError(403, "You do not have access to this invoice.");
    const labMember = hasDirectLabMembership(
      invoice.labOrganizationId,
      readScope,
    );

    const items = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.invoiceId, invoice.id),
      orderBy: [invoiceLineItems.sortOrder],
    });
    if (items.length === 0 && Number(invoice.total) !== 0) {
      req.log.warn(
        {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          total: invoice.total,
          labOrganizationId: invoice.labOrganizationId,
        },
        "invoice_items_empty_nonzero_total: invoice has no line items but a non-zero total; possible mobile-origin creation gap"
      );
    }
    const paymentRows = await db.query.payments.findMany({
      where: eq(payments.invoiceId, invoice.id),
      orderBy: [desc(payments.paidAt)],
    });
    const safePaymentRows = labMember
      ? paymentRows
      : paymentRows.map(({ recordedByUserId: _r, referenceNumber: _ref, ...rest }) => rest);
    const linkedTxns = await db
      .select({
        id: bankTransactions.id,
        bankAccountId: bankTransactions.bankAccountId,
        txnDate: bankTransactions.txnDate,
        debitAmount: bankTransactions.debitAmount,
        creditAmount: bankTransactions.creditAmount,
        source: bankTransactions.source,
        status: bankTransactions.status,
        memo: bankTransactions.memo,
        payee: bankTransactions.payee,
        accountName: bankAccounts.name,
      })
      .from(bankTransactionInvoices)
      .innerJoin(
        bankTransactions,
        eq(bankTransactions.id, bankTransactionInvoices.bankTransactionId)
      )
      .innerJoin(
        bankAccounts,
        eq(bankAccounts.id, bankTransactions.bankAccountId)
      )
      .where(eq(bankTransactionInvoices.invoiceId, invoice.id));
    let caseCompletedAt: string | null = null;
    let linkedCaseIsDeleted: boolean | null = null;
    let linkedCaseNumber: string | null = null;
    if (invoice.caseId) {
      const lc = await db.query.labCases.findFirst({
        where: eq(labCases.id, invoice.caseId),
      }).catch(() => null);
      if (lc) {
        try {
          const parsed =
            typeof lc.caseData === "string" ? JSON.parse(lc.caseData) : lc.caseData;
          const routeHistory: Array<{ station: string; timestamp: number }> =
            Array.isArray(parsed?.routeHistory) ? parsed.routeHistory : [];
          const completeEntries = routeHistory.filter((e) => e.station === "COMPLETE");
          if (completeEntries.length > 0) {
            const d = new Date(completeEntries[completeEntries.length - 1].timestamp);
            caseCompletedAt = Number.isNaN(d.getTime()) ? null : d.toISOString();
          }
        } catch {
          /* no-op */
        }
      }
      // Look up canonical case for frozen-invoice status metadata.
      const linkedCase = await db.query.cases.findFirst({
        where: eq(cases.id, invoice.caseId),
      }).catch(() => null);
      if (linkedCase) {
        linkedCaseIsDeleted = linkedCase.deletedAt !== null;
        linkedCaseNumber = linkedCase.caseNumber;
      }
    }
    const practiceOrg = invoice.providerOrganizationId
      ? await db.query.organizations.findFirst({
          where: eq(organizations.id, invoice.providerOrganizationId),
        }).catch(() => null)
      : null;

    // Invoice audit history — lab members only (billing data).
    const [paymentDeleteLogs, dateRepairLogs, doctorIdentityRepairLogs] = labMember
      ? await Promise.all([
          db
          .select({
            id: auditLogs.id,
            userId: auditLogs.userId,
            metadataJson: auditLogs.metadataJson,
            createdAt: auditLogs.createdAt,
            userInitials: users.initials,
          })
          .from(auditLogs)
          .leftJoin(users, eq(users.id, auditLogs.userId))
          .where(
            and(
              eq(auditLogs.entityType, "invoice"),
              eq(auditLogs.entityId, invoice.id),
              eq(auditLogs.action, "invoice_payments_deleted"),
            ),
          )
          .orderBy(desc(auditLogs.createdAt))
          .limit(50)
          .catch(() => []),
          db
            .select({
              id: auditLogs.id,
              userId: auditLogs.userId,
              beforeJson: auditLogs.beforeJson,
              afterJson: auditLogs.afterJson,
              createdAt: auditLogs.createdAt,
              actorUsername: users.username,
              actorFirstName: users.firstName,
              actorLastName: users.lastName,
              actorInitials: users.initials,
            })
            .from(auditLogs)
            .leftJoin(users, eq(users.id, auditLogs.userId))
            .where(
              and(
                eq(auditLogs.entityType, "invoice"),
                eq(auditLogs.entityId, invoice.id),
                eq(auditLogs.action, "invoice_dates_repaired"),
              ),
            )
            .orderBy(desc(auditLogs.createdAt))
            .limit(50)
            .catch(() => []),
          db
            .select({
              id: auditLogs.id,
              userId: auditLogs.userId,
              beforeJson: auditLogs.beforeJson,
              afterJson: auditLogs.afterJson,
              metadataJson: auditLogs.metadataJson,
              createdAt: auditLogs.createdAt,
              actorUsername: users.username,
              actorFirstName: users.firstName,
              actorLastName: users.lastName,
              actorInitials: users.initials,
            })
            .from(auditLogs)
            .leftJoin(users, eq(users.id, auditLogs.userId))
            .where(
              and(
                eq(auditLogs.entityType, "invoice"),
                eq(auditLogs.entityId, invoice.id),
                eq(auditLogs.action, "invoice_doctor_identity_repaired"),
              ),
            )
            .orderBy(desc(auditLogs.createdAt))
            .limit(50)
            .catch(() => []),
        ])
      : [[], [], []];

    const topLevelItems = items.filter((it) => it.parentLineItemId == null);
    const subItemsByParent = new Map<string, typeof items>();
    for (const it of items) {
      if (it.parentLineItemId) {
        const arr = subItemsByParent.get(it.parentLineItemId) ?? [];
        arr.push(it);
        subItemsByParent.set(it.parentLineItemId, arr);
      }
    }
    // Derive priced:false for any alloy-description line whose unitPrice is $0.
    // The DB has no `priced` column — this derives the signal at serialization
    // time so clients can surface "alloy pricing needed" affordances without a
    // separate fetch.  Condition: description starts with "Alloy" (covers both
    // "Alloy #<tooth>" child lines and the bare "Alloy" top-level line) AND
    // unitPrice == 0 (stored as a decimal string by Drizzle).
    const withPriced = <T extends { description: string; unitPrice: string | null }>(
      item: T,
    ): T | (T & { priced: false }) => {
      const isAlloy = item.description.startsWith("Alloy");
      const isZero = Number(item.unitPrice ?? 0) === 0;
      return isAlloy && isZero ? { ...item, priced: false as const } : item;
    };
    const nestedItems = topLevelItems.map((it) => ({
      ...withPriced(it),
      subItems: (subItemsByParent.get(it.id) ?? []).map(withPriced),
    }));

    // Check if this invoice appears in any practice statement — surfaced to the
    // client so the Paid→Open payment-guard dialog can show statement context.
    const statementRow = labMember && invoice.labOrganizationId
      ? await db.query.practiceStatements.findFirst({
          where: and(
            eq(practiceStatements.labOrganizationId, invoice.labOrganizationId),
            sql`${practiceStatements.invoiceIdsJson} @> ${JSON.stringify([invoice.id])}::jsonb`,
          ),
          columns: { id: true },
        }).catch(() => null)
      : null;

    return ok(res, {
      ...invoice,
      items: nestedItems,
      payments: safePaymentRows,
      linkedTransactions: labMember ? linkedTxns : [],
      paymentDeleteLogs,
      dateRepairLogs,
      doctorIdentityRepairLogs,
      caseCompletedAt,
      practiceEmail: practiceOrg?.billingEmail ?? null,
      practicePhone: practiceOrg?.phone ?? null,
      linkedCaseIsDeleted,
      linkedCaseNumber,
      inStatement: statementRow != null,
      statementId: statementRow?.id ?? null,
    });
  })
);

router.patch(
  "/:invoiceId/repair-doctor",
  asyncHandler(async (req, res) => {
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, req.params.invoiceId),
    });
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    await requireAnyRole(
      (req as any).auth.userId,
      invoice.labOrganizationId,
      ADMIN_ROLES,
    );

    const { doctorProfileId } = z
      .object({ doctorProfileId: z.string().min(1) })
      .strict()
      .parse(req.body);

    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.id}))`);
      const lockedInvoice = await tx.query.invoices.findFirst({
        where: eq(invoices.id, invoice.id),
      });
      if (!lockedInvoice) throw new HttpError(404, "Invoice not found.");
      if (lockedInvoice.doctorIdentity !== null) {
        throw new HttpError(
          409,
          "This invoice already has a doctor profile and cannot be repaired.",
        );
      }
      if (!lockedInvoice.providerOrganizationId) {
        throw new HttpError(
          400,
          "This legacy invoice has no practice and cannot be assigned to a doctor profile.",
        );
      }

      const profile = await tx.query.doctorProfiles.findFirst({
        where: and(
          eq(doctorProfiles.id, doctorProfileId),
          eq(doctorProfiles.labOrganizationId, lockedInvoice.labOrganizationId),
          eq(
            doctorProfiles.providerOrganizationId,
            lockedInvoice.providerOrganizationId,
          ),
        ),
      });
      if (!profile) {
        throw new HttpError(
          400,
          "Choose a doctor profile from this invoice's lab and practice.",
        );
      }

      const [row] = await tx
        .update(invoices)
        .set({
          doctorIdentity: profile.id,
          updatedAt: new Date(),
          updatedByUserId: (req as any).auth.userId,
        })
        .where(eq(invoices.id, lockedInvoice.id))
        .returning();

      await writeAuditLogTx(tx, {
        req,
        organizationId: lockedInvoice.labOrganizationId,
        action: "invoice_doctor_identity_repaired",
        entityType: "invoice",
        entityId: lockedInvoice.id,
        beforeJson: {
          doctorIdentity: null,
          doctorDisplayName:
            lockedInvoice.displayMetadataJson &&
            typeof lockedInvoice.displayMetadataJson === "object" &&
            typeof (lockedInvoice.displayMetadataJson as Record<string, unknown>).billTo === "string"
              ? (lockedInvoice.displayMetadataJson as Record<string, string>).billTo
              : lockedInvoice.displayMetadataJson &&
                  typeof lockedInvoice.displayMetadataJson === "object" &&
                  typeof (lockedInvoice.displayMetadataJson as Record<string, unknown>).doctorName === "string"
                ? (lockedInvoice.displayMetadataJson as Record<string, string>).doctorName
                : null,
        },
        afterJson: {
          doctorIdentity: profile.id,
          doctorDisplayName: profile.displayName || profile.doctorName,
        },
        metadataJson: {
          invoiceNumber: row.invoiceNumber,
          doctorProfileId: profile.id,
          reason: "explicit_admin_legacy_invoice_repair",
        },
      });
      return row;
    });

    return ok(res, updated);
  }),
);

router.patch(
  "/:invoiceId/repair-dates",
  asyncHandler(async (req, res) => {
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, req.params.invoiceId),
    });
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    await requireAnyRole(
      (req as any).auth.userId,
      invoice.labOrganizationId,
      ADMIN_ROLES,
    );
    if ((invoice as any).frozen) {
      throw new HttpError(409, "Invoice is frozen — the linked case was deleted.");
    }

    const input = z
      .object({
        issuedAt: z.string().datetime().nullable(),
        dueAt: z.string().datetime().nullable(),
      })
      .strict()
      .parse(req.body);

    const toCanonicalDate = (value: string | null, field: string) => {
      if (value === null) return null;
      if (!/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value)) {
        throw new HttpError(400, `${field} must be a date at UTC midnight.`);
      }
      return new Date(value);
    };
    const repairedIssuedAt = toCanonicalDate(input.issuedAt, "issuedAt");
    const repairedDueAt = toCanonicalDate(input.dueAt, "dueAt");

    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.id}))`);
      const lockedInvoice = await tx.query.invoices.findFirst({
        where: eq(invoices.id, invoice.id),
      });
      if (!lockedInvoice) throw new HttpError(404, "Invoice not found.");
      if (lockedInvoice.frozen) {
        throw new HttpError(409, "Invoice is frozen — the linked case was deleted.");
      }

      const issuedEligible = isLikelyLegacyShiftedInvoiceDate(
        lockedInvoice.issuedAt,
        lockedInvoice.createdAt,
      );
      const dueEligible = isLikelyLegacyShiftedInvoiceDate(
        lockedInvoice.dueAt,
        lockedInvoice.createdAt,
      );
      if (!issuedEligible && !dueEligible) {
        throw new HttpError(400, "This invoice does not have a likely legacy date shift.");
      }
      if (
        (issuedEligible && repairedIssuedAt === null) ||
        (dueEligible && repairedDueAt === null)
      ) {
        throw new HttpError(400, "Likely shifted dates require a corrected date.");
      }
      const issuedChanged =
        lockedInvoice.issuedAt?.toISOString() !== repairedIssuedAt?.toISOString();
      const dueChanged =
        lockedInvoice.dueAt?.toISOString() !== repairedDueAt?.toISOString();
      if ((issuedChanged && !issuedEligible) || (dueChanged && !dueEligible)) {
        throw new HttpError(400, "Only dates identified as likely shifted can be repaired.");
      }
      if (!issuedChanged && !dueChanged) {
        throw new HttpError(400, "Choose at least one corrected date.");
      }

      const [row] = await tx
        .update(invoices)
        .set({
          issuedAt: repairedIssuedAt,
          dueAt: repairedDueAt,
          updatedAt: new Date(),
          updatedByUserId: (req as any).auth.userId,
        })
        .where(eq(invoices.id, invoice.id))
        .returning();

      await writeAuditLogTx(tx, {
        req,
        organizationId: invoice.labOrganizationId,
        action: "invoice_dates_repaired",
        entityType: "invoice",
        entityId: invoice.id,
        beforeJson: {
          issuedAt: lockedInvoice.issuedAt,
          dueAt: lockedInvoice.dueAt,
        },
        afterJson: {
          issuedAt: row.issuedAt,
          dueAt: row.dueAt,
        },
        metadataJson: {
          invoiceNumber: row.invoiceNumber,
          reason: "historical_timezone_drift",
        },
      });
      return row;
    });

    return ok(res, updated);
  }),
);

router.patch(
  "/:invoiceId",
  asyncHandler(async (req, res) => {
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, req.params.invoiceId),
    });
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    await requireAnyRole(
      (req as any).auth.userId,
      invoice.labOrganizationId,
      BILLING_ROLES
    );

    if ((invoice as any).frozen) {
      throw new HttpError(409, "Invoice is frozen — the linked case was deleted.");
    }

    const input = z
      .object({
        status: z
          .enum(["open", "partially_paid", "paid", "void"])
          .optional(),
        tax: z.coerce.number().min(0).optional(),
        discount: z.coerce.number().min(0).optional(),
        dueAt: z.string().datetime().nullable().optional(),
        issuedAt: z.string().datetime().nullable().optional(),
        invoiceNumber: z.string().min(1).optional(),
        notes: z.string().nullable().optional(),
        providerOrganizationId: z.string().min(1).optional(),
        items: z
          .array(
            z.object({
              id: z.string().optional(),
              toothNumber: z.coerce.number().int().nullable().optional()
                .transform((v) => (v != null && v >= 1 && v <= 32 ? v : null)),
              toothLabel: z.string().nullable().optional(),
              description: z.string().min(1),
              quantity: z.coerce.number().min(0),
              unitPrice: z.number().finite(),
              isDiscount: z.boolean().optional(),
              sortOrder: z.coerce.number().int().optional(),
              subItems: z
                .array(
                  z.object({
                    id: z.string().optional(),
                    toothNumber: z.coerce.number().int().nullable().optional()
                      .transform((v) => (v != null && v >= 1 && v <= 32 ? v : null)),
                    toothLabel: z.string().nullable().optional(),
                    description: z.string().min(1),
                    quantity: z.coerce.number().min(0),
                    unitPrice: z.number().finite(),
                    isDiscount: z.boolean().optional(),
                    sortOrder: z.coerce.number().int().optional(),
                  })
                )
                .optional(),
            })
          )
          .optional(),
        displayMetadata: z.record(z.any()).nullable().optional(),
        layoutPresetId: z.string().nullable().optional(),
        depositBankAccountId: z.string().min(1).optional(),
      })
      .parse(req.body);

    if (input.providerOrganizationId !== undefined) {
      await requireAnyRole(
        (req as any).auth.userId,
        invoice.labOrganizationId,
        BILLING_ROLES
      );
      const newPractice = await db.query.organizations.findFirst({
        where: eq(organizations.id, input.providerOrganizationId),
      });
      if (!newPractice || newPractice.deletedAt) {
        throw new HttpError(404, "Practice not found.");
      }
      if (newPractice.isActive === false) {
        throw new HttpError(400, "Cannot reassign invoice to an inactive practice.");
      }
      if (newPractice.type !== "provider" && newPractice.type !== "practice") {
        throw new HttpError(400, "Target organization is not a practice or provider.");
      }
      const practiceLabId =
        newPractice.parentLabOrganizationId ?? newPractice.id;
      if (practiceLabId !== invoice.labOrganizationId && newPractice.id !== invoice.labOrganizationId) {
        throw new HttpError(400, "Practice does not belong to the same lab.");
      }
    }

    const updated = await db.transaction(async (tx) => {
      if (invoice.providerOrganizationId) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.labOrganizationId}), hashtext(${invoice.providerOrganizationId}))`,
        );
      }
      await assertNoActiveCardReversalForInvoices(tx, [invoice.id]);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.id}))`);
      const lockedInvoice = await tx.query.invoices.findFirst({
        where: eq(invoices.id, invoice.id),
      });
      if (!lockedInvoice) throw new HttpError(404, "Invoice not found.");
      if (isInvoiceDraftStatus(lockedInvoice.status)) {
        throw new HttpError(409, "Draft invoices are read-only. Use their original issuance or review workflow.");
      }
      const issuedChanged =
        input.issuedAt !== undefined &&
        lockedInvoice.issuedAt?.toISOString() !== input.issuedAt;
      const dueChanged =
        input.dueAt !== undefined &&
        lockedInvoice.dueAt?.toISOString() !== input.dueAt;
      if (
        (issuedChanged &&
          isLikelyLegacyShiftedInvoiceDate(
            lockedInvoice.issuedAt,
            lockedInvoice.createdAt,
          )) ||
        (dueChanged &&
          isLikelyLegacyShiftedInvoiceDate(
            lockedInvoice.dueAt,
            lockedInvoice.createdAt,
          ))
      ) {
        throw new HttpError(
          409,
          "Review and confirm likely shifted dates with the invoice date repair action.",
        );
      }
      if (input.items) {
        const existingItems = await tx.query.invoiceLineItems.findMany({
          where: eq(invoiceLineItems.invoiceId, invoice.id),
        });
        const existingById = new Map(existingItems.map((item) => [item.id, item]));
        const retainedIds = new Set<string>();

        const saveItem = async (
          item: (typeof input.items)[number] | NonNullable<(typeof input.items)[number]["subItems"]>[number],
          sortOrder: number,
          parentLineItemId: string | null,
        ) => {
          const existing = item.id ? existingById.get(item.id) : null;
          if (item.id && !existing) {
            throw new HttpError(400, "Invoice line item is stale. Refresh and try again.");
          }
          const isDiscount = item.isDiscount ?? existing?.isDiscount ?? false;
          const rawUnitPrice = Number(item.unitPrice);
          if (!Number.isFinite(rawUnitPrice)) {
            throw new HttpError(400, "Invoice line prices must be valid numbers.");
          }
          if (isDiscount && rawUnitPrice >= 0) {
            throw new HttpError(
              400,
              "Discount line amounts must be sent as negative values.",
            );
          }
          if (!isDiscount && rawUnitPrice < 0) {
            throw new HttpError(
              400,
              "Charge line amounts cannot be negative. Mark the line as a discount to subtract it.",
            );
          }
          if (
            isDiscount &&
            (parentLineItemId !== null ||
              existing?.caseRestorationId != null ||
              existing?.sourceType === "restoration")
          ) {
            throw new HttpError(
              400,
              "Discounts must be separate manual invoice lines, not restoration lines or sub-items.",
            );
          }
          const quantity = Math.max(0, Math.round(Number(item.quantity)));
          const unitPrice = rawUnitPrice.toFixed(2);
          const values = {
            toothNumber: item.toothNumber ?? null,
            toothLabel: item.toothLabel ?? null,
            description: item.description,
            quantity,
            unitPrice,
            lineTotal: calculateLineTotal(quantity, unitPrice),
            isDiscount,
            sortOrder,
            parentLineItemId,
            updatedAt: new Date(),
          };
          if (existing && existing.invoiceId === invoice.id) {
            retainedIds.add(existing.id);
            await tx.update(invoiceLineItems).set(values).where(eq(invoiceLineItems.id, existing.id));
            if (
              existing.caseRestorationId &&
              existing.unitPrice !== unitPrice
            ) {
              const sourceIds = Array.isArray(existing.sourceRestorationIdsJson)
                ? existing.sourceRestorationIdsJson.filter((id): id is string => typeof id === "string")
                : [existing.caseRestorationId];
              await tx.update(caseRestorations).set({
                unitPrice,
                priceSource: "manual",
                priceSourceId: null,
                priceSourceName: null,
                updatedAt: new Date(),
              }).where(inArray(caseRestorations.id, sourceIds));
            }
            return existing.id;
          }
          const [created] = await tx.insert(invoiceLineItems).values({
            invoiceId: invoice.id,
            sourceType: "manual",
            ...values,
          }).returning();
          retainedIds.add(created.id);
          return created.id;
        };

        for (const [idx, item] of input.items.entries()) {
          const parentId = await saveItem(item, item.sortOrder ?? idx, null);
          for (const [subIdx, sub] of (item.subItems ?? []).entries()) {
            await saveItem(sub, sub.sortOrder ?? subIdx, parentId);
          }
        }
        const removedIds = existingItems
          .filter((item) => !retainedIds.has(item.id))
          .map((item) => item.id);
        if (removedIds.length > 0) {
          const removed = existingItems.filter((item) => removedIds.includes(item.id));
          const sourceIds = Array.from(new Set(removed.flatMap((item) =>
            Array.isArray(item.sourceRestorationIdsJson)
              ? item.sourceRestorationIdsJson.filter((id): id is string => typeof id === "string")
              : item.caseRestorationId ? [item.caseRestorationId] : [],
          )));
          if (sourceIds.length > 0) {
            await tx.delete(caseRestorations).where(inArray(caseRestorations.id, sourceIds));
          }
          const suppressedGeneratedLineKeys = Array.from(new Set([
            ...(
              Array.isArray(
                ((input.displayMetadata ?? lockedInvoice.displayMetadataJson ?? {}) as Record<string, unknown>)
                  .suppressedGeneratedLineKeys,
              )
                ? (((input.displayMetadata ?? lockedInvoice.displayMetadataJson ?? {}) as Record<string, unknown>)
                    .suppressedGeneratedLineKeys as string[])
                : []
            ),
            ...removed
              .filter((item) => item.sourceType === "restoration" && item.sourceKey && (
                !Array.isArray(item.sourceRestorationIdsJson) ||
                item.sourceRestorationIdsJson.length === 0
              ))
              .map((item) => item.sourceKey as string),
          ]));
          if (suppressedGeneratedLineKeys.length > 0) {
            input.displayMetadata = {
              ...((input.displayMetadata ?? lockedInvoice.displayMetadataJson ?? {}) as Record<string, unknown>),
              suppressedGeneratedLineKeys,
            };
          }
          await tx.delete(invoiceLineItems).where(inArray(invoiceLineItems.id, removedIds));
        }
      }

      const items = await tx.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.invoiceId, invoice.id),
      });
      const subtotal = sumMoney(items.map((item) => item.lineTotal));
      const tax =
        input.tax !== undefined ? input.tax.toFixed(2) : lockedInvoice.tax;
      const discount =
        input.discount !== undefined
          ? input.discount.toFixed(2)
          : lockedInvoice.discount;
      // Credits live in displayMetadata.credits (a JSON-blob column).
      // They behave like an additional discount applied to the invoice
      // — the desktop editor shows them on their own row and subtracts
      // them from the visible total, so we must do the same on the
      // server or the persisted total will drift from what the user
      // saw when they hit Save.
      const incomingMeta = (input.displayMetadata ??
        lockedInvoice.displayMetadataJson ??
        {}) as Record<string, unknown>;
      const credits = Math.max(0, Number(incomingMeta.credits ?? 0) || 0);
      const total = (
        Number(subtotal) +
        Number(tax) -
        Number(discount) -
        credits
      ).toFixed(2);

      const paidSum = await tx
        .select({ value: sum(payments.amount) })
        .from(payments)
        .where(eq(payments.invoiceId, invoice.id));
      const paid = Number(paidSum[0]?.value ?? 0);
      const hasDiscountLines = items.some((item) => item.isDiscount);
      if (hasDiscountLines && Number(total) < -0.004) {
        throw new HttpError(
          409,
          "Discount lines cannot reduce the invoice total below $0.00.",
        );
      }
      if (
        hasDiscountLines &&
        Number(total) + 0.004 < paid
      ) {
        throw new HttpError(
          409,
          `Discount lines cannot reduce the total below the $${paid.toFixed(2)} already paid. Issue a refund or apply a credit instead.`,
        );
      }
      const newStatus = input.status ?? lockedInvoice.status;
      // A voided invoice must never carry an outstanding balance — zero it out
      // regardless of what the (total - paid) arithmetic produces.
      const balanceDue = newStatus === "void" ? "0.00" : (Number(total) - paid).toFixed(2);
      // Voiding has to be dated, or the reports cannot tell a reversal made
      // this month from one made last year: an undated void looks like the
      // invoice was never revenue at all. Restoring an invoice out of void
      // clears the date for the same reason.
      const becomingVoid =
        newStatus === "void" && lockedInvoice.status !== "void";
      const leavingVoid =
        newStatus !== "void" && lockedInvoice.status === "void";
      const voidFields = becomingVoid
        ? {
            voidedAt: new Date(),
            voidedByUserId: (req as any).auth.userId,
            voidReason: lockedInvoice.voidReason ?? "Status changed to void",
            voidKind: lockedInvoice.voidKind ?? "void",
          }
        : leavingVoid
          ? {
              voidedAt: null,
              voidedByUserId: null,
              voidReason: null,
              voidKind: null,
            }
          : {};

      const [row] = await tx
        .update(invoices)
        .set({
          status: newStatus,
          ...voidFields,
          tax,
          discount,
          subtotal,
          total,
          balanceDue,
          dueAt:
            input.dueAt === null
              ? null
              : input.dueAt
                ? new Date(input.dueAt)
                : invoice.dueAt,
          issuedAt:
            input.issuedAt === null
              ? null
              : input.issuedAt
                ? new Date(input.issuedAt)
                : invoice.issuedAt,
          invoiceNumber: input.invoiceNumber ?? invoice.invoiceNumber,
          notes:
            input.notes === undefined ? invoice.notes : input.notes,
          providerOrganizationId:
            input.providerOrganizationId ?? invoice.providerOrganizationId,
          displayMetadataJson:
            (lockedInvoice.displayMetadataJson as Record<string, unknown> | null)?.legacyChargesNeedsReview === true
              ? {
                  ...(input.displayMetadata ?? lockedInvoice.displayMetadataJson as Record<string, unknown>),
                  reviewedCharges: true,
                  reviewedChargesNeedsReview: !Array.isArray(input.items),
                  legacyChargesNeedsReview: !Array.isArray(input.items),
                }
              : input.displayMetadata === undefined
              ? invoice.displayMetadataJson
              : input.displayMetadata,
          layoutPresetId:
            input.layoutPresetId === undefined
              ? invoice.layoutPresetId
              : input.layoutPresetId,
          updatedByUserId: (req as any).auth.userId,
        })
        .where(eq(invoices.id, invoice.id))
        .returning();
      return row;
    });

    await writeAuditLog({
      req,
      organizationId: invoice.labOrganizationId,
      action: "invoice_updated",
      entityType: "invoice",
      entityId: invoice.id,
      beforeJson: invoice,
      afterJson: updated,
    });

    if (
      input.providerOrganizationId !== undefined &&
      input.providerOrganizationId !== invoice.providerOrganizationId
    ) {
      await writeAuditLog({
        req,
        organizationId: invoice.labOrganizationId,
        action: "invoice_reassigned",
        entityType: "invoice",
        entityId: invoice.id,
        metadataJson: {
          invoiceNumber: updated.invoiceNumber,
          fromProviderOrganizationId: invoice.providerOrganizationId,
          toProviderOrganizationId: input.providerOrganizationId,
        },
      });
    }

    // Mirror invoice lifecycle changes onto the case History tab so users
    // see edits and voids without digging into the audit log.
    if (invoice.caseId) {
      const userForEvent = (req as any).user;
      const statusChanged = invoice.status !== updated.status;
      const becameVoid =
        statusChanged && updated.status === "void";
      await db.insert(caseEvents).values({
        caseId: invoice.caseId,
        eventType: becameVoid ? "invoice_voided" : "invoice_updated",
        actorUserId: (req as any).auth.userId,
        actorOrganizationId: invoice.labOrganizationId,
        actorInitials: userForEvent?.initials || "SYS",
        metadataJson: {
          invoiceId: invoice.id,
          invoiceNumber: updated.invoiceNumber,
          previousStatus: invoice.status,
          newStatus: updated.status,
          itemsReplaced: input.items !== undefined,
          previousTotal: invoice.total,
          newTotal: updated.total,
        },
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to record invoice update timeline event.",
      }));
    }

    if (updated.status === "paid" && invoice.status !== "paid") {
      await ensureInvoiceDeposit(
        {
          id: updated.id,
          invoiceNumber: updated.invoiceNumber,
          total: String(updated.total),
          labOrganizationId: updated.labOrganizationId,
        },
        (req as any).auth.userId,
        input.depositBankAccountId
      );
    } else if (invoice.status === "paid" && updated.status !== "paid") {
      await reverseInvoiceDepositIfAny(
        invoice.id,
        invoice.labOrganizationId,
        (req as any).auth.userId,
      );
    }

    return ok(res, updated);
  })
);

router.post(
  "/:invoiceId/payments",
  asyncHandler(async (req, res) => {
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, req.params.invoiceId),
    });
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    await requireInvoicePaymentAccess((req as any).auth.userId, invoice);

    const input = z
      .object({
        amount: z.coerce.number().positive(),
        paymentMethod: z.enum(["card", "ach", "check", "cash", "other"]),
        referenceNumber: z.string().optional(),
        depositBankAccountId: z.string().min(1).optional(),
      })
      .parse(req.body);

    const { payment, updatedInvoice } = await db.transaction(async (tx) => {
      if (invoice.providerOrganizationId) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.labOrganizationId}), hashtext(${invoice.providerOrganizationId}))`,
        );
      }
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.id}))`);
      const [lockedInvoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoice.id))
        .for("update");
      if (!lockedInvoice) throw new HttpError(404, "Invoice not found.");
      const [payment] = await tx
        .insert(payments)
        .values({
          invoiceId: lockedInvoice.id,
          amount: input.amount.toFixed(2),
          paymentMethod: input.paymentMethod,
          referenceNumber: input.referenceNumber ?? null,
          recordedByUserId: (req as any).auth.userId,
        })
        .returning();
      const paidRows = await tx
        .select({ value: sum(payments.amount) })
        .from(payments)
        .where(eq(payments.invoiceId, lockedInvoice.id));
      const paid = Number(paidRows[0]?.value ?? 0);
      const balanceDue = Math.max(
        Number(lockedInvoice.total) - paid,
        0
      ).toFixed(2);
      const status =
        balanceDue === "0.00"
          ? "paid"
          : paid > 0
            ? "partially_paid"
            : lockedInvoice.status;
      const [updatedInvoice] = await tx
        .update(invoices)
        .set({
          balanceDue,
          status,
          updatedByUserId: (req as any).auth.userId,
        })
        .where(eq(invoices.id, lockedInvoice.id))
        .returning();
      return { payment, updatedInvoice };
    });

    if (invoice.caseId) {
      const user = (req as any).user;
      await db.insert(caseEvents).values({
        caseId: invoice.caseId,
        eventType: "payment_received",
        actorUserId: (req as any).auth.userId,
        actorOrganizationId: invoice.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          invoiceId: invoice.id,
          paymentId: payment.id,
          amount: payment.amount,
        },
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to record payment_received timeline event.",
      }));
    }

    if (
      updatedInvoice.status === "paid" &&
      invoice.status !== "paid"
    ) {
      await ensureInvoiceDeposit(
        {
          id: updatedInvoice.id,
          invoiceNumber: updatedInvoice.invoiceNumber,
          total: String(updatedInvoice.total),
          labOrganizationId: updatedInvoice.labOrganizationId,
        },
        (req as any).auth.userId,
        input.depositBankAccountId
      );
    }

    if (invoice.providerOrganizationId) {
      await deliverPaymentNotifications({
        origin: "lab",
        sourceType: "invoice_payment",
        sourceId: payment.id,
        labOrganizationId: invoice.labOrganizationId,
        providerOrganizationId: invoice.providerOrganizationId,
        amount: payment.amount,
        invoiceIds: [invoice.id],
        paymentMethod: payment.paymentMethod,
      });
    }

    return ok(res, { payment, invoice: updatedInvoice }, 201);
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Delete all payments on an invoice (Paid → Open guard).
// Removes every payments row for the invoice, recalculates balance/status back
// to open, and reverses any auto-deposit so the books stay balanced. Used by
// the desktop "Delete payment & mark Open" confirmation dialog.
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  "/:invoiceId/payments",
  asyncHandler(async (req, res) => {
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, req.params.invoiceId),
    });
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    await requireInvoicePaymentAccess((req as any).auth.userId, invoice);

    if ((invoice as any).frozen) {
      throw new HttpError(409, "Invoice is frozen — the linked case was deleted.");
    }
    // Run the full deletion + deposit reversal in one transaction so a
    // partial failure cannot leave payments deleted but deposits still active.
    const { deletedPayments, updatedInvoice, reversedCount } = await db.transaction(async (tx) => {
      if (invoice.providerOrganizationId) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.labOrganizationId}), hashtext(${invoice.providerOrganizationId}))`,
        );
      }
      await assertNoActiveCardReversalForInvoices(tx, [invoice.id]);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.id}))`);
      const [lockedInvoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoice.id))
        .for("update");
      if (!lockedInvoice) throw new HttpError(404, "Invoice not found.");
      const lockedPayments = await tx
        .select()
        .from(payments)
        .where(eq(payments.invoiceId, invoice.id))
        .for("update");
      const linkedTxnIds = lockedPayments
        .map((payment) => payment.bankTransactionId)
        .filter(Boolean) as string[];
      await releaseBatchesForChildren(tx, invoice.labOrganizationId, linkedTxnIds);
      if (lockedPayments.some((payment) => payment.paymentSessionId)) {
        throw new HttpError(
          409,
          "This invoice includes a statement payment. Cancel that payment session instead.",
        );
      }
      const deleted = await tx
        .delete(payments)
        .where(eq(payments.invoiceId, invoice.id))
        .returning();
      // Each of these settled the invoice from its payment date until now,
      // and dated reports still have to see that window.
      await archiveReversedSettlements(
        tx,
        deleted.map((payment) => ({
          labOrganizationId: invoice.labOrganizationId,
          invoiceId: invoice.id,
          sourceType: "payment" as const,
          sourceId: payment.id,
          paymentSessionId: payment.paymentSessionId ?? null,
          amount: payment.amount,
          settledAt: payment.paidAt ?? new Date(),
          reversedByUserId: (req as any).auth.userId,
        })),
      );

      // With no payments, balance equals the invoice total and status reverts.
      const balanceDue = Number(lockedInvoice.total ?? 0).toFixed(2);
      const [updated] = await tx
        .update(invoices)
        .set({
          balanceDue,
          status: "open",
          updatedByUserId: (req as any).auth.userId,
        })
        .where(eq(invoices.id, invoice.id))
        .returning();

      // Resolve all non-void invoice-source deposits linked to this invoice.
      // An invoice can have multiple deposits (repeated receive-payments while
      // partially_paid) and each deposit may itself be linked to multiple
      // invoices when a batch payment was recorded.
      const links = await tx
        .select({
          bankTransactionId: bankTransactionInvoices.bankTransactionId,
          txnSource: bankTransactions.source,
          txnStatus: bankTransactions.status,
          txnCreditAmount: bankTransactions.creditAmount,
          txnNetAmount: bankTransactions.netAmount,
        })
        .from(bankTransactionInvoices)
        .innerJoin(
          bankTransactions,
          eq(bankTransactions.id, bankTransactionInvoices.bankTransactionId),
        )
        .where(eq(bankTransactionInvoices.invoiceId, invoice.id));

      const autoDeposits = links.filter(
        (l: any) => l.txnSource === "invoice" && l.txnStatus !== "void",
      );

      let reversedCnt = 0;
      for (const dep of autoDeposits) {
        // Fetch the current link rows for this deposit (I's link is still
        // present at this point; it is removed at the end of the loop body).
        const shareRows = await tx
          .select({ invoiceId: bankTransactionInvoices.invoiceId })
          .from(bankTransactionInvoices)
          .where(eq(bankTransactionInvoices.bankTransactionId, dep.bankTransactionId));

        const otherInvoiceIds = shareRows
          .map((r: any) => r.invoiceId)
          .filter((id: string) => id !== invoice.id);

        if (otherInvoiceIds.length === 0) {
          // Exclusively linked to this invoice — safe to void the whole deposit.
          await tx
            .update(bankTransactions)
            .set({ status: "void" })
            .where(eq(bankTransactions.id, dep.bankTransactionId));
          reversedCnt++;
        } else {
          // Shared with other invoices.  Compute this invoice's attribution for
          // deposit D as the residual after accounting for the other invoices'
          // contributions.  Because I's payments are already deleted at this
          // point in the transaction, summing the current payments for the other
          // invoices gives an accurate picture of their share.
          //
          //   I's share of D = D.creditAmount − Σ(current payments for others in D)
          //
          // This is exact when each other invoice has payments from only the
          // batch that created D.  When an invoice has payments from multiple
          // batches the attribution is conservative (I's share is understated),
          // which is always safer than over-reducing and potentially zeroing
          // funds belonging to uninvolved invoices.
          const otherPaymentRows = await tx
            .select({ amount: payments.amount })
            .from(payments)
            .where(inArray(payments.invoiceId, otherInvoiceIds));

          const otherTotal = otherPaymentRows.reduce(
            (s: number, r: any) => s + Number(r.amount),
            0,
          );

          const thisInvoiceShareOfDep = Math.max(
            0,
            Number(dep.txnCreditAmount) - otherTotal,
          );

          const newCredit = Math.max(
            0,
            Number(dep.txnCreditAmount) - thisInvoiceShareOfDep,
          );
          const newNet = Math.max(
            0,
            Number(dep.txnNetAmount) - thisInvoiceShareOfDep,
          );
          await tx
            .update(bankTransactions)
            .set({
              creditAmount: newCredit.toFixed(2),
              netAmount: newNet.toFixed(2),
            })
            .where(eq(bankTransactions.id, dep.bankTransactionId));
        }

        // Always remove the link row for this invoice.
        await tx
          .delete(bankTransactionInvoices)
          .where(
            and(
              eq(bankTransactionInvoices.bankTransactionId, dep.bankTransactionId),
              eq(bankTransactionInvoices.invoiceId, invoice.id),
            ),
          );
      }

      return { deletedPayments: deleted, updatedInvoice: updated, reversedCount: reversedCnt };
    });

    await writeAuditLog({
      req,
      organizationId: invoice.labOrganizationId,
      action: "invoice_payments_deleted",
      entityType: "invoice",
      entityId: invoice.id,
      metadataJson: {
        invoiceNumber: invoice.invoiceNumber,
        deletedCount: deletedPayments.length,
        reversedDepositCount: reversedCount,
        previousStatus: invoice.status,
      },
    });

    // Write a case timeline event so the deletion is visible on the linked case.
    if (invoice.caseId) {
      const actorUser = (req as any).user;
      const actorInitials = actorUser?.initials || "SYS";
      await db
        .insert(caseEvents)
        .values({
          caseId: invoice.caseId,
          eventType: "invoice_payments_deleted",
          actorUserId: (req as any).auth.userId,
          actorOrganizationId: invoice.labOrganizationId,
          actorInitials,
          metadataJson: {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            deletedCount: deletedPayments.length,
            previousStatus: invoice.status,
          },
        })
        .catch((err: unknown) => {
          req.log?.warn?.(
            { err, invoiceId: invoice.id },
            "case_event insert failed for invoice_payments_deleted",
          );
        });
    }

    return ok(res, { deletedCount: deletedPayments.length, invoice: updatedInvoice });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Invoice attachments (separate from case-media; per-invoice files that can
// optionally be appended to the rendered invoice PDF).
// ─────────────────────────────────────────────────────────────────────────────

const invoiceAttachmentsDir = path.resolve(
  process.cwd(),
  "uploads",
  "invoice-attachments",
);

// Use in-memory storage so the access check below runs BEFORE we touch the
// disk; an unauthenticated/unauthorised caller cannot create orphan files
// in the upload directory.
const invoiceAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

async function loadInvoiceWithAccess(
  callerId: string,
  invoiceId: string,
  requireBilling = false,
) {
  const invoice = await db.query.invoices.findFirst({
    where: eq(invoices.id, invoiceId),
  });
  if (!invoice) throw new HttpError(404, "Invoice not found.");
  if (requireBilling) {
    await requireAnyRole(callerId, invoice.labOrganizationId, BILLING_ROLES);
    return invoice;
  }
  const readScope = await getInvoiceReadScope(callerId);
  if (!invoiceIsInReadScope(invoice, readScope)) {
    throw new HttpError(403, "You do not have access to this invoice.");
  }
  return invoice;
}

router.get(
  "/:invoiceId/attachments",
  asyncHandler(async (req, res) => {
    await loadInvoiceWithAccess(
      (req as any).auth.userId,
      req.params.invoiceId,
    );
    const rows = await db.query.invoiceAttachments.findMany({
      where: and(
        eq(invoiceAttachments.invoiceId, req.params.invoiceId),
        isNull(invoiceAttachments.deletedAt),
      ),
      orderBy: [desc(invoiceAttachments.createdAt)],
    });
    return ok(res, rows);
  }),
);

router.post(
  "/:invoiceId/attachments",
  invoiceAttachmentUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "No file uploaded.");
    const callerId = (req as any).auth.userId as string;
    // Authorize BEFORE writing the in-memory upload to disk so an
    // unauthorized caller can't create orphan files.
    const invoice = await loadInvoiceWithAccess(
      callerId,
      req.params.invoiceId,
      true,
    );
    const includeInPdf = req.body?.includeInPdf === "true";
    const ext = (path.extname(req.file.originalname || "") || "").toLowerCase();
    const safeBase =
      path
        .basename(req.file.originalname || "file", ext)
        .replace(/[^a-zA-Z0-9\-_]+/g, "-")
        .slice(0, 60) || "file";
    const filename = `${Date.now()}-${randomBytes(4).toString("hex")}-${safeBase}${ext}`;
    try {
      fs.mkdirSync(invoiceAttachmentsDir, { recursive: true });
    } catch {
      /* ignore */
    }
    const diskPath = path.join(invoiceAttachmentsDir, filename);
    fs.writeFileSync(diskPath, req.file.buffer);
    const storageKey = `/uploads/invoice-attachments/${filename}`;
    const [row] = await db
      .insert(invoiceAttachments)
      .values({
        invoiceId: invoice.id,
        fileName: req.file.originalname || filename,
        storageKey,
        fileType: req.file.mimetype || "application/octet-stream",
        fileSize: req.file.size || 0,
        includeInPdf,
        uploadedByUserId: callerId,
      })
      .returning();
    await writeAuditLog({
      req,
      organizationId: invoice.labOrganizationId,
      action: "invoice_attachment_added",
      entityType: "invoice",
      entityId: invoice.id,
      afterJson: { attachmentId: row.id, fileName: row.fileName },
    });
    return ok(res, row, 201);
  }),
);

router.patch(
  "/:invoiceId/attachments/:attachmentId",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const invoice = await loadInvoiceWithAccess(
      callerId,
      req.params.invoiceId,
      true,
    );
    const input = z
      .object({ includeInPdf: z.boolean().optional() })
      .parse(req.body);
    const [row] = await db
      .update(invoiceAttachments)
      .set({ includeInPdf: input.includeInPdf })
      .where(
        and(
          eq(invoiceAttachments.id, req.params.attachmentId),
          eq(invoiceAttachments.invoiceId, invoice.id),
          isNull(invoiceAttachments.deletedAt),
        ),
      )
      .returning();
    if (!row) throw new HttpError(404, "Attachment not found.");
    return ok(res, row);
  }),
);

router.delete(
  "/:invoiceId/attachments/:attachmentId",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const invoice = await loadInvoiceWithAccess(
      callerId,
      req.params.invoiceId,
      true,
    );
    const { softDelete } = await import("../lib/soft-delete");
    await softDelete({
      table: invoiceAttachments,
      where: and(
        eq(invoiceAttachments.id, req.params.attachmentId),
        eq(invoiceAttachments.invoiceId, invoice.id),
      )!,
      actorUserId: callerId,
      req,
      organizationId: invoice.labOrganizationId,
      entityType: "invoice_attachment",
      entityId: req.params.attachmentId,
    });
    return ok(res, { deleted: true });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Credits applied to invoices.
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/:invoiceId/credits/apply",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const invoice = await loadInvoiceWithAccess(
      callerId,
      req.params.invoiceId,
      true,
    );
    const input = z
      .object({
        amount: z.coerce.number().positive(),
        sourceKind: z
          .enum(["adjustment", "deposit", "writeoff", "manual"])
          .default("manual"),
        sourceId: z.string().optional(),
        note: z.string().max(500).optional(),
      })
      .parse(req.body);

    // When applying from a deposit pool, verify the source deposit exists,
    // belongs to the same lab + practice, and has unused capacity not yet
    // consumed by other (non-reversed) credits pointing at the same source.
    if (input.sourceKind === "deposit") {
      if (!input.sourceId) {
        throw new HttpError(400, "sourceId (bank transaction id) is required for deposit credits.");
      }
      const { bankTransactions, bankTransactionInvoices } = await import(
        "@workspace/db"
      );
      const dep = await db.query.bankTransactions.findFirst({
        where: eq(bankTransactions.id, input.sourceId),
      });
      if (!dep || dep.type !== "deposit" || dep.status !== "posted") {
        throw new HttpError(404, "Source deposit not found or not posted.");
      }
      if (dep.labOrganizationId !== invoice.labOrganizationId) {
        throw new HttpError(403, "Source deposit belongs to a different lab.");
      }
      // Confirm the deposit is for this practice — either explicitly tagged
      // or already linked to one of the practice's invoices.
      const linkedRows = await db
        .select({ providerOrganizationId: invoices.providerOrganizationId })
        .from(bankTransactionInvoices)
        .innerJoin(invoices, eq(invoices.id, bankTransactionInvoices.invoiceId))
        .where(eq(bankTransactionInvoices.bankTransactionId, dep.id));
      const practiceMatch =
        !linkedRows.length ||
        linkedRows.some(
          (r) => r.providerOrganizationId === invoice.providerOrganizationId,
        );
      if (!practiceMatch) {
        throw new HttpError(403, "Source deposit belongs to a different practice.");
      }
      const usedRows = await db
        .select({ amount: invoiceCredits.amount })
        .from(invoiceCredits)
        .where(
          and(
            eq(invoiceCredits.sourceKind, "deposit"),
            eq(invoiceCredits.sourceId, dep.id),
            isNull(invoiceCredits.reversedAt),
          ),
        );
      const used = usedRows.reduce((s, r) => s + Number(r.amount || 0), 0);
      const capacity = Math.max(Number(dep.debitAmount ?? 0), Number(dep.creditAmount ?? 0));
      if (used + input.amount > capacity + 0.0001) {
        throw new HttpError(
          409,
          `Insufficient deposit balance. Remaining ${(capacity - used).toFixed(2)}, requested ${input.amount.toFixed(2)}.`,
        );
      }
    }

    const credit = await db.transaction(async (tx) => {
      if (invoice.providerOrganizationId) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.labOrganizationId}), hashtext(${invoice.providerOrganizationId}))`);
      }
      await assertNoActiveCardReversalForInvoices(tx, [invoice.id]);
      const [authoritative] = await tx.select().from(invoices)
        .where(eq(invoices.id, invoice.id)).for("update");
      if (!authoritative) throw new HttpError(404, "Invoice not found.");
      const [credit] = await tx.insert(invoiceCredits).values({
        invoiceId: authoritative.id,
        providerOrganizationId: authoritative.providerOrganizationId,
        labOrganizationId: authoritative.labOrganizationId,
        amount: input.amount.toFixed(2),
        sourceKind: input.sourceKind,
        sourceId: input.sourceId ?? null,
        note: input.note ?? null,
        appliedByUserId: callerId,
      }).returning();
      const newBalance = Math.max(0, Number(authoritative.balanceDue) - input.amount).toFixed(2);
      const newStatus = Number(newBalance) === 0 && authoritative.status !== "void"
        ? "paid" : authoritative.status;
      await tx.update(invoices).set({
        balanceDue: newBalance,
        status: newStatus,
        updatedByUserId: callerId,
      }).where(eq(invoices.id, authoritative.id));
      return credit;
    });

    await writeAuditLog({
      req,
      organizationId: invoice.labOrganizationId,
      action: "invoice_credit_applied",
      entityType: "invoice",
      entityId: invoice.id,
      afterJson: { creditId: credit.id, amount: input.amount },
    });

    return ok(res, credit, 201);
  }),
);

router.delete(
  "/credits/:creditId",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const credit = await db.query.invoiceCredits.findFirst({
      where: eq(invoiceCredits.id, req.params.creditId),
    });
    if (!credit) throw new HttpError(404, "Credit not found.");
    if (credit.reversedAt) throw new HttpError(409, "Credit already reversed.");
    await requireAnyRole(callerId, credit.labOrganizationId, BILLING_ROLES);

    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, credit.invoiceId),
    });
    if (!invoice) throw new HttpError(404, "Invoice not found.");

    await db.transaction(async (tx) => {
      if (invoice.providerOrganizationId) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.labOrganizationId}), hashtext(${invoice.providerOrganizationId}))`);
      }
      await assertNoActiveCardReversalForInvoices(tx, [invoice.id]);
      const [authoritativeInvoice] = await tx.select().from(invoices)
        .where(eq(invoices.id, invoice.id)).for("update");
      const [authoritativeCredit] = await tx.select().from(invoiceCredits)
        .where(eq(invoiceCredits.id, credit.id)).for("update");
      if (!authoritativeInvoice || !authoritativeCredit || authoritativeCredit.reversedAt) {
        throw new HttpError(409, "Credit or invoice changed; reload and retry.");
      }
      await tx.update(invoiceCredits).set({
        reversedAt: new Date(), reversedByUserId: callerId,
      }).where(eq(invoiceCredits.id, authoritativeCredit.id));
      const newBalance = (Number(authoritativeInvoice.balanceDue) + Number(authoritativeCredit.amount)).toFixed(2);
      const newStatus = authoritativeInvoice.status === "paid" ? "open" : authoritativeInvoice.status;
      await tx.update(invoices).set({
        balanceDue: newBalance,
        status: newStatus,
        updatedByUserId: callerId,
      }).where(eq(invoices.id, authoritativeInvoice.id));
      if (authoritativeInvoice.status === "paid" && newStatus !== "paid") {
        await reverseInvoiceDepositIfAny(
          authoritativeInvoice.id,
          authoritativeInvoice.labOrganizationId,
          callerId,
          tx,
        );
      }
    });

    await writeAuditLog({
      req,
      organizationId: invoice.labOrganizationId,
      action: "invoice_credit_reversed",
      entityType: "invoice",
      entityId: invoice.id,
      afterJson: { creditId: credit.id, amount: credit.amount },
    });

    return ok(res, { reversed: true });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate invoice. Clones the invoice + line items + displayMetadata into
// a brand-new draft. The clone trail is recorded via sourceInvoiceId.
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/:invoiceId/duplicate",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const original = await loadInvoiceWithAccess(
      callerId,
      req.params.invoiceId,
      true,
    );
    const items = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.invoiceId, original.id),
      orderBy: [invoiceLineItems.sortOrder],
    });

    // Generate a unique invoice number based on the original's number with a -COPY suffix.
    const baseNumber = `${original.invoiceNumber}-COPY`;
    let candidate = baseNumber;
    let suffix = 1;
    while (true) {
      const exists = await db.query.invoices.findFirst({
        where: eq(invoices.invoiceNumber, candidate),
      });
      if (!exists) break;
      suffix += 1;
      candidate = `${baseNumber}-${suffix}`;
      if (suffix > 100) {
        throw new HttpError(500, "Could not generate a unique invoice number.");
      }
    }

    const linkedCase = original.caseId
      ? await db.query.cases.findFirst({
          where: eq(cases.id, original.caseId),
          columns: { receivedAt: true },
        })
      : null;

    const cloned = await db.transaction(async (tx) => {
      const [newInvoice] = await tx
        .insert(invoices)
        .values({
          invoiceNumber: candidate,
          caseId: original.caseId,
          labOrganizationId: original.labOrganizationId,
          providerOrganizationId: original.providerOrganizationId,
          doctorIdentity: original.doctorIdentity,
          status: "open",
          subtotal: original.subtotal,
          tax: original.tax,
          discount: original.discount,
          total: original.total,
          balanceDue: original.total,
          notes: original.notes,
          displayMetadataJson: original.displayMetadataJson,
          sourceInvoiceId: original.id,
          issuedAt: linkedCase?.receivedAt
            ? calendarDateToUtcNoon(linkedCase.receivedAt)
            : new Date(),
          createdByUserId: callerId,
          updatedByUserId: callerId,
        })
        .returning();
      if (items.length) {
        const topLevel = items.filter((it: any) => !it.parentLineItemId);
        const children = items.filter((it: any) => !!it.parentLineItemId);
        const insertedParents = await tx
          .insert(invoiceLineItems)
          .values(
            topLevel.map((it: any, idx: number) => ({
              invoiceId: newInvoice.id,
              // A duplicate is a financial snapshot, not a second owner of
              // the case's restoration sources.
              caseRestorationId: null,
              sourceType: "manual",
              sourceKey: null,
              sourceRestorationIdsJson: [],
              toothNumber: it.toothNumber ?? null,
              toothLabel: it.toothLabel ?? null,
              description: it.description,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              lineTotal: it.lineTotal,
              isDiscount: !!it.isDiscount,
              sortOrder: it.sortOrder ?? idx,
            })),
          )
          .returning();
        const oldToNew = new Map<string, string>();
        topLevel.forEach((it: any, idx: number) => {
          oldToNew.set(it.id, insertedParents[idx].id);
        });
        if (children.length) {
          await tx.insert(invoiceLineItems).values(
            children.map((it: any, idx: number) => ({
              invoiceId: newInvoice.id,
              caseRestorationId: null,
              sourceType: "manual",
              sourceKey: null,
              sourceRestorationIdsJson: [],
              toothNumber: it.toothNumber ?? null,
              toothLabel: it.toothLabel ?? null,
              description: it.description,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              lineTotal: it.lineTotal,
              isDiscount: !!it.isDiscount,
              sortOrder: it.sortOrder ?? idx,
              parentLineItemId: oldToNew.get(it.parentLineItemId) ?? null,
            })),
          );
        }
      }
      return newInvoice;
    });

    await writeAuditLog({
      req,
      organizationId: original.labOrganizationId,
      action: "invoice_duplicated",
      entityType: "invoice",
      entityId: cloned.id,
      afterJson: {
        sourceInvoiceId: original.id,
        sourceInvoiceNumber: original.invoiceNumber,
      },
    });

    return ok(res, cloned, 201);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Void / write-off. Both record a reason and optionally reverse the
// auto-deposit so the books match. Write-off is a special-case void that
// also issues an offsetting credit so the open balance becomes 0.
// ─────────────────────────────────────────────────────────────────────────────

const voidBodySchema = z.object({
  reason: z.string().max(2000).optional().default(""),
  reverseDeposit: z.boolean().default(true),
});

async function reverseInvoiceDepositIfAny(
  invoiceId: string,
  labOrganizationId: string,
  callerId: string,
  executor: any = db,
): Promise<{ reversed: boolean; transactionId: string | null }> {
  if (executor === db) {
    return db.transaction((tx) =>
      reverseInvoiceDepositIfAny(invoiceId, labOrganizationId, callerId, tx),
    );
  }
  const links = await executor
    .select({
      bankTransactionId: bankTransactionInvoices.bankTransactionId,
      txnSource: bankTransactions.source,
      txnStatus: bankTransactions.status,
    })
    .from(bankTransactionInvoices)
    .innerJoin(
      bankTransactions,
      eq(bankTransactions.id, bankTransactionInvoices.bankTransactionId),
    )
    .where(eq(bankTransactionInvoices.invoiceId, invoiceId));
  const autoDeposit = links.find(
    (l: any) => l.txnSource === "invoice" && l.txnStatus !== "void",
  );
  if (!autoDeposit) return { reversed: false, transactionId: null };
  await releaseBatchForChild(
    executor,
    labOrganizationId,
    autoDeposit.bankTransactionId,
  );
  await executor
    .update(bankTransactions)
    .set({ status: "void" })
    .where(eq(bankTransactions.id, autoDeposit.bankTransactionId));
  await executor
    .delete(bankTransactionInvoices)
    .where(
      and(
        eq(bankTransactionInvoices.bankTransactionId, autoDeposit.bankTransactionId),
        eq(bankTransactionInvoices.invoiceId, invoiceId),
      ),
    );
  return { reversed: true, transactionId: autoDeposit.bankTransactionId };
}

router.post(
  "/:invoiceId/void",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const invoice = await loadInvoiceWithAccess(callerId, req.params.invoiceId, true);
    if ((invoice as any).frozen) {
      throw new HttpError(409, "Invoice is frozen — the linked case was deleted.");
    }
    if (invoice.status === "void") {
      throw new HttpError(409, "Invoice is already voided.");
    }
    const input = voidBodySchema.parse(req.body);
    const voidReason = input.reason.trim();
    if (voidReason.length === 0) {
      throw new HttpError(400, "A reason is required to void an invoice.");
    }
    const { updated, dep } = await db.transaction(async (tx) => {
      if (invoice.providerOrganizationId) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.labOrganizationId}), hashtext(${invoice.providerOrganizationId}))`);
      }
      await assertNoActiveCardReversalForInvoices(tx, [invoice.id]);
      const [authoritative] = await tx.select().from(invoices)
        .where(eq(invoices.id, invoice.id)).for("update");
      if (!authoritative || authoritative.status === "void") {
        throw new HttpError(409, "Invoice is unavailable or already voided.");
      }
      const dep = input.reverseDeposit
        ? await reverseInvoiceDepositIfAny(
            invoice.id,
            invoice.labOrganizationId,
            callerId,
            tx,
          )
        : { reversed: false, transactionId: null };
      const [updated] = await tx.update(invoices).set({
        status: "void",
        balanceDue: "0.00",
        voidedAt: new Date(),
        voidedByUserId: callerId,
        voidReason: voidReason,
        voidKind: "void",
        updatedByUserId: callerId,
      }).where(eq(invoices.id, authoritative.id)).returning();
      if (authoritative.caseId) {
        const user = (req as any).user;
        await tx.insert(caseEvents).values({
        caseId: authoritative.caseId,
        eventType: "invoice_voided",
        actorUserId: callerId,
        actorOrganizationId: invoice.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          reason: input.reason,
          depositReversed: dep.reversed,
        },
        });
      }
      return { updated, dep };
    });

    await writeAuditLog({
      req,
      organizationId: invoice.labOrganizationId,
      action: "invoice_voided",
      entityType: "invoice",
      entityId: invoice.id,
      beforeJson: invoice,
      afterJson: { ...updated, depositReversed: dep.reversed },
    });

    return ok(res, { invoice: updated, depositReversed: dep.reversed });
  }),
);

router.post(
  "/:invoiceId/write-off",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const invoice = await loadInvoiceWithAccess(callerId, req.params.invoiceId, true);
    if ((invoice as any).frozen) {
      throw new HttpError(409, "Invoice is frozen — the linked case was deleted.");
    }
    if (invoice.status === "void" || invoice.status === "paid") {
      throw new HttpError(
        409,
        "Only open / partially paid invoices can be written off.",
      );
    }
    const input = voidBodySchema.parse(req.body);
    // UI exposes the reason as optional for write-offs; default to a
    // sensible value so the audit log/case event always have something
    // human-readable.
    const writeOffReason = input.reason.trim() || "Write-off";
    const { updated, dep, writeOffAmount } = await db.transaction(async (tx) => {
      if (invoice.providerOrganizationId) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.labOrganizationId}), hashtext(${invoice.providerOrganizationId}))`);
      }
      await assertNoActiveCardReversalForInvoices(tx, [invoice.id]);
      const [authoritative] = await tx.select().from(invoices)
        .where(eq(invoices.id, invoice.id)).for("update");
      if (!authoritative || authoritative.status === "void" || authoritative.status === "paid") {
        throw new HttpError(409, "Only open / partially paid invoices can be written off.");
      }
      const writeOffAmount = Number(authoritative.balanceDue);
      const dep = input.reverseDeposit
        ? await reverseInvoiceDepositIfAny(
            authoritative.id,
            authoritative.labOrganizationId,
            callerId,
            tx,
          )
        : { reversed: false, transactionId: null };
      if (writeOffAmount > 0) {
        await tx.insert(invoiceCredits).values({
        invoiceId: authoritative.id,
        providerOrganizationId: authoritative.providerOrganizationId,
        labOrganizationId: authoritative.labOrganizationId,
        amount: writeOffAmount.toFixed(2),
        sourceKind: "writeoff",
        note: writeOffReason,
        appliedByUserId: callerId,
        });
      }
      const [updated] = await tx.update(invoices).set({
        status: "void",
        balanceDue: "0.00",
        voidedAt: new Date(),
        voidedByUserId: callerId,
        voidReason: writeOffReason,
        voidKind: "writeoff",
        updatedByUserId: callerId,
      }).where(eq(invoices.id, authoritative.id)).returning();
      if (authoritative.caseId) {
        const user = (req as any).user;
        await tx.insert(caseEvents).values({
        caseId: authoritative.caseId,
        eventType: "invoice_written_off",
        actorUserId: callerId,
        actorOrganizationId: invoice.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          reason: input.reason,
          writeOffAmount,
          depositReversed: dep.reversed,
        },
        });
      }
      return { updated, dep, writeOffAmount };
    });

    await writeAuditLog({
      req,
      organizationId: invoice.labOrganizationId,
      action: "invoice_written_off",
      entityType: "invoice",
      entityId: invoice.id,
      beforeJson: invoice,
      afterJson: { ...updated, writeOffAmount, depositReversed: dep.reversed },
    });
    return ok(res, {
      invoice: updated,
      writeOffAmount,
      depositReversed: dep.reversed,
    });
  }),
);

// Mark invoices as sent (sets issuedAt if not already set).
router.post(
  "/batch-mark-sent",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const input = z
      .object({
        invoiceIds: z.array(z.string()).min(1).max(500),
      })
      .parse(req.body);
    const rows = await db.query.invoices.findMany({
      where: inArray(invoices.id, input.invoiceIds),
    });
    const labOrgIds = Array.from(
      new Set(rows.map((r: any) => r.labOrganizationId)),
    );
    for (const orgId of labOrgIds) {
      await requireAnyRole(callerId, orgId as string, BILLING_ROLES);
    }
    const now = new Date();
    const updatedIds: string[] = [];
    for (const row of rows as any[]) {
      const [u] = await db
        .update(invoices)
        .set({
          status: row.status,
          issuedAt: row.issuedAt ?? now,
          updatedByUserId: callerId,
        })
        .where(eq(invoices.id, row.id))
        .returning();
      if (u) updatedIds.push(u.id);
    }
    return ok(res, { updated: updatedIds.length, ids: updatedIds });
  }),
);

// AI review acknowledgment for an invoice (matches case AI review).
router.patch(
  "/:invoiceId/ai-review",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const invoice = await loadInvoiceWithAccess(callerId, req.params.invoiceId, true);
    const [updated] = await db
      .update(invoices)
      .set({
        aiReviewedAt: new Date(),
        aiReviewedByUserId: callerId,
        updatedByUserId: callerId,
      })
      .where(eq(invoices.id, invoice.id))
      .returning();
    await writeAuditLog({
      req,
      organizationId: invoice.labOrganizationId,
      action: "invoice_ai_review_acknowledged",
      entityType: "invoice",
      entityId: invoice.id,
    });
    return ok(res, updated);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Practice statements (manual builder).
// ─────────────────────────────────────────────────────────────────────────────

const practiceStatementsDir = path.resolve(
  process.cwd(),
  "uploads",
  "practice-statements",
);

async function buildAndPersistStatementPdf(opts: {
  statementId: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  periodStart: Date;
  periodEnd: Date;
  invoicesList: any[];
  totals: { billed: number; paid: number; open: number };
}): Promise<{ storageKey: string; fileName: string; size: number }> {
  const labOrg = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.labOrganizationId),
  });
  const practice = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.providerOrganizationId),
  });
  const labName = labOrg?.displayName || labOrg?.name || "LabTrax";
  const practiceName =
    practice?.displayName || practice?.name || "Practice";
  // Batch-fetch line items for all invoices in this statement so the PDF
  // can render per-invoice group subtotals.
  const invoiceIds = opts.invoicesList.map((inv: any) => inv.id as string).filter(Boolean);
  const liRows =
    invoiceIds.length > 0
      ? await db.query.invoiceLineItems.findMany({
          where: inArray(invoiceLineItems.invoiceId, invoiceIds),
          orderBy: [asc(invoiceLineItems.sortOrder)],
        })
      : [];
  const liByInvoiceId = new Map<string, typeof liRows>();
  for (const li of liRows) {
    if (!liByInvoiceId.has(li.invoiceId)) liByInvoiceId.set(li.invoiceId, []);
    liByInvoiceId.get(li.invoiceId)!.push(li);
  }

  // Hydrate every payment for the selected invoices. The shared PDF renderer
  // uses these rows for the chronological running-balance ledger; the last
  // row also preserves the existing statement-level payment summary.
  const paymentRows = invoiceIds.length
    ? await db
      .select({
        id: payments.id,
        invoiceId: payments.invoiceId,
        amount: payments.amount,
        paidAt: payments.paidAt,
        paymentMethod: payments.paymentMethod,
        referenceNumber: payments.referenceNumber,
      })
      .from(payments)
      .where(inArray(payments.invoiceId, invoiceIds))
      .orderBy(desc(payments.paidAt), desc(payments.id))
    : [];
  const latestPmt = paymentRows[0];
  const paidAt: Date | null = latestPmt?.paidAt ?? null;
  const paymentMethod: string | null = latestPmt?.paymentMethod ?? null;

  const data: PracticeStatementData = {
    practiceId: opts.providerOrganizationId,
    providerOrganizationId: opts.providerOrganizationId,
    practiceName,
    practiceEmail: practice?.billingEmail || null,
    statementEmailOptOut: practice?.statementEmailOptOut ?? false,
    invoiceCount: opts.invoicesList.length,
    totalBilled: opts.totals.billed,
    totalPaid: opts.totals.paid,
    openBalance: opts.totals.open,
    paidAt,
    paymentMethod,
    payments: paymentRows.map((payment: any) => ({
      id: String(payment.id ?? ""),
      invoiceId: payment.invoiceId,
      amount: String(payment.amount ?? "0"),
      paidAt: payment.paidAt,
      paymentMethod: payment.paymentMethod,
      referenceNumber: payment.referenceNumber ?? null,
    })),
    invoices: opts.invoicesList.map((inv: any) => {
      const meta = (inv.displayMetadataJson ?? null) as
        | { patientName?: string | null; billTo?: string | null }
        | null;
      const items = liByInvoiceId.get(inv.id) ?? [];
      return {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        issuedAt: inv.issuedAt ?? inv.createdAt ?? null,
        dueAt: inv.dueAt ?? null,
        status: inv.status,
        total: String(inv.total ?? "0"),
        balanceDue: String(inv.balanceDue ?? "0"),
        patientName: meta?.patientName ?? null,
        billTo: meta?.billTo ?? null,
        lineItems: items.map((li) => ({
          id: li.id,
          description: li.description,
          quantity: li.quantity,
          unitPrice: String(li.unitPrice),
          lineTotal: String(li.lineTotal),
          isDiscount: !!li.isDiscount,
          parentLineItemId: li.parentLineItemId ?? null,
          toothLabel: li.toothLabel ?? null,
          toothNumber: li.toothNumber ?? null,
          sortOrder: li.sortOrder,
        })),
      };
    }),
  };
  const periodLabel = `${opts.periodStart.toISOString().slice(0, 10)} to ${opts.periodEnd.toISOString().slice(0, 10)}`;
  await attachStatementContacts(opts.labOrganizationId, [data]);
  const template = coerceStatementTemplate((labOrg as any)?.statementTemplate);
  const buf = await generateStatementPdfBuffer(
    labName,
    data,
    periodLabel,
    await readLogoBuffer(opts.labOrganizationId),
    (labOrg as any)?.logoPdfSize,
    "all",
    labOrg?.invoiceDueDayOfMonth ?? null,
    null,
    template.defaultTextBlocks,
    opts.labOrganizationId,
    template,
  );
  // Delegate the disk-write to the shared helper so all send paths use
  // the same storage location and naming convention.
  return persistStatementPdf({
    buffer: buf,
    providerOrganizationId: opts.providerOrganizationId,
    periodMonth: periodMonthFor(opts.periodStart),
  });
}

router.post(
  "/practice-statements/generate",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const input = z
      .object({
        labOrganizationId: z.string().min(1),
        providerOrganizationIds: z.array(z.string().min(1)).min(1).max(200),
        periodStart: z.string().datetime(),
        periodEnd: z.string().datetime(),
        includeStatuses: z
          .array(z.enum(["open", "partially_paid", "paid"]))
          .default(["open", "partially_paid"]),
      })
      .parse(req.body);
    await requireAnyRole(callerId, input.labOrganizationId, BILLING_ROLES);

    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);
    const created: any[] = [];

    for (const providerOrganizationId of input.providerOrganizationIds) {
      const list = await db.query.invoices.findMany({
        where: and(
          eq(invoices.labOrganizationId, input.labOrganizationId),
          eq(invoices.providerOrganizationId, providerOrganizationId),
          isNull(invoices.deletedAt),
          inArray(invoices.status, input.includeStatuses),
          gte(invoices.createdAt, periodStart),
          lte(invoices.createdAt, periodEnd),
        ),
      });
      const totalBilled = list
        .reduce((acc: number, r: any) => acc + Number(r.total ?? 0), 0)
        .toFixed(2);
      const totalPaid = list
        .reduce(
          (acc: number, r: any) =>
            acc + (Number(r.total ?? 0) - Number(r.balanceDue ?? 0)),
          0,
        )
        .toFixed(2);
      const balanceDue = list
        .reduce((acc: number, r: any) => acc + Number(r.balanceDue ?? 0), 0)
        .toFixed(2);

      const [stmt] = await db
        .insert(practiceStatements)
        .values({
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId,
          periodStart,
          periodEnd,
          invoiceCount: list.length,
          totalBilled,
          totalPaid,
          balanceDue,
          invoiceIdsJson: list.map((r: any) => r.id),
          invoiceAmountsJson: Object.fromEntries(
            list.map((invoice: any) => [invoice.id, invoice.total]),
          ),
          invoiceDetailsJson: Object.fromEntries(
            list.map((invoice: any) => {
              const metadata =
                invoice.displayMetadataJson &&
                typeof invoice.displayMetadataJson === "object"
                  ? invoice.displayMetadataJson
                  : {};
              return [
                invoice.id,
                {
                  invoiceNumber: invoice.invoiceNumber,
                  patientName:
                    typeof metadata.patientName === "string"
                      ? metadata.patientName
                      : null,
                  billTo:
                    typeof metadata.billTo === "string" ? metadata.billTo : null,
                  issuedAt: invoice.issuedAt?.toISOString() ?? null,
                  dueAt: invoice.dueAt?.toISOString() ?? null,
                  status: invoice.status,
                },
              ];
            }),
          ),
          createdByUserId: callerId,
        })
        .returning();
      // Server-side PDF generation + persistence so subsequent send/download
      // operations reference the durable artifact, not a client-supplied blob.
      try {
        const pdf = await buildAndPersistStatementPdf({
          statementId: stmt.id,
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId,
          periodStart,
          periodEnd,
          invoicesList: list,
          totals: {
            billed: Number(totalBilled),
            paid: Number(totalPaid),
            open: Number(balanceDue),
          },
        });
        const [withPdf] = await db
          .update(practiceStatements)
          .set({
            pdfStorageKey: pdf.storageKey,
            pdfFileName: pdf.fileName,
            pdfFileSize: pdf.size,
          })
          .where(eq(practiceStatements.id, stmt.id))
          .returning();
        created.push(withPdf ?? stmt);
      } catch (pdfErr) {
        req.log?.warn(
          { err: pdfErr, statementId: stmt.id },
          "practice-statement PDF generation failed",
        );
        created.push(stmt);
      }
    }

    await writeAuditLog({
      req,
      organizationId: input.labOrganizationId,
      action: "practice_statements_generated",
      entityType: "organization",
      entityId: input.labOrganizationId,
      metadataJson: {
        count: created.length,
        statementIds: created.map((s: any) => s.id),
      },
    });

    return ok(res, { statements: created }, 201);
  }),
);

router.post(
  "/practice-statements/:statementId/email",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const stmt = await db.query.practiceStatements.findFirst({
      where: eq(practiceStatements.id, req.params.statementId),
    });
    if (!stmt) throw new HttpError(404, "Statement not found.");
    await requireAnyRole(callerId, stmt.labOrganizationId, BILLING_ROLES);

    const input = z
      .object({
        to: z.string().email().optional(),
        subject: z.string().min(1).max(500).default("Account statement"),
        message: z.string().min(1).max(20000).default("Please find your account statement attached."),
        attachmentIndex: z.number().int().min(0).optional(),
      })
      .parse(req.body);

    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, stmt.providerOrganizationId),
    });
    if (!practice) throw new HttpError(404, "Practice not found.");
    const recipient = (input.to ?? practice.billingEmail ?? "").trim();
    if (!recipient) {
      throw new HttpError(
        400,
        "This practice has no billing email on file. Add one first or enter a recipient.",
      );
    }

    const cfg = getMailerConfig();
    if (!cfg) {
      throw new HttpError(503, "Email is not configured on the server.");
    }
    if (!stmt.pdfStorageKey) {
      throw new HttpError(
        409,
        "Statement PDF was not generated. Re-generate the statement and try again.",
      );
    }
    const manifest = coerceStatementBundleManifest(stmt.bundleManifestJson);
    const attachment =
      input.attachmentIndex === undefined
        ? undefined
        : manifest?.attachments[input.attachmentIndex];
    if (input.attachmentIndex !== undefined && !attachment) {
      throw new HttpError(404, "Statement PDF attachment not found.");
    }
    // An omitted index preserves full-bundle resend behavior. A selected
    // index replays that exact issued manifest attachment; legacy statements
    // continue to use the pdf_* columns.
    const sources = attachment
      ? [{ storageKey: attachment.storageKey, fileName: attachment.fileName }]
      : manifest && manifest.attachments.length
        ? manifest.attachments.map((a) => ({
            storageKey: a.storageKey,
            fileName: a.fileName,
          }))
        : [
            {
              storageKey: stmt.pdfStorageKey,
              fileName: stmt.pdfFileName || "statement.pdf",
            },
          ];

    const mailAttachments: Array<{
      filename: string;
      content: Buffer;
      contentType: string;
    }> = [];
    for (const source of sources) {
      const safeKey = path.basename(source.storageKey);
      const pdfPath = path.resolve(practiceStatementsDir, safeKey);
      if (!pdfPath.startsWith(practiceStatementsDir + path.sep)) {
        throw new HttpError(500, "Invalid statement file path.");
      }
      const buffer = fs.readFileSync(pdfPath);
      if (buffer.length === 0) {
        throw new HttpError(500, "Statement PDF is empty.");
      }
      const filename = source.fileName || "statement.pdf";
      mailAttachments.push({
        filename: filename.endsWith(".pdf") ? filename : `${filename}.pdf`,
        content: buffer,
        contentType: "application/pdf",
      });
    }

    let errorMessage: string | null = null;
    let status: "sent" | "failed" = "sent";
    try {
      const t = createTransport(cfg);
      await t.sendMail({
        from: cfg.from,
        to: recipient,
        subject: input.subject,
        text: input.message,
        attachments: mailAttachments,
      });
    } catch (err: any) {
      status = "failed";
      const classified = classifySmtpError(err);
      errorMessage = classified.message;
      req.log?.error?.(
        {
          smtpCategory: classified.category,
          smtpResponseCode: classified.responseCode,
          smtpCode: classified.code,
        },
        "[PRACTICE STATEMENT EMAIL] sendMail failed",
      );
    }

    const [send] = await db
      .insert(practiceStatementSends)
      .values({
        statementId: stmt.id,
        channel: "email",
        recipient,
        status,
        errorMessage,
        sentByUserId: callerId,
      })
      .returning();

    if (status === "failed") {
      throw new HttpError(502, errorMessage || "Email failed.");
    }
    return ok(res, send);
  }),
);

router.get(
  "/practice-statements/:statementId/pdf",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const stmt = await db.query.practiceStatements.findFirst({
      where: eq(practiceStatements.id, req.params.statementId),
    });
    if (!stmt) throw new HttpError(404, "Statement not found.");
    await requireAnyRole(callerId, stmt.labOrganizationId, BILLING_ROLES);
    const attachmentIndex =
      req.query.attachmentIndex === undefined
        ? 0
        : z.coerce.number().int().min(0).parse(req.query.attachmentIndex);
    const manifest = coerceStatementBundleManifest(stmt.bundleManifestJson);
    const attachments = manifest?.attachments ?? [];
    const attachment = attachments[attachmentIndex];
    if (attachments.length > 0 && !attachment) {
      throw new HttpError(404, "Statement PDF attachment not found.");
    }
    if (attachments.length === 0 && attachmentIndex !== 0) {
      throw new HttpError(404, "Statement PDF attachment not found.");
    }
    const storageKey = attachment?.storageKey ?? stmt.pdfStorageKey;
    const fileName =
      attachment?.fileName ?? stmt.pdfFileName ?? "statement.pdf";
    const attachmentDescription = attachment
      ? ` for ${attachment.doctorName?.trim() || attachment.label || fileName} (${fileName})`
      : "";
    if (!storageKey) {
      throw new HttpError(
        409,
        `Statement PDF${attachmentDescription} was not generated.`,
      );
    }
    const safeKey = path.basename(storageKey);
    const pdfPath = path.resolve(practiceStatementsDir, safeKey);
    if (!pdfPath.startsWith(practiceStatementsDir + path.sep)) {
      throw new HttpError(500, "Invalid statement file path.");
    }
    if (!fs.existsSync(pdfPath)) {
      throw new HttpError(
        404,
        `Statement PDF${attachmentDescription} is missing.`,
      );
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${fileName}"`,
    );
    res.sendFile(pdfPath);
  }),
);

router.post(
  "/practice-statements/:statementId/sms",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const stmt = await db.query.practiceStatements.findFirst({
      where: eq(practiceStatements.id, req.params.statementId),
    });
    if (!stmt) throw new HttpError(404, "Statement not found.");
    await requireAnyRole(callerId, stmt.labOrganizationId, BILLING_ROLES);
    const input = z
      .object({
        to: z.string().min(7).max(40),
        message: z.string().min(1).max(1500),
      })
      .parse(req.body);

    const toE164 = normalizePhoneE164(input.to);
    if (!toE164) {
      throw new HttpError(400, "Invalid phone number. Please use a 10-digit US number or E.164 format (e.g. +18503633336).");
    }

    const { sendSms } = await import("../lib/sms.js");
    const smsResult = await sendSms({ to: toE164, body: input.message });
    let status: "sent" | "failed" = smsResult.ok || smsResult.skipped ? "sent" : "failed";
    let errorMessage: string | null = smsResult.ok || smsResult.skipped ? null : (smsResult.errorMessage ?? "SMS failed.");
    const [send] = await db
      .insert(practiceStatementSends)
      .values({
        statementId: stmt.id,
        channel: "sms",
        recipient: input.to.trim(),
        status,
        errorMessage,
        sentByUserId: callerId,
      })
      .returning();
    if (status === "failed") {
      throw new HttpError(502, errorMessage || "SMS failed.");
    }
    return ok(res, send);
  }),
);

// Batch email: send a separate email per invoice (uses each invoice's
// existing /email handler logic via a loop). Single-tx, best-effort.
router.post(
  "/batch-email",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const input = z
      .object({
        items: z
          .array(
            z.object({
              invoiceId: z.string().min(1),
              to: z
                .union([
                  z.string().email(),
                  z.array(z.string().email()).min(1).max(20),
                ])
                .optional(),
              cc: z.array(z.string().email()).max(20).optional(),
              bcc: z.array(z.string().email()).max(20).optional(),
              subject: z.string().min(1).max(500),
              message: z.string().min(1).max(20000),
              filename: z.string().min(1).max(200),
              pdfBase64: z.string().min(1).max(8 * 1024 * 1024),
            }),
          )
          .min(1)
          .max(100),
      })
      .parse(req.body);

    const cfg = getMailerConfig();
    if (!cfg) {
      throw new HttpError(503, "Email is not configured on the server.");
    }
    const transporter = createTransport(cfg);

    const results: Array<{
      invoiceId: string;
      status: "sent" | "failed";
      error?: string;
    }> = [];
    for (const item of input.items) {
      try {
        const invoice = await db.query.invoices.findFirst({
          where: eq(invoices.id, item.invoiceId),
        });
        if (!invoice) {
          results.push({ invoiceId: item.invoiceId, status: "failed", error: "not found" });
          continue;
        }
        await requireAnyRole(callerId, invoice.labOrganizationId, BILLING_ROLES);
        assertRecoveryReleased(invoice);
        const practice = invoice.providerOrganizationId
          ? await db.query.organizations.findFirst({
              where: eq(organizations.id, invoice.providerOrganizationId),
            })
          : null;
        const recipientList: string[] = Array.isArray(item.to)
          ? item.to.map((s) => s.trim()).filter(Boolean)
          : item.to
            ? [item.to.trim()]
            : practice?.billingEmail
              ? [practice.billingEmail.trim()]
              : [];
        if (recipientList.length === 0) {
          results.push({
            invoiceId: item.invoiceId,
            status: "failed",
            error: "no recipient",
          });
          continue;
        }
        const buf = Buffer.from(item.pdfBase64, "base64");
        try {
          await transporter.sendMail({
            from: cfg.from,
            to: recipientList,
            ...(item.cc && item.cc.length ? { cc: item.cc } : {}),
            ...(item.bcc && item.bcc.length ? { bcc: item.bcc } : {}),
            subject: item.subject,
            text: item.message,
            attachments: [
              {
                filename: item.filename.endsWith(".pdf")
                  ? item.filename
                  : `${item.filename}.pdf`,
                content: buf,
                contentType: "application/pdf",
              },
            ],
          });
        } catch (err: any) {
          const classified = classifySmtpError(err);
          req.log?.error?.(
            {
              invoiceId: item.invoiceId,
              smtpCategory: classified.category,
              smtpResponseCode: classified.responseCode,
              smtpCode: classified.code,
            },
            "[INVOICE BATCH EMAIL] sendMail failed",
          );
          results.push({
            invoiceId: item.invoiceId,
            status: "failed",
            error: classified.message,
          });
          continue;
        }
        results.push({ invoiceId: item.invoiceId, status: "sent" });
      } catch (err: any) {
        results.push({
          invoiceId: item.invoiceId,
          status: "failed",
          error: err?.message || "send failed",
        });
      }
    }

    return ok(res, {
      sent: results.filter((r) => r.status === "sent").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    });
  }),
);

router.get(
  "/reports/sales",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        organizationId: z.string(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      })
      .parse(req.query);

    await requireAnyRole(
      (req as any).auth.userId,
      query.organizationId,
      BILLING_ROLES
    );

    // Match the conventions used elsewhere (sales-series, the Invoices page
    // date filter): bucket/filter by the invoice's issued date, falling back
    // to createdAt when it hasn't been issued yet, and always exclude
    // soft-deleted + voided invoices so this KPI can't disagree with the rest
    // of the app for the same lab + range.
    const rows = (await db
      .select({
        status: invoices.status,
        total: invoices.total,
        balanceDue: invoices.balanceDue,
        frozen: invoices.frozen,
      })
      .from(invoices)
      .where(
        salesInvoiceScope(query.organizationId,
          query.dateFrom ? new Date(query.dateFrom) : undefined,
          query.dateTo ? new Date(query.dateTo) : undefined),
      )) as Array<{
      status: string;
      total: string;
      balanceDue: string;
      frozen: boolean;
    }>;

    const totalSales = rows
      .reduce((acc, row) => acc + Number(row.total), 0)
      .toFixed(2);
    // Frozen invoices (linked case deleted) are excluded from the open-balance
    // figure — they're zeroed out at freeze time, and any stragglers should
    // not surface as outstanding money owed.
    const openBalance = rows
      .filter((row) => !row.frozen)
      .reduce((acc, row) => acc + Number(row.balanceDue), 0)
      .toFixed(2);

    return ok(res, {
      totalSales,
      openBalance,
      invoices: rows.length,
      paidInvoices: rows.filter((row) => row.status === "paid").length,
      openInvoices: rows.filter((row) => row.status !== "paid").length,
    });
  })
);

// ───────── Reports: Sales time series (Task #381) ─────────
router.get(
  "/reports/sales-invoices",
  asyncHandler(async (req, res) => {
    const q = z.object({
      organizationId: z.string().min(1),
      dateFrom: z.string().min(1),
      dateTo: z.string().min(1),
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    await requireAnyRole((req as any).auth.userId, q.organizationId, BILLING_ROLES);
    const from = new Date(q.dateFrom);
    const to = new Date(q.dateTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new HttpError(400, "Invalid dateFrom/dateTo range.");
    }
    // One snapshot prevents the page/count from disagreeing during concurrent writes.
    const page = await db.transaction(async (tx) => {
      const where = salesInvoiceScope(q.organizationId, from, to);
      const [totals] = await tx.select({
        total: sql<number>`count(*)::int`,
        billedTotal: sql<string>`coalesce(sum(${invoices.total}), 0)::text`,
      }).from(invoices).where(where);
      const rows = await tx.select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        issuedAt: salesIssuedDate,
        total: invoices.total,
        status: invoices.status,
        practiceName: organizations.name,
        doctorName: sql<string | null>`coalesce(${invoices.displayMetadataJson}->>'billTo', ${invoices.displayMetadataJson}->>'doctorName')`,
      }).from(invoices)
        .leftJoin(organizations, eq(organizations.id, invoices.providerOrganizationId))
        .where(where)
        .orderBy(desc(salesIssuedDate), desc(invoices.id))
        .limit(q.limit).offset(q.offset);
      return {
        rows: rows.map((row) => ({ ...row, issuedAt: new Date(row.issuedAt).toISOString() })),
        offset: q.offset,
        total: totals!.total,
        billedTotal: Number(totals!.billedTotal).toFixed(2),
        hasMore: q.offset + rows.length < totals!.total,
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    return ok(res, page);
  }),
);

//
// Buckets invoiced sales for one lab into day / week (Mon-anchored) /
// month periods. Bucketing key uses `issuedAt` if set, otherwise
// `createdAt`. Voided invoices are excluded. Soft-deleted invoices are
// excluded via `notDeleted(invoices)`.
router.get(
  "/reports/sales-series",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        organizationId: z.string().min(1),
        dateFrom: z.string().min(1),
        dateTo: z.string().min(1),
        groupBy: z.enum(["day", "week", "month"]).default("month"),
        // IANA TZ (e.g. "America/Los_Angeles"); buckets anchor to it.
        timeZone: z.string().min(1).max(64).optional(),
      })
      .parse(req.query);
    await requireAnyRole(
      (req as any).auth.userId,
      q.organizationId,
      BILLING_ROLES,
    );
    const from = new Date(q.dateFrom);
    const to = new Date(q.dateTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new HttpError(400, "Invalid dateFrom/dateTo.");
    }
    const tz = q.timeZone ?? "UTC";
    let tzFmt: Intl.DateTimeFormat;
    try {
      tzFmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      throw new HttpError(400, `Invalid timeZone: ${tz}`);
    }

    const issued = salesIssuedDate;
    const rows = (await db
      .select({
        issued,
        subtotal: invoices.subtotal,
        discount: invoices.discount,
        lineDiscountTotal: sql<string>`coalesce((
          select sum(abs(discount_line.line_total))
          from invoice_line_items as discount_line
          where discount_line.invoice_id = invoices.id
            and discount_line.is_discount = true
        ), 0)::text`,
        tax: invoices.tax,
        total: invoices.total,
        status: invoices.status,
      })
      .from(invoices)
      .where(
        salesInvoiceScope(q.organizationId, from, to),
      )) as Array<{
      issued: string | Date;
      subtotal: string;
      discount: string;
      lineDiscountTotal: string;
      tax: string;
      total: string;
      status: string;
    }>;

    function bucketKey(d: Date): { key: string; start: Date } {
      const parts = tzFmt.format(d).split("-"); // en-CA → "YYYY-MM-DD"
      const yr = Number(parts[0]);
      const mo = Number(parts[1]) - 1;
      const day = Number(parts[2]);
      if (q.groupBy === "day") {
        const start = new Date(Date.UTC(yr, mo, day));
        return { key: start.toISOString().slice(0, 10), start };
      }
      if (q.groupBy === "month") {
        const start = new Date(Date.UTC(yr, mo, 1));
        return { key: `${yr}-${String(mo + 1).padStart(2, "0")}`, start };
      }
      // Week — anchor to local Monday.
      const local = new Date(Date.UTC(yr, mo, day));
      const dow = (local.getUTCDay() + 6) % 7; // Mon = 0
      const start = new Date(Date.UTC(yr, mo, day - dow));
      return { key: start.toISOString().slice(0, 10), start };
    }

    const buckets = new Map<
      string,
      {
        periodStart: string;
        gross: number;
        discounts: number;
        net: number;
        tax: number;
        billedTotal: number;
        count: number;
      }
    >();
    let tGross = 0;
    let tDiscounts = 0;
    let tNet = 0;
    let tTax = 0;
    let tBilledTotal = 0;
    let tCount = 0;
    for (const r of rows) {
      if (r.status === "void") continue;
      const d = new Date(r.issued as string);
      if (Number.isNaN(d.getTime())) continue;
      const { key, start } = bucketKey(d);
      const subtotal = Number(r.subtotal || 0);
      const lineDiscount = Number(r.lineDiscountTotal || 0);
      const discount = Number(r.discount || 0) + lineDiscount;
      const tax = Number(r.tax || 0);
      const billedTotal = Number(r.total || 0);
      const gross = subtotal + lineDiscount;
      const net = gross - discount; // pre-tax revenue, excluding credits
      const cur =
        buckets.get(key) ??
        {
          periodStart: start.toISOString(),
          gross: 0,
          discounts: 0,
          net: 0,
          tax: 0,
          billedTotal: 0,
          count: 0,
        };
      cur.gross += gross;
      cur.discounts += discount;
      cur.net += net;
      cur.tax += tax;
      cur.billedTotal += billedTotal;
      cur.count += 1;
      buckets.set(key, cur);
      tGross += gross;
      tDiscounts += discount;
      tNet += net;
      tTax += tax;
      tBilledTotal += billedTotal;
      tCount += 1;
    }

    const series = Array.from(buckets.values())
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
      .map((b) => ({
        periodStart: b.periodStart,
        gross: b.gross.toFixed(2),
        discounts: b.discounts.toFixed(2),
        net: b.net.toFixed(2),
        tax: b.tax.toFixed(2),
        billedTotal: b.billedTotal.toFixed(2),
        count: b.count,
        avg: b.count ? (b.billedTotal / b.count).toFixed(2) : "0.00",
      }));

    return ok(res, {
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy: q.groupBy,
      timeZone: tz,
      series,
      totals: {
        gross: tGross.toFixed(2),
        discounts: tDiscounts.toFixed(2),
        net: tNet.toFixed(2),
        tax: tTax.toFixed(2),
        billedTotal: tBilledTotal.toFixed(2),
        count: tCount,
        avg: tCount ? (tBilledTotal / tCount).toFixed(2) : "0.00",
      },
    });
  }),
);

// ───────── Reports: Discounts given ─────────
router.get(
  "/reports/discounts",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        organizationId: z.string().min(1),
        dateFrom: z.string().min(1),
        dateTo: z.string().min(1),
        groupBy: z.enum(["day", "week", "month"]).default("month"),
        timeZone: z.string().min(1).max(64).optional(),
      })
      .parse(req.query);
    await requireAnyRole(
      (req as any).auth.userId,
      q.organizationId,
      BILLING_ROLES,
    );

    const from = new Date(q.dateFrom);
    const to = new Date(q.dateTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new HttpError(400, "Invalid dateFrom/dateTo range.");
    }

    const tz = q.timeZone ?? "UTC";
    let tzFmt: Intl.DateTimeFormat;
    try {
      tzFmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      throw new HttpError(400, `Invalid timeZone: ${tz}`);
    }

    const { invoicesInRange, discountLines } = await db.transaction(
      async (tx) => {
        const where = salesInvoiceScope(q.organizationId, from, to);
        const invoicesInRange = await tx
          .select({
            id: invoices.id,
            issued: salesIssuedDate,
            discount: invoices.discount,
            providerOrganizationId: invoices.providerOrganizationId,
            practiceName: organizations.name,
            doctorName: sql<string | null>`coalesce(${doctorProfiles.doctorName}, ${invoices.displayMetadataJson}->>'doctorName')`,
          })
          .from(invoices)
          .leftJoin(
            organizations,
            eq(organizations.id, invoices.providerOrganizationId),
          )
          .leftJoin(
            doctorProfiles,
            eq(doctorProfiles.id, invoices.doctorIdentity),
          )
          .where(where);
        const discountLines = await tx
          .select({
            invoiceId: invoiceLineItems.invoiceId,
            description: invoiceLineItems.description,
            lineTotal: invoiceLineItems.lineTotal,
          })
          .from(invoiceLineItems)
          .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
          .where(
            and(
              salesInvoiceScope(q.organizationId, from, to),
              eq(invoiceLineItems.isDiscount, true),
            ),
          );
        return { invoicesInRange, discountLines };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

    function bucketKey(d: Date): { key: string; start: Date } {
      const parts = tzFmt.format(d).split("-");
      const yr = Number(parts[0]);
      const mo = Number(parts[1]) - 1;
      const day = Number(parts[2]);
      if (q.groupBy === "day") {
        const start = new Date(Date.UTC(yr, mo, day));
        return { key: start.toISOString().slice(0, 10), start };
      }
      if (q.groupBy === "month") {
        const start = new Date(Date.UTC(yr, mo, 1));
        return { key: `${yr}-${String(mo + 1).padStart(2, "0")}`, start };
      }
      const local = new Date(Date.UTC(yr, mo, day));
      const dow = (local.getUTCDay() + 6) % 7;
      const start = new Date(Date.UTC(yr, mo, day - dow));
      return { key: start.toISOString().slice(0, 10), start };
    }

    const linesByInvoice = new Map<
      string,
      Array<{ description: string; amount: number }>
    >();
    for (const line of discountLines) {
      const amount = Math.abs(Number(line.lineTotal || 0));
      if (amount <= 0) continue;
      const current = linesByInvoice.get(line.invoiceId) ?? [];
      current.push({ description: line.description, amount });
      linesByInvoice.set(line.invoiceId, current);
    }

    const periodBuckets = new Map<
      string,
      { periodStart: string; amount: number; count: number }
    >();
    const itemBuckets = new Map<string, { amount: number; count: number }>();
    const practiceBuckets = new Map<
      string,
      {
        practiceId: string | null;
        practiceName: string | null;
        doctorName: string | null;
        amount: number;
        count: number;
      }
    >();
    let totalAmount = 0;
    let totalCount = 0;

    for (const invoice of invoicesInRange) {
      const issued = new Date(
        invoice.issued instanceof Date
          ? invoice.issued.getTime()
          : String(invoice.issued),
      );
      if (Number.isNaN(issued.getTime())) continue;
      const headerDiscount = Math.max(0, Number(invoice.discount || 0));
      const lines = linesByInvoice.get(invoice.id) ?? [];
      const lineAmount = lines.reduce((sum, line) => sum + line.amount, 0);
      const amount = headerDiscount + lineAmount;
      if (amount <= 0) continue;

      const { key, start } = bucketKey(issued);
      const period = periodBuckets.get(key) ?? {
        periodStart: start.toISOString(),
        amount: 0,
        count: 0,
      };
      period.amount += amount;
      period.count += 1;
      periodBuckets.set(key, period);
      totalAmount += amount;
      totalCount += 1;

      if (headerDiscount > 0) {
        const label = "Invoice-level discount";
        const item = itemBuckets.get(label) ?? { amount: 0, count: 0 };
        item.amount += headerDiscount;
        item.count += 1;
        itemBuckets.set(label, item);
      }
      for (const line of lines) {
        const item = itemBuckets.get(line.description) ?? {
          amount: 0,
          count: 0,
        };
        item.amount += line.amount;
        item.count += 1;
        itemBuckets.set(line.description, item);
      }

      const practiceKey = JSON.stringify([
        invoice.providerOrganizationId,
        invoice.doctorName,
      ]);
      const practice = practiceBuckets.get(practiceKey) ?? {
        practiceId: invoice.providerOrganizationId,
        practiceName: invoice.practiceName,
        doctorName: invoice.doctorName,
        amount: 0,
        count: 0,
      };
      practice.amount += amount;
      practice.count += 1;
      practiceBuckets.set(practiceKey, practice);
    }

    return ok(res, {
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy: q.groupBy,
      timeZone: tz,
      series: Array.from(periodBuckets.values())
        .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
        .map((period) => ({
          ...period,
          amount: period.amount.toFixed(2),
        })),
      items: Array.from(itemBuckets.entries())
        .sort((a, b) => b[1].amount - a[1].amount || a[0].localeCompare(b[0]))
        .map(([item, value]) => ({
          item,
          amount: value.amount.toFixed(2),
          count: value.count,
        })),
      practices: Array.from(practiceBuckets.values())
        .sort(
          (a, b) =>
            b.amount - a.amount ||
            (a.practiceName ?? "").localeCompare(b.practiceName ?? "") ||
            (a.doctorName ?? "").localeCompare(b.doctorName ?? ""),
        )
        .map((practice) => ({
          ...practice,
          amount: practice.amount.toFixed(2),
        })),
      totals: {
        amount: totalAmount.toFixed(2),
        count: totalCount,
      },
    });
  }),
);

// ── Draft-invoice preview (read-only, non-persisting) ─────────────────────
//
// Returns the line items + totals that WOULD be generated for a case with the
// given restorations, WITHOUT creating a case, invoice, or any DB row. Used by
// the Desktop drop-zone Rx proposal panel so users see the draft invoice
// before clicking "Create case". Pricing and grouping reuse the exact same
// code paths as the real create flow (resolveAllPricesForContext +
// resolveServerPriceWithSource fallback, then buildBridgeAwareLineItems) so
// the preview matches the generated draft invoice line-for-line.
const previewRestorationSchema = z.object({
  toothNumber: z.string().trim().default(""),
  restorationType: z.string().trim().min(1),
  restorationSubtype: z.string().trim().nullish(),
  material: z.string().nullish(),
  shade: z.string().nullish(),
  quantity: z.number().int().positive().max(99).default(1),
});

const previewDraftInvoiceSchema = z.object({
  labOrganizationId: z.string().min(1),
  providerOrganizationId: z.string().nullish(),
  doctorName: z.string().nullish(),
  bridgeConnectors: z.string().nullish(),
  restorations: z.array(previewRestorationSchema).max(64),
});

router.post(
  "/preview-draft",
  asyncHandler(async (req, res) => {
    const input = previewDraftInvoiceSchema.parse(req.body);
    const auth = (req as any).auth;
    await requireMembership(auth.userId, input.labOrganizationId);

    const doctorName = (input.doctorName ?? "").trim();
    const providerOrganizationId = input.providerOrganizationId ?? undefined;

    // Batch-resolve every standard price key once (mirrors POST /cases). The
    // preview never carries user-supplied prices, so auto-pricing always runs.
    const batchPriceMap = new Map<string, ResolvedItemRow>();
    if (input.restorations.length > 0) {
      const allPrices = await resolveAllPricesForContext({
        labOrganizationId: input.labOrganizationId,
        doctorName,
        providerOrganizationId,
      });
      for (const p of allPrices) batchPriceMap.set(p.key, p);
    }

    // Resolve each restoration's price + source exactly like the create path,
    // assigning a synthetic stable id (its index) so the grouping helper can
    // attribute each produced line back to its source restoration.
    const priced = await Promise.all(
      input.restorations.map(async (r, idx) => {
        let unit = 0;
        let priceSource: string | null = null;
        let priceKey: string | null = null;
        const key = await resolveRestorationPriceKey({
          labOrganizationId: input.labOrganizationId,
          material: r.material ?? null,
          restorationType: r.restorationType,
          restorationSubtype: r.restorationSubtype,
        });
        if (key !== null && batchPriceMap.has(key)) {
          const batchHit = batchPriceMap.get(key)!;
          if (batchHit.source !== null && batchHit.unitPrice > 0) {
            unit = batchHit.unitPrice;
            priceSource = batchHit.source;
            priceKey = batchHit.key;
          }
        } else {
          const fallback = await resolveServerPriceWithSource(
            {
              labOrganizationId: input.labOrganizationId,
              doctorName,
              providerOrganizationId,
            },
            r.material ?? null,
            r.restorationType,
            r.restorationSubtype,
          );
          if (fallback) {
            unit = fallback.amount;
            priceSource = fallback.source;
            priceKey = fallback.key;
          }
        }
        return {
          id: String(idx),
          toothNumber: r.toothNumber ?? "",
          restorationType: r.restorationType,
          material: r.material ?? null,
          quantity: r.quantity,
          unitPrice: unit.toFixed(2),
          priceSource,
          priceKey,
        };
      }),
    );

    // When the lab has opted into autoAddAlloyOnPfm, synthesize an alloy
    // restoration row for each PFM/FCM tooth in the preview. These synthetic
    // rows are always $0 with no price source, so buildBridgeAwareLineItems
    // will attach them as $0 child sub-items under their matching PFM/FCM
    // parent lines — exactly mirroring what addAlloyChargeToCase + invoice
    // sync produce after the real case is created.
    const labOrgForAlloy = await db.query.organizations.findFirst({
      where: eq(organizations.id, input.labOrganizationId),
      columns: { autoAddAlloyOnPfm: true },
    });
    const autoAddAlloy = labOrgForAlloy?.autoAddAlloyOnPfm ?? false;

    const allRestorations = [...priced];
    if (autoAddAlloy) {
      for (const p of priced) {
        const tooth = (p.toothNumber ?? "").trim();
        if (
          isPfmOrFcmMaterial(p.material) &&
          tooth &&
          tooth !== "N/A" &&
          /^\d+$/.test(tooth)
        ) {
          allRestorations.push({
            id: `alloy-synth-${p.id}`,
            toothNumber: tooth,
            restorationType: "Alloy",
            material: null,
            quantity: 1,
            unitPrice: "0.00",
            priceSource: null,
            priceKey: "alloy",
          });
        }
      }
    }

    // Map synthetic id → resolved source so produced lines can report pricing.
    const sourceById = new Map(
      allRestorations.map((p) => [p.id, { priceSource: p.priceSource, priceKey: p.priceKey }]),
    );

    const grouped = buildBridgeAwareLineItems(
      allRestorations.map((p) => ({
        id: p.id,
        toothNumber: p.toothNumber,
        restorationType: p.restorationType,
        material: p.material,
        quantity: p.quantity,
        unitPrice: p.unitPrice,
      })),
      input.bridgeConnectors ?? null,
      false,
    );

    const lineItems = grouped.map((line) => {
      const src = line.caseRestorationId
        ? sourceById.get(line.caseRestorationId)
        : undefined;
      const priceSource = src?.priceSource ?? null;
      const priceKey = src?.priceKey ?? null;
      const isPriced = priceSource !== null && Number(line.unitPrice) > 0;
      // Synthetic restoration ids are the input array indices (see `priced`
      // above). Surface them so the desktop preview can map a user's inline
      // price edit on a grouped line back to the exact source restorations and
      // thread the override into POST /cases.
      // NB: alloy-synth-* ids are NaN and filtered out — they must not appear
      // in restorationIndices since they are child sub-items, not parent lines.
      const restorationIndices = line.groupedRestorationIds
        .map((id) => Number(id))
        .filter((n) => Number.isInteger(n));
      // Expose child sub-items (Layered Porcelain $37 for PFZ; Alloy $0 for
      // PFM/FCM) in the preview so the UI renders them beneath the parent line
      // before case save. Include priced:false on alloy children so the UI can
      // show the pre-create warning banner.
      const subItems = (line.childItems ?? []).map((c) => ({
        description: c.description,
        quantity: c.quantity,
        unitPrice: c.unitPrice,
        lineTotal: c.lineTotal,
        ...(c.priced === false ? { priced: false as const } : {}),
      }));
      return {
        description: line.description,
        toothNumber: line.toothNumber,
        toothLabel: line.toothLabel,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        priceSource,
        priceKey,
        priced: isPriced,
        restorationIndices,
        ...(subItems.length > 0 ? { subItems } : {}),
      };
    });

    // Include child item totals (e.g. Layered Porcelain $37) in the subtotal.
    const subtotal = sumMoney([
      ...lineItems.map((l) => l.lineTotal),
      ...lineItems.flatMap((l) => ((l as any).subItems ?? []).map((s: any) => s.lineTotal)),
    ]);
    return ok(res, {
      lineItems,
      subtotal,
      total: subtotal,
    });
  }),
);

export default router;
