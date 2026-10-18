import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import {
  db, caseNotes, caseRestorations, cases, invoices, organizations,
} from "@workspace/db";
import {
  buildGroupedLineItemsForInvoice,
  insertGroupedLineItemsWithChildren,
  sumGroupedLineItemsTotal,
} from "./invoice-sync";
import { fetchLabItemLabels } from "./pricing";
import { ensureDoctorProfileIdentity } from "./doctor-profile-identity";
import { invoiceDueDate } from "./invoice-due-date";
import { CaseInvoiceConflictError, insertOrResolveAiIntakeInvoice } from "./ai-intake-invoice";
import { calendarDateToUtcNoon } from "@workspace/calendar-date";
import { logger } from "./logger";
import { isArchApplicable } from "./arch-billing";
import { historicalStartupMaintenanceEnabled } from "./startup-maintenance";

type RepairOutcome = "repaired" | "skipped";

/** Only canonical cases received on either of the two most recent calendar days. */
export async function repairRecentCaseInvoices(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString().slice(0, 10);
  const candidates = await db.select({
    id: cases.id,
    labOrganizationId: cases.labOrganizationId,
    caseNumber: cases.caseNumber,
  }).from(cases).where(and(
    isNull(cases.deletedAt),
    gte(cases.receivedAt, yesterday),
    lte(cases.receivedAt, today),
  ));
  const summary = { scanned: candidates.length, repaired: 0, skipped: 0, conflicting: 0, failed: 0 };
  for (const candidate of candidates) {
    try {
      const outcome = await repairOne(candidate);
      summary[outcome]++;
    } catch (err) {
      const category = err instanceof CaseInvoiceConflictError ? "conflicting" : "failed";
      summary[category]++;
      logger.warn({ err, caseId: candidate.id, caseNumber: candidate.caseNumber,
        labOrganizationId: candidate.labOrganizationId, category },
      "Recent case invoice repair: case not repaired");
    }
  }
  return summary;
}

async function repairOne(candidate: { id: string; labOrganizationId: string; caseNumber: string }): Promise<RepairOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${candidate.id}))`);
    const [locked] = await tx.select().from(cases)
      .where(eq(cases.id, candidate.id)).for("update");
    if (!locked || locked.deletedAt || locked.labOrganizationId !== candidate.labOrganizationId) return "skipped";

    // Never modify an existing invoice, including a paid or void invoice.
    const linked = await tx.select({ id: invoices.id }).from(invoices).where(and(
      eq(invoices.caseId, locked.id),
      eq(invoices.labOrganizationId, locked.labOrganizationId),
      isNull(invoices.deletedAt),
    )).for("update");
    if (linked.length) return "skipped";
    const restorations = await tx.query.caseRestorations.findMany({
      where: eq(caseRestorations.caseId, locked.id),
      orderBy: [caseRestorations.createdAt],
    });
    const billable = restorations.filter((r) => !/^missing$/i.test(r.restorationType));
    const notes = await tx.query.caseNotes.findMany({
      where: and(eq(caseNotes.caseId, locked.id), eq(caseNotes.visibility, "shared_with_provider")),
    });
    const [provider] = locked.providerOrganizationId
      ? await tx.select().from(organizations).where(and(
          eq(organizations.id, locked.providerOrganizationId),
          eq(organizations.parentLabOrganizationId, locked.labOrganizationId),
        ))
      : [];
    if (locked.providerOrganizationId && !provider) {
      throw new Error("Case practice is not owned by its lab.");
    }
    const billTo = provider?.displayName || provider?.name || locked.doctorName || "";
    const missingArch = billable.some((r) =>
      isArchApplicable(r.restorationType, r.restorationSubtype) && !r.arch);
    const metadata = {
      patientName: `${locked.patientFirstName ?? ""} ${locked.patientLastName ?? ""}`.trim(),
      billTo,
      teeth: [...new Set(billable.map((r) => r.toothNumber?.trim()).filter(Boolean))].join(", "),
      shade: [...new Set(billable.map((r) => r.shade?.trim()).filter(Boolean))].join(", "),
      material: [...new Set(billable.map((r) => r.material?.trim()).filter(Boolean))].join(", "),
      caseNotes: [locked.rxNotes, ...notes.map((n) => n.noteText), ...billable.map((r) => r.notes)]
        .map((text) => text?.trim()).filter(Boolean).join("\n"),
      credits: 0,
    };
    const noChargeRemake = !!locked.remakeOfCaseId && locked.remakeCharged === false;
    const invoice = await insertOrResolveAiIntakeInvoice(tx, {
      invoiceNumber: `INV-${locked.caseNumber}`,
      caseId: locked.id,
      labOrganizationId: locked.labOrganizationId,
      providerOrganizationId: locked.providerOrganizationId,
      doctorIdentity: await ensureDoctorProfileIdentity(tx, {
        labOrganizationId: locked.labOrganizationId,
        providerOrganizationId: locked.providerOrganizationId,
        doctorName: billTo,
      }),
      status: "open",
      displayMetadataJson: metadata,
      aiGenerated: locked.aiImportSource != null,
      aiPricingWarning: missingArch
        ? "Arch is missing — select an arch and verify clinical completeness before sending."
        : billable.length === 0 && locked.aiImportSource
          ? "AI could not extract restorations — add and verify line items before sending."
          : null,
      notes: noChargeRemake ? `No-charge remake of case ${locked.caseNumber}` : null,
      issuedAt: calendarDateToUtcNoon(locked.receivedAt),
      dueAt: invoiceDueDate(new Date()),
      createdByUserId: locked.createdByUserId,
      updatedByUserId: locked.createdByUserId,
    }, locked.id, locked.labOrganizationId);
    // A same-case insert conflict can be another writer's completed invoice.
    // Never append lines or reset its totals.
    if (!invoice.newlyCreated) return "skipped";
    const labels = await fetchLabItemLabels(locked.labOrganizationId);
    const items = await buildGroupedLineItemsForInvoice(
      billable, labels, invoice.id, locked.labOrganizationId, null,
    );
    if (noChargeRemake) {
      for (const item of items) {
        item.unitPrice = "0.00";
        item.lineTotal = "0.00";
        for (const child of item.childItems ?? []) {
          child.unitPrice = "0.00";
          child.lineTotal = "0.00";
        }
      }
    }
    await insertGroupedLineItemsWithChildren(tx, items);
    const subtotal = sumGroupedLineItemsTotal(items);
    await tx.update(invoices).set({
      subtotal, total: subtotal, balanceDue: subtotal,
      displayMetadataJson: {
        ...metadata,
        lineItems: items.map((it) => ({
          item: it.catalogItemLabel ?? it.description,
          description: it.description,
          catalogItemKey: it.catalogItemKey ?? null,
          missingCatalogItem: it.missingCatalogItem ?? false,
        })),
      },
    }).where(eq(invoices.id, invoice.id));
    return "repaired";
  });
}

export function scheduleRecentCaseInvoiceRepair(): void {
  if (!historicalStartupMaintenanceEnabled()) {
    logger.warn("Recent case invoice repair: deferred outside explicit development startup");
    return;
  }
  setImmediate(() => void repairRecentCaseInvoices().then((summary) => {
    logger.info(summary, "Recent case invoice repair: complete");
  }).catch((err) => {
    logger.error({ err }, "Recent case invoice repair: failed");
  }));
}