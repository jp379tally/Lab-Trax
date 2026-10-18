import { finalizedInvoiceSql } from "./recovery-billing-hold";
/**
 * Dated AP/AR figures for the financial reports.
 *
 * Every function here reconstructs a balance from records that carry their own
 * date, rather than reading a "current" balance column. That is what lets a
 * report dated to the end of last quarter show what was actually outstanding
 * then instead of what is outstanding now.
 *
 * Accounting basis (see docs/ap-ar-workflow-contract.md):
 *   - A vendor bill recognizes its expense on the bill date.
 *   - Paying that bill moves cash; it is not a second expense.
 *   - An immediate register expense (a check written without a bill) is still
 *     recognized once, on its transaction date.
 *   - AP is a liability, AR an asset. Neither is derived from the legacy
 *     "Accounts Payable" / "Accounts Receivable" spending categories, whose
 *     income/expense labels describe where a lab filed a cash transaction,
 *     not a control account.
 */

import { and, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  bankTransactionInvoices,
  bankTransactions,
  customerCreditApplications,
  customerCredits,
  invoiceAccountingEvents,
  invoiceCredits,
  invoices,
  payments,
  reversedInvoiceSettlements,
  statementPaymentApplications,
  statementPaymentSessions,
  vendorBillEvents,
  vendorBillLines,
  vendorBills,
  vendorCredits,
  vendorPaymentAllocations,
  vendorPayments,
} from "@workspace/db";
import { toCents } from "./money-cents";

/**
 * Resolve end-of-day for a calendar Y/M/D in an IANA tz, returned as the UTC
 * instant. Falls back to UTC if no tz is supplied or invalid.
 */
export function endOfDayInTz(
  yr: number,
  mo: number,
  day: number,
  tz: string | undefined,
): Date {
  if (!tz) return new Date(Date.UTC(yr, mo, day, 23, 59, 59, 999));
  try {
    const guess = Date.UTC(yr, mo, day, 23, 59, 59, 999);
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = fmt.formatToParts(new Date(guess));
    const get = (t: string) =>
      Number(parts.find((p) => p.type === t)?.value ?? "0");
    const wallAsUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    const offset = wallAsUtc - guess; // ms tz is ahead of UTC
    return new Date(guess - offset);
  } catch {
    return new Date(Date.UTC(yr, mo, day, 23, 59, 59, 999));
  }
}

/** Bank-transaction source marking cash that settled a vendor bill. */
export const BILL_PAYMENT_TXN_SOURCE = "bill_payment";

/** A bill's accounting facts as they stood at a point in time. */
export interface BillVersion {
  billId: string;
  billDate: Date;
  dueDate: Date | null;
  totalCents: number;
  lines: Array<{ categoryId: string | null; cents: number }>;
}

/**
 * Reconstruct every bill in a lab as it stood on `asOf`.
 *
 * Each bill edit freezes a snapshot onto its event row, so the version in
 * force at a past date is the last snapshot recorded by then — not the
 * current bill row, which a later edit may have changed. A bill entered
 * today but dated to an earlier period still belongs to that period, so it
 * is replayed there exactly as it was first entered; only later edits are
 * withheld from reports dated before them. Whether the bill counts at all
 * is then decided by the version's own bill date. Bills with no snapshots
 * (recorded before snapshots existed) fall back to their current row, the
 * only evidence available for them.
 */
export async function billVersionsAsOf(
  organizationId: string,
  asOf: Date,
): Promise<Map<string, BillVersion>> {
  const [snapshots, currentBills] = await Promise.all([
    db
      .select({
        billId: vendorBillEvents.billId,
        occurredAt: vendorBillEvents.occurredAt,
        billDate: vendorBillEvents.effectiveBillDate,
        dueDate: vendorBillEvents.effectiveDueDate,
        total: vendorBillEvents.effectiveTotal,
        lines: vendorBillEvents.effectiveLinesJson,
      })
      .from(vendorBillEvents)
      .where(
        and(
          eq(vendorBillEvents.labOrganizationId, organizationId),
          sql`${vendorBillEvents.effectiveTotal} IS NOT NULL`,
          sql`${vendorBillEvents.billId} IS NOT NULL`,
        ),
      )
      .orderBy(vendorBillEvents.occurredAt),
    db
      .select({
        id: vendorBills.id,
        billDate: vendorBills.billDate,
        dueDate: vendorBills.dueDate,
        total: vendorBills.total,
      })
      .from(vendorBills)
      .where(eq(vendorBills.labOrganizationId, organizationId)),
  ]);

  const toVersion = (snapshot: (typeof snapshots)[number]): BillVersion => {
    const rawLines = Array.isArray(snapshot.lines)
      ? (snapshot.lines as Array<{ categoryId: string | null; amount: string }>)
      : [];
    return {
      billId: snapshot.billId as string,
      billDate: new Date(snapshot.billDate as unknown as string),
      dueDate: snapshot.dueDate ? new Date(snapshot.dueDate as unknown as string) : null,
      totalCents: toCents(snapshot.total as unknown as string),
      lines: rawLines.map((line) => ({
        categoryId: line.categoryId ?? null,
        cents: toCents(line.amount),
      })),
    };
  };

  const versions = new Map<string, BillVersion>();
  const hasAnySnapshot = new Set<string>();
  for (const snapshot of snapshots) {
    if (!snapshot.billId) continue;
    const firstSnapshot = !hasAnySnapshot.has(snapshot.billId);
    hasAnySnapshot.add(snapshot.billId);
    // The as-entered version applies from the bill's own date, so a bill
    // recorded late still shows up in the period it belongs to.
    if (firstSnapshot) {
      versions.set(snapshot.billId, toVersion(snapshot));
      continue;
    }
    // Later edits only apply to reports dated on or after the edit.
    if (new Date(snapshot.occurredAt) > asOf) continue;
    versions.set(snapshot.billId, toVersion(snapshot));
  }

  if (hasAnySnapshot.size === currentBills.length) return versions;
  // Pre-snapshot bills: the live row is the only record of what they say.
  const legacyIds = currentBills
    .filter((bill) => !hasAnySnapshot.has(bill.id))
    .map((bill) => bill.id);
  if (!legacyIds.length) return versions;
  const legacyLines = await db
    .select({
      billId: vendorBillLines.billId,
      categoryId: vendorBillLines.categoryId,
      amount: vendorBillLines.amount,
    })
    .from(vendorBillLines)
    .where(inArray(vendorBillLines.billId, legacyIds));
  const linesByBill = new Map<string, Array<{ categoryId: string | null; cents: number }>>();
  for (const line of legacyLines) {
    const list = linesByBill.get(line.billId) ?? [];
    list.push({ categoryId: line.categoryId ?? null, cents: toCents(line.amount) });
    linesByBill.set(line.billId, list);
  }
  for (const bill of currentBills) {
    if (hasAnySnapshot.has(bill.id)) continue;
    const billDate = new Date(bill.billDate as unknown as string);
    if (billDate > asOf) continue;
    versions.set(bill.id, {
      billId: bill.id,
      billDate,
      dueDate: bill.dueDate ? new Date(bill.dueDate as unknown as string) : null,
      totalCents: toCents(bill.total),
      lines: linesByBill.get(bill.id) ?? [],
    });
  }
  return versions;
}

