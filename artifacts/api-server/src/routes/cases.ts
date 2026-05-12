import * as fs from "node:fs";
import * as path from "node:path";
import { Router, type Request, type Response } from "express";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  caseAttachments,
  caseEvents,
  caseLocations,
  caseNotes,
  caseRestorations,
  caseSubmissionQueue,
  cases,
  invoiceLineItems,
  invoices,
  iteroImportedOrders,
  labCases,
  organizationConnections,
  organizationMemberships,
  users,
} from "@workspace/db";
import multer from "multer";
import { randomBytes } from "node:crypto";
import OpenAI, { toFile } from "openai";
import { writeAuditLog } from "../lib/audit";
import { calculateLineTotal, sumMoney } from "../lib/case";
import { softDeleteById } from "../lib/soft-delete";
import { caseMediaDir, extractMediaFileName } from "../lib/case-media";
import { deleteFromOneDrive } from "../lib/onedrive";
import { HttpError, ok } from "../lib/http";
import { resolveServerPriceWithSource } from "../lib/pricing";
import { ADMIN_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

// Canonical authenticated file-download route.
// Authorizes by exact (caseId, attachmentId) identity from the DB record,
// then derives the on-disk filename from storageKey via extractMediaFileName.
// The served file path comes from the authoritative DB record, never from the
// raw URL, preventing any decoupled-authorization / confused-deputy attacks.
router.get(
  "/:caseId/attachments/:attachmentId/file",
  asyncHandler(async (req: Request, res: Response) => {
    const caseId = String(req.params["caseId"] ?? "");
    const attachmentId = String(req.params["attachmentId"] ?? "");

    const { labMembership } = await assertCaseAccessWithMemberships(
      (req as any).auth.userId,
      caseId,
    );

    const attachment = await db.query.caseAttachments.findFirst({
      where: and(
        eq(caseAttachments.id, attachmentId),
        eq(caseAttachments.caseId, caseId),
      ),
    });

    if (!attachment) {
      throw new HttpError(404, "Attachment not found.");
    }

    if (attachment.visibility === "internal_lab_only" && !labMembership) {
      throw new HttpError(403, "You do not have access to this file.");
    }

    const filename = extractMediaFileName(attachment.storageKey);
    if (!filename) {
      throw new HttpError(404, "File not found.");
    }

    const resolvedPath = path.resolve(caseMediaDir, filename);
    if (
      resolvedPath === caseMediaDir ||
      !resolvedPath.startsWith(caseMediaDir + path.sep)
    ) {
      throw new HttpError(400, "Invalid file path.");
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new HttpError(404, "File not found.");
    }

    return res.sendFile(resolvedPath);
  })
);

// Legacy compatibility route for URLs stored before the ID-based route was
// introduced (storageKeys of the form
// "https://host/uploads/case-media/<filename>" or
// "https://host/api/cases/attachment-file/<filename>").
// Strategy:
//   1. Narrow DB scan to rows whose storageKey plausibly contains the filename.
//   2. Filter in memory via extractMediaFileName for exact canonical match.
//   3. Enforce uniqueness — reject if 0 or >1 records claim the same filename
//      (>1 would indicate a crafted storageKey alongside the legitimate one).
//   4. Perform auth (case membership + visibility) against the matched record
//      BEFORE serving — no case/attachment IDs are ever exposed in redirects.
//   5. Derive the on-disk path from the record's storageKey, not the raw URL.
router.get(
  "/attachment-file/:filename",
  asyncHandler(async (req: Request, res: Response) => {
    const filename = String(req.params["filename"] ?? "");

    if (!filename || /[/\\]|\.\./.test(filename)) {
      throw new HttpError(400, "Invalid filename.");
    }

    // Narrow the SQL scan to rows whose storageKey plausibly ends with the
    // filename preceded by a slash, or equals the bare filename.
    const slashPattern = `%/${filename}`;
    const candidateRows = await db
      .select()
      .from(caseAttachments)
      .where(
        or(
          sql`${caseAttachments.storageKey} LIKE ${slashPattern}`,
          eq(caseAttachments.storageKey, filename),
        ),
      );

    // Exact canonical match — prevents suffix-based confused-deputy attacks.
    const matching = candidateRows.filter(
      (r) => extractMediaFileName(r.storageKey) === filename,
    );

    // Reject ambiguous matches.
    if (matching.length !== 1) {
      throw new HttpError(404, "Attachment not found.");
    }

    const attachment = matching[0]!;

    // Auth check before any response — no case/attachment IDs exposed.
    const { labMembership } = await assertCaseAccessWithMemberships(
      (req as any).auth.userId,
      attachment.caseId,
    );

    if (attachment.visibility === "internal_lab_only" && !labMembership) {
      throw new HttpError(403, "You do not have access to this file.");
    }

    // Derive the file path from the authoritative DB record, not the URL param.
    const resolvedFilename = extractMediaFileName(attachment.storageKey)!;
    const resolvedPath = path.resolve(caseMediaDir, resolvedFilename);
    if (
      resolvedPath === caseMediaDir ||
      !resolvedPath.startsWith(caseMediaDir + path.sep)
    ) {
      throw new HttpError(400, "Invalid file path.");
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new HttpError(404, "File not found.");
    }

    return res.sendFile(resolvedPath);
  })
);

async function assertCaseAccess(userId: string, caseId: string) {
  const access = await assertCaseAccessWithMemberships(userId, caseId);
  return access.case;
}

async function assertCaseAccessWithMemberships(userId: string, caseId: string) {
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
  return { case: found, labMembership, providerMembership };
}

const ATTACHMENT_VISIBILITIES = [
  "shared_with_provider",
  "internal_lab_only",
] as const;

function visibleAttachmentsFor(
  attachments: any[],
  isLabMember: boolean
): any[] {
  if (isLabMember) return attachments;
  return attachments.filter(
    (a: any) => a.visibility !== "internal_lab_only"
  );
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

router.get(
  "/next-case-number",
  asyncHandler(async (req, res) => {
    const labOrganizationId = String(req.query.labOrganizationId ?? "").trim();
    if (!labOrganizationId) {
      throw new HttpError(400, "labOrganizationId is required.");
    }
    await requireMembership((req as any).auth.userId, labOrganizationId);
    const year = String(new Date().getFullYear()).slice(2);
    const [row] = await db
      .select({
        maxCaseNumber: sql<string | null>`max(
          case
            when ${cases.caseNumber} ~ ${`^${year}-(\\d+)$`}
            then regexp_replace(${cases.caseNumber}, ${`^${year}-(\\d+)$`}, '\\1')::int
            else null
          end
        )`,
      })
      .from(cases)
      .where(eq(cases.labOrganizationId, labOrganizationId));
    const next = (Number(row?.maxCaseNumber ?? 0) || 0) + 1;
    return ok(res, { caseNumber: `${year}-${next}` });
  })
);

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
      const resolved = await Promise.all(
        input.restorations.map(async (r) => {
          let unit = r.unitPrice;
          const userSupplied = Number.isFinite(unit) && unit > 0;
          let priceSource: string | null = userSupplied ? "manual" : null;
          let priceSourceId: string | null = null;
          let priceSourceName: string | null = null;
          let priceKey: string | null = null;
          if (!userSupplied) {
            const fallback = await resolveServerPriceWithSource(
              {
                labOrganizationId: input.labOrganizationId,
                doctorName: input.doctorName,
                providerOrganizationId: input.providerOrganizationId,
              },
              r.material,
              r.restorationType
            );
            if (fallback) {
              unit = fallback.amount;
              priceSource = fallback.source;
              priceSourceId = fallback.sourceId;
              priceSourceName = fallback.sourceName;
              priceKey = fallback.key;
            }
          }
          return {
            caseId: createdCase.id,
            toothNumber: r.toothNumber,
            restorationType: r.restorationType,
            material: r.material ?? null,
            shade: r.shade ?? null,
            notes: r.notes ?? null,
            quantity: r.quantity,
            unitPrice: unit.toFixed(2),
            priceSource,
            priceSourceId,
            priceSourceName,
            priceKey,
          };
        })
      );
      await db.insert(caseRestorations).values(resolved);
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

    // Auto-generate a draft invoice for every new case so the
    // History tab shows the invoice and the Invoice tab is
    // immediately editable. Empty drafts are intentionally allowed:
    // AI-imported / drag-and-dropped cases often have no priced
    // restorations yet but still need an invoice skeleton.
    try {
      const restorationsForInvoice = await db.query.caseRestorations.findMany({
        where: eq(caseRestorations.caseId, createdCase.id),
      });
      const hasLines = restorationsForInvoice.length > 0;
      const invoiceNumber = `INV-${createdCase.caseNumber}`;
      const [newInvoice] = await db
        .insert(invoices)
        .values({
          invoiceNumber,
          caseId: createdCase.id,
          labOrganizationId: createdCase.labOrganizationId,
          providerOrganizationId: createdCase.providerOrganizationId,
          status: "draft",
          createdByUserId: (req as any).auth.userId,
          updatedByUserId: (req as any).auth.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (newInvoice) {
        if (hasLines) {
          await db.insert(invoiceLineItems).values(
            restorationsForInvoice.map((r, idx) => ({
              invoiceId: newInvoice.id,
              caseRestorationId: r.id,
              description: `${r.restorationType} - Tooth ${r.toothNumber}`,
              quantity: r.quantity,
              unitPrice: r.unitPrice,
              lineTotal: calculateLineTotal(r.quantity, r.unitPrice),
              sortOrder: idx,
            }))
          );
        }
        const items = await db.query.invoiceLineItems.findMany({
          where: eq(invoiceLineItems.invoiceId, newInvoice.id),
        });
        const subtotal = sumMoney(items.map((it) => it.lineTotal));
        const [finalized] = await db
          .update(invoices)
          .set({
            subtotal,
            total: subtotal,
            balanceDue: subtotal,
            updatedByUserId: (req as any).auth.userId,
            ...(hasLines
              ? { issuedAt: new Date(), status: "open" as const }
              : {}),
          })
          .where(eq(invoices.id, newInvoice.id))
          .returning();
        await db.insert(caseEvents).values({
          caseId: createdCase.id,
          eventType: "invoice_generated",
          actorUserId: (req as any).auth.userId,
          actorOrganizationId: createdCase.labOrganizationId,
          actorInitials: user?.initials || "SYS",
          metadataJson: {
            invoiceId: finalized.id,
            invoiceNumber: finalized.invoiceNumber,
            empty: !hasLines,
          },
        });
      }
    } catch (err) {
      // Auto-invoice failure should not block case creation. The user
      // can hit "Generate invoice" manually from the Invoice tab.
      req.log?.warn?.(
        { err, caseId: createdCase.id },
        "auto invoice generation on case create failed"
      );
    }

    return ok(res, createdCase, 201);
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const organizationId = req.query.organizationId as string | undefined;
    const include = String(req.query.include ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const includeRestorations = include.includes("restorations");
    const membershipOrgIds = organizationId
      ? [organizationId]
      : (
          await db.query.organizationMemberships.findMany({
            where: and(
              eq(organizationMemberships.userId, (req as any).auth.userId),
              eq(organizationMemberships.status, "active")
            ),
          })
        ).map((m: any) => m.labId);

    // Status map: mobile legacy → desktop format
    const MOBILE_TO_DESKTOP_STATUS: Record<string, string> = {
      INTAKE: "received",
      DESIGN: "in_design",
      MILLING: "in_milling",
      PORCELAIN: "in_porcelain",
      QC_CHECK: "qc",
      DELIVERY: "shipped",
      COMPLETE: "delivered",
      ON_HOLD: "on_hold",
      REMAKE: "remake",
    };

    const [rows, mobileRows] = await Promise.all([
      membershipOrgIds.length
        ? db.query.cases.findMany({
            where: or(
              inArray(cases.labOrganizationId, membershipOrgIds),
              inArray(cases.providerOrganizationId, membershipOrgIds)
            ),
            orderBy: [desc(cases.createdAt)],
          })
        : Promise.resolve([]),
      membershipOrgIds.length
        ? db
            .select()
            .from(labCases)
            .where(
              and(
                isNull(labCases.deletedAt),
                inArray(labCases.organizationId, membershipOrgIds)
              )
            )
        : Promise.resolve([]),
    ]);

    const caseIds = rows.map((r: any) => r.id);
    const restorations = caseIds.length
      ? await db.query.caseRestorations.findMany({
          where: inArray(caseRestorations.caseId, caseIds),
        })
      : [];
    const byCase = new Map<string, typeof restorations>();
    for (const r of restorations) {
      const list = byCase.get(r.caseId) ?? [];
      list.push(r);
      byCase.set(r.caseId, list);
    }
    const enriched: any[] = rows.map((row: any) => {
      const items = byCase.get(row.id) ?? [];
      const teeth = items.map((i: any) => i.toothNumber).join(", ");
      const types = Array.from(
        new Set(items.map((i: any) => i.restorationType).filter(Boolean))
      ).join(", ");
      const materials = Array.from(
        new Set(items.map((i: any) => i.material).filter(Boolean))
      ).join(", ");
      const price = items.reduce(
        (sum: number, i: any) =>
          sum + Number(i.quantity ?? 0) * Number(i.unitPrice ?? 0),
        0
      );
      return {
        ...row,
        restorationCount: items.length,
        restorationTypes: types || null,
        restorationMaterials: materials || null,
        teeth: teeth || null,
        totalPrice: price.toFixed(2),
        ...(includeRestorations ? { restorations: items } : {}),
      };
    });

    // Bridge mobile cases into the desktop list so users see everything
    // regardless of which platform they used to create the case.
    const desktopIdSet = new Set(rows.map((r: any) => r.id));
    for (const mr of mobileRows) {
      if (desktopIdSet.has(mr.id)) continue;
      try {
        const parsed = typeof mr.caseData === "string" ? JSON.parse(mr.caseData) : mr.caseData;
        if (!parsed || typeof parsed !== "object") continue;
        const patientName = String(parsed.patientName ?? "");
        const spaceIdx = patientName.indexOf(" ");
        const firstName = spaceIdx >= 0 ? patientName.slice(0, spaceIdx) : patientName;
        const lastName = spaceIdx >= 0 ? patientName.slice(spaceIdx + 1) : "";
        const rawStatus = String(parsed.status ?? "INTAKE").toUpperCase();
        const desktopStatus = MOBILE_TO_DESKTOP_STATUS[rawStatus] ?? "received";
        const createdAt = parsed.createdAt
          ? new Date(Number(parsed.createdAt)).toISOString()
          : new Date().toISOString();
        const updatedAt = parsed.updatedAt
          ? new Date(Number(parsed.updatedAt)).toISOString()
          : createdAt;
        enriched.push({
          id: mr.id,
          caseNumber: String(parsed.caseNumber ?? ""),
          labOrganizationId: mr.organizationId ?? null,
          providerOrganizationId: null,
          patientFirstName: firstName,
          patientLastName: lastName,
          doctorName: String(parsed.doctorName ?? ""),
          status: desktopStatus,
          priority: parsed.isRush ? "rush" : "normal",
          dueDate: parsed.dueDate ?? null,
          createdByUserId: mr.ownerId,
          createdAt,
          updatedAt,
          restorationCount: 0,
          restorationTypes: parsed.caseType ?? null,
          restorationMaterials: parsed.material ?? null,
          teeth: parsed.toothIndices ?? null,
          totalPrice: parsed.price != null ? String(parsed.price) : "0.00",
          _source: "mobile",
        });
      } catch {
        // skip malformed rows
      }
    }

    if (!enriched.length) return ok(res, []);
    return ok(res, enriched);
  })
);

router.get(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const access = await assertCaseAccessWithMemberships(
      (req as any).auth.userId,
      req.params.caseId
    );
    const found = access.case;
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

    const uploaderIds = Array.from(
      new Set(attachments.map((a: any) => a.uploadedByUserId).filter(Boolean))
    );
    const uploaderRows = uploaderIds.length
      ? await db.query.users.findMany({ where: inArray(users.id, uploaderIds) })
      : [];
    const uploaderById = new Map(uploaderRows.map((u: any) => [u.id, u]));
    const enrichedAttachments = attachments.map((a: any) => {
      const u = uploaderById.get(a.uploadedByUserId) as any | undefined;
      const name = u
        ? [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          u.username ||
          u.email ||
          null
        : null;
      return { ...a, uploaderName: name };
    });

    const isLabMember = !!access.labMembership;
    const labRole = access.labMembership?.role as string | undefined;
    const viewerCanManageAttachments =
      isLabMember && !!labRole && (ADMIN_ROLES as string[]).includes(labRole);

    return ok(res, {
      ...found,
      restorations,
      notes,
      attachments: visibleAttachmentsFor(enrichedAttachments, isLabMember),
      events,
      locations,
      viewerIsLabMember: isLabMember,
      viewerCanManageAttachments,
    });
  })
);

router.get(
  "/:caseId/attachments",
  asyncHandler(async (req, res) => {
    const access = await assertCaseAccessWithMemberships(
      (req as any).auth.userId,
      req.params.caseId
    );
    const found = access.case;
    const attachments = await db.query.caseAttachments.findMany({
      where: eq(caseAttachments.caseId, found.id),
      orderBy: [desc(caseAttachments.createdAt)],
    });
    const uploaderIds = Array.from(
      new Set(attachments.map((a: any) => a.uploadedByUserId).filter(Boolean))
    );
    const uploaderRows = uploaderIds.length
      ? await db.query.users.findMany({ where: inArray(users.id, uploaderIds) })
      : [];
    const uploaderById = new Map(uploaderRows.map((u: any) => [u.id, u]));
    const enriched = attachments.map((a: any) => {
      const u = uploaderById.get(a.uploadedByUserId) as any | undefined;
      const name = u
        ? [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          u.username ||
          u.email ||
          null
        : null;
      return { ...a, uploaderName: name };
    });
    const isLabMember = !!access.labMembership;
    return ok(res, visibleAttachmentsFor(enriched, isLabMember));
  })
);

const updateAttachmentSchema = z.object({
  visibility: z.enum(ATTACHMENT_VISIBILITIES),
});

router.patch(
  "/:caseId/attachments/:attachmentId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );
    const input = updateAttachmentSchema.parse(req.body);
    const attachment = await db.query.caseAttachments.findFirst({
      where: and(
        eq(caseAttachments.id, req.params.attachmentId),
        eq(caseAttachments.caseId, found.id)
      ),
    });
    if (!attachment) throw new HttpError(404, "Attachment not found.");
    if (attachment.visibility === input.visibility) {
      return ok(res, attachment);
    }
    const [updated] = await db
      .update(caseAttachments)
      .set({ visibility: input.visibility })
      .where(eq(caseAttachments.id, attachment.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "case_attachment_visibility_changed",
      entityType: "case_attachment",
      entityId: attachment.id,
      beforeJson: attachment,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

// Best-effort removal of the underlying file backing a case attachment.
// The DB row's `storageKey` is the public URL the file was uploaded to
// (e.g. https://host/uploads/case-media/<filename>). We only ever delete
// inside `uploads/case-media/` and resolve paths defensively so a crafted
// storageKey can't escape the media directory.
function removeAttachmentFile(
  req: any,
  storageKey: string | null | undefined
): void {
  if (!storageKey) return;
  try {
    const fileName = extractMediaFileName(storageKey);
    if (!fileName) return;
    const resolved = path.resolve(caseMediaDir, fileName);
    if (
      resolved !== caseMediaDir &&
      (resolved + path.sep).startsWith(caseMediaDir + path.sep)
    ) {
      fs.rmSync(resolved, { force: true });
    }
  } catch (err: any) {
    req.log?.warn?.(
      { err: err?.message || String(err), storageKey },
      "Failed to remove underlying attachment file"
    );
  }
}

router.post(
  "/:caseId/attachments",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const input = z
      .object({
        storageKey: z.string().min(1),
        fileName: z.string().min(1),
        fileType: z.string().default("application/octet-stream"),
        visibility: z
          .enum(["internal_lab_only", "shared_with_provider"] as const)
          .default("shared_with_provider"),
      })
      .parse(req.body);

    const [attachment] = await db
      .insert(caseAttachments)
      .values({
        caseId: found.id,
        uploadedByUserId: (req as any).auth.userId,
        uploadedByOrganizationId: found.labOrganizationId,
        fileName: input.fileName,
        storageKey: input.storageKey,
        fileType: input.fileType,
        visibility: input.visibility,
      })
      .returning();

    const attachmentActor = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "case_attachment_added",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: attachmentActor?.initials || "SYS",
      metadataJson: {
        attachmentId: attachment.id,
        fileName: attachment.fileName,
        fileType: attachment.fileType,
        visibility: attachment.visibility,
      },
    });

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "case_attachment_created",
      entityType: "case_attachment",
      entityId: attachment.id,
      afterJson: attachment,
    });

    return ok(res, attachment, 201);
  })
);

