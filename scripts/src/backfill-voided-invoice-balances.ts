/**
 * One-shot data fix: clears the outstanding balance on invoices that are
 * already "void" but still carry a nonzero `balance_due`.
 *
 * Background: voiding an invoice through the dedicated single-invoice
 * `/invoices/:id/void` action has always zeroed `balance_due` immediately.
 * The bulk "change status" action, however, only flipped `status` to "void"
 * without touching `balance_due` — so any invoice voided in bulk kept
 * whatever balance it had at the time, and that stale amount got summed into
 * open-balance totals elsewhere (Invoices page cards/column totals, Reports
 * "Open balance"). The bulk-status route itself has been fixed to zero the
 * balance going forward; this script corrects the invoices that were already
 * left in that inconsistent state before the fix.
 *
 * Scope: any invoice with status = 'void' and balance_due <> 0.00, regardless
 * of how it came to be void (bulk-status is the known/expected cause, but the
 * condition itself — "void invoices must not carry a balance" — is a general
 * data invariant, so the fix is not narrowed to a specific code path).
 * Soft-deleted rows are included too: a voided-and-deleted invoice should
 * never carry a nonzero balance either, and correcting it is harmless.
 *
 * Safe to re-run: only rows currently in the inconsistent state are touched;
 * a repaired row no longer matches the WHERE clause on a later run.
 *
 * Required env:
 *   DATABASE_URL — Postgres connection string (same one the API uses). Run
 *   this against whichever environment needs the correction.
 *
 * Flags:
 *   --dry-run   Report what would change without writing (default: apply).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-voided-invoice-balances
 *   pnpm --filter @workspace/scripts run backfill-voided-invoice-balances -- --dry-run
 */

import { and, eq, ne, sql } from "drizzle-orm";
import { db, pool, invoices } from "@workspace/db";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  console.log(
    `[backfill-voided-invoice-balances] starting — mode=${dryRun ? "DRY-RUN" : "WRITE"}`,
  );

  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      labOrganizationId: invoices.labOrganizationId,
      balanceDue: invoices.balanceDue,
      deletedAt: invoices.deletedAt,
    })
    .from(invoices)
    .where(and(eq(invoices.status, "void"), ne(invoices.balanceDue, "0.00")));

  console.log(
    `[backfill-voided-invoice-balances] found ${rows.length} voided invoice(s) with a stale nonzero balance`,
  );

  for (const row of rows) {
    console.log(
      `  ${dryRun ? "would clear" : "clearing"} invoice ${row.invoiceNumber} ` +
        `(lab=${row.labOrganizationId}${row.deletedAt ? ", soft-deleted" : ""}) ` +
        `balance_due ${row.balanceDue} -> 0.00`,
    );
  }

  if (rows.length === 0) {
    console.log("[backfill-voided-invoice-balances] nothing to do.");
    await pool.end();
    return;
  }

  if (dryRun) {
    console.log(
      `\n[backfill-voided-invoice-balances] dry-run — no writes performed. ` +
        `Re-run without --dry-run to apply.`,
    );
    await pool.end();
    return;
  }

  // Guarded, re-assert-on-write UPDATE: only rows still void with a nonzero
  // balance are touched, so a concurrent change between the read above and
  // this write cannot silently over-correct.
  const updated = await db
    .update(invoices)
    .set({ balanceDue: "0.00" })
    .where(and(eq(invoices.status, "void"), ne(invoices.balanceDue, "0.00")))
    .returning({ id: invoices.id });

  console.log(
    `\n[backfill-voided-invoice-balances] done — cleared balance on ${updated.length} invoice(s).`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error("[backfill-voided-invoice-balances] fatal error:", err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