export interface BilledExpenses {
  /** Expense recognized per category, in cents. `null` key = uncategorized. */
  byCategoryId: Map<string | null, number>;
  totalCents: number;
}

/**
 * Cumulative expense recognized from vendor bills through `asOf`.
 *
 * Each bill is replayed as it stood on that date: an edit made later has not
 * happened yet here, and a bill voided later is still an expense.
 */
export async function billedExpensesThrough(
  organizationId: string,
  asOf: Date,
): Promise<BilledExpenses> {
  const byCategoryId = new Map<string | null, number>();
  let totalCents = 0;
  if (Number.isNaN(asOf.getTime())) return { byCategoryId, totalCents };
  const [versions, voidDates] = await Promise.all([
    billVersionsAsOf(organizationId, asOf),
    db
      .select({ id: vendorBills.id, voidedAt: vendorBills.voidedAt })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.labOrganizationId, organizationId),
          sql`${vendorBills.voidedAt} IS NOT NULL`,
        ),
      ),
  ]);
  const voidedByAsOf = new Set(
    voidDates
      .filter((row) => row.voidedAt && new Date(row.voidedAt) <= asOf)
      .map((row) => row.id),
  );

  for (const version of versions.values()) {
    if (voidedByAsOf.has(version.billId)) continue;
    if (version.billDate > asOf) continue;
    for (const line of version.lines) {
      byCategoryId.set(
        line.categoryId,
        (byCategoryId.get(line.categoryId) ?? 0) + line.cents,
      );
      totalCents += line.cents;
    }
  }
  return { byCategoryId, totalCents };
}

/**
 * Expense recognized from vendor bills within the period.
 *
 * The period figure is the difference between what had been recognized by the
 * period end and what had been recognized the instant before it started, so
 * later events land in their own period instead of restating a closed one:
 *
 *   - entering a bill recognizes its expense on the bill date;
 *   - editing it later recognizes only the change, in the period of the edit;
 *   - voiding it later reverses it, in the period of the void.
 *
 * Adjacent periods therefore add up to the combined range, and the cumulative
 * figure through any date matches the balance sheet's payable reconstruction
 * for that same date.
 */
export async function billedExpensesInPeriod(
  organizationId: string,
  from: Date,
  to: Date,
): Promise<BilledExpenses> {
  const priorEnd = new Date(from.getTime() - 1);
  const [through, prior] = await Promise.all([
    billedExpensesThrough(organizationId, to),
    // An all-time range has nothing before it to subtract.
    priorEnd.getTime() <= 0
      ? Promise.resolve<BilledExpenses>({ byCategoryId: new Map(), totalCents: 0 })
      : billedExpensesThrough(organizationId, priorEnd),
  ]);

  const byCategoryId = new Map<string | null, number>();
  for (const [categoryId, cents] of through.byCategoryId) {
    const delta = cents - (prior.byCategoryId.get(categoryId) ?? 0);
    if (delta !== 0) byCategoryId.set(categoryId, delta);
  }
  for (const [categoryId, cents] of prior.byCategoryId) {
    if (through.byCategoryId.has(categoryId)) continue;
    if (cents !== 0) byCategoryId.set(categoryId, -cents);
  }
  return { byCategoryId, totalCents: through.totalCents - prior.totalCents };
}

/**
 * Unapplied vendor credit per credit at a point in time.
 *
 * Reconstructed as issued amount less the applications dated on or before
 * `asOf`, so applying a credit today does not retroactively erase it from a
 * report dated before the application. Credits voided by `asOf` are dropped;
 * a credit voided later still counted then.
 */
