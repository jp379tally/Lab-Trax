import { Router } from "express";
import { and, desc, eq, gte, lte, or, sum } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  bankAccounts,
  bankTransactionInvoices,
  bankTransactions,
  caseEvents,
  caseRestorations,
  cases,
  invoiceLineItems,
  invoices,
  organizationMemberships,
  organizations,
  payments,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { ensureInvoiceDeposit } from "../lib/invoice-deposits";
import { writeAuditLog } from "../lib/audit";
import { calculateLineTotal, sumMoney } from "../lib/case";
import { HttpError, ok } from "../lib/http";
import { createTransport, getMailerConfig } from "../lib/mailer";
import { ADMIN_ROLES, BILLING_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

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

const emailInvoiceSchema = z.object({
  to: z.string().email().optional(),
  cc: z.array(z.string().email()).max(10).optional(),
  subject: z.string().min(1).max(500),
  message: z.string().min(1).max(20000),
  filename: z.string().min(1).max(200),
  pdfBase64: z.string().min(1).max(8 * 1024 * 1024),
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
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
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
      const [invoice] = await db
        .insert(invoices)
        .values({
          invoiceNumber,
          caseId: found.id,
          labOrganizationId: found.labOrganizationId,
          providerOrganizationId: found.providerOrganizationId,
          status: "draft",
          createdByUserId: (req as any).auth.userId,
          updatedByUserId: (req as any).auth.userId,
        })
        .onConflictDoNothing()
        .returning();

      if (!invoice) {
        // Invoice number collided with a row not linked to this case (e.g.
        // a manual invoice created with the same number). Do nothing — we
        // refuse to silently retitle or relink an existing invoice.
        skippedNumberTaken++;
        continue;
      }

      const itemsToInsert = restorations.map((restoration, index) => ({
        invoiceId: invoice.id,
        caseRestorationId: restoration.id,
        description: `${restoration.restorationType} - Tooth ${restoration.toothNumber}`,
        quantity: restoration.quantity,
        unitPrice: restoration.unitPrice,
        lineTotal: calculateLineTotal(
          restoration.quantity,
          restoration.unitPrice
        ),
        sortOrder: index,
      }));
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

router.post(
  "/cases/:caseId/generate-invoice",
  asyncHandler(async (req, res) => {
    const found = await db.query.cases.findFirst({
      where: eq(cases.id, req.params.caseId),
    });
    if (!found) throw new HttpError(404, "Case not found.");
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      BILLING_ROLES
    );

    const restorations = await db.query.caseRestorations.findMany({
      where: eq(caseRestorations.caseId, found.id),
    });
    if (!restorations.length)
      throw new HttpError(
        400,
        "Cannot generate an invoice with no restorations."
      );

    const [invoice] = await db
      .insert(invoices)
      .values({
        invoiceNumber: nextInvoiceNumber(found.caseNumber),
        caseId: found.id,
        labOrganizationId: found.labOrganizationId,
        providerOrganizationId: found.providerOrganizationId,
        status: "draft",
        createdByUserId: (req as any).auth.userId,
        updatedByUserId: (req as any).auth.userId,
      })
      .onConflictDoNothing()
      .returning();

    const targetInvoice =
      invoice ??
      (await db.query.invoices.findFirst({
        where: eq(
          invoices.invoiceNumber,
          nextInvoiceNumber(found.caseNumber)
        ),
      }));
    if (!targetInvoice)
      throw new HttpError(500, "Invoice could not be generated.");

    if (invoice) {
      const itemsToInsert = restorations.map((restoration, index) => ({
        invoiceId: targetInvoice.id,
        caseRestorationId: restoration.id,
        description: `${restoration.restorationType} - Tooth ${restoration.toothNumber}`,
        quantity: restoration.quantity,
        unitPrice: restoration.unitPrice,
        lineTotal: calculateLineTotal(
          restoration.quantity,
          restoration.unitPrice
        ),
        sortOrder: index,
      }));
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
        updatedByUserId: (req as any).auth.userId,
        issuedAt: new Date(),
        status: "open",
      })
      .where(eq(invoices.id, targetInvoice.id))
      .returning();

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "invoice_generated",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        invoiceId: updatedInvoice.id,
        invoiceNumber: updatedInvoice.invoiceNumber,
      },
    });

    return ok(res, updatedInvoice, invoice ? 201 : 200);
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const memberships =
      await db.query.organizationMemberships.findMany({
        where: eq(
          organizationMemberships.userId,
          (req as any).auth.userId
        ),
      });
    const orgIds = memberships
      .filter((m: any) => m.status === "active")
      .map((m: any) => m.labId);

    const caseIdFilter =
      typeof req.query.caseId === "string" && req.query.caseId
        ? req.query.caseId
        : null;

    const rows = orgIds.length
      ? await db.query.invoices.findMany({
          where: and(
            caseIdFilter ? eq(invoices.caseId, caseIdFilter) : undefined,
            or(
              ...orgIds.flatMap((orgId: string) => [
                eq(invoices.labOrganizationId, orgId),
                eq(invoices.providerOrganizationId, orgId),
              ])
            )
          ),
          orderBy: [desc(invoices.createdAt)],
        })
      : [];

    if (!rows.length) return ok(res, []);
    const orgIdsToFetch = Array.from(
      new Set(
        rows.flatMap((r: any) => [r.providerOrganizationId, r.labOrganizationId])
      )
    );
    const orgRows = orgIdsToFetch.length
      ? await db.select().from(organizations).where(inArray(organizations.id, orgIdsToFetch))
      : [];
    const orgsById = new Map(orgRows.map((o: any) => [o.id, o]));
    const enriched = rows.map((r: any) => ({
      ...r,
      providerOrganization: orgsById.get(r.providerOrganizationId)
        ? {
            id: r.providerOrganizationId,
            name:
              orgsById.get(r.providerOrganizationId)!.displayName ||
              orgsById.get(r.providerOrganizationId)!.name,
          }
        : null,
      labOrganization: orgsById.get(r.labOrganizationId)
        ? {
            id: r.labOrganizationId,
            name:
              orgsById.get(r.labOrganizationId)!.displayName ||
              orgsById.get(r.labOrganizationId)!.name,
          }
        : null,
    }));
    return ok(res, enriched);
  })
);

