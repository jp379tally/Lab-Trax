import { Router } from "express";
import multer from "multer";
import { normalizePhoneE164 } from "../lib/account-link-sms";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { and, asc, desc, eq, gte, lte, ne, or, sql, sum } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
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
  practiceStatements,
  practiceStatementSends,
  organizationMemberships,
  organizations,
  payments,
  users,
} from "@workspace/db";
import { getProviderOrgIdsForUserAndLinks } from "../lib/cross-lab-doctor";
import { inArray, isNull } from "drizzle-orm";
import { ensureInvoiceDeposit } from "../lib/invoice-deposits";
import { writeAuditLog } from "../lib/audit";
import { calculateLineTotal, sumMoney } from "../lib/case";
import { HttpError, ok } from "../lib/http";
import { createTransport, getMailerConfig } from "../lib/mailer";
import {
  generateStatementPdfBuffer,
  type PracticeStatementData,
} from "../lib/statements";
import { ADMIN_ROLES, BILLING_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth, requireVerifiedAccount } from "../middlewares/auth";
import {
  buildLineItemDescription,
  materialToPriceKey,
  resolveItemLabel,
} from "../lib/pricing";
import { invoiceDueDate } from "../lib/invoice-due-date";

const router = Router();
router.use(requireAuth);
router.use(requireVerifiedAccount);

