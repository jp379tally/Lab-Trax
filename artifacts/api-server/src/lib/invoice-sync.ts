import { and, eq, inArray, isNull, sql, sum } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  caseRestorations,
  cases,
  invoiceLineItems,
  invoices,
  organizations,
  payments,
} from "@workspace/db";
import { calendarDateToUtcNoon } from "@workspace/calendar-date";
import { sumMoney } from "./case";
import { ensureDoctorProfileIdentity } from "./doctor-profile-identity";
import { insertOrResolveAiIntakeInvoice } from "./ai-intake-invoice";
import { invoiceDueDate } from "./invoice-due-date";
import {
  normalizeDoctor,
  resolveItemLabelFromMap,
  resolveServerPriceWithSource,
} from "./pricing";
import { resolveRestorationPriceKey } from "./restoration-pricing.js";
import { notDeleted } from "./soft-delete";
import {
  buildBridgeAwareLineItems,
  parseToothInt,
} from "./invoice-line-grouping";
import { validateToothConnectors, toothAssignmentSummary } from "@workspace/case-taxonomy";
import {
  isPfmOrFcmMaterial,
  isPfzMaterial,
  LAYERED_PORCELAIN_DESCRIPTION,
  LAYERED_PORCELAIN_SURCHARGE,
} from "./material-mapping";

/**
 * Re-sync the invoice attached to a case from its current restoration rows.
 * Invoices with explicitly reviewed charges are excluded from automatic repricing.
 *
 * Use this whenever the restoration set on a case changes (add / delete /
 * price edit) so the user doesn't have to also open the Invoice tab and
 * regenerate by hand. Mirrors the auto-invoice logic that runs on case
 * creation, but for the post-creation lifecycle.
 *
 * Safety rules:
 *   - Only touches invoices in "open" status. Paid / void /
 *     cancelled invoices are left alone — they're closed books.
 *   - Skips invoices that already have a recorded payment, even if their
 *     status is still "open" (partial-pay safety).
 *   - Preserves the invoice's no-charge-remake intent: if every existing
 *     line item on the invoice is at $0 and the invoice carries a
 *     "no-charge remake" note, the rebuilt line items are also forced
 *     to $0 so we don't silently start charging for a no-charge remake.
 *   - If the case has no invoice yet, this function is normally a no-op.
 *     Clinical edits may opt in to creating a draft invoice once billable
 *     restoration rows exist.
 *   - When the case has `bridgeConnectors`, adjacent pontic+crown spans
 *     are collapsed into a single bridge line item with a combined
 *     description (e.g. "#13-15 Zirconia Bridge – 3 units").
 *
 * Returns whether the invoice was updated, created, skipped, or needs review.
 */
export type InvoiceSyncAction = "updated" | "created" | "skipped" | "needs_review";
export interface InvoiceSyncResult {
  action: InvoiceSyncAction;
  invoiceId: string | null;
}

async function createCaseInvoiceForClinicalEdit(
  caseRow: typeof cases.$inferSelect,
  actorUserId: string,
): Promise<string | null> {
  const restorations = await db.query.caseRestorations.findMany({
    where: eq(caseRestorations.caseId, caseRow.id),
  });
  const billable = restorations.filter((row) => row.restorationType !== "missing");
  if (billable.length === 0) return null;

  const provider = caseRow.providerOrganizationId
    ? await db.query.organizations.findFirst({
        where: eq(organizations.id, caseRow.providerOrganizationId),
      })
    : null;
  const displayMetadataJson = {
    patientName: `${caseRow.patientFirstName ?? ""} ${caseRow.patientLastName ?? ""}`.trim(),
    billTo: provider?.displayName || provider?.name || "",
    teeth: Array.from(new Set(billable.map((row) => row.toothNumber.trim()).filter(Boolean))).join(", "),
    shade: Array.from(new Set(billable.map((row) => row.shade?.trim() ?? "").filter(Boolean))).join(", "),
    material: Array.from(new Set(billable.map((row) => row.material?.trim() ?? "").filter(Boolean))).join(", "),
    caseNotes: billable.map((row) => row.notes?.trim() ?? "").filter(Boolean).join("\n"),
    credits: 0,
  };

  const invoice = await db.transaction(async (tx) => {
    const doctorIdentity = await ensureDoctorProfileIdentity(tx, {
      labOrganizationId: caseRow.labOrganizationId,
      providerOrganizationId: caseRow.providerOrganizationId ?? null,
      doctorName: provider?.displayName || provider?.name || caseRow.doctorName,
    });
    const noChargeRemake =
      !!caseRow.remakeOfCaseId && caseRow.remakeCharged === false;
    return insertOrResolveAiIntakeInvoice(
      tx,
      {
        invoiceNumber: `INV-${caseRow.caseNumber}`,
        caseId: caseRow.id,
        labOrganizationId: caseRow.labOrganizationId,
        providerOrganizationId: caseRow.providerOrganizationId,
        doctorIdentity,
        status: "open",
        issuedAt: calendarDateToUtcNoon(caseRow.receivedAt),
        dueAt: invoiceDueDate(new Date()),
        displayMetadataJson,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
        ...(noChargeRemake ? { notes: "No-charge remake" } : {}),
      },
      caseRow.id,
      caseRow.labOrganizationId,
    );
  });
  return invoice.id;
}

