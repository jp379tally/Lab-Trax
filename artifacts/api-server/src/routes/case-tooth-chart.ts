import { Router, type Request } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, cases, caseRestorations, caseEvents, invoices } from "@workspace/db";
import { expandToothAssignmentIdentifiers, validateToothConnectors, IMPLANT_FIELDS, IMPLANT_RETENTIONS, IMPLANT_MANUFACTURERS, TOOTH_INDICATIONS, indicationCatalogContext, isToothIndication, toothIndicationShapeError } from "@workspace/case-taxonomy";
import { asyncHandler } from "../middlewares/async-handler";
import { HttpError } from "../lib/http";
import { BILLING_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { resolveServerPriceWithSource } from "../lib/pricing";
import { syncInvoiceFromRestorationsDetailed, type InvoiceSyncExecutor } from "../lib/invoice-sync";
import { UpdateCaseRestorationHierarchyBody } from "@workspace/api-zod";

const implantInputFields = {
  implantRetention: z.enum(IMPLANT_RETENTIONS).nullish(),
  implantManufacturer: z.enum(IMPLANT_MANUFACTURERS).nullish(),
  implantPlatformNotes: z.string().max(10000).nullish(),
};
const unit = z.object({
  toothNumber: z.string().max(100),
  restorationType: z.string().min(1).max(100).transform((value) =>
    /^missing$/i.test(value) ? "missing" : value),
  material: z.string().nullish(),
  restorationSubtype: z.string().nullish(),
  shade: z.string().nullish(),
  quantity: z.number().int().min(1).max(128).default(1),
  arch: z.enum(["upper", "lower", "upper_lower"]).nullish(),
  unitPrice: z.number().nonnegative().optional(),
  ...implantInputFields,
});
export const ToothChartSaveBody = z.object({
  creates: z.array(unit.extend({ localId: z.string().uuid() })).max(52),
  updates: z.array(z.object({
    restorationId: z.string(),
    toothNumber: z.string().max(100),
    restorationType: z.enum(TOOTH_INDICATIONS as [string, ...string[]]).optional(),
    arch: z.enum(["upper", "lower"]).nullable().optional(),
    material: z.string().optional(),
    restorationSubtype: z.string().optional(),
    shade: z.string().optional(),
  })).max(52),
  deletes: z.array(z.string()).max(104),
  bridgeConnectors: z.string().nullable(),
  hierarchy: UpdateCaseRestorationHierarchyBody.optional(),
  implants: z.array(z.object({
    restorationId: z.string(),
    values: z.object(implantInputFields).strict(),
  })).max(104).default([]),
  caseDetails: z.object({
    patientFirstName: z.string().max(200).optional(),
    patientLastName: z.string().max(200).optional(),
    doctorName: z.string().max(200).optional(),
    providerOrganizationId: z.string().optional(),
    priority: z.enum(["normal", "rush"]).optional(),
    receivedAt: z.string().optional(),
    dueDate: z.string().nullable().optional(),
    dueTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    casePanBarcode: z.string().max(200).nullable().optional(),
    rxNotes: z.string().max(100000).nullable().optional(),
    gingivialShade: z.string().max(200).nullable().optional(),
  }).strict().optional(),
});

/**
 * One chart Save is one transaction, including the invoice rebuild. An invoice
 * that cannot legally be rebuilt refuses the operation before anything commits.
 * Existing row endpoints remain available to their non-chart callers.
 */
export function caseToothChartRouter(deps: {
  access: (userId: string, caseId: string) => Promise<typeof cases.$inferSelect>;
  broadcast: (caseId: string) => void;
  calendarDate: (value: string | undefined) => string | undefined;
  applyHierarchy: (req: Request, body: unknown, executor: InvoiceSyncExecutor) => Promise<void>;
}) {
  const router = Router();
  router.patch("/:caseId/tooth-chart", asyncHandler(async (req, res) => {
    const actorId = (req as any).auth.userId as string;
    const found = await deps.access(actorId, String(req.params.caseId));
    await requireMembership(actorId, found.labOrganizationId);
    const input = ToothChartSaveBody.parse(req.body);
    // Chart edits synchronize financial records, so use the invoice writer's
    // authorization boundary rather than silently elevating a clinical viewer.
    await requireAnyRole(actorId, found.labOrganizationId, BILLING_ROLES);
    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(cases).where(eq(cases.id, found.id)).for("update");
      if (!locked) throw new HttpError(404, "Case not found.");
      const before = await tx.select().from(caseRestorations).where(eq(caseRestorations.caseId, found.id));
      const originalIds = new Set(before.map((row) => row.id));
      for (const id of [...input.deletes, ...input.updates.map((row) => row.restorationId)]) {
        if (!originalIds.has(id) && !input.deletes.includes(id)) {
          throw new HttpError(409, "An assignment changed. Reopen the case before saving.");
        }
      }
      const invoice = await tx.query.invoices.findFirst({
        where: and(eq(invoices.caseId, found.id), isNull(invoices.sourceInvoiceId)),
      });
      if (invoice) {
        // Match the invoice synchronizer's lock ordering and recheck status in
        // its locked rebuild below, including payments arriving concurrently.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.id}))`);
        const [current] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id)).for("update");
        if (!current || current.status !== "open" ||
            (current.displayMetadataJson as Record<string, unknown> | null)?.reviewedCharges === true) {
          throw new HttpError(409, "The invoice is paid, finalized or reviewed. Use the authorized invoice correction workflow before changing these assignments. Nothing was saved.");
        }
      }
      if (input.caseDetails) {
        const { doctorName, providerOrganizationId, receivedAt, dueDate, rxNotes, ...details } = input.caseDetails;
        if ((doctorName !== undefined && doctorName !== locked.doctorName) ||
            (providerOrganizationId !== undefined && providerOrganizationId !== locked.providerOrganizationId)) {
          throw new HttpError(409, "Save doctor/practice reassignment through its dedicated workflow before editing tooth assignments. Nothing was saved.");
        }
        const due = dueDate ? new Date(dueDate) : null;
        if (due && !Number.isFinite(due.getTime())) throw new HttpError(400, "Choose a valid due date.");
        await tx.update(cases).set({
          ...details,
          ...(rxNotes !== undefined ? { rxNotes } : {}),
          ...(receivedAt !== undefined ? { receivedAt: deps.calendarDate(receivedAt) } : {}),
          ...(dueDate !== undefined ? { dueDate: due, ...(due === null ? { dueTime: null } : {}) } : {}),
          updatedAt: new Date(),
        }).where(eq(cases.id, found.id));
      }
      if (input.hierarchy) {
        const hierarchy = { ...input.hierarchy };
        if (hierarchy.toothNumbers) {
          // Explicit replacements retain their source IDs through reconciliation.
          const protectedTeeth = before.filter((row) => input.updates.some((update) => update.restorationId === row.id))
            .flatMap((row) => expandToothAssignmentIdentifiers(row.toothNumber));
          hierarchy.toothNumbers = [...new Set([...hierarchy.toothNumbers, ...protectedTeeth])];
        }
        await deps.applyHierarchy(req, hierarchy, tx);
      }
      for (const edit of input.implants) {
        if (!originalIds.has(edit.restorationId)) throw new HttpError(409, "An implant row changed. Nothing was saved.");
        await tx.update(caseRestorations).set(edit.values)
          .where(and(eq(caseRestorations.caseId, found.id), eq(caseRestorations.id, edit.restorationId)));
      }
      for (const id of input.deletes) {
        await tx.delete(caseRestorations).where(and(eq(caseRestorations.caseId, found.id), eq(caseRestorations.id, id)));
      }
      async function price(row: z.infer<typeof unit>, previous?: typeof caseRestorations.$inferSelect) {
        if (row.restorationType === "missing") {
          return { unitPrice: "0.00", priceSource: null, priceSourceId: null, priceSourceName: null, priceKey: null };
        }
        if (!row.material?.trim() && (row.unitPrice === undefined || /^(Crown|Pontic|Veneer)$/i.test(row.restorationType))) {
          throw new HttpError(400, "Choose a catalog material for each restoration.");
        }
        const unchanged = previous && previous.restorationType === row.restorationType &&
          (previous.material ?? "") === (row.material ?? "") &&
          (previous.restorationSubtype ?? "") === (row.restorationSubtype ?? "");
        if (unchanged) return { unitPrice: previous.unitPrice, priceSource: previous.priceSource,
          priceSourceId: previous.priceSourceId, priceSourceName: previous.priceSourceName, priceKey: previous.priceKey };
        if (locked.remakeOfCaseId && locked.remakeCharged === false) {
          return { unitPrice: "0.00", priceSource: "manual", priceSourceId: null, priceSourceName: "No-charge remake", priceKey: null };
        }
        const resolved = await resolveServerPriceWithSource({
          labOrganizationId: locked.labOrganizationId, doctorName: locked.doctorName,
          providerOrganizationId: locked.providerOrganizationId,
        }, row.material ?? "", row.restorationType, row.restorationSubtype);
        if (row.unitPrice !== undefined) return { unitPrice: row.unitPrice.toFixed(2), priceSource: "manual",
          priceSourceId: null, priceSourceName: null, priceKey: resolved?.key ?? null };
        if (!resolved) throw new HttpError(400, `No catalog/practice price is configured for tooth #${row.toothNumber}. Nothing was saved.`);
        return { unitPrice: resolved.amount.toFixed(2), priceSource: resolved.source,
          priceSourceId: resolved.sourceId, priceSourceName: resolved.sourceName, priceKey: resolved.key };
      }
      for (const update of input.updates) {
        const previous = before.find((row) => row.id === update.restorationId)!;
        if (input.deletes.includes(previous.id)) throw new HttpError(400, "An assignment cannot be changed and removed in the same save.");
        const previousArchIndication = (previous.arch === "upper" || previous.arch === "lower") &&
          !(previous.toothNumber ?? "").trim();
        if (!previousArchIndication && expandToothAssignmentIdentifiers(previous.toothNumber).length !== 1) {
          throw new HttpError(409, "Edit shared multi-tooth rows in the restoration row editor.");
        }
        const row = unit.parse({ ...previous, ...update, unitPrice: undefined, quantity: 1 });
        const shapeError = toothIndicationShapeError(row);
        if (shapeError) throw new HttpError(400, shapeError);
        await tx.update(caseRestorations).set({
          toothNumber: row.toothNumber, restorationType: row.restorationType,
          arch: row.arch,
          material: row.material, restorationSubtype: row.restorationSubtype, shade: row.shade,
          quantity: 1, ...await price(row, previous),
          assignmentProvenance: { origin: "manual", manualFields: ["role", "product", "shade"] },
        }).where(and(eq(caseRestorations.caseId, found.id), eq(caseRestorations.id, previous.id)));
      }
      for (const create of input.creates) {
        const shapeError = toothIndicationShapeError(create);
        if (shapeError) throw new HttpError(400, shapeError);
        const replay = await tx.query.caseRestorations.findFirst({ where: eq(caseRestorations.id, create.localId) });
        if (replay) {
          if (replay.caseId !== found.id || replay.toothNumber !== create.toothNumber ||
              replay.restorationType !== create.restorationType || (replay.material ?? "") !== (create.material ?? "") ||
              (replay.shade ?? "") !== (create.shade ?? "") ||
               (replay.restorationSubtype ?? "") !== (create.restorationSubtype ?? "") ||
               replay.quantity !== create.quantity || (replay.arch ?? "") !== (create.arch ?? "")) {
            throw new HttpError(409, "The assignment save identifier is already in use. Reopen the case.");
          }
          continue;
        }
        await tx.insert(caseRestorations).values({
          id: create.localId, caseId: found.id, toothNumber: create.toothNumber,
          restorationType: create.restorationType, quantity: create.quantity, arch: create.arch,
          material: create.restorationType === "missing" ? null : create.material,
          restorationSubtype: create.restorationType === "missing" ? null : create.restorationSubtype,
          shade: create.restorationType === "missing" ? null : create.shade,
          ...Object.fromEntries(IMPLANT_FIELDS.map((key) => [key, create[key] ?? null])),
          ...await price(create),
          assignmentProvenance: { origin: "manual", manualFields: ["role", "product", "shade"] },
        });
      }
      const after = await tx.select().from(caseRestorations).where(eq(caseRestorations.caseId, found.id));
      const seen = new Set<string>();
      for (const row of after.filter((row) => row.restorationType === "missing" ||
        (isToothIndication(row.restorationType) && !indicationCatalogContext(row.restorationType).archBased))) {
        for (const position of expandToothAssignmentIdentifiers(row.toothNumber)) {
          if (seen.has(position)) throw new HttpError(409, `Tooth #${position} already has an assignment or missing status.`);
          seen.add(position);
        }
      }
      const archKeys = new Set<string>();
      for (const row of after.filter((row) => isToothIndication(row.restorationType) &&
        indicationCatalogContext(row.restorationType).archBased)) {
        const key = `${row.restorationType}:${row.arch}`;
        if (archKeys.has(key)) throw new HttpError(409, `An ${row.arch} ${row.restorationType} already exists. Edit it instead of adding another charge.`);
        archKeys.add(key);
      }
      const validation = validateToothConnectors(input.bridgeConnectors, after.filter((row) => row.restorationType !== "missing"));
      if (!validation.valid) throw new HttpError(400, validation.errors.join(" "));
      await tx.update(cases).set({ bridgeConnectors: input.bridgeConnectors || null }).where(eq(cases.id, found.id));
      const sync = await syncInvoiceFromRestorationsDetailed({
        caseId: found.id, actorUserId: actorId, createIfMissing: true, executor: tx,
      });
      if (sync.action === "needs_review" || (sync.action === "skipped" && sync.invoiceId)) {
        throw new HttpError(409, "The invoice cannot be synchronized under its current payment/review rules. Case and invoice were left unchanged.");
      }
      await tx.insert(caseEvents).values({
        caseId: found.id, eventType: "tooth_chart_saved", actorUserId: actorId,
        actorOrganizationId: found.labOrganizationId, actorInitials: (req as any).user?.initials || "SYS",
        metadataJson: { createdIds: input.creates.map((row) => row.localId),
          updatedIds: input.updates.map((row) => row.restorationId), deletedIds: input.deletes,
          invoiceId: sync.invoiceId, invoiceAction: sync.action,
          ...(input.caseDetails ? {
            caseDetailsBefore: Object.fromEntries(Object.keys(input.caseDetails).map((key) =>
              [key, (locked as unknown as Record<string, unknown>)[key]])),
            caseDetailsAfter: input.caseDetails,
          } : {}),
          hierarchyEdited: Boolean(input.hierarchy) },
      });
      return { invoiceId: sync.invoiceId, invoiceAction: sync.action };
    });
    deps.broadcast(found.id);
    res.json({ ok: true, data: result });
  }));
  return router;
}
