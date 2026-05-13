import { and, eq, sum } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  caseRestorations,
  cases,
  invoiceLineItems,
  invoices,
  payments,
} from "@workspace/db";
import { calculateLineTotal, sumMoney } from "./case";

/**
 * Re-sync the invoice attached to a case from its current restoration rows.
 *
 * Use this whenever the restoration set on a case changes (add / delete /
 * price edit) so the user doesn't have to also open the Invoice tab and
 * regenerate by hand. Mirrors the auto-invoice logic that runs on case
 * creation, but for the post-creation lifecycle.
 *
 * Safety rules:
 *   - Only touches invoices in "draft" or "open" status. Paid / void /
 *     cancelled invoices are left alone — they're closed books.
 *   - Skips invoices that already have a recorded payment, even if their
 *     status is still "open" (partial-pay safety).
 *   - Preserves the invoice's no-charge-remake intent: if every existing
 *     line item on the invoice is at $0 and the invoice carries a
 *     "no-charge remake" note, the rebuilt line items are also forced
 *     to $0 so we don't silently start charging for a no-charge remake.
 *   - If the case has no invoice yet, this function is a no-op (cases
 *     auto-create their invoice on POST /cases). Callers that need to
 *     guarantee an invoice exists should use the existing
 *     `/invoices/cases/:caseId/generate-invoice` endpoint.
 *
 * Returns the rebuilt invoice id (or null if nothing was synced).
 */
export async function syncInvoiceFromRestorations(args: {
  caseId: string;
  actorUserId: string | null;
}): Promise<string | null> {
  const { caseId, actorUserId } = args;

  const caseRow = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
  });
  if (!caseRow) return null;

  const invoice = await db.query.invoices.findFirst({
    where: eq(invoices.caseId, caseId),
  });
  if (!invoice) return null;

  // Closed-book statuses are off-limits.
  if (invoice.status !== "draft" && invoice.status !== "open") return null;

  // Bail if any payment has already been applied to the invoice — at that
  // point the line items are part of the financial record and shouldn't
  // be silently rewritten.
  const [paidAgg] = await db
    .select({ value: sum(payments.amount) })
    .from(payments)
    .where(eq(payments.invoiceId, invoice.id));
  const paidSoFar = Number(paidAgg?.value ?? 0);
  if (paidSoFar > 0) return null;

  // Detect "no-charge remake" intent on the existing invoice so we don't
  // silently start charging for one. Two signals must both be true:
  //   1. The case is flagged as a remake with remakeCharged = false.
  //   2. The current invoice notes mention "no-charge".
  const noChargeRemake =
    !!caseRow.remakeOfCaseId &&
    caseRow.remakeCharged === false &&
    !!invoice.notes &&
    /no-?charge/i.test(invoice.notes);

  // Replace the invoice's line items + header in one transaction so
  // we never leave the invoice with new line items but a stale total
  // (or vice versa). Read restorations inside the transaction so we
  // see a consistent snapshot under concurrent restoration writes.
  await db.transaction(async (tx) => {
    const restorations = await tx.query.caseRestorations.findMany({
      where: eq(caseRestorations.caseId, caseId),
    });

    await tx
      .delete(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));

    const itemsToInsert = restorations.map((r, idx) => ({
      invoiceId: invoice.id,
      caseRestorationId: r.id,
      description: noChargeRemake
        ? `${r.restorationType} - Tooth ${r.toothNumber} (no-charge remake)`
        : `${r.restorationType} - Tooth ${r.toothNumber}`,
      quantity: r.quantity,
      unitPrice: noChargeRemake ? "0.00" : r.unitPrice,
      lineTotal: noChargeRemake
        ? "0.00"
        : calculateLineTotal(r.quantity, r.unitPrice),
      sortOrder: idx,
    }));

    if (itemsToInsert.length > 0) {
      await tx.insert(invoiceLineItems).values(itemsToInsert);
    }

    const subtotal = sumMoney(itemsToInsert.map((i) => i.lineTotal));

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
    const existingMeta =
      (invoice.displayMetadataJson as Record<string, unknown> | null) ?? {};
    const nextMeta: Record<string, unknown> = {
      ...existingMeta,
      teeth: teethList,
      shade: shadeList,
      lineItems: restorations.map((r) => ({
        item: r.restorationType,
        description: `${r.restorationType} - Tooth ${r.toothNumber}`,
      })),
    };

    await tx
      .update(invoices)
      .set({
        subtotal,
        total: subtotal,
        // Recompute balance from scratch — paidSoFar is 0 here per the
        // guard above, so balance equals the new total.
        balanceDue: subtotal,
        displayMetadataJson: nextMeta,
        updatedByUserId: actorUserId,
        // A draft invoice that now has line items should automatically
        // become "open" so it shows up on the receivables worklist.
        ...(invoice.status === "draft" && restorations.length > 0
          ? { status: "open" as const, issuedAt: new Date() }
          : {}),
      })
      .where(and(eq(invoices.id, invoice.id)));
  });

  return invoice.id;
}