export async function syncInvoiceFromRestorationsDetailed(args: {
  caseId: string;
  actorUserId: string | null;
  createIfMissing?: boolean;
}): Promise<InvoiceSyncResult> {
  const { caseId, actorUserId, createIfMissing = false } = args;

  const caseRow = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
  });
  if (!caseRow) return { action: "skipped", invoiceId: null };

  let invoice = await db.query.invoices.findFirst({
    // Copies are invoice-owned snapshots, not the case's generated bill.
    where: and(eq(invoices.caseId, caseId), isNull(invoices.sourceInvoiceId)),
  });
  if (!invoice) {
    if (!createIfMissing || !actorUserId) {
      return { action: "skipped", invoiceId: null };
    }
    const invoiceId = await createCaseInvoiceForClinicalEdit(caseRow, actorUserId);
    if (!invoiceId) return { action: "skipped", invoiceId: null };
    invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, invoiceId),
    });
    if (!invoice) throw new Error("The new case invoice could not be reloaded.");
    const synced = await syncInvoiceFromRestorationsDetailed({ caseId, actorUserId });
    return {
      action: synced.action === "updated" ? "created" : synced.action,
      invoiceId,
    };
  }

  // Closed-book statuses are off-limits. Payment-state invoices still enter
  // the transaction so settlement/reversal work and restoration sync meet at
  // the same invoice lock; the locked status/payment checks below keep them
  // from being rebuilt.
  if (!["open", "partially_paid", "paid", "overdue"].includes(invoice.status)) {
    return { action: "skipped", invoiceId: invoice.id };
  }

  // Merge the invoice's generated line items + header in one transaction so
  // we never leave the invoice with new line items but a stale total
  // (or vice versa). Read restorations inside the transaction so we
  // see a consistent snapshot under concurrent restoration writes.
  const action = await db.transaction(async (tx): Promise<InvoiceSyncAction> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoice.id}))`);
    const [lockedInvoice] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .for("update");
    if (!lockedInvoice || lockedInvoice.status !== "open") return "skipped";
    // A reviewed invoice is a manually approved bill. Rebuilding it from case
    // restorations would add back removed charges or undo corrected prices.
    // A later case edit may also introduce a charge that needs approval; flag
    // the invoice explicitly instead of silently pretending it was billed.
    const reviewedMeta = lockedInvoice.displayMetadataJson as Record<string, unknown> | null;
    if (reviewedMeta?.reviewedCharges === true) {
      await tx.update(invoices).set({
        displayMetadataJson: { ...reviewedMeta, reviewedChargesNeedsReview: true },
      }).where(eq(invoices.id, lockedInvoice.id));
      return "needs_review";
    }
    const [paidAgg] = await tx
      .select({ value: sum(payments.amount) })
      .from(payments)
      .where(eq(payments.invoiceId, lockedInvoice.id));
    if (Number(paidAgg?.value ?? 0) > 0) return "skipped";
    const noChargeRemake =
      !!caseRow.remakeOfCaseId &&
      caseRow.remakeCharged === false &&
      !!lockedInvoice.notes &&
      /no-?charge/i.test(lockedInvoice.notes);
    const allRestorations = await tx.query.caseRestorations.findMany({
      where: eq(caseRestorations.caseId, caseId),
    });
    // Missing-tooth markers are visual-only; exclude them from invoice line items.
    const restorations = allRestorations.filter(
      (r) => !/^missing$/i.test(r.restorationType),
    );
    const connectorValidation = validateToothConnectors(caseRow.bridgeConnectors, restorations);
    const assignmentSummary = toothAssignmentSummary(restorations, caseRow.bridgeConnectors);
    const clinicalReviewReasons = [...connectorValidation.errors,
      ...assignmentSummary.unresolvedPontics.map((tooth) => `Pontic #${tooth} has no connected prepared crown.`)];
    if (clinicalReviewReasons.length) {
      await tx.update(invoices).set({ displayMetadataJson: { ...reviewedMeta,
        toothAssignmentsNeedsReview: true, toothAssignmentReviewReasons: clinicalReviewReasons } }).where(eq(invoices.id, lockedInvoice.id));
      return "needs_review";
    }
    if (reviewedMeta?.toothAssignmentsNeedsReview) {
      await tx.update(invoices).set({ displayMetadataJson: { ...reviewedMeta,
        toothAssignmentsNeedsReview: false, toothAssignmentReviewReasons: [] } }).where(eq(invoices.id, lockedInvoice.id));
    }
    const existingLines = await tx.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.invoiceId, invoice.id),
      orderBy: [invoiceLineItems.sortOrder],
    });
    // A deleted source can leave a pre-provenance parent indistinguishable
    // from an invoice-only charge. Names are enough to request review, never
    // enough to delete or reprice a charge without ownership evidence.
    const ambiguousLegacyCharge = existingLines.some((child) => {
      if (child.sourceType !== "manual" ||
        child.caseRestorationId != null || child.sourceKey ||
        Array.isArray(child.sourceRestorationIdsJson)) return false;
      if (child.parentLineItemId == null) {
        // Standalone restorations (including arch appliances) may have no
        // child surcharge. Clinical hints request review, not ownership.
        return child.toothNumber != null || !!child.toothLabel?.trim() ||
          /\b(crown|bridge|pontic|veneer|inlay|onlay|implant|denture|partial|alloy|porcelain|retainer|aligner|nightguard)\b/i.test(child.description);
      }
      const parent = existingLines.find((line) => line.id === child.parentLineItemId);
      return parent?.sourceType === "manual" &&
        parent.caseRestorationId == null && !parent.sourceKey &&
        !Array.isArray(parent.sourceRestorationIdsJson) &&
        (child.description === LAYERED_PORCELAIN_DESCRIPTION ||
          (parent.toothNumber != null &&
            child.description === `Alloy #${parent.toothNumber}`));
    });
    if (ambiguousLegacyCharge) {
      await tx.update(invoices).set({
        displayMetadataJson: {
          ...reviewedMeta,
          reviewedCharges: true,
          reviewedChargesNeedsReview: true,
          legacyChargesNeedsReview: true,
        },
      }).where(eq(invoices.id, lockedInvoice.id));
      return "needs_review";
    }
    const knownGeneratedParents = existingLines.filter(
      (line) => line.sourceType === "restoration" || line.caseRestorationId != null,
    );
    const knownGeneratedParentIds = new Set(
      knownGeneratedParents
        .filter((line) => line.parentLineItemId == null)
        .map((line) => line.id),
    );
    const legacyGeneratedChildren = existingLines.filter(
      (line) =>
        line.parentLineItemId != null &&
        knownGeneratedParentIds.has(line.parentLineItemId) &&
        knownGeneratedParents.some(
          (parent) =>
            parent.id === line.parentLineItemId &&
            !parent.sourceKey &&
            !Array.isArray(parent.sourceRestorationIdsJson) &&
            // Recognize historical generated descriptions even after source
            // deletion/material changes, but never a manual "Alloy adjustment".
            (line.description === LAYERED_PORCELAIN_DESCRIPTION ||
              (parent.toothNumber != null &&
                line.description === `Alloy #${parent.toothNumber}`)),
        ) &&
        line.caseRestorationId == null,
    );
    const existingGenerated = [
      ...knownGeneratedParents,
      ...legacyGeneratedChildren.filter(
        (line) => !knownGeneratedParents.some((known) => known.id === line.id),
      ),
    ];
    // First reconciliation upgrades recognizable pre-provenance children in
    // place rather than retaining them as manual rows and inserting a duplicate.
    const manualLines = existingLines.filter(
      (line) =>
        line.sourceType === "manual" &&
        line.caseRestorationId == null &&
        !legacyGeneratedChildren.some((legacy) => legacy.id === line.id),
    );

    // Build bridge-aware line items. When the case has `bridgeConnectors`,
    // connected spans of adjacent teeth that include a pontic are merged
    // into a single bridge line item with a combined description.
    const itemsToInsert = buildBridgeAwareLineItems(
      restorations,
      (caseRow as any).bridgeConnectors ?? null,
      noChargeRemake,
    );
    const sourceKeyFor = (ids: string[]) =>
      `restoration:${[...ids].sort().join(",")}`;
    const suppressedKeys = new Set(
      Array.isArray(
        (lockedInvoice.displayMetadataJson as Record<string, unknown> | null)
          ?.suppressedGeneratedLineKeys,
      )
        ? ((lockedInvoice.displayMetadataJson as Record<string, unknown>)
            .suppressedGeneratedLineKeys as string[])
        : [],
    );
    for (let idx = itemsToInsert.length - 1; idx >= 0; idx--) {
      const parentKey = sourceKeyFor(itemsToInsert[idx].groupedRestorationIds);
      if (suppressedKeys.has(parentKey)) itemsToInsert.splice(idx, 1);
    }

    // Synthetic generated children (currently Layered Porcelain) do not have
    // their own restoration row. Preserve an edited saved price by matching it
    // to the same generated parent source + description before replacement.
    for (const item of itemsToInsert) {
      const parentSourceKey = sourceKeyFor(item.groupedRestorationIds);
      const oldParent = existingGenerated.find(
        (line) =>
          line.parentLineItemId == null &&
          (line.sourceKey === parentSourceKey ||
            line.caseRestorationId === item.caseRestorationId),
      );
      if (!oldParent) continue;
      for (const child of item.childItems ?? []) {
        if (child.caseRestorationId) continue;
        const childKey = child.caseRestorationId
          ? sourceKeyFor([child.caseRestorationId])
          : `synthetic:${sourceKeyFor(item.groupedRestorationIds)}:${child.description.trim().toLowerCase()}`;
        if (suppressedKeys.has(childKey)) {
          item.childItems = (item.childItems ?? []).filter((candidate) => candidate !== child);
          continue;
        }
        const oldChild = existingLines.find(
          (line) =>
            line.sourceKey === childKey ||
            (line.parentLineItemId === oldParent.id &&
              line.caseRestorationId == null &&
              line.description === child.description),
        );
        if (!oldChild) continue;
        child.unitPrice = oldChild.unitPrice;
        child.lineTotal = sumMoney([
          ...Array.from({ length: child.quantity }, () => oldChild.unitPrice),
        ]);
      }
    }

    const retainedGeneratedIds = new Set<string>();
    const newParentBySourceKey = new Map<string, string>();
    if (itemsToInsert.length > 0) {
      // Insert parent rows and capture their DB-assigned IDs so we can link
      // any child sub-items (e.g. Layered Porcelain for PFZ restorations).
      const insertedParents: Array<{ id: string; sortOrder: number }> = [];
      for (const [idx, item] of itemsToInsert.entries()) {
        const sourceKey = sourceKeyFor(item.groupedRestorationIds);
        const existing = existingGenerated.find(
          (line) =>
            line.parentLineItemId == null &&
            (line.sourceKey === sourceKey ||
              (!line.sourceKey && line.caseRestorationId === item.caseRestorationId)),
        );
        const values = {
            invoiceId: invoice.id,
            sourceType: "restoration",
            sourceKey,
            sourceRestorationIdsJson: item.groupedRestorationIds,
            caseRestorationId: item.caseRestorationId,
            toothNumber: item.toothNumber,
            toothLabel: item.toothLabel ?? null,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineTotal: item.lineTotal,
            sortOrder: idx,
        };
        const row = existing
          ? (await tx.update(invoiceLineItems).set(values).where(eq(invoiceLineItems.id, existing.id)).returning({
              id: invoiceLineItems.id,
              sortOrder: invoiceLineItems.sortOrder,
            }))[0]
          : (await tx.insert(invoiceLineItems).values(values).returning({
              id: invoiceLineItems.id,
              sortOrder: invoiceLineItems.sortOrder,
            }))[0];
        retainedGeneratedIds.add(row.id);
        newParentBySourceKey.set(sourceKey, row.id);
        insertedParents.push(row);
      }

      // Insert child sub-items (e.g. Layered Porcelain $37 for PFZ) with
      // parentLineItemId pointing to the just-inserted parent rows.
      for (const [idx, item] of itemsToInsert.entries()) {
        if (!item.childItems?.length) continue;
        const parent = insertedParents.find((p) => p.sortOrder === idx);
        if (!parent) continue;
        for (const [cidx, child] of item.childItems.entries()) {
          const sourceKey = child.caseRestorationId
            ? sourceKeyFor([child.caseRestorationId])
            : `synthetic:${sourceKeyFor(item.groupedRestorationIds)}:${child.description.trim().toLowerCase()}`;
          const values = {
            invoiceId: invoice.id,
            parentLineItemId: parent.id,
            caseRestorationId: child.caseRestorationId ?? null,
            sourceType: "restoration",
            sourceKey,
            sourceRestorationIdsJson: child.caseRestorationId ? [child.caseRestorationId] : [],
            description: child.description,
            quantity: child.quantity,
            unitPrice: child.unitPrice,
            lineTotal: child.lineTotal,
            sortOrder: cidx,
          };
          const existing = existingGenerated.find(
            (line) =>
              line.parentLineItemId != null &&
              (line.sourceKey === sourceKey ||
                (!line.sourceKey && line.caseRestorationId === child.caseRestorationId &&
                  line.description === child.description)),
          );
          const row = existing
            ? (await tx.update(invoiceLineItems).set(values).where(eq(invoiceLineItems.id, existing.id)).returning({ id: invoiceLineItems.id }))[0]
            : (await tx.insert(invoiceLineItems).values(values).returning({ id: invoiceLineItems.id }))[0];
          retainedGeneratedIds.add(row.id);
        }
      }
    }
    // Manual children attached to generated parents remain manual; move them
    // under the reconciled replacement/current parent before stale deletion.
    for (const line of manualLines.filter((candidate) => candidate.parentLineItemId != null)) {
      const oldParent = existingGenerated.find((parent) => parent.id === line.parentLineItemId);
      if (!oldParent) continue;
      const oldSourceIds = new Set(
        Array.isArray(oldParent?.sourceRestorationIdsJson)
          ? oldParent.sourceRestorationIdsJson.filter((id): id is string => typeof id === "string")
          : oldParent?.caseRestorationId ? [oldParent.caseRestorationId] : [],
      );
      const replacement = itemsToInsert
        .map((item) => ({
          key: sourceKeyFor(item.groupedRestorationIds),
          overlap: item.groupedRestorationIds.filter((id) => oldSourceIds.has(id)).length,
        }))
        .sort((a, b) => b.overlap - a.overlap || a.key.localeCompare(b.key))[0];
      const newParentId =
        replacement?.overlap > 0 ? newParentBySourceKey.get(replacement.key) : null;
      if (newParentId !== line.parentLineItemId) {
        await tx.update(invoiceLineItems).set({ parentLineItemId: newParentId ?? null }).where(eq(invoiceLineItems.id, line.id));
      }
    }
    const staleGeneratedIds = existingGenerated
      .filter((line) => !retainedGeneratedIds.has(line.id))
      .map((line) => line.id);
    if (staleGeneratedIds.length > 0) {
      await tx.delete(invoiceLineItems).where(inArray(invoiceLineItems.id, staleGeneratedIds));
    }

    // Include child item line totals (e.g. Layered Porcelain) in the subtotal.
    const finalLines = await tx.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.invoiceId, lockedInvoice.id),
    });
    const subtotal = sumMoney(finalLines.map((line) => line.lineTotal));

    // Refresh the invoice's display metadata (teeth, shade, line-item
    // labels) so the Invoice tab UI shows current restoration data
    // without the user having to manually re-enter anything.
    const teethList = Array.from(
      new Set(
        restorations.map((r) => (r.toothNumber || "").trim()).filter(Boolean),
      ),
    ).join(", ");
    const shadeList = Array.from(
      new Set(
        restorations.map((r) => (r.shade || "").trim()).filter(Boolean),
      ),
    ).join(", ");
    const materialList = Array.from(
      new Set(
        restorations.map((r) => (r.material || "").trim()).filter(Boolean),
      ),
    ).join(", ");
    const caseTypeList = Array.from(
      new Set(
        restorations
          .map((r) => (r.restorationType || "").trim())
          .filter(Boolean),
      ),
    ).join(", ");
    const caseSubtypeList = Array.from(
      new Set(
        restorations
          .map((r) => (r.restorationSubtype || "").trim())
          .filter(Boolean),
      ),
    ).join(", ");
    const existingMeta =
      (lockedInvoice.displayMetadataJson as Record<string, unknown> | null) ?? {};
    const nextMeta: Record<string, unknown> = {
      ...existingMeta,
      teeth: teethList,
      shade: shadeList,
      material: materialList,
      caseType: caseTypeList,
      caseSubtype: caseSubtypeList,
      lineItems: [
        ...itemsToInsert.map((i) => ({
        item: i.description,
        description: i.description,
        })),
        ...manualLines.filter((line) => line.parentLineItemId == null).map((line) => ({
          item: line.description,
          description: line.description,
        })),
      ],
    };

    // Clear the repair-type-unclear warning when every previously-ambiguous
    // restoration now has an explicit restorationSubtype set.  The warning is
    // identified by its sentinel phrase so we don't accidentally erase
    // unrelated pricing warnings.
    const REPAIR_UNCLEAR_SENTINEL = "repair type is unclear";
    let clearAiPricingWarning = false;
    if (lockedInvoice.aiPricingWarning?.includes(REPAIR_UNCLEAR_SENTINEL)) {
      const stillAmbiguous = restorations.some(
        (r) => r.restorationType === "Removable Repair" && !r.restorationSubtype,
      );
      if (!stillAmbiguous) clearAiPricingWarning = true;
    }

    const credits = Math.max(
      0,
      Number(
        ((lockedInvoice.displayMetadataJson as Record<string, unknown> | null) ?? {}).credits ?? 0,
      ) || 0,
    );
    const total = (
      Number(subtotal) +
      Number(lockedInvoice.tax) -
      Number(lockedInvoice.discount) -
      credits
    ).toFixed(2);

    await tx
      .update(invoices)
      .set({
        subtotal,
        total,
        // Recompute balance from scratch — paidSoFar is 0 here per the
        // guard above, so balance equals the new total.
        balanceDue: total,
        displayMetadataJson: nextMeta,
        updatedByUserId: actorUserId,
        ...(clearAiPricingWarning ? { aiPricingWarning: null } : {}),
      })
      .where(and(eq(invoices.id, invoice.id)));
    return "updated";
  });

  return { action, invoiceId: invoice.id };
}

