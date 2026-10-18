import { and, eq, isNull } from "drizzle-orm";
import { invoices } from "@workspace/db";

export class CaseInvoiceConflictError extends Error {}

/**
 * Insert an AI-intake invoice header and resolve a concurrent/idempotent
 * conflict.  A conflict is only acceptable when it points at the same live
 * case in the same lab; callers can then safely continue using the returned
   * invoice.  Returning null from an invoice insert is never treated as success.
 */
export async function insertOrResolveAiIntakeInvoice(
  tx: any,
  values: Record<string, unknown>,
  caseId: string,
  labOrganizationId: string,
) {
  const [created] = await tx
    .insert(invoices)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (created) return { ...created, newlyCreated: true };

  const [existing] = await tx
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.invoiceNumber, String(values.invoiceNumber)),
        eq(invoices.caseId, caseId),
        eq(invoices.labOrganizationId, labOrganizationId),
        isNull(invoices.deletedAt),
        isNull(invoices.caseDeletedAt),
      ),
    )
    .for("update");
  if (!existing) {
    throw new CaseInvoiceConflictError(
      `Invoice conflict for ${String(values.invoiceNumber)} did not resolve to a live invoice for case ${caseId}.`,
    );
  }
  return { ...existing, newlyCreated: false };
}