export async function unappliedVendorCreditsAsOf(
  organizationId: string,
  asOf: Date,
): Promise<Map<string, number>> {
  const credits = await db
    .select({
      id: vendorCredits.id,
      vendorId: vendorCredits.vendorId,
      amount: vendorCredits.amount,
    })
    .from(vendorCredits)
    .where(
      and(
        eq(vendorCredits.labOrganizationId, organizationId),
        lte(vendorCredits.creditDate, asOf),
        or(isNull(vendorCredits.voidedAt), sql`${vendorCredits.voidedAt} > ${asOf}`)!,
      ),
    );
  const remaining = new Map<string, number>();
  if (!credits.length) return remaining;
  for (const credit of credits) remaining.set(credit.id, toCents(credit.amount));

  const applications = await db
    .select({
      vendorCreditId: vendorPaymentAllocations.vendorCreditId,
      amount: vendorPaymentAllocations.amount,
      reversedAt: vendorPaymentAllocations.reversedAt,
      paymentVoidedAt: vendorPayments.voidedAt,
    })
    .from(vendorPaymentAllocations)
    .innerJoin(
      vendorPayments,
      eq(vendorPaymentAllocations.vendorPaymentId, vendorPayments.id),
    )
    .where(
      and(
        inArray(
          vendorPaymentAllocations.vendorCreditId,
          credits.map((credit) => credit.id),
        ),
        lte(vendorPaymentAllocations.appliedAt, asOf),
      ),
    );
  for (const application of applications) {
    if (!application.vendorCreditId) continue;
    const undoneByAsOf =
      (application.reversedAt && new Date(application.reversedAt) <= asOf) ||
      (application.paymentVoidedAt && new Date(application.paymentVoidedAt) <= asOf);
    if (undoneByAsOf) continue;
    const current = remaining.get(application.vendorCreditId);
    if (current === undefined) continue;
    remaining.set(application.vendorCreditId, current - toCents(application.amount));
  }
  for (const [creditId, cents] of remaining) {
    if (cents <= 0) remaining.delete(creditId);
  }
  return remaining;
}

/**
 * Unapplied customer credit (a liability) at a point in time.
 *
 * Overpayments recorded through a payment session live in `customerCredits`
 * and are consumed by dated application rows, so the remaining liability is
 * reconstructed the same way as its vendor-side counterpart. Reversing a
 * session removes both the credit and its applications, so a reversed credit
 * correctly disappears from every dated report.
 */
export async function unappliedCustomerCreditsAsOf(
  organizationId: string,
  asOf: Date,
): Promise<number> {
  // A credit and its applications belong to the period their payment session
  // was dated to, which the user can backdate. The row's insert time only
  // says when it was typed in.
  const creditEffectiveDate = sql`COALESCE(${statementPaymentSessions.paymentDate}, ${customerCredits.createdAt})`;
  const credits = await db
    .select({ id: customerCredits.id, amount: customerCredits.amount })
    .from(customerCredits)
    .leftJoin(
      statementPaymentSessions,
      eq(customerCredits.paymentSessionId, statementPaymentSessions.id),
    )
    .where(
      and(
        eq(customerCredits.labOrganizationId, organizationId),
        lte(creditEffectiveDate, asOf),
        or(
          isNull(customerCredits.reversedAt),
          sql`${customerCredits.reversedAt} > ${asOf}`,
        )!,
      ),
    );
  if (!credits.length) return 0;

  const applicationEffectiveDate = sql`COALESCE(${statementPaymentSessions.paymentDate}, ${customerCreditApplications.createdAt})`;
  const applications = await db
    .select({
      customerCreditId: customerCreditApplications.customerCreditId,
      amount: customerCreditApplications.amount,
    })
    .from(customerCreditApplications)
    .leftJoin(
      statementPaymentSessions,
      eq(customerCreditApplications.paymentSessionId, statementPaymentSessions.id),
    )
    .where(
      and(
        inArray(
          customerCreditApplications.customerCreditId,
          credits.map((credit) => credit.id),
        ),
        lte(applicationEffectiveDate, asOf),
      ),
    );
  const consumed = new Map<string, number>();
  for (const application of applications) {
    consumed.set(
      application.customerCreditId,
      (consumed.get(application.customerCreditId) ?? 0) + toCents(application.amount),
    );
  }

  let unappliedCents = 0;
  for (const credit of credits) {
    const remaining = toCents(credit.amount) - (consumed.get(credit.id) ?? 0);
    if (remaining > 0) unappliedCents += remaining;
  }
  return unappliedCents;
}

/**
 * Outstanding accounts payable at a point in time, reconstructed from bills
 * dated on or before `asOf` less the allocations applied by then.
 */