async function removeAttachmentFromOneDrive(
  req: any,
  storageKey: string | null | undefined
): Promise<void> {
  if (!storageKey) return;
  try {
    const fileName = extractMediaFileName(storageKey);
    if (!fileName) return;
    const result = await deleteFromOneDrive(fileName);
    if (result === "deleted" || result === "missing") {
      req.log?.info?.(
        { fileName, result },
        "Removed mirrored attachment from OneDrive"
      );
    }
  } catch (err: any) {
    req.log?.warn?.(
      { err: err?.message || String(err), storageKey },
      "Failed to remove mirrored attachment from OneDrive"
    );
  }
}

router.delete(
  "/:caseId/attachments/:attachmentId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const attachment = await db.query.caseAttachments.findFirst({
      where: and(
        eq(caseAttachments.id, req.params.attachmentId),
        eq(caseAttachments.caseId, found.id)
      ),
    });
    if (!attachment) throw new HttpError(404, "Attachment not found.");

    await db
      .delete(caseAttachments)
      .where(eq(caseAttachments.id, attachment.id));

    // Remove the file from disk after the DB row is gone. Failures are
    // logged but don't surface to the caller — the DB delete already
    // succeeded and a stray file is preferable to an inconsistent state.
    removeAttachmentFile(req, attachment.storageKey);

    // If a OneDrive backup mirror is configured, also remove the
    // mirrored copy. Same best-effort policy: log and continue on any
    // failure so the DB delete is never reverted.
    void removeAttachmentFromOneDrive(req, attachment.storageKey);

    const attachmentDeleter = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "case_attachment_deleted",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: attachmentDeleter?.initials || "SYS",
      metadataJson: {
        attachmentId: attachment.id,
        fileName: attachment.fileName,
        fileType: attachment.fileType,
      },
    });

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "case_attachment_deleted",
      entityType: "case_attachment",
      entityId: attachment.id,
      beforeJson: attachment,
    });
    return ok(res, { deleted: true });
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
      req.params.caseId
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
      req.params.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );

    await softDeleteById({
      table: cases,
      id: found.id,
      actorUserId: (req as any).auth.userId,
      req,
      organizationId: found.labOrganizationId,
      entityType: "case",
      beforeJson: found,
    });
    return ok(res, { deleted: true });
  })
);

