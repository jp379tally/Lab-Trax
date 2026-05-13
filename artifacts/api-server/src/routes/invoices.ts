import { Router } from "express";
import { and, asc, desc, eq, gte, lte, or, sql, sum } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  bankAccounts,
  bankTransactionInvoices,
  bankTransactions,
  caseEvents,
  caseNotes,
  caseRestorations,
  cases,
  invoiceLineItems,
  invoices,
  labCases,
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

  const caseNotesText = noteRows
    .map((n) => (n.noteText ?? "").trim())
    .filter(Boolean)
    .join("\n\n");

  return {
    patientName,
    billTo: (caseRow.doctorName ?? "").trim(),
    teeth,
    shade,
    caseNotes: caseNotesText,
  };
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

    const [invoice] = await db
      .insert(invoices)
      .values({
        invoiceNumber: nextInvoiceNumber(found.caseNumber),
        caseId: found.id,
        labOrganizationId: found.labOrganizationId,
        providerOrganizationId: found.providerOrganizationId,
        status: "draft",
        displayMetadataJson,
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

    if (invoice && hasRestorations) {
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
        // Empty drafts stay in "draft" with no issuedAt; only invoices
        // with at least one line item are auto-issued to "open".
        ...(hasRestorations
          ? { issuedAt: new Date(), status: "open" as const }
          : {}),
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

    const [rows, mobileCaseRows] = await Promise.all([
      orgIds.length
        ? db.query.invoices.findMany({
            where: and(
              caseIdFilter ? eq(invoices.caseId, caseIdFilter) : undefined,
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
    const enriched = [...rows.map(enrich), ...mobileInvoices.map(enrich)].sort(
      (a: any, b: any) =>
        String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))
    );
    return ok(res, enriched);
  })
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
    ? `M-${caseNumber}`
    : `M-${localInvoiceId.slice(-8)}`;
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
  // Mandatory: every Receive Payments batch posts a single combined deposit
  // to a real bank account so the register reflects the cash inflow.
  depositBankAccountId: z.string().min(1),
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

    const depositAccount = await db.query.bankAccounts.findFirst({
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