export async function apBalanceAsOf(
  organizationId: string,
  asOf: Date,
): Promise<{ balanceCents: number; unappliedVendorCreditCents: number }> {
  const [versions, voidDates] = await Promise.all([
    billVersionsAsOf(organizationId, asOf),
    db
      .select({ id: vendorBills.id, voidedAt: vendorBills.voidedAt })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.labOrganizationId, organizationId),
          sql`${vendorBills.voidedAt} IS NOT NULL`,
        ),
      ),
  ]);
  const voidedByAsOf = new Set(
    voidDates
      .filter((row) => row.voidedAt && new Date(row.voidedAt) <= asOf)
      .map((row) => row.id),
  );
  const bills = [...versions.values()]
    .filter((version) => !voidedByAsOf.has(version.billId) && version.billDate <= asOf)
    .map((version) => ({ id: version.billId, totalCents: version.totalCents }));
  const vendorCreditRemaining = await unappliedVendorCreditsAsOf(organizationId, asOf);
  let unappliedVendorCreditCents = 0;
  for (const cents of vendorCreditRemaining.values()) unappliedVendorCreditCents += cents;
  if (!bills.length) {
    return { balanceCents: 0, unappliedVendorCreditCents };
  }

  const allocations = await db
    .select({
      billId: vendorPaymentAllocations.billId,
      amount: vendorPaymentAllocations.amount,
      reversedAt: vendorPaymentAllocations.reversedAt,
      paymentVoidedAt: vendorPayments.voidedAt,
    })
    .from(vendorPaymentAllocations)
    .innerJoin(
      vendorPayments,
      eq(vendorPaymentAllocations.vendorPaymentId, vendorPayments.id),
    )
    .where(
      and(
        inArray(
          vendorPaymentAllocations.billId,
          bills.map((bill) => bill.id),
        ),
        lte(vendorPaymentAllocations.appliedAt, asOf),
      ),
    );

  const settled = new Map<string, number>();
  for (const allocation of allocations) {
    const undoneByAsOf =
      (allocation.reversedAt && new Date(allocation.reversedAt) <= asOf) ||
      (allocation.paymentVoidedAt && new Date(allocation.paymentVoidedAt) <= asOf);
    if (undoneByAsOf) continue;
    settled.set(
      allocation.billId,
      (settled.get(allocation.billId) ?? 0) + toCents(allocation.amount),
    );
  }

  let balanceCents = 0;
  for (const bill of bills) {
    const outstanding = bill.totalCents - (settled.get(bill.id) ?? 0);
    if (outstanding > 0) balanceCents += outstanding;
  }
  return { balanceCents, unappliedVendorCreditCents };
}

/** An invoice's accounting facts as they stood at a point in time. */
export interface InvoiceVersion {
  invoiceId: string;
  status: string;
  totalCents: number;
  /** Effective issue date — what dates the revenue and the receivable. */
  issuedAt: Date | null;
  /** Effective due date — what the aging bucket was measured against. */
  dueAt: Date | null;
  voidedAt: Date | null;
  /**
   * What the invoice itself said was still owed at that moment, when a
   * contemporaneous snapshot recorded it. Dated payment rows are the primary
   * evidence, but a reversal deletes them, and then this is all that is left
   * to show the invoice had been settled.
   */
  balanceDueCents: number | null;
  /** False when the only evidence is the live row, which today's edits move. */
  fromSnapshot: boolean;
}

/**
 * Reconstruct every live invoice in a lab as it stood on `asOf`.
 *
 * A database trigger freezes an accounting snapshot onto `invoice_accounting_events`
 * whenever an invoice's total, status, issue date, void, or deletion changes,
 * so a past date can be answered from what the books held then instead of
 * from the current row, which a later edit may have changed. Issuance and
 * voids are dated by the document itself; revisions take effect when they
 * were made, so raising an invoice this month cannot restate last month.
 * An invoice whose snapshots all postdate the report was not on the books
 * yet. Invoices recorded before snapshots existed have only their live row,
 * which is then the only evidence available for them.
 *
 * Soft-deleted invoices are excluded at every date, as they always have been:
 * a deleted document is not part of the books in any period.
 */
export async function invoiceVersionsAsOf(
  organizationId: string,
  asOf: Date,
): Promise<Map<string, InvoiceVersion>> {
  const [currentRows, snapshots] = await Promise.all([
    db
      .select({
        id: invoices.id,
        total: invoices.total,
        balanceDue: invoices.balanceDue,
        status: invoices.status,
        issuedAt: sql<Date>`COALESCE(${invoices.issuedAt}, ${invoices.createdAt})`,
        dueAt: invoices.dueAt,
        voidedAt: invoices.voidedAt,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.labOrganizationId, organizationId),
          isNull(invoices.deletedAt),
          finalizedInvoiceSql(),
        ),
      ),
    db
      .select({
        invoiceId: invoiceAccountingEvents.invoiceId,
        occurredAt: invoiceAccountingEvents.occurredAt,
        status: invoiceAccountingEvents.effectiveStatus,
        total: invoiceAccountingEvents.effectiveTotal,
        balanceDue: invoiceAccountingEvents.effectiveBalanceDue,
        issuedAt: invoiceAccountingEvents.effectiveIssuedAt,
        dueAt: invoiceAccountingEvents.effectiveDueAt,
        createdAt: invoiceAccountingEvents.effectiveCreatedAt,
        voidedAt: invoiceAccountingEvents.effectiveVoidedAt,
        deletedAt: invoiceAccountingEvents.effectiveDeletedAt,
      })
      .from(invoiceAccountingEvents)
      .where(eq(invoiceAccountingEvents.labOrganizationId, organizationId))
      .orderBy(invoiceAccountingEvents.occurredAt),
  ]);

  const live = new Map(currentRows.map((row) => [row.id, row]));
  const versions = new Map<string, InvoiceVersion>();
  const hasAnySnapshot = new Set<string>();
  const issuanceSeen = new Set<string>();
  for (const snapshot of snapshots) {
    // A snapshot of an invoice that was since deleted, or that belongs to
    // another lab's row, has nothing to contribute.
    if (!live.has(snapshot.invoiceId)) continue;
    hasAnySnapshot.add(snapshot.invoiceId);
    // Each change takes effect on the date it carries, and only an amendment
    // that carries none takes effect when it was recorded:
    //   - issuance is dated by the invoice's issue date, so a document
    //     entered late but dated to an earlier period belongs to that period;
    //   - a void is dated by its void date, so it reverses the revenue in the
    //     period the void belongs to;
    //   - an amount or date revision carries no document date of its own, so
    //     it applies from the moment it was made and cannot restate a period
    //     that closed before it.
    const isVoid = snapshot.status === "void" && snapshot.voidedAt != null;
    const isIssuance =
      !isVoid && snapshot.issuedAt != null && !issuanceSeen.has(snapshot.invoiceId);
    // An invoice voided before its issuance was ever snapshotted — a void
    // that predates this history, or one the rollout baseline captured. It
    // was on the books between its issue date and its void date, so both
    // states are reconstructed rather than only the void.
    const voidWithoutIssuance =
      isVoid && snapshot.issuedAt != null && !issuanceSeen.has(snapshot.invoiceId);
    if (snapshot.issuedAt != null) issuanceSeen.add(snapshot.invoiceId);
    const issued = snapshot.issuedAt ?? snapshot.createdAt ?? snapshot.occurredAt;
    const base: InvoiceVersion = {
      invoiceId: snapshot.invoiceId,
      status: snapshot.status ?? "open",
      totalCents: toCents(snapshot.total ?? "0"),
      issuedAt: issued ? new Date(issued) : null,
      dueAt: snapshot.dueAt ? new Date(snapshot.dueAt) : null,
      voidedAt: snapshot.voidedAt ? new Date(snapshot.voidedAt) : null,
      balanceDueCents:
        snapshot.balanceDue == null ? null : toCents(snapshot.balanceDue),
      fromSnapshot: true,
    };
    if (voidWithoutIssuance) {
      const issuedFrom = new Date(snapshot.issuedAt as unknown as string);
      if (issuedFrom <= asOf) {
        // What it was before the void: outstanding, with the balance of the
        // day left to the settlement replay rather than guessed at.
        versions.set(snapshot.invoiceId, {
          ...base,
          status: "open",
          voidedAt: null,
          balanceDueCents: null,
        });
      }
    }
    const effectiveFrom = isVoid
      ? new Date(snapshot.voidedAt as unknown as string)
      : isIssuance
        ? new Date(snapshot.issuedAt as unknown as string)
        : new Date(snapshot.occurredAt);
    if (effectiveFrom > asOf) continue;
    versions.set(snapshot.invoiceId, base);
  }

  for (const row of currentRows) {
    if (hasAnySnapshot.has(row.id)) continue;
    versions.set(row.id, {
      invoiceId: row.id,
      status: row.status,
      totalCents: toCents(row.total),
      issuedAt: row.issuedAt ? new Date(row.issuedAt) : null,
      dueAt: row.dueAt ? new Date(row.dueAt) : null,
      voidedAt: row.voidedAt ? new Date(row.voidedAt) : null,
      // Today's balance is not evidence about any earlier date.
      balanceDueCents: null,
      fromSnapshot: false,
    });
  }
  return versions;
}