router.post(
  "/:caseId/notes",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
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
      req.params.caseId
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

router.patch(
  "/restorations/pricing",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        restorationType: z.string().min(1),
        material: z.string().nullable().optional(),
        unitPrice: z.coerce.number().min(0),
      })
      .parse(req.body);

    const memberships = await db.query.organizationMemberships.findMany({
      where: eq(organizationMemberships.userId, (req as any).auth.userId),
    });
    const labOrgIds = memberships
      .filter(
        (m: any) =>
          m.status === "active" &&
          (m.role === "owner" || m.role === "admin" || m.role === "billing")
      )
      .map((m: any) => m.labId);

    if (labOrgIds.length === 0) {
      throw new HttpError(403, "You don't have permission to update pricing.");
    }

    const accessibleCases = await db.query.cases.findMany({
      where: inArray(cases.labOrganizationId, labOrgIds),
    });
    const accessibleCaseIds = accessibleCases.map((c) => c.id);
    if (accessibleCaseIds.length === 0) {
      return ok(res, { updated: 0 });
    }

    const candidates = await db.query.caseRestorations.findMany({
      where: and(
        inArray(caseRestorations.caseId, accessibleCaseIds),
        eq(caseRestorations.restorationType, input.restorationType)
      ),
    });
    const matchMaterial = (input.material ?? "").trim();
    const matching = candidates.filter((r) => {
      const m = (r.material ?? "").trim();
      if (!matchMaterial) return !m;
      return m === matchMaterial;
    });

    if (matching.length === 0) {
      return ok(res, { updated: 0 });
    }

    await db
      .update(caseRestorations)
      .set({
        unitPrice: input.unitPrice.toFixed(2),
        priceSource: "manual",
        priceSourceId: null,
        priceSourceName: null,
        priceKey: null,
      })
      .where(
        inArray(
          caseRestorations.id,
          matching.map((r) => r.id)
        )
      );

    await writeAuditLog({
      req,
      action: "restoration_pricing_updated",
      entityType: "case_restoration",
      entityId: input.restorationType,
      metadataJson: {
        restorationType: input.restorationType,
        material: input.material ?? null,
        unitPrice: input.unitPrice.toFixed(2),
        updated: matching.length,
      },
    });

    return ok(res, { updated: matching.length });
  })
);