/**
 * Backwards-compatible wrapper for existing callers that only need the
 * invoice id. Clinical hierarchy edits use the detailed outcome above.
 */
export async function syncInvoiceFromRestorations(args: {
  caseId: string;
  actorUserId: string | null;
}): Promise<string | null> {
  const result = await syncInvoiceFromRestorationsDetailed(args);
  return result.invoiceId;
}

// ── Grouped line items for AI-import invoice builders ─────────────────────

export interface GroupedLineItemInsert {
  invoiceId: string;
  caseRestorationId: string | null;
  groupedRestorationIds?: string[];
  sourceKey?: string;
  sourceRestorationIdsJson?: string[];
  sourceType?: "restoration" | "manual";
  toothNumber: number | null;
  toothLabel: string | null;
  description: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  sortOrder: number;
  /**
   * The price key (e.g. "pfm_crown") that was resolved for this line item.
   * Null when the material/type is not in the standard price key catalog.
   * Stored in displayMetadataJson.lineItems — NOT a DB column.
   */
  catalogItemKey?: string | null;
  /**
   * The human-readable tier label for the catalog item (e.g. "PFM High Noble").
   * Stored in displayMetadataJson.lineItems so the Item picker pre-selects it.
   * NOT a DB column.
   */
  catalogItemLabel?: string | null;
  /**
   * True when the price key was recognized but no pricing-tier entry (or doctor
   * tier) has a price > 0 for it. Frontend renders an amber warning prompting
   * the user to add the item to the tier. NOT a DB column.
   */
  missingCatalogItem?: boolean;
  /**
   * Child sub-items to insert after the parent with `parentLineItemId` set.
   * Used for PFZ restorations that carry a Layered Porcelain surcharge.
   * NOT a DB column — consumed by `insertGroupedLineItemsWithChildren`.
   */
  childItems?: GroupedLineItemChild[];
}