/**
 * Whether a version is on the books as of a date: issued by then, not a
 * draft, and not yet voided.
 */
export function invoiceRecognizedAsOf(
  version: InvoiceVersion,
  asOf: Date,
): boolean {
  if (!version.issuedAt || version.issuedAt > asOf) return false;
  if (version.status === "draft" || version.status === "recovery_draft") return false;
  if (
    version.status === "void" &&
    (!version.voidedAt || version.voidedAt <= asOf)
  ) {
    return false;
  }
  return true;
}

/**
 * Cumulative invoiced revenue through `asOf`, in cents.
 *
 * Revenue is recognized when an invoice is issued. Because the figure is
 * cumulative and replays dated snapshots, a later edit or void shows up as
 * the difference between two dates rather than as a rewrite of the period
 * that earned the revenue.
 */
export async function invoicedRevenueThrough(
  organizationId: string,
  asOf: Date,
): Promise<number> {
  if (Number.isNaN(asOf.getTime()) || asOf.getTime() <= 0) return 0;
  const versions = await invoiceVersionsAsOf(organizationId, asOf);
  let cents = 0;
  for (const version of versions.values()) {
    if (!invoiceRecognizedAsOf(version, asOf)) continue;
    cents += version.totalCents;
  }
  return cents;
}

export interface DatedArBalance {
  /** Sum of positive outstanding invoice balances, in cents. */
  receivableCents: number;
  /** Sum of negative invoice balances (overpaid invoices), in cents. */
  invoiceOverpaymentCents: number;
  /**
   * True when at least one invoice is settled today but has no dated payment
   * record to prove when — normally because a payment was reversed and its
   * row removed. Historical figures for that lab are then approximate.
   */
  approximate: boolean;
  /** Invoices carrying settlement that nothing in the books can date. */
  unreconstructedInvoiceCount: number;
  /** How much of the receivable those invoices account for, in cents. */
  unreconstructedSettlementCents: number;
}

/** One invoice's receivable position on a given date. */
export interface DatedInvoiceOutstanding {
  invoiceId: string;
  status: string;
  totalCents: number;
  /** Positive when still owed, negative when overpaid. */
  outstandingCents: number;
  issuedAt: Date | null;
  dueAt: Date | null;
  /**
   * True when the invoice said it was settled at that date but no dated
   * payment survives to prove it, so this figure is a reconstruction from
   * the contemporaneous balance rather than from settlement records.
   */
  approximate: boolean;
  /**
   * Settlement the invoice's live row proves happened, that no record in the
   * books can place in time. It is subtracted at every date — today's balance
   * is the only thing that evidences it — and reported as a limitation rather
   * than dressed up as a dated figure.
   */
  unreconstructedSettlementCents: number;
}