router.post(
  "/:caseId/restorations",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
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

    let unit = input.unitPrice;
    const userSupplied = Number.isFinite(unit) && unit > 0;
    let priceSource: string | null = userSupplied ? "manual" : null;
    let priceSourceId: string | null = null;
    let priceSourceName: string | null = null;
    let priceKey: string | null = null;
    if (!userSupplied) {
      const fallback = await resolveServerPriceWithSource(
        {
          labOrganizationId: found.labOrganizationId,
          doctorName: found.doctorName,
          providerOrganizationId: found.providerOrganizationId,
        },
        input.material,
        input.restorationType
      );
      if (fallback) {
        unit = fallback.amount;
        priceSource = fallback.source;
        priceSourceId = fallback.sourceId;
        priceSourceName = fallback.sourceName;
        priceKey = fallback.key;
      }
    }

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
        unitPrice: unit.toFixed(2),
        priceSource,
        priceSourceId,
        priceSourceName,
        priceKey,
      })
      .returning();

    const restorationActor = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "restoration_added",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: restorationActor?.initials || "SYS",
      metadataJson: {
        restorationId: restoration.id,
        restorationType: restoration.restorationType,
        toothNumber: restoration.toothNumber,
        material: restoration.material,
        shade: restoration.shade,
        quantity: restoration.quantity,
        unitPrice: restoration.unitPrice,
      },
    });

    return ok(res, restoration, 201);
  })
);