router.get(
  "/:invoiceId",
  asyncHandler(async (req, res) => {
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, req.params.invoiceId),
    });
    if (!invoice) throw new HttpError(404, "Invoice not found.");

    const labMember = await requireMembership(
      (req as any).auth.userId,
      invoice.labOrganizationId
    ).catch(() => null);
    const providerMember = await requireMembership(
      (req as any).auth.userId,
      invoice.providerOrganizationId
    ).catch(() => null);
    if (!labMember && !providerMember)
      throw new HttpError(403, "You do not have access to this invoice.");

    const items = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.invoiceId, invoice.id),
      orderBy: [invoiceLineItems.sortOrder],
    });
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
    return ok(res, {
      ...invoice,
      items,
      payments: safePaymentRows,
      linkedTransactions: labMember ? linkedTxns : [],
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
        items: z
          .array(
            z.object({
              id: z.string().optional(),
              description: z.string().min(1),
              quantity: z.coerce.number().min(0),
              unitPrice: z.coerce.number().min(0),
              sortOrder: z.coerce.number().int().optional(),
            })
          )
          .optional(),
        displayMetadata: z.record(z.any()).nullable().optional(),
      })
      .parse(req.body);

    const updated = await db.transaction(async (tx) => {
      if (input.items) {
        await tx
          .delete(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, invoice.id));
        if (input.items.length) {
          await tx.insert(invoiceLineItems).values(
            input.items.map((it, idx) => ({
              invoiceId: invoice.id,
              description: it.description,
              quantity: Math.max(0, Math.round(Number(it.quantity))),
              unitPrice: Number(it.unitPrice).toFixed(2),
              lineTotal: calculateLineTotal(
                Math.max(0, Math.round(Number(it.quantity))),
                Number(it.unitPrice).toFixed(2)
              ),
              sortOrder: it.sortOrder ?? idx,
            }))
          );
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
      const total = (
        Number(subtotal) +
        Number(tax) -
        Number(discount)
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
          displayMetadataJson:
            input.displayMetadata === undefined
              ? invoice.displayMetadataJson
              : input.displayMetadata,
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

export default router;