/**
 * Settlement an invoice's own row proves, that its dated records do not
 * account for.
 *
 * `invoices.balance_due` is the lab's live answer to what is still owed. When
 * it sits below the invoice total by more than the dated payments, credits,
 * and credit applications explain, something settled the difference before
 * that history was being recorded. Those older settlements are usually still
 * evidenced elsewhere, and elsewhere is dated:
 *
 *   - a statement payment session's application rows carry the amount applied
 *     to each invoice, and the session carries the payment date the user
 *     recorded;
 *   - a deposit recorded against the invoice carries the date the money was
 *     banked, though nothing in it splits an amount per invoice.
 *
 * No amount is ever invented: every figure below comes from the invoice's own
 * row or from an application row, and only the date comes from the
 * surrounding record. What is left over after that stays undated.
 */
interface LegacySettlement {
  /** Portions another record can place in time. */
  dated: Array<{ cents: number; settledAt: Date }>;
  /** The part nothing dates: visible only as today's lower balance. */
  undatedCents: number;
}

interface LegacySettlementInput {
  /** Live invoice facts: total, balance, and whether a void zeroed it. */
  live: Map<
    string,
    { totalCents: number; balanceDueCents: number; balanceZeroedByAdmin: boolean }
  >;
  payments: Array<{ invoiceId: string; cents: number; sessionId: string | null }>;
  credits: Array<{ invoiceId: string; cents: number; reversed: boolean }>;
  creditApplications: Array<{
    invoiceId: string;
    cents: number;
    sessionId: string;
  }>;
  reversed: Array<{ invoiceId: string; cents: number; sessionId: string | null }>;
  statementApplications: Array<{
    invoiceId: string;
    cents: number;
    sessionId: string;
    paymentDate: Date;
  }>;
  deposits: Array<{ invoiceId: string; depositedAt: Date }>;
}

function reconstructLegacySettlements(
  input: LegacySettlementInput,
): Map<string, LegacySettlement> {
  const add = (map: Map<string, number>, key: string, cents: number) =>
    map.set(key, (map.get(key) ?? 0) + cents);
  const sessionKey = (invoiceId: string, sessionId: string) =>
    `${invoiceId}\u0000${sessionId}`;

  // What dated records already account for. A reversed credit and an archived
  // reversal both gave their reduction back, so neither explains a balance
  // that is still down today.
  const explained = new Map<string, number>();
  // The same, narrowed to one payment session, so a session's application row
  // is only treated as older evidence for the part its own dated rows miss.
  const explainedBySession = new Map<string, number>();
  for (const row of input.payments) {
    add(explained, row.invoiceId, row.cents);
    if (row.sessionId) {
      add(explainedBySession, sessionKey(row.invoiceId, row.sessionId), row.cents);
    }
  }
  for (const row of input.credits) {
    if (row.reversed) continue;
    add(explained, row.invoiceId, row.cents);
  }
  for (const row of input.creditApplications) {
    add(explained, row.invoiceId, row.cents);
    add(
      explainedBySession,
      sessionKey(row.invoiceId, row.sessionId),
      row.cents,
    );
  }
  for (const row of input.reversed) {
    if (!row.sessionId) continue;
    add(explainedBySession, sessionKey(row.invoiceId, row.sessionId), row.cents);
  }

  const applicationsByInvoice = new Map<
    string,
    Array<{ cents: number; settledAt: Date }>
  >();
  for (const row of input.statementApplications) {
    const alreadyDated =
      explainedBySession.get(sessionKey(row.invoiceId, row.sessionId)) ?? 0;
    const extra = row.cents - alreadyDated;
    if (extra <= 0) continue;
    const list = applicationsByInvoice.get(row.invoiceId) ?? [];
    list.push({ cents: extra, settledAt: row.paymentDate });
    applicationsByInvoice.set(row.invoiceId, list);
  }

  const lastDepositByInvoice = new Map<string, Date>();
  for (const row of input.deposits) {
    const current = lastDepositByInvoice.get(row.invoiceId);
    if (!current || row.depositedAt > current) {
      lastDepositByInvoice.set(row.invoiceId, row.depositedAt);
    }
  }

  const result = new Map<string, LegacySettlement>();
  for (const [invoiceId, facts] of input.live) {
    // A void, or the freeze that follows deleting a case, zeroes the balance
    // without anyone paying anything. That is not a settlement to go looking
    // for, and both are already dated by their own reports.
    if (facts.balanceZeroedByAdmin) continue;
    let residual =
      facts.totalCents - facts.balanceDueCents - (explained.get(invoiceId) ?? 0);
    if (residual <= 0) continue;

    const dated: Array<{ cents: number; settledAt: Date }> = [];
    // Newest application first: where the records cannot say which of several
    // sessions covered the gap, the later date leaves the receivable standing
    // longer rather than clearing it on an earlier date nothing proves.
    const applications = (applicationsByInvoice.get(invoiceId) ?? []).sort(
      (a, b) => b.settledAt.getTime() - a.settledAt.getTime(),
    );
    for (const application of applications) {
      if (residual <= 0) break;
      const cents = Math.min(residual, application.cents);
      dated.push({ cents, settledAt: application.settledAt });
      residual -= cents;
    }
    // A deposit dates the money without apportioning it, so it can only date
    // what is left. The last one is the earliest date every record agrees the
    // invoice had been settled by.
    const lastDeposit = lastDepositByInvoice.get(invoiceId);
    if (residual > 0 && lastDeposit) {
      dated.push({ cents: residual, settledAt: lastDeposit });
      residual = 0;
    }
    result.set(invoiceId, { dated, undatedCents: residual });
  }
  return result;
}