router.delete(
  "/:caseId/restorations/:restorationId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const restoration = await db.query.caseRestorations.findFirst({
      where: and(
        eq(caseRestorations.id, req.params.restorationId),
        eq(caseRestorations.caseId, found.id)
      ),
    });
    if (!restoration) throw new HttpError(404, "Restoration not found.");
    await db
      .delete(caseRestorations)
      .where(eq(caseRestorations.id, restoration.id));
    const restorationDeleter = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "restoration_deleted",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: restorationDeleter?.initials || "SYS",
      metadataJson: {
        restorationId: restoration.id,
        restorationType: restoration.restorationType,
        toothNumber: restoration.toothNumber,
        material: restoration.material,
      },
    });
    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "restoration_deleted",
      entityType: "case_restoration",
      entityId: restoration.id,
      beforeJson: restoration,
    });
    return ok(res, { deleted: true });
  })
);

router.post(
  "/:caseId/submissions",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
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
      req.params.caseId
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
        where: eq(caseSubmissionQueue.id, req.params.submissionId),
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
        where: eq(caseSubmissionQueue.id, req.params.submissionId),
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

// ─────────────────────────────────────────────────────────────────────────────
// iTero Lab-Review auto-import
// ─────────────────────────────────────────────────────────────────────────────

const iteroImportUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(caseMediaDir, { recursive: true });
      } catch {
        /* ignore */
      }
      cb(null, caseMediaDir);
    },
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname || "") || "").toLowerCase();
      const safe =
        path
          .basename(file.originalname || "rx", ext)
          .replace(/[^a-zA-Z0-9\-_]+/g, "-")
          .slice(0, 60) || "rx";
      cb(null, `${Date.now()}-${randomBytes(4).toString("hex")}-${safe}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

let cachedIteroOpenAIClient: OpenAI | null | undefined;
function getIteroOpenAIClient(): OpenAI | null {
  if (cachedIteroOpenAIClient !== undefined) return cachedIteroOpenAIClient;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) {
    cachedIteroOpenAIClient = null;
    return null;
  }
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  cachedIteroOpenAIClient = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
  return cachedIteroOpenAIClient;
}

const ITERO_RX_SYSTEM_PROMPT = `You are a dental laboratory prescription reader. Analyze the iTero Lab-Review prescription and extract every available field. Return ONLY valid JSON with this exact shape (use null for any field you cannot determine — never guess):

{
  "doctorName": "Dr. Full Name",
  "patientFirstName": "First",
  "patientLastName": "Last",
  "caseType": "one of: Crown, Bridge, Veneer, Implant Crown, Inlay, Onlay, Full Denture, Partial Denture, Night Guard, Retainer, Other",
  "material": "one of: Zirconia, PFM, E.max, Full Cast, Composite, Acrylic, Metal, PMMA, Other",
  "shade": "shade value like A2 or BL2",
  "teeth": "comma-separated Universal-system tooth numbers like 3,5,14",
  "dueDate": "YYYY-MM-DD or null",
  "isRush": false,
  "notes": "free-text special instructions",
  "practiceName": "dental practice or office name"
}

Important rules:
- Tooth numbers must use Universal Numbering System (1–32). Convert FDI to Universal if needed.
- If a name appears in "Last, First" form, swap to "First Last" and remove the comma.
- Only set isRush=true when the Rx is explicitly marked rush/urgent/STAT.
- Return ONLY the JSON object — no commentary, no markdown fences.`;

function buildIteroAttachmentUrl(
  req: Request,
  filename: string
): string {
  const forwardedHost = req.header("x-forwarded-host");
  const host = forwardedHost || req.get("host") || "localhost";
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto
    ? forwardedProto.split(",")[0]!.trim()
    : (req.protocol || "https");
  return `${protocol}://${host}/api/cases/attachment-file/${filename}`;
}

