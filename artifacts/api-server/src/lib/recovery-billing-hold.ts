import { sql } from "drizzle-orm";
import { invoices } from "@workspace/db";
import { HttpError } from "./http";

export const RECOVERY_DRAFT_STATUS = "recovery_draft";

export function isRecoveryHeld(invoice: {
  status?: string | null;
  displayMetadataJson?: unknown;
}): boolean {
  const metadata = invoice.displayMetadataJson as {
    recoveryBilling?: { state?: string };
  } | null;
  return invoice.status === RECOVERY_DRAFT_STATUS ||
    metadata?.recoveryBilling?.state === "held";
}

/** Fail closed even if a legacy writer changed the status but left the hold. */
export function assertRecoveryReleased(invoice: Parameters<typeof isRecoveryHeld>[0]): void {
  if (isRecoveryHeld(invoice)) {
    throw new HttpError(409,
      "Reconstructed billing is held for charge and historical-payment review. A lab admin must release it in Recovery Billing; do not send or collect it.");
  }
}

/** Use on every financial/statement query, not on the lab's invoice register. */
export function finalizedInvoiceSql() {
  return sql`(${invoices.status} <> ${RECOVERY_DRAFT_STATUS}
    AND COALESCE(${invoices.displayMetadataJson}->'recoveryBilling'->>'state', '') <> 'held')`;
}