const emailStatementSchema = z.object({
  labOrganizationId: z.string().min(1),
  practiceOrganizationId: z.string().min(1),
  invoiceIds: z.array(z.string().min(1)).min(1).max(500),
  to: z.string().email().optional(),
  cc: z.array(z.string().email()).max(10).optional(),
  subject: z.string().min(1).max(500),
  message: z.string().min(1).max(20000),
  filename: z.string().min(1).max(200),
  pdfBase64: z.string().min(1).max(8 * 1024 * 1024),
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

    let pdfBuffer: Buffer;
    try {
      pdfBuffer = Buffer.from(input.pdfBase64, "base64");
    } catch {
      throw new HttpError(400, "Invalid PDF payload.");
    }
    if (pdfBuffer.length === 0) {
      throw new HttpError(400, "Invalid PDF payload.");
    }

    const transporter = createTransport(cfg);
    try {
      await transporter.sendMail({
        from: cfg.from,
        to: recipient,
        cc: input.cc?.length ? input.cc : undefined,
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
      req.log?.error?.({ err }, "[STATEMENT EMAIL] sendMail failed");
      throw new HttpError(
        502,
        "Failed to send the email. Check SMTP settings and try again.",
      );
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
      );
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

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!sid || !token || !from) {
      throw new HttpError(503, "SMS is not configured on the server.");
    }

    const params = new URLSearchParams();
    params.set("From", from);
    params.set("To", recipient);
    params.set("Body", input.message);

    let twilioError: string | null = null;
    try {
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        },
      );
      if (!r.ok) {
        twilioError = `Twilio HTTP ${r.status}`;
      }
    } catch (err: any) {
      twilioError = err?.message || "SMS failed.";
    }

    if (twilioError) {
      throw new HttpError(502, twilioError);
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
        cc: input.cc?.length ? input.cc : undefined,
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
      req.log?.error?.({ err }, "[INVOICE EMAIL] sendMail failed");
      throw new HttpError(
        502,
        "Failed to send the email. Check SMTP settings and try again.",
      );
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
      });
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

    const recipient = (input.to ?? (practice as any).phone ?? "").trim();
    if (!recipient) {
      throw new HttpError(
        400,
        "This practice has no phone number on file. Add one first or enter a number.",
      );
    }

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!sid || !token || !from) {
      throw new HttpError(503, "SMS is not configured on the server. Ask an administrator to set Twilio credentials.");
    }

    const params = new URLSearchParams();
    params.set("From", from);
    params.set("To", recipient);
    params.set("Body", input.message);

    let twilioError: string | null = null;
    try {
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        },
      );
      if (!r.ok) {
        twilioError = `Twilio HTTP ${r.status}`;
      }
    } catch (err: any) {
      twilioError = err?.message || "SMS failed.";
    }

    if (twilioError) {
      throw new HttpError(502, `Failed to send SMS. ${twilioError}`);
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
      });
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

    const [invoice] = await db
      .insert(invoices)
      .values({
        invoiceNumber: input.invoiceNumber,
        labOrganizationId: input.labOrganizationId,
        providerOrganizationId: input.providerOrganizationId,
        status: "draft",
        issuedAt: input.issuedAt ? new Date(input.issuedAt) : new Date(),
        dueAt: input.dueAt
          ? new Date(input.dueAt)
          : invoiceDueDate(input.issuedAt ? new Date(input.issuedAt) : new Date()),
        createdByUserId: (req as any).auth.userId,
        updatedByUserId: (req as any).auth.userId,
      })
      .returning();

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
      const [invoice] = await db
        .insert(invoices)
        .values({
          invoiceNumber,
          caseId: found.id,
          labOrganizationId: found.labOrganizationId,
          providerOrganizationId: found.providerOrganizationId,
          status: "draft",
          displayMetadataJson,
          dueAt: invoiceDueDate(new Date()),
          createdByUserId: (req as any).auth.userId,
          updatedByUserId: (req as any).auth.userId,
        })
        .onConflictDoNothing({ target: [invoices.labOrganizationId, invoices.invoiceNumber] })
        .returning();

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
        const pk = materialToPriceKey(r.material, r.restorationType) ?? r.restorationType;
        if (!(pk in backfillLabelCache)) {
          backfillLabelCache[pk] = await resolveItemLabel(found.labOrganizationId, pk);
        }
      }
      const itemsToInsert = restorations.map((restoration, index) => {
        const pk = materialToPriceKey(restoration.material, restoration.restorationType) ?? restoration.restorationType;
        const label = backfillLabelCache[pk] ?? restoration.restorationType;
        const toothInt = parseInt(restoration.toothNumber, 10);
        return {
          invoiceId: invoice.id,
          caseRestorationId: restoration.id,
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
      });
      await db.insert(invoiceLineItems).values(itemsToInsert);

      const subtotal = sumMoney(itemsToInsert.map((item) => item.lineTotal));
      await db
        .update(invoices)
        .set({
          subtotal,
          total: subtotal,
          balanceDue: subtotal,
          updatedByUserId: (req as any).auth.userId,
          issuedAt: new Date(),
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
      });

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
          status: "draft",
          displayMetadataJson,
          ...(bodyLayoutPresetId ? { layoutPresetId: bodyLayoutPresetId } : {}),
          dueAt: invoiceDueDate(new Date()),
          createdByUserId: userId,
          updatedByUserId: userId,
        })
        .onConflictDoNothing({ target: [invoices.labOrganizationId, invoices.invoiceNumber] })
        .returning();

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
        // When the existing invoice has caseId=null it was created via the
        // legacy mobile path before this case was promoted to canonical.
        // Link it to the canonical case now instead of refusing with a
        // collision error — idempotent: if called again after linking it
        // will already have caseId=found.id and this branch won't fire.
        if (targetInvoice.caseId === null) {
          await db
            .update(invoices)
            .set({ caseId: found.id, updatedByUserId: userId })
            .where(eq(invoices.id, targetInvoice.id));
          (targetInvoice as any).caseId = found.id;
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
          const pk = materialToPriceKey(r.material, r.restorationType) ?? r.restorationType;
          if (!(pk in genLabelCache)) {
            genLabelCache[pk] = await resolveItemLabel(found.labOrganizationId, pk);
          }
        }
        const itemsToInsert = restorations.map((restoration, index) => {
          const pk = materialToPriceKey(restoration.material, restoration.restorationType) ?? restoration.restorationType;
          const label = genLabelCache[pk] ?? restoration.restorationType;
          const toothInt = parseInt(restoration.toothNumber, 10);
          return {
            invoiceId: targetInvoice.id,
            caseRestorationId: restoration.id,
            toothNumber: Number.isInteger(toothInt) && toothInt >= 1 && toothInt <= 32 ? toothInt : null,
            description: buildLineItemDescription(restoration.toothNumber, label),
            quantity: restoration.quantity,
            unitPrice: restoration.unitPrice,
            lineTotal: calculateLineTotal(restoration.quantity, restoration.unitPrice),
            sortOrder: index,
          };
        });
        await db.insert(invoiceLineItems).values(itemsToInsert);
      }

      const items = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.invoiceId, targetInvoice.id),
        orderBy: [invoiceLineItems.sortOrder],
      });
      const subtotal = sumMoney(items.map((item) => item.lineTotal));

      const [updatedInvoice] = await db
        .update(invoices)
        .set({
          subtotal,
          total: subtotal,
          balanceDue: subtotal,
          updatedByUserId: userId,
          // Empty drafts stay in "draft" with no issuedAt; only invoices
          // with at least one line item are auto-issued to "open".
          // Preserve an existing dueAt when re-generating; only default to
          // 10th-of-next-month when dueAt is not already set.
          ...(hasRestorations
            ? {
                issuedAt: new Date(),
                status: "open" as const,
                dueAt: targetInvoice.dueAt ?? invoiceDueDate(new Date()),
              }
            : {}),
        })
        .where(eq(invoices.id, targetInvoice.id))
        .returning();

      const user = (req as any).user;
      await db.insert(caseEvents).values({
        caseId: found.id,
        eventType: "invoice_generated",
        actorUserId: userId,
        actorOrganizationId: found.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          invoiceId: updatedInvoice.id,
          invoiceNumber: updatedInvoice.invoiceNumber,
        },
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
        status: "draft",
        displayMetadataJson,
        ...(bodyLayoutPresetId ? { layoutPresetId: bodyLayoutPresetId } : {}),
        dueAt: invoiceDueDate(new Date()),
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .onConflictDoNothing({ target: [invoices.labOrganizationId, invoices.invoiceNumber] })
      .returning();

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
        });
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
  "/",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const memberships =
      await db.query.organizationMemberships.findMany({
        where: eq(organizationMemberships.userId, callerId),
      });
    const baseOrgIds = memberships
      .filter((m: any) => m.status === "active")
      .map((m: any) => m.labId);

    // Cross-lab doctor expansion (Task #320). Provider users see invoices
    // for every linked-doctor copy of themselves; lab users see only
    // their own lab.
    let orgIds = baseOrgIds;
    const callerUser = await db.query.users.findFirst({
      where: eq(users.id, callerId),
    });
    if (callerUser?.userType === "provider") {
      const { providerOrgIds } = await getProviderOrgIdsForUserAndLinks(
        callerId
      );
      orgIds = Array.from(new Set([...baseOrgIds, ...providerOrgIds]));
    }

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
    const statusFilter =
      typeof req.query.status === "string" && req.query.status
        ? req.query.status
        : null; // values: "open" | "all" | specific status
    const statusList =
      statusFilter === "open"
        ? ["open", "partially_paid"]
        : statusFilter && statusFilter !== "all"
          ? statusFilter.split(",").map((s) => s.trim()).filter(Boolean)
          : null;
    const dateFromFilter =
      typeof req.query.dateFrom === "string" && req.query.dateFrom
        ? new Date(req.query.dateFrom)
        : null;
    const dateToFilter =
      typeof req.query.dateTo === "string" && req.query.dateTo
        ? new Date(req.query.dateTo)
        : null;
    const minAmount =
      typeof req.query.minAmount === "string" && req.query.minAmount
        ? Number(req.query.minAmount)
        : null;
    const maxAmount =
      typeof req.query.maxAmount === "string" && req.query.maxAmount
        ? Number(req.query.maxAmount)
        : null;
    const aiOnly = req.query.aiOnly === "true";
    const overdueBucket =
      typeof req.query.overdueBucket === "string" && req.query.overdueBucket
        ? req.query.overdueBucket // "0_30" | "31_60" | "61_90" | "90_plus"
        : null;

    const [rows, mobileCaseRows] = await Promise.all([
      orgIds.length
        ? db.query.invoices.findMany({
            where: and(
              caseIdFilter ? eq(invoices.caseId, caseIdFilter) : undefined,
              practiceIdFilter
                ? eq(invoices.providerOrganizationId, practiceIdFilter)
                : undefined,
              practiceIdsFilter && practiceIdsFilter.length
                ? inArray(invoices.providerOrganizationId, practiceIdsFilter)
                : undefined,
              labIdFilter
                ? eq(invoices.labOrganizationId, labIdFilter)
                : undefined,
              statusList && statusList.length
                ? inArray(invoices.status, statusList)
                : undefined,
              dateFromFilter && !Number.isNaN(dateFromFilter.getTime())
                ? gte(invoices.createdAt, dateFromFilter)
                : undefined,
              dateToFilter && !Number.isNaN(dateToFilter.getTime())
                ? lte(invoices.createdAt, dateToFilter)
                : undefined,
              aiOnly ? eq(invoices.aiGenerated, true) : undefined,
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
        mobileInvoices.push(toMobileInvoice(lc, parsed, localInvoiceId));
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
    const enrich = (r: any) => ({
      ...r,
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
        String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))
    );

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

    return ok(res, enriched);
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

    // Caller must be a member of either side.
    const labMember = labOrganizationId
      ? await requireMembership(callerId, labOrganizationId).catch(() => null)
      : null;
    const providerMember = await requireMembership(
      callerId,
      providerOrganizationId,
    ).catch(() => null);
    if (!labMember && !providerMember) {
      throw new HttpError(403, "You do not have access to this practice.");
    }

    const rows = await db.query.invoices.findMany({
      where: and(
        eq(invoices.providerOrganizationId, providerOrganizationId),
        labOrganizationId
          ? eq(invoices.labOrganizationId, labOrganizationId)
          : undefined,
        isNull(invoices.deletedAt),
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
  return {
    id: `mobile:${localInvoiceId}`,
    invoiceNumber,
    caseId: lc.id,
    labOrganizationId: lc.organizationId as string,
    providerOrganizationId: null as string | null,
    status: "open" as const,
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

    const rows = await db.query.invoices.findMany({
      where: and(
        isNull(invoices.deletedAt),
        eq(invoices.providerOrganizationId, query.providerOrganizationId),
        eq(invoices.labOrganizationId, query.labOrganizationId),
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

    const result = await db.transaction(async (tx) => {
      const invoiceIds = input.applications.map((a) => a.invoiceId);
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

      const refLabel = input.referenceNumber
        ? ` (#${input.referenceNumber})`
        : "";
      const [deposit] = await tx
        .insert(bankTransactions)
        .values({
          labOrganizationId: input.labOrganizationId,
          bankAccountId: depositAccount.id,
          txnDate,
          type: "deposit",
          payee: `Customer payment${refLabel}`,
          memo:
            input.memo ||
            `Payment applied to ${updatedInvoices.length} invoice${
              updatedInvoices.length === 1 ? "" : "s"
            }`,
          debitAmount: "0.00",
          creditAmount: totalToApply.toFixed(2),
          netAmount: totalToApply.toFixed(2),
          cleared: false,
          status: "posted",
          source: "invoice",
          createdByUserId: callerId,
        })
        .returning();
      for (const inv of updatedInvoices) {
        await tx.insert(bankTransactionInvoices).values({
          bankTransactionId: deposit.id,
          invoiceId: inv.id,
        });
      }

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

    return ok(res, result, 201);
  })
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

  // Scope the case scan to the caller's own labs (mirrors GET /api/invoices).
  const memberships = await db.query.organizationMemberships.findMany({
    where: eq(organizationMemberships.userId, callerId),
  });
  let orgIds = memberships
    .filter((m: any) => m.status === "active")
    .map((m: any) => m.labId)
    .filter((id: any): id is string => !!id);
  const callerUser = await db.query.users.findFirst({
    where: eq(users.id, callerId),
  });
  if (callerUser?.userType === "provider") {
    const { providerOrgIds } = await getProviderOrgIdsForUserAndLinks(callerId);
    orgIds = Array.from(new Set([...orgIds, ...providerOrgIds]));
  }
  if (orgIds.length === 0)
    throw new HttpError(404, "Invoice not found.");

  const caseRows = await db
    .select()
    .from(labCases)
    .where(
      and(isNull(labCases.deletedAt), inArray(labCases.organizationId, orgIds))
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

  const [newInvoice] = await db
    .insert(invoices)
    .values({
      invoiceNumber: nextInvoiceNumber(legacyCaseNumber),
      caseId: null,
      labOrganizationId: matched.orgId,
      providerOrganizationId: null,
      status: "draft",
      displayMetadataJson,
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
      });
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

    const labMember = await requireMembership(
      (req as any).auth.userId,
      invoice.labOrganizationId
    ).catch(() => null);
    const providerMember = invoice.providerOrganizationId
      ? await requireMembership(
          (req as any).auth.userId,
          invoice.providerOrganizationId
        ).catch(() => null)
      : null;
    if (!labMember && !providerMember)
      throw new HttpError(403, "You do not have access to this invoice.");

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

    const topLevelItems = items.filter((it) => it.parentLineItemId == null);
    const subItemsByParent = new Map<string, typeof items>();
    for (const it of items) {
      if (it.parentLineItemId) {
        const arr = subItemsByParent.get(it.parentLineItemId) ?? [];
        arr.push(it);
        subItemsByParent.set(it.parentLineItemId, arr);
      }
    }
    const nestedItems = topLevelItems.map((it) => ({
      ...it,
      subItems: subItemsByParent.get(it.id) ?? [],
    }));

    return ok(res, {
      ...invoice,
      items: nestedItems,
      payments: safePaymentRows,
      linkedTransactions: labMember ? linkedTxns : [],
      caseCompletedAt,
      practiceEmail: practiceOrg?.billingEmail ?? null,
      practicePhone: practiceOrg?.phone ?? null,
      linkedCaseIsDeleted,
      linkedCaseNumber,
    });
  })
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
          .enum(["draft", "open", "partially_paid", "paid", "void"])
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
              unitPrice: z.coerce.number().min(0),
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
                    unitPrice: z.coerce.number().min(0),
                    sortOrder: z.coerce.number().int().optional(),
                  })
                )
                .optional(),
            })
          )
          .optional(),
        displayMetadata: z.record(z.any()).nullable().optional(),
        layoutPresetId: z.string().nullable().optional(),
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
      if (input.items) {
        await tx
          .delete(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, invoice.id));
        if (input.items.length) {
          const topLevelValues = input.items.map((it, idx) => ({
            invoiceId: invoice.id,
            toothNumber: it.toothNumber ?? null,
            toothLabel: it.toothLabel ?? null,
            description: it.description,
            quantity: Math.max(0, Math.round(Number(it.quantity))),
            unitPrice: Number(it.unitPrice).toFixed(2),
            lineTotal: calculateLineTotal(
              Math.max(0, Math.round(Number(it.quantity))),
              Number(it.unitPrice).toFixed(2)
            ),
            sortOrder: it.sortOrder ?? idx,
          }));
          const inserted = await tx
            .insert(invoiceLineItems)
            .values(topLevelValues)
            .returning();
          const subValues: Array<{
            invoiceId: string;
            toothNumber: number | null;
            toothLabel: string | null;
            description: string;
            quantity: number;
            unitPrice: string;
            lineTotal: string;
            sortOrder: number;
            parentLineItemId: string;
          }> = [];
          for (let i = 0; i < input.items.length; i++) {
            const parent = input.items[i];
            const parentId = inserted[i].id;
            for (const sub of (parent.subItems ?? [])) {
              subValues.push({
                invoiceId: invoice.id,
                toothNumber: sub.toothNumber ?? null,
                toothLabel: sub.toothLabel ?? null,
                description: sub.description,
                quantity: Math.max(0, Math.round(Number(sub.quantity))),
                unitPrice: Number(sub.unitPrice).toFixed(2),
                lineTotal: calculateLineTotal(
                  Math.max(0, Math.round(Number(sub.quantity))),
                  Number(sub.unitPrice).toFixed(2)
                ),
                sortOrder: sub.sortOrder ?? 0,
                parentLineItemId: parentId,
              });
            }
          }
          if (subValues.length) {
            await tx.insert(invoiceLineItems).values(subValues);
          }
        }
      }

      const items = await tx.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.invoiceId, invoice.id),
      });
      const subtotal = sumMoney(items.map((item) => item.lineTotal));
      const tax =
        input.tax !== undefined ? input.tax.toFixed(2) : invoice.tax;
      const discount =
        input.discount !== undefined
          ? input.discount.toFixed(2)
          : invoice.discount;
      // Credits live in displayMetadata.credits (a JSON-blob column).
      // They behave like an additional discount applied to the invoice
      // — the desktop editor shows them on their own row and subtracts
      // them from the visible total, so we must do the same on the
      // server or the persisted total will drift from what the user
      // saw when they hit Save.
      const incomingMeta = (input.displayMetadata ??
        (invoice as any).displayMetadataJson ??
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
      const balanceDue = (Number(total) - paid).toFixed(2);

      const newStatus = input.status ?? invoice.status;
      const [row] = await tx
        .update(invoices)
        .set({
          status: newStatus,
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
            input.displayMetadata === undefined
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
      });
    }

    if (updated.status === "paid" && invoice.status !== "paid") {
      await ensureInvoiceDeposit(
        {
          id: updated.id,
          invoiceNumber: updated.invoiceNumber,
          total: String(updated.total),
          labOrganizationId: updated.labOrganizationId,
        },
        (req as any).auth.userId
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
    await requireAnyRole(
      (req as any).auth.userId,
      invoice.labOrganizationId,
      BILLING_ROLES
    );

    const input = z
      .object({
        amount: z.coerce.number().positive(),
        paymentMethod: z.enum(["card", "ach", "check", "cash", "other"]),
        referenceNumber: z.string().optional(),
      })
      .parse(req.body);

    const [payment] = await db
      .insert(payments)
      .values({
        invoiceId: invoice.id,
        amount: input.amount.toFixed(2),
        paymentMethod: input.paymentMethod,
        referenceNumber: input.referenceNumber ?? null,
        recordedByUserId: (req as any).auth.userId,
      })
      .returning();

    const paidRows = await db
      .select({ value: sum(payments.amount) })
      .from(payments)
      .where(eq(payments.invoiceId, invoice.id));
    const paid = Number(paidRows[0]?.value ?? 0);
    const balanceDue = Math.max(
      Number(invoice.total) - paid,
      0
    ).toFixed(2);
    const status =
      balanceDue === "0.00"
        ? "paid"
        : paid > 0
        ? "partially_paid"
        : invoice.status;

    const [updatedInvoice] = await db
      .update(invoices)
      .set({
        balanceDue,
        status,
        updatedByUserId: (req as any).auth.userId,
      })
      .where(eq(invoices.id, invoice.id))
      .returning();

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
      });
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
        (req as any).auth.userId
      );
    }

    return ok(res, { payment, invoice: updatedInvoice }, 201);
  })
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
  const labMember = await requireMembership(
    callerId,
    invoice.labOrganizationId,
  ).catch(() => null);
  const providerMember = invoice.providerOrganizationId
    ? await requireMembership(callerId, invoice.providerOrganizationId).catch(() => null)
    : null;
  if (!labMember && !providerMember) {
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
      const capacity = Number(dep.creditAmount || dep.netAmount || 0);
      if (used + input.amount > capacity + 0.0001) {
        throw new HttpError(
          409,
          `Insufficient deposit balance. Remaining ${(capacity - used).toFixed(2)}, requested ${input.amount.toFixed(2)}.`,
        );
      }
    }

    const [credit] = await db
      .insert(invoiceCredits)
      .values({
        invoiceId: invoice.id,
        providerOrganizationId: invoice.providerOrganizationId,
        labOrganizationId: invoice.labOrganizationId,
        amount: input.amount.toFixed(2),
        sourceKind: input.sourceKind,
        sourceId: input.sourceId ?? null,
        note: input.note ?? null,
        appliedByUserId: callerId,
      })
      .returning();

    // Subtract from balanceDue (cap at 0).
    const newBalance = Math.max(
      0,
      Number(invoice.balanceDue) - input.amount,
    ).toFixed(2);
    const newStatus =
      Number(newBalance) === 0 && invoice.status !== "void"
        ? "paid"
        : invoice.status;
    await db
      .update(invoices)
      .set({
        balanceDue: newBalance,
        status: newStatus,
        updatedByUserId: callerId,
      })
      .where(eq(invoices.id, invoice.id));

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

    await db
      .update(invoiceCredits)
      .set({ reversedAt: new Date(), reversedByUserId: callerId })
      .where(eq(invoiceCredits.id, credit.id));

    const newBalance = (
      Number(invoice.balanceDue) + Number(credit.amount)
    ).toFixed(2);
    const newStatus = invoice.status === "paid" ? "open" : invoice.status;
    await db
      .update(invoices)
      .set({
        balanceDue: newBalance,
        status: newStatus,
        updatedByUserId: callerId,
      })
      .where(eq(invoices.id, invoice.id));

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

    const cloned = await db.transaction(async (tx) => {
      const [newInvoice] = await tx
        .insert(invoices)
        .values({
          invoiceNumber: candidate,
          caseId: original.caseId,
          labOrganizationId: original.labOrganizationId,
          providerOrganizationId: original.providerOrganizationId,
          status: "draft",
          subtotal: original.subtotal,
          tax: original.tax,
          discount: original.discount,
          total: original.total,
          balanceDue: original.total,
          notes: original.notes,
          displayMetadataJson: original.displayMetadataJson,
          sourceInvoiceId: original.id,
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
              caseRestorationId: it.caseRestorationId,
              toothNumber: it.toothNumber ?? null,
              toothLabel: it.toothLabel ?? null,
              description: it.description,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              lineTotal: it.lineTotal,
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
              caseRestorationId: it.caseRestorationId,
              toothNumber: it.toothNumber ?? null,
              toothLabel: it.toothLabel ?? null,
              description: it.description,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              lineTotal: it.lineTotal,
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
  callerId: string,
): Promise<{ reversed: boolean; transactionId: string | null }> {
  const links = await db
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
  await db
    .update(bankTransactions)
    .set({ status: "void" })
    .where(eq(bankTransactions.id, autoDeposit.bankTransactionId));
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

    const dep = input.reverseDeposit
      ? await reverseInvoiceDepositIfAny(invoice.id, callerId)
      : { reversed: false, transactionId: null };

    const [updated] = await db
      .update(invoices)
      .set({
        status: "void",
        balanceDue: "0.00",
        voidedAt: new Date(),
        voidedByUserId: callerId,
        voidReason: voidReason,
        voidKind: "void",
        updatedByUserId: callerId,
      })
      .where(eq(invoices.id, invoice.id))
      .returning();

    if (invoice.caseId) {
      const user = (req as any).user;
      await db.insert(caseEvents).values({
        caseId: invoice.caseId,
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
    const writeOffAmount = Number(invoice.balanceDue);

    // Reverse any auto-generated deposit (mirrors /void) so the bank-side
    // balance doesn't keep counting a payment for an invoice that's been
    // written off.
    const dep = input.reverseDeposit
      ? await reverseInvoiceDepositIfAny(invoice.id, callerId)
      : { reversed: false, transactionId: null };

    if (writeOffAmount > 0) {
      await db.insert(invoiceCredits).values({
        invoiceId: invoice.id,
        providerOrganizationId: invoice.providerOrganizationId,
        labOrganizationId: invoice.labOrganizationId,
        amount: writeOffAmount.toFixed(2),
        sourceKind: "writeoff",
        note: writeOffReason,
        appliedByUserId: callerId,
      });
    }

    const [updated] = await db
      .update(invoices)
      .set({
        status: "void",
        balanceDue: "0.00",
        voidedAt: new Date(),
        voidedByUserId: callerId,
        voidReason: writeOffReason,
        voidKind: "writeoff",
        updatedByUserId: callerId,
      })
      .where(eq(invoices.id, invoice.id))
      .returning();

    if (invoice.caseId) {
      const user = (req as any).user;
      await db.insert(caseEvents).values({
        caseId: invoice.caseId,
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

// Mark invoices as sent (sets issuedAt + status=open if still draft).
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
          status: row.status === "draft" ? "open" : row.status,
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

router.get(
  "/practice-statements",
  asyncHandler(async (req, res) => {
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
    if (labOrganizationId) {
      await requireMembership(callerId, labOrganizationId);
    } else if (providerOrganizationId) {
      await requireMembership(callerId, providerOrganizationId);
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
    return ok(res, rows);
  }),
);

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

  const data: PracticeStatementData = {
    practiceId: opts.providerOrganizationId,
    practiceName,
    practiceEmail: practice?.billingEmail || null,
    statementEmailOptOut: practice?.statementEmailOptOut ?? false,
    invoiceCount: opts.invoicesList.length,
    totalBilled: opts.totals.billed,
    totalPaid: opts.totals.paid,
    openBalance: opts.totals.open,
    invoices: opts.invoicesList.map((inv: any) => {
      const meta = (inv.displayMetadataJson ?? null) as
        | { patientName?: string | null; billTo?: string | null }
        | null;
      const items = liByInvoiceId.get(inv.id) ?? [];
      return {
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
          parentLineItemId: li.parentLineItemId ?? null,
          toothLabel: li.toothLabel ?? null,
          toothNumber: li.toothNumber ?? null,
          sortOrder: li.sortOrder,
        })),
      };
    }),
  };
  const periodLabel = `${opts.periodStart.toISOString().slice(0, 10)} to ${opts.periodEnd.toISOString().slice(0, 10)}`;
  const buf = await generateStatementPdfBuffer(labName, data, periodLabel, null);
  fs.mkdirSync(practiceStatementsDir, { recursive: true });
  const safeName = practiceName.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60);
  const fileName = `statement-${safeName}-${opts.statementId}.pdf`;
  const filePath = path.resolve(practiceStatementsDir, fileName);
  if (!filePath.startsWith(practiceStatementsDir + path.sep)) {
    throw new HttpError(500, "Invalid statement file path.");
  }
  fs.writeFileSync(filePath, buf);
  return { storageKey: fileName, fileName, size: buf.length };
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
          .array(z.enum(["draft", "open", "partially_paid", "paid"]))
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
    const safeKey = path.basename(stmt.pdfStorageKey);
    const pdfPath = path.resolve(practiceStatementsDir, safeKey);
    if (!pdfPath.startsWith(practiceStatementsDir + path.sep)) {
      throw new HttpError(500, "Invalid statement file path.");
    }
    const buffer = fs.readFileSync(pdfPath);
    if (buffer.length === 0) throw new HttpError(500, "Statement PDF is empty.");
    const filename = stmt.pdfFileName || "statement.pdf";

    let errorMessage: string | null = null;
    let status: "sent" | "failed" = "sent";
    try {
      const t = createTransport(cfg);
      await t.sendMail({
        from: cfg.from,
        to: recipient,
        subject: input.subject,
        text: input.message,
        attachments: [
          {
            filename: filename.endsWith(".pdf") ? filename : `${filename}.pdf`,
            content: buffer,
            contentType: "application/pdf",
          },
        ],
      });
    } catch (err: any) {
      status = "failed";
      errorMessage = err?.message || "Email failed.";
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
    if (!stmt.pdfStorageKey) {
      throw new HttpError(409, "Statement PDF was not generated.");
    }
    const safeKey = path.basename(stmt.pdfStorageKey);
    const pdfPath = path.resolve(practiceStatementsDir, safeKey);
    if (!pdfPath.startsWith(practiceStatementsDir + path.sep)) {
      throw new HttpError(500, "Invalid statement file path.");
    }
    if (!fs.existsSync(pdfPath)) throw new HttpError(404, "PDF file missing.");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${stmt.pdfFileName || "statement.pdf"}"`,
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

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!sid || !token || !from) {
      throw new HttpError(503, "SMS is not configured on the server.");
    }
    const params = new URLSearchParams();
    params.set("From", from);
    params.set("To", toE164);
    params.set("Body", input.message);
    let status: "sent" | "failed" = "sent";
    let errorMessage: string | null = null;
    try {
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization:
              "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        },
      );
      if (!r.ok) {
        status = "failed";
        errorMessage = `Twilio HTTP ${r.status}`;
      }
    } catch (err: any) {
      status = "failed";
      errorMessage = err?.message || "SMS failed.";
    }
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
        // Mark as sent
        if (invoice.status === "draft") {
          await db
            .update(invoices)
            .set({ status: "open", issuedAt: invoice.issuedAt ?? new Date() })
            .where(eq(invoices.id, invoice.id));
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

    const rows = await db.query.invoices.findMany({
      where: and(
        eq(invoices.labOrganizationId, query.organizationId),
        query.dateFrom
          ? gte(invoices.createdAt, new Date(query.dateFrom))
          : undefined,
        query.dateTo
          ? lte(invoices.createdAt, new Date(query.dateTo))
          : undefined
      ),
    });

    const totalSales = rows
      .reduce((acc, row) => acc + Number(row.total), 0)
      .toFixed(2);
    const openBalance = rows
      .reduce((acc, row) => acc + Number(row.balanceDue), 0)
      .toFixed(2);

    return ok(res, {
      totalSales,
      openBalance,
      invoices: rows.length,
      paidInvoices: rows.filter((row) => row.status === "paid").length,
      openInvoices: rows.filter(
        (row) => row.status !== "paid" && row.status !== "void"
      ).length,
    });
  })
);

// ───────── Reports: Sales time series (Task #381) ─────────
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

    const issued = sql<Date>`COALESCE(${invoices.issuedAt}, ${invoices.createdAt})`;
    const rows = (await db
      .select({
        issued,
        subtotal: invoices.subtotal,
        discount: invoices.discount,
        tax: invoices.tax,
        total: invoices.total,
        status: invoices.status,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.labOrganizationId, q.organizationId),
          isNull(invoices.deletedAt),
          gte(issued, from),
          lte(issued, to),
        ),
      )) as Array<{
      issued: string | Date;
      subtotal: string;
      discount: string;
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
        count: number;
      }
    >();
    let tGross = 0;
    let tDiscounts = 0;
    let tNet = 0;
    let tTax = 0;
    let tCount = 0;
    for (const r of rows) {
      if (r.status === "void") continue;
      const d = new Date(r.issued as string);
      if (Number.isNaN(d.getTime())) continue;
      const { key, start } = bucketKey(d);
      const subtotal = Number(r.subtotal || 0);
      const discount = Number(r.discount || 0);
      const tax = Number(r.tax || 0);
      const net = subtotal - discount; // pre-tax revenue
      const gross = subtotal;
      const cur =
        buckets.get(key) ??
        {
          periodStart: start.toISOString(),
          gross: 0,
          discounts: 0,
          net: 0,
          tax: 0,
          count: 0,
        };
      cur.gross += gross;
      cur.discounts += discount;
      cur.net += net;
      cur.tax += tax;
      cur.count += 1;
      buckets.set(key, cur);
      tGross += gross;
      tDiscounts += discount;
      tNet += net;
      tTax += tax;
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
        count: b.count,
        avg: b.count ? (b.net / b.count).toFixed(2) : "0.00",
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
        count: tCount,
        avg: tCount ? (tNet / tCount).toFixed(2) : "0.00",
      },
    });
  }),
);

export default router;