async function generateIteroCaseNumber(
  labOrganizationId: string
): Promise<string> {
  const year = String(new Date().getFullYear()).slice(2);
  const [row] = await db
    .select({
      maxCaseNumber: sql<string | null>`max(
        case
          when ${cases.caseNumber} ~ ${`^${year}-(\\d+)$`}
          then regexp_replace(${cases.caseNumber}, ${`^${year}-(\\d+)$`}, '\\1')::int
          else null
        end
      )`,
    })
    .from(cases)
    .where(eq(cases.labOrganizationId, labOrganizationId));
  const next = (Number(row?.maxCaseNumber ?? 0) || 0) + 1;
  return `${year}-${next}`;
}

interface ExtractedRxFields {
  doctorName?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  caseType?: string | null;
  material?: string | null;
  shade?: string | null;
  teeth?: string | null;
  dueDate?: string | null;
  isRush?: boolean | null;
  notes?: string | null;
  practiceName?: string | null;
}

async function extractRxFieldsFromBuffer(
  openai: OpenAI,
  buf: Buffer,
  mimeType: string,
  originalName: string
): Promise<ExtractedRxFields> {
  const isPdf =
    mimeType.toLowerCase().includes("pdf") ||
    originalName.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    // Use the Responses API with file input for native PDF understanding.
    const uploaded = await openai.files.create({
      file: await toFile(buf, originalName || "rx.pdf", {
        type: "application/pdf",
      }),
      purpose: "user_data",
    });
    try {
      const r = await openai.responses.create({
        model: "gpt-5.1",
        input: [
          {
            role: "user",
            content: [
              { type: "input_file", file_id: uploaded.id },
              { type: "input_text", text: ITERO_RX_SYSTEM_PROMPT },
            ],
          },
        ],
      });
      const text = r.output_text || "";
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return {};
      try {
        return JSON.parse(m[0]) as ExtractedRxFields;
      } catch {
        return {};
      }
    } finally {
      try {
        await openai.files.delete(uploaded.id);
      } catch {
        /* ignore */
      }
    }
  }

  // Image path — use chat.completions vision (matches existing pattern).
  const dataUrl = `data:${mimeType || "image/jpeg"};base64,${buf.toString("base64")}`;
  const resp = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: ITERO_RX_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this iTero Lab-Review prescription." },
          {
            type: "image_url",
            image_url: { url: dataUrl, detail: "auto" },
          },
        ],
      },
    ],
    max_completion_tokens: 1200,
    temperature: 0.1,
  });
  const text = resp.choices?.[0]?.message?.content || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    return JSON.parse(m[0]) as ExtractedRxFields;
  } catch {
    return {};
  }
}