/**
 * Every invoice on the books at `asOf`, with what was outstanding on it.
 *
 * This is the one reconstruction behind the dated receivable, AR aging, and
 * the balance sheet, so those three cannot disagree about which invoices
 * existed or what was owed on them.
 *
 * Balances replay dated payments and dated credit applications rather than
 * reading `invoices.balanceDue`, which today's activity moves. Where a
 * contemporaneous snapshot shows a smaller balance than the surviving
 * settlement records explain — a payment that was later reversed takes its
 * payment rows with it — the snapshot wins and the figure is marked
 * approximate, because the invoice's own record of the day is better
 * evidence than an absence.
 */
export async function invoicesOutstandingAsOf(
  organizationId: string,
  asOf: Date,
): Promise<DatedInvoiceOutstanding[]> {
  const [versions, freezeRows] = await Promise.all([
    invoiceVersionsAsOf(organizationId, asOf),
    db
      .select({
        id: invoices.id,
        frozen: invoices.frozen,
        caseDeletedAt: invoices.caseDeletedAt,
        status: invoices.status,
        voidedAt: invoices.voidedAt,
        total: invoices.total,
        balanceDue: invoices.balanceDue,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.labOrganizationId, organizationId),
          isNull(invoices.deletedAt),
          finalizedInvoiceSql(),
        ),
      ),
  ]);
  const freezeById = new Map(freezeRows.map((row) => [row.id, row]));
  const invoiceRows = [...versions.values()]
    .filter((version) => invoiceRecognizedAsOf(version, asOf))
    // Deleting a case freezes its invoice and zeroes the balance at that
    // moment. Before that moment the receivable was real, so only drop the
    // invoice for dates on or after the freeze. A frozen invoice with no
    // recorded freeze date carries no evidence of when it stopped being
    // owed, so it stays excluded at every date.
    .filter((version) => {
      const freeze = freezeById.get(version.invoiceId);
      if (!freeze?.frozen) return true;
      return freeze.caseDeletedAt != null && freeze.caseDeletedAt > asOf;
    });
  if (!invoiceRows.length) return [];

  const invoiceIds = invoiceRows.map((invoice) => invoice.invoiceId);
  // Settlement rows are read without an as-of filter and dated in memory: the
  // same rows answer both "what had settled by this date" and "how much of
  // today's lower balance any dated record explains".
  const [
    paymentRows,
    creditRows,
    customerCreditRows,
    reversedRows,
    statementApplicationRows,
    depositRows,
  ] = await Promise.all([
    db
      .select({
        invoiceId: payments.invoiceId,
        amount: payments.amount,
        paidAt: payments.paidAt,
        sessionId: payments.paymentSessionId,
      })
      .from(payments)
      .where(inArray(payments.invoiceId, invoiceIds)),
    db
      .select({
        invoiceId: invoiceCredits.invoiceId,
        amount: invoiceCredits.amount,
        appliedAt: invoiceCredits.appliedAt,
        reversedAt: invoiceCredits.reversedAt,
      })
      .from(invoiceCredits)
      .where(inArray(invoiceCredits.invoiceId, invoiceIds)),
    // Existing customer credit consumed by Receive Payments settles the
    // invoice just as cash does, and it settles it on the payment session's
    // selected date, not on the date the application row happened to be
    // written.
    db
      .select({
        invoiceId: customerCreditApplications.invoiceId,
        amount: customerCreditApplications.amount,
        sessionId: customerCreditApplications.paymentSessionId,
        paymentDate: statementPaymentSessions.paymentDate,
      })
      .from(customerCreditApplications)
      .innerJoin(
        statementPaymentSessions,
        eq(
          customerCreditApplications.paymentSessionId,
          statementPaymentSessions.id,
        ),
      )
      .where(inArray(customerCreditApplications.invoiceId, invoiceIds)),
    // Settlements that have since been undone still count for the dates
    // they were in force. Cancelling a payment deletes its rows, so this
    // archive is the only dated evidence that the invoice was settled
    // between its payment date and the reversal.
    db
      .select({
        invoiceId: reversedInvoiceSettlements.invoiceId,
        amount: reversedInvoiceSettlements.amount,
        settledAt: reversedInvoiceSettlements.settledAt,
        reversedAt: reversedInvoiceSettlements.reversedAt,
        sessionId: reversedInvoiceSettlements.paymentSessionId,
      })
      .from(reversedInvoiceSettlements)
      .where(inArray(reversedInvoiceSettlements.invoiceId, invoiceIds)),
    // A receipt's per-invoice application rows outlive the payment rows that
    // used to accompany them and carry the session's payment date, so they
    // can date a settlement recorded before invoice-level history existed.
    // A cancelled session settled nothing: its restoration is already dated
    // by the archive above.
    db
      .select({
        invoiceId: statementPaymentApplications.invoiceId,
        amount: statementPaymentApplications.amount,
        sessionId: statementPaymentApplications.paymentSessionId,
        paymentDate: statementPaymentSessions.paymentDate,
      })
      .from(statementPaymentApplications)
      .innerJoin(
        statementPaymentSessions,
        eq(
          statementPaymentApplications.paymentSessionId,
          statementPaymentSessions.id,
        ),
      )
      .where(
        and(
          inArray(statementPaymentApplications.invoiceId, invoiceIds),
          isNull(statementPaymentSessions.cancelledAt),
        ),
      ),
    // A deposit says when money banked against this invoice arrived. It does
    // not say how much of it belonged to this invoice, so it can only date an
    // amount the invoice's own row already proves.
    db
      .select({
        invoiceId: bankTransactionInvoices.invoiceId,
        depositedAt: bankTransactions.txnDate,
      })
      .from(bankTransactionInvoices)
      .innerJoin(
        bankTransactions,
        eq(bankTransactions.id, bankTransactionInvoices.bankTransactionId),
      )
      .where(
        and(
          inArray(bankTransactionInvoices.invoiceId, invoiceIds),
          isNull(bankTransactions.deletedAt),
          eq(bankTransactions.status, "posted"),
        ),
      ),
  ]);

  const legacySettlements = reconstructLegacySettlements({
    live: new Map(
      invoiceRows.map((version) => {
        const row = freezeById.get(version.invoiceId);
        return [
          version.invoiceId,
          {
            totalCents: toCents(row?.total ?? "0"),
            balanceDueCents: toCents(row?.balanceDue ?? "0"),
            balanceZeroedByAdmin:
              row == null ||
              row.frozen ||
              row.status === "void" ||
              row.voidedAt != null,
          },
        ];
      }),
    ),
    payments: paymentRows.map((row) => ({
      invoiceId: row.invoiceId,
      cents: toCents(row.amount),
      sessionId: row.sessionId,
    })),
    credits: creditRows.map((row) => ({
      invoiceId: row.invoiceId,
      cents: toCents(row.amount),
      reversed: row.reversedAt != null,
    })),
    creditApplications: customerCreditRows.map((row) => ({
      invoiceId: row.invoiceId,
      cents: toCents(row.amount),
      sessionId: row.sessionId,
    })),
    reversed: reversedRows.map((row) => ({
      invoiceId: row.invoiceId,
      cents: toCents(row.amount),
      sessionId: row.sessionId,
    })),
    statementApplications: statementApplicationRows.map((row) => ({
      invoiceId: row.invoiceId,
      cents: toCents(row.amount),
      sessionId: row.sessionId,
      paymentDate: new Date(row.paymentDate),
    })),
    deposits: depositRows.map((row) => ({
      invoiceId: row.invoiceId,
      depositedAt: new Date(row.depositedAt),
    })),
  });

  const settled = new Map<string, number>();
  const settle = (invoiceId: string, cents: number) =>
    settled.set(invoiceId, (settled.get(invoiceId) ?? 0) + cents);
  for (const row of paymentRows) {
    if (new Date(row.paidAt) > asOf) continue;
    settle(row.invoiceId, toCents(row.amount));
  }
  for (const row of creditRows) {
    if (new Date(row.appliedAt) > asOf) continue;
    if (row.reversedAt != null && new Date(row.reversedAt) <= asOf) continue;
    settle(row.invoiceId, toCents(row.amount));
  }
  for (const row of customerCreditRows) {
    if (new Date(row.paymentDate) > asOf) continue;
    settle(row.invoiceId, toCents(row.amount));
  }
  for (const row of reversedRows) {
    if (new Date(row.settledAt) > asOf) continue;
    if (new Date(row.reversedAt) <= asOf) continue;
    settle(row.invoiceId, toCents(row.amount));
  }
  for (const [invoiceId, legacy] of legacySettlements) {
    for (const portion of legacy.dated) {
      if (portion.settledAt > asOf) continue;
      settle(invoiceId, portion.cents);
    }
  }

  return invoiceRows.map((version) => {
    let outstanding = version.totalCents - (settled.get(version.invoiceId) ?? 0);
    let approximate = false;
    let unreconstructedSettlementCents = 0;
    // A settlement the invoice itself recorded, whose payment rows a later
    // reversal deleted. Full or partial, the contemporaneous balance is the
    // only surviving measure of it.
    if (
      version.fromSnapshot &&
      version.balanceDueCents != null &&
      version.balanceDueCents < outstanding
    ) {
      outstanding = version.balanceDueCents;
      approximate = true;
    } else if (version.balanceDueCents == null) {
      // No contemporaneous balance for this date — the invoice predates that
      // history. Settlement that nothing dates is carried at every date,
      // because today's balance is the only measure of it that exists. It is
      // never allowed to turn into an overpayment the records do not show,
      // and the report discloses it rather than presenting it as history.
      const undated = legacySettlements.get(version.invoiceId)?.undatedCents ?? 0;
      if (undated > 0 && outstanding > 0) {
        unreconstructedSettlementCents = Math.min(undated, outstanding);
        outstanding -= unreconstructedSettlementCents;
      }
    }
    return {
      invoiceId: version.invoiceId,
      status: version.status,
      totalCents: version.totalCents,
      outstandingCents: outstanding,
      issuedAt: version.issuedAt,
      dueAt: version.dueAt,
      approximate,
      unreconstructedSettlementCents,
    };
  });
}

/**
 * Accounts receivable at a point in time, folded up from the same dated
 * reconstruction that AR aging reports line by line.
 */
export async function arBalanceAsOf(
  organizationId: string,
  asOf: Date,
): Promise<DatedArBalance> {
  const rows = await invoicesOutstandingAsOf(organizationId, asOf);
  let receivableCents = 0;
  let invoiceOverpaymentCents = 0;
  let approximate = false;
  let unreconstructedInvoiceCount = 0;
  let unreconstructedSettlementCents = 0;
  for (const row of rows) {
    if (row.approximate) approximate = true;
    if (row.unreconstructedSettlementCents > 0) {
      unreconstructedInvoiceCount += 1;
      unreconstructedSettlementCents += row.unreconstructedSettlementCents;
    }
    if (row.outstandingCents > 0) receivableCents += row.outstandingCents;
    else if (row.outstandingCents < 0) invoiceOverpaymentCents += -row.outstandingCents;
  }
  return {
    receivableCents,
    invoiceOverpaymentCents,
    approximate,
    unreconstructedInvoiceCount,
    unreconstructedSettlementCents,
  };
}