/** Child sub-item shape for GroupedLineItemInsert. */
export interface GroupedLineItemChild {
  caseRestorationId?: string | null;
  sourceType?: "restoration" | "manual";
  sourceKey?: string;
  description: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

/**
 * Strip the catalog-metadata-only and child-items fields from a
 * GroupedLineItemInsert array before passing to Drizzle's `.values()`.
 * Those fields are not DB columns and must not appear in the INSERT payload.
 * Use `insertGroupedLineItemsWithChildren` to insert both parents and children
 * when the array may contain PFZ items with childItems.
 */
export function toInvoiceLineItemValues(
  items: GroupedLineItemInsert[],
): Array<Omit<GroupedLineItemInsert, "catalogItemKey" | "catalogItemLabel" | "missingCatalogItem" | "childItems">> {
  return items.map(
    ({ catalogItemKey: _ck, catalogItemLabel: _cl, missingCatalogItem: _mc, childItems: _ci, groupedRestorationIds, ...rest }) => ({
      ...rest,
      sourceType: rest.sourceType ?? (rest.caseRestorationId ? "restoration" : "manual"),
      sourceKey:
        rest.sourceKey ??
        (groupedRestorationIds?.length
          ? `restoration:${[...groupedRestorationIds].sort().join(",")}`
          : rest.caseRestorationId ? `restoration:${rest.caseRestorationId}` : undefined),
      sourceRestorationIdsJson:
        rest.sourceRestorationIdsJson ??
        groupedRestorationIds ??
        (rest.caseRestorationId ? [rest.caseRestorationId] : []),
    }),
  );
}

/**
 * Insert parent line items and their child sub-items (e.g. Layered Porcelain
 * for PFZ restorations) in one atomic operation. Uses `.returning()` to
 * capture the DB-assigned parent IDs so children can be linked via
 * `parentLineItemId`. Safe to call with items that have no children — it
 * falls back to a simple insert in that case.
 */
export async function insertGroupedLineItemsWithChildren(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOrTx: any,
  items: GroupedLineItemInsert[],
): Promise<void> {
  if (items.length === 0) return;

  const hasChildren = items.some((it) => (it.childItems?.length ?? 0) > 0);

  if (!hasChildren) {
    // Fast path: no child items — skip the returning() overhead.
    await dbOrTx.insert(invoiceLineItems).values(toInvoiceLineItemValues(items));
    return;
  }

  const inserted: Array<{ id: string; sortOrder: number }> = await dbOrTx
    .insert(invoiceLineItems)
    .values(toInvoiceLineItemValues(items))
    .returning({ id: invoiceLineItems.id, sortOrder: invoiceLineItems.sortOrder });

  const childRows: Array<{
    invoiceId: string;
    parentLineItemId: string;
    sourceType: "restoration" | "manual";
    caseRestorationId: string | null;
    sourceKey: string | null;
    sourceRestorationIdsJson: string[];
    description: string;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
    sortOrder: number;
  }> = [];
  for (const item of items) {
    if (!item.childItems?.length) continue;
    const parent = inserted.find((p) => p.sortOrder === item.sortOrder);
    if (!parent) continue;
    for (const [cidx, child] of item.childItems.entries()) {
      childRows.push({
        invoiceId: item.invoiceId,
        parentLineItemId: parent.id,
        sourceType: child.sourceType === "manual" ? "manual" : "restoration",
        caseRestorationId: child.caseRestorationId ?? null,
        sourceKey:
          child.sourceType === "manual" ? null : child.sourceKey ??
          (child.caseRestorationId
            ? `restoration:${child.caseRestorationId}`
            : `synthetic:${item.sourceKey ?? `restoration:${[...(item.groupedRestorationIds ?? [item.caseRestorationId].filter((id): id is string => !!id))].sort().join(",")}`}:${child.description.trim().toLowerCase()}`),
        sourceRestorationIdsJson: child.caseRestorationId ? [child.caseRestorationId] : [],
        description: child.description,
        quantity: child.quantity,
        unitPrice: child.unitPrice,
        lineTotal: child.lineTotal,
        sortOrder: cidx,
      });
    }
  }
  if (childRows.length > 0) {
    await dbOrTx.insert(invoiceLineItems).values(childRows);
  }
}

/**
 * Compute the grand total across parent AND child line items.
 * Child items (e.g. Layered Porcelain) contribute to the invoice total just
 * like any other line, so callers that previously summed only parent line
 * totals must use this helper after adding PFZ child items.
 */
export function sumGroupedLineItemsTotal(items: GroupedLineItemInsert[]): string {
  const parentSum = items.reduce((acc, it) => acc + Number(it.lineTotal), 0);
  const childSum = items
    .flatMap((it) => it.childItems ?? [])
    .reduce((acc, c) => acc + Number(c.lineTotal), 0);
  return (parentSum + childSum).toFixed(2);
}

type AiRestoration = {
  teeth: string;
  material: string | null;
  type: string;
  isBridge: boolean;
};

type RestorationRow = {
  id: string;
  toothNumber: string | null;
  restorationType: string;
  restorationSubtype?: string | null;
  material: string | null;
  quantity: number;
  unitPrice: string;
};

/**
 * Count teeth represented by an AI restoration `teeth` string.
 *  - Comma list "3, 4, 5" → 3
 *  - Dash range "8-10"    → 3 (10 - 8 + 1)
 *  - Single "3"           → 1
 */
function countAiTeeth(teeth: string): number {
  const t = teeth.trim();
  if (t.includes(",")) {
    return t.split(",").filter((s) => s.trim()).length;
  }
  const dashMatch = t.match(/^(\d+)-(\d+)$/);
  if (dashMatch) {
    const lo = parseInt(dashMatch[1]!, 10);
    const hi = parseInt(dashMatch[2]!, 10);
    return Math.abs(hi - lo) + 1;
  }
  return 1;
}

/**
 * Loose match between a DB restoration row and an AI restorations element.
 * Checks material (case-insensitive, null-tolerant) and that the
 * restorationType / AI type share a meaningful substring.
 */
function rowMatchesAiRestoration(r: RestorationRow, ai: AiRestoration): boolean {
  const rMat = (r.material ?? "").toLowerCase().trim();
  const aiMat = (ai.material ?? "").toLowerCase().trim();
  const matMatch = rMat === aiMat;
  const rType = r.restorationType.toLowerCase().trim();
  const aiType = ai.type.toLowerCase().trim();
  const typeMatch =
    rType.includes(aiType) ||
    aiType.includes(rType) ||
    rType.split(/\s+/).some((word) => aiType.includes(word)) ||
    aiType.split(/\s+/).some((word) => rType.includes(word));
  return matMatch && typeMatch;
}

/**
 * Build ready-to-insert invoice line items from DB restoration rows, grouping
 * same-material/same-type restorations into a single row with a combined
 * `toothLabel`. Called by the three AI-import invoice-creation blocks in
 * `cases.ts`.
 *
 * When `aiRestorations` is provided and non-empty it is used as the primary
 * grouping source (preserving bridge dash notation such as "8-10"). Each AI
 * element is matched against the DB rows to obtain the unit price.
 *
 * When `aiRestorations` is absent/empty the function falls back to grouping
 * `restorations` by `(restorationType, material)`.
 *
 * Single-tooth groups preserve the existing `toothNumber` integer column so
 * they are unaffected by this change.
 */
export async function buildGroupedLineItemsForInvoice(
  restorations: RestorationRow[],
  labelCache: Record<string, string>,
  invoiceId: string,
  labOrganizationId: string,
  aiRestorations?: AiRestoration[] | null,
): Promise<GroupedLineItemInsert[]> {
  // Missing-tooth markers are visual-only; exclude them from invoice line items.
  const billableRestorations = restorations.filter(
    (r) => r.restorationType !== "missing",
  );
  if (billableRestorations.length === 0) return [];
  restorations = billableRestorations;

  if (aiRestorations && aiRestorations.length > 0) {
    // AI-guided grouping: each AI element becomes one line item.
    // We limit consumption to countAiTeeth(ai.teeth) rows per element so that
    // two AI groups with the same material/type (e.g. two separate bridge spans)
    // each claim their own distinct DB rows rather than the first element
    // greedily consuming all matching rows.
    const used = new Set<string>();
    const items: GroupedLineItemInsert[] = [];

    for (let i = 0; i < aiRestorations.length; i++) {
      const ai = aiRestorations[i]!;
      const qty = countAiTeeth(ai.teeth);
      // Take only as many matching rows as this AI element's tooth count.
      const allMatched = restorations.filter(
        (r) => !used.has(r.id) && rowMatchesAiRestoration(r, ai),
      );
      const toUse = allMatched.slice(0, qty);

      if (toUse.length === 0) continue;

      const resolvedKeys = await Promise.all(
        toUse.map(async (r) => ({
          row: r,
          key: labOrganizationId
            ? await resolveRestorationPriceKey({
                labOrganizationId,
                material: r.material,
                restorationType: r.restorationType,
                restorationSubtype: r.restorationSubtype,
              })
            : null,
        })),
      );
      const byKey = new Map<string, RestorationRow[]>();
      for (const { row, key } of resolvedKeys) {
        // Flippers: each tooth is a separate physical appliance — never group.
        // restorationSubtype is stored as "Removable/flippers" (caseType/subtype).
        const isFlipperRow = (row.restorationSubtype ?? "").split("/")[1] === "flippers";
        const baseKey = key
          ?? `legacy:${(row.material ?? "").toLowerCase()}::${row.restorationType.toLowerCase()}`;
        const groupKey = isFlipperRow
          ? `${baseKey}::tooth:${(row.toothNumber ?? "").trim()}`
          : baseKey;
        const group = byKey.get(groupKey) ?? [];
        group.push(row);
        byKey.set(groupKey, group);
      }

      let groupIndex = 0;
      for (const groupedRows of byKey.values()) {
        const first = groupedRows[0]!;
        const catalogItemKey = resolvedKeys.find(({ row }) => row.id === first.id)?.key ?? null;
        const pk = catalogItemKey ?? first.restorationType;
        const label = resolveItemLabelFromMap(labelCache, pk);
        const groupQty = groupedRows.reduce(
          (total, row) => total + Number(row.quantity ?? 1),
          0,
        );
        const groupTeeth = groupedRows
          .map((row) => (row.toothNumber ?? "").trim())
          .filter(Boolean);
        const isSingle = groupQty === 1;
        const toothLabel = groupTeeth.length > 0
          ? groupTeeth.join(", ")
          : ai.teeth.trim();
        const unitPrice = first.unitPrice;
        const lineTotal = (groupQty * Number(unitPrice)).toFixed(2);
        const missingCatalogItem = !!catalogItemKey && Number(unitPrice) <= 0;

        items.push({
          invoiceId,
          caseRestorationId: first.id,
          groupedRestorationIds: groupedRows.map((row) => row.id),
          toothNumber: isSingle ? parseToothInt(toothLabel) : null,
          toothLabel: isSingle ? null : toothLabel,
          description: isSingle
            ? buildLabelWithTooth(toothLabel, label)
            : label,
          quantity: groupQty,
          unitPrice,
          lineTotal,
          sortOrder: i + groupIndex++,
          catalogItemKey,
          catalogItemLabel: label,
          missingCatalogItem,
        });
      }

      for (const r of toUse) used.add(r.id);
    }

    // Any DB rows not consumed by the AI array fall back to per-row items.
    const unconsumed = restorations.filter((r) => !used.has(r.id));
    const fallback = (await buildGroupedFromRows(
      unconsumed,
      labelCache,
      items.length,
      labOrganizationId,
    )).map((it) => ({ ...it, invoiceId }));
    return [...items, ...fallback];
  }

  // Fallback: group DB rows by (restorationType, material).
  return (await buildGroupedFromRows(restorations, labelCache, 0, labOrganizationId))
    .map((it) => ({ ...it, invoiceId }));
}

/**
 * Group an array of restoration rows by (restorationType, material, price key) and
 * produce one line item per group, with a comma-joined `toothLabel` for
 * multi-tooth groups. `invoiceId` is set to an empty string placeholder;
 * callers set the real value on each item after calling.
 *
 * PFZ restorations are never grouped — each tooth is a singleton with a
 * "Layered Porcelain" child sub-item. Flipper restorations are also never
 * grouped — each tooth is a separate physical appliance.
 */
async function buildGroupedFromRows(
  restorations: RestorationRow[],
  labelCache: Record<string, string>,
  sortOffset: number,
  labOrganizationId?: string,
): Promise<GroupedLineItemInsert[]> {
  if (restorations.length === 0) return [];

  type Group = { rows: RestorationRow[] };
  const groupMap = new Map<string, Group>();
  const order: string[] = [];

  const resolvedKeys = await Promise.all(
    restorations.map(async (r) => ({
      row: r,
      priceKey: labOrganizationId
        ? await resolveRestorationPriceKey({
            labOrganizationId,
            material: r.material,
            restorationType: r.restorationType,
            restorationSubtype: r.restorationSubtype,
          })
        : null,
    })),
  );
  for (const { row: r, priceKey } of resolvedKeys) {
    // PFZ: each tooth is a singleton with its own Layered Porcelain child item.
    // PFM/FCM: each tooth is a singleton so alloy sub-items can be attached
    //   per tooth by syncInvoiceFromRestorations after alloy rows are inserted.
    // Flipper: each tooth is a separate physical appliance — never group.
    // restorationSubtype is stored as "Removable/flippers" (caseType/subtype encoded).
    const isFlipperRow = (r.restorationSubtype ?? "").split("/")[1] === "flippers";
    const isAlloyRow = r.restorationType.trim().toLowerCase() === "alloy";
    const key = isPfzMaterial(r.material)
      ? `pfz-singleton::${r.id}`
      : isPfmOrFcmMaterial(r.material)
        ? `pfm-singleton::${r.id}`
        : isFlipperRow
          ? `flipper-singleton::${r.id}`
          : isAlloyRow
            ? `alloy-singleton::${r.id}`
            : `${(r.material ?? "").toLowerCase()}::${r.restorationType.toLowerCase()}::${priceKey ?? ""}::${r.unitPrice}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, { rows: [] });
      order.push(key);
    }
    groupMap.get(key)!.rows.push(r);
  }

  const items: GroupedLineItemInsert[] = [];
  let idx = sortOffset;

  for (const key of order) {
    const { rows } = groupMap.get(key)!;
    const first = rows[0]!;
    const catalogItemKey =
      resolvedKeys.find(({ row }) => row.id === first.id)?.priceKey ?? null;
    const pk = catalogItemKey ?? first.restorationType;
    const label = resolveItemLabelFromMap(labelCache, pk);
    const unitPrice = first.unitPrice;
    const missingCatalogItem = !!catalogItemKey && Number(unitPrice) <= 0;

    if (rows.length === 1) {
      const qty = Number(first.quantity ?? 1);
      // Attach the Layered Porcelain child sub-item for PFZ singletons.
      const childItems: GroupedLineItemChild[] = isPfzMaterial(first.material)
        ? [
            {
              description: LAYERED_PORCELAIN_DESCRIPTION,
              quantity: 1,
              unitPrice: LAYERED_PORCELAIN_SURCHARGE,
              lineTotal: LAYERED_PORCELAIN_SURCHARGE,
            },
          ]
        : [];
      items.push({
        invoiceId: "",
        caseRestorationId: first.id,
        groupedRestorationIds: [first.id],
        toothNumber: parseToothInt(first.toothNumber ?? ""),
        toothLabel: null,
        description: buildLabelWithTooth(first.toothNumber ?? "", label),
        quantity: qty,
        unitPrice,
        lineTotal: (qty * Number(unitPrice)).toFixed(2),
        sortOrder: idx++,
        catalogItemKey,
        catalogItemLabel: label,
        missingCatalogItem,
        ...(childItems.length > 0 ? { childItems } : {}),
      });
    } else {
      const qty = rows.reduce((s, r) => s + Number(r.quantity ?? 1), 0);
      const teeth = rows
        .map((r) => parseInt(r.toothNumber ?? "", 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 32)
        .sort((a, b) => a - b);
      const toothLabel = teeth.length > 0 ? teeth.join(", ") : null;
      items.push({
        invoiceId: "",
        caseRestorationId: first.id,
        groupedRestorationIds: rows.map((row) => row.id),
        toothNumber: null,
        toothLabel,
        description: label,
        quantity: qty,
        unitPrice,
        lineTotal: (qty * Number(unitPrice)).toFixed(2),
        sortOrder: idx++,
        catalogItemKey,
        catalogItemLabel: label,
        missingCatalogItem,
      });
    }
  }

  return items;
}

function buildLabelWithTooth(toothStr: string, label: string): string {
  const t = (toothStr ?? "").trim();
  if (!t) return label;
  if (/^\d+$/.test(t)) return `#${t} ${label}`;
  return `${t} ${label}`;
}

/**
 * Count open unpaid invoices for a doctor in a lab.
 * Used by the pre-save pricing dialog to tell admins how many invoices
 * would be affected before they decide whether to apply the new pricing.
 */
export async function countDoctorDraftInvoices(args: {
  labOrganizationId: string;
  doctorName: string;
}): Promise<number> {
  const { labOrganizationId, doctorName } = args;
  const normalized = normalizeDoctor(doctorName);
  if (!normalized) return 0;

  const normalizedDoctorExpr = sql`regexp_replace(lower(trim(${cases.doctorName})), '^dr\\.?\\s*', '')`;

  const matchingCases = await db.query.cases.findMany({
    where: and(
      eq(cases.labOrganizationId, labOrganizationId),
      notDeleted(cases),
      sql`${normalizedDoctorExpr} = ${normalized}`,
    ),
  });

  let count = 0;
  for (const caseRow of matchingCases) {
    try {
      const invoice = await db.query.invoices.findFirst({
        where: eq(invoices.caseId, caseRow.id),
      });
      if (!invoice) continue;
      if (invoice.status !== "open") continue;

      const [paidAgg] = await db
        .select({ value: sum(payments.amount) })
        .from(payments)
        .where(eq(payments.invoiceId, invoice.id));
      if (Number(paidAgg?.value ?? 0) > 0) continue;

      count++;
    } catch {
      // Skip on error — partial count is still useful.
    }
  }
  return count;
}

/**
 * Re-resolve and re-sync invoices for all of a doctor's existing open,
 * unpaid cases in a lab after a pricing override is created or edited.
 *
 * For each matching case:
 *  - Restorations with `priceSource = "manual"` (user-set prices) are
 *    preserved exactly — only auto-priced restorations are updated.
 *  - All existing `syncInvoiceFromRestorations` safety rules apply:
 *    paid / void / cancelled invoices are skipped; invoices with any recorded
 *    payment are skipped; no-charge remake $0 intent is preserved.
 *
 * This is fire-and-forget safe: individual case failures are silently
 * skipped so one bad row doesn't abort the whole batch.
 */
export async function requoteDoctorDraftInvoices(args: {
  labOrganizationId: string;
  doctorName: string;
  actorUserId: string | null;
}): Promise<void> {
  const { labOrganizationId, doctorName, actorUserId } = args;
  const normalized = normalizeDoctor(doctorName);
  if (!normalized) return;

  // Mirror the SQL normalization used by findDoctorOverride.
  const normalizedDoctorExpr = sql`regexp_replace(lower(trim(${cases.doctorName})), '^dr\\.?\\s*', '')`;

  const matchingCases = await db.query.cases.findMany({
    where: and(
      eq(cases.labOrganizationId, labOrganizationId),
      notDeleted(cases),
      sql`${normalizedDoctorExpr} = ${normalized}`,
    ),
  });

  for (const caseRow of matchingCases) {
    try {
      const invoice = await db.query.invoices.findFirst({
        where: eq(invoices.caseId, caseRow.id),
      });
      if (!invoice) continue;
      if (invoice.status !== "open") continue;

      const [paidAgg] = await db
        .select({ value: sum(payments.amount) })
        .from(payments)
        .where(eq(payments.invoiceId, invoice.id));
      if (Number(paidAgg?.value ?? 0) > 0) continue;

      const restorations = await db.query.caseRestorations.findMany({
        where: eq(caseRestorations.caseId, caseRow.id),
      });

      for (const r of restorations) {
        // Skip missing-tooth markers (no price) and manually-set prices.
        if (r.restorationType === "missing") continue;
        if (r.priceSource === "manual") continue;

        const repriced = await resolveServerPriceWithSource(
          {
            labOrganizationId,
            doctorName: caseRow.doctorName,
            providerOrganizationId: (caseRow as any).providerOrganizationId ?? null,
          },
          r.material,
          r.restorationType,
          r.restorationSubtype,
        );
        if (!repriced) continue;

        await db
          .update(caseRestorations)
          .set({
            unitPrice: repriced.amount.toFixed(2),
            priceSource: repriced.source,
            priceSourceId: repriced.sourceId,
            priceSourceName: repriced.sourceName,
            priceKey: repriced.key,
            updatedAt: new Date(),
          })
          .where(eq(caseRestorations.id, r.id));
      }

      await syncInvoiceFromRestorations({ caseId: caseRow.id, actorUserId });
    } catch {
      // Skip this case silently — one bad row shouldn't abort the batch.
    }
  }
}