const iteroImportBodySchema = z.object({
  iteroOrderId: z.string().min(1, "iteroOrderId is required"),
  labOrganizationId: z.string().min(1, "labOrganizationId is required"),
  providerOrganizationId: z
    .string()
    .min(1, "providerOrganizationId is required"),
  // Optional client hints — used as fallbacks when AI fails to extract them.
  doctorNameHint: z.string().optional(),
  patientFirstNameHint: z.string().optional(),
  patientLastNameHint: z.string().optional(),
});

router.post(
  "/import-from-itero-rx",
  iteroImportUpload.single("file"),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const body = iteroImportBodySchema.parse(req.body ?? {});

    if (!req.file) {
      throw new HttpError(400, "Rx file is required (field name 'file').");
    }

    // Lab membership is required to create cases for this organization.
    await requireMembership(userId, body.labOrganizationId);

    // Cheap optimistic dedup check so we skip OpenAI calls for already-imported
    // orders. The authoritative dedup is the unique-index claim INSIDE the
    // transaction below; this check is purely an optimization.
    const preExisting = await db.query.iteroImportedOrders.findFirst({
      where: and(
        eq(iteroImportedOrders.labOrganizationId, body.labOrganizationId),
        eq(iteroImportedOrders.iteroOrderId, body.iteroOrderId)
      ),
    });
    if (preExisting && preExisting.createdCaseId) {
      try {
        if (req.file?.path) fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
      await db
        .update(iteroImportedOrders)
        .set({ lastSeenAt: new Date() })
        .where(eq(iteroImportedOrders.id, preExisting.id));
      return ok(res, {
        deduped: true,
        caseId: preExisting.createdCaseId,
        iteroOrderId: preExisting.iteroOrderId,
      });
    }

    // AI extraction (best-effort — if AI is unconfigured or fails, we still
    // create a stub case marked needsAiReview=true so the user can fix it).
    let extracted: ExtractedRxFields = {};
    const openai = getIteroOpenAIClient();
    if (openai) {
      try {
        const buf = await fs.promises.readFile(req.file.path);
        extracted = await extractRxFieldsFromBuffer(
          openai,
          buf,
          req.file.mimetype || "application/octet-stream",
          req.file.originalname || "rx"
        );
      } catch (err) {
        req.log?.warn?.(
          { err: (err as Error)?.message },
          "iTero Rx AI extraction failed; creating case with hints only"
        );
      }
    }

    const patientFirstName =
      (extracted.patientFirstName?.trim() || body.patientFirstNameHint?.trim() ||
        "Unknown");
    const patientLastName =
      (extracted.patientLastName?.trim() || body.patientLastNameHint?.trim() ||
        "Patient");
    const doctorName =
      (extracted.doctorName?.trim() || body.doctorNameHint?.trim() ||
        "Unknown Doctor");

    let dueDate: Date | null = null;
    if (extracted.dueDate) {
      const parsed = new Date(extracted.dueDate);
      if (!Number.isNaN(parsed.getTime())) dueDate = parsed;
    }

    const caseNumber = await generateIteroCaseNumber(body.labOrganizationId);

    // Resolve any AI-derived restoration rows BEFORE the transaction so the
    // pricing lookups don't hold open the dedup-claim transaction.
    const teethList = (extracted.teeth || "")
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    let prebuiltRestorations: Array<{
      toothNumber: string;
      restorationType: string;
      material: string | null;
      shade: string | null;
      unitPrice: string;
      priceSource: string | null;
      priceSourceId: string | null;
      priceSourceName: string | null;
      priceKey: string | null;
    }> = [];
    if (teethList.length > 0 && extracted.caseType) {
      prebuiltRestorations = await Promise.all(
        teethList.map(async (toothNumber) => {
          const fallback = await resolveServerPriceWithSource(
            {
              labOrganizationId: body.labOrganizationId,
              doctorName,
              providerOrganizationId: body.providerOrganizationId,
            },
            extracted.material ?? null,
            extracted.caseType ?? ""
          );
          return {
            toothNumber,
            restorationType: extracted.caseType ?? "Other",
            material: extracted.material ?? null,
            shade: extracted.shade ?? null,
            unitPrice: (fallback?.amount ?? 0).toFixed(2),
            priceSource: fallback?.source ?? null,
            priceSourceId: fallback?.sourceId ?? null,
            priceSourceName: fallback?.sourceName ?? null,
            priceKey: fallback?.key ?? null,
          };
        })
      );
    }

    const user = (req as any).user;
    const storageKey = buildIteroAttachmentUrl(req, req.file.filename);

    // Atomic write: dedup claim + case + restorations + notes + attachment +
    // back-fill + event all happen in one transaction. If ANY step fails,
    // Postgres rolls back the dedup-claim row too, freeing the iTero order
    // for retry on the next poll cycle. The only success path commits the
    // claim with createdCaseId set, so future requests see the existing case.
    const txResult = await db.transaction(async (tx) => {
      const [claim] = await tx
        .insert(iteroImportedOrders)
        .values({
          labOrganizationId: body.labOrganizationId,
          iteroOrderId: body.iteroOrderId,
          createdCaseId: null,
        })
        .onConflictDoNothing({
          target: [
            iteroImportedOrders.labOrganizationId,
            iteroImportedOrders.iteroOrderId,
          ],
        })
        .returning();

      if (!claim) {
        const existing = await tx.query.iteroImportedOrders.findFirst({
          where: and(
            eq(iteroImportedOrders.labOrganizationId, body.labOrganizationId),
            eq(iteroImportedOrders.iteroOrderId, body.iteroOrderId)
          ),
        });
        if (existing) {
          await tx
            .update(iteroImportedOrders)
            .set({ lastSeenAt: new Date() })
            .where(eq(iteroImportedOrders.id, existing.id));
        }
        return { kind: "deduped" as const, existing };
      }

      const [createdCase] = await tx
        .insert(cases)
        .values({
          caseNumber,
          labOrganizationId: body.labOrganizationId,
          providerOrganizationId: body.providerOrganizationId,
          patientFirstName,
          patientLastName,
          doctorName,
          status: "received",
          priority: extracted.isRush ? "rush" : "normal",
          dueDate,
          createdByUserId: userId,
          needsAiReview: true,
          aiImportSource: "itero",
          externalPatientId: body.iteroOrderId,
        })
        .returning();

      if (prebuiltRestorations.length > 0) {
        await tx.insert(caseRestorations).values(
          prebuiltRestorations.map((r) => ({
            caseId: createdCase.id,
            toothNumber: r.toothNumber,
            restorationType: r.restorationType,
            material: r.material,
            shade: r.shade,
            notes: null,
            quantity: 1,
            unitPrice: r.unitPrice,
            priceSource: r.priceSource,
            priceSourceId: r.priceSourceId,
            priceSourceName: r.priceSourceName,
            priceKey: r.priceKey,
          }))
        );
      }

      if (extracted.notes && extracted.notes.trim()) {
        await tx.insert(caseNotes).values({
          caseId: createdCase.id,
          authorUserId: userId,
          authorOrganizationId: body.labOrganizationId,
          noteText: `[iTero AI import] ${extracted.notes.trim()}`,
          visibility: "internal_lab_only",
        });
      }

      const [attachment] = await tx
        .insert(caseAttachments)
        .values({
          caseId: createdCase.id,
          uploadedByUserId: userId,
          uploadedByOrganizationId: body.labOrganizationId,
          fileName: req.file!.originalname || "iTero-Rx",
          storageKey,
          fileType: req.file!.mimetype || "application/octet-stream",
          visibility: "shared_with_provider",
        })
        .returning();

      await tx
        .update(iteroImportedOrders)
        .set({ createdCaseId: createdCase.id, lastSeenAt: new Date() })
        .where(eq(iteroImportedOrders.id, claim.id));

      await tx.insert(caseEvents).values({
        caseId: createdCase.id,
        eventType: "case_created_from_itero",
        actorUserId: userId,
        actorOrganizationId: body.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          iteroOrderId: body.iteroOrderId,
          aiExtracted: Object.keys(extracted ?? {}),
          attachmentId: attachment?.id,
        },
      });

      return { kind: "created" as const, createdCase, attachment };
    });

    if (txResult.kind === "deduped") {
      try {
        if (req.file?.path) fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
      const existing = txResult.existing;
      if (existing && existing.createdCaseId) {
        return ok(res, {
          deduped: true,
          caseId: existing.createdCaseId,
          iteroOrderId: existing.iteroOrderId,
        });
      }
      // The order is being concurrently imported by another request that
      // hasn't committed yet — surface a 409 so the poller retries on the
      // next cycle. We never return deduped:true with a null caseId.
      throw new HttpError(409, "iTero order is already being imported; retry shortly.");
    }

    const { createdCase, attachment } = txResult;

    await writeAuditLog({
      req,
      organizationId: body.labOrganizationId,
      action: "case_created_from_itero",
      entityType: "case",
      entityId: createdCase.id,
      afterJson: {
        case: createdCase,
        iteroOrderId: body.iteroOrderId,
        attachmentId: attachment?.id,
      },
    });

    return ok(
      res,
      {
        deduped: false,
        caseId: createdCase.id,
        caseNumber: createdCase.caseNumber,
        needsAiReview: true,
        attachmentId: attachment?.id,
        extracted,
      },
      201
    );
  })
);

// Clear the "needs AI review" flag once a human has verified the imported case.
router.patch(
  "/:caseId/ai-review",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const found = await assertCaseAccess(userId, String(req.params.caseId ?? ""));
    await requireMembership(userId, found.labOrganizationId);

    const input = z
      .object({ acknowledged: z.boolean().default(true) })
      .parse(req.body ?? {});

    if (!input.acknowledged) {
      return ok(res, { caseId: found.id, needsAiReview: found.needsAiReview ?? false });
    }

    const [updated] = await db
      .update(cases)
      .set({ needsAiReview: false })
      .where(eq(cases.id, found.id))
      .returning();

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "ai_review_acknowledged",
      actorUserId: userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: { aiImportSource: found.aiImportSource ?? null },
    });

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "ai_review_acknowledged",
      entityType: "case",
      entityId: found.id,
      beforeJson: { needsAiReview: found.needsAiReview },
      afterJson: { needsAiReview: false },
    });

    return ok(res, { caseId: updated.id, needsAiReview: updated.needsAiReview ?? false });
  })
);

export default router;
