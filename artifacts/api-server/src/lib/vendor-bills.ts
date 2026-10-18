/**
 * Accounts Payable subledger service.
 *
 * Owns every write that can change a bill balance, a vendor credit balance, or
 * the bank transaction that funds a bill payment. Routes call in here rather
 * than touching the tables directly so the invariants below hold everywhere:
 *
 *   1. A bill's balance is always recomputed from its non-reversed allocations,
 *      never incremented in place. Concurrent payments therefore converge on
 *      the same answer instead of racing on a read-modify-write.
 *   2. All arithmetic runs in integer cents (`money-cents.ts`).
 *   3. Locks are taken in one order everywhere — AP mutation fence, then bills
 *      by ascending id, then credits by ascending id — so two concurrent Pay
 *      Bills runs queue rather than deadlock.
 *   4. A bill payment's bank withdrawal carries `source = "bill_payment"`, and
 *      the register refuses to edit or delete those rows. Corrections go
 *      through the vendor payment, mirroring how statement payments must be
 *      corrected through their payment session.
 *
 * See docs/ap-ar-workflow-contract.md for the accounting rules these enforce.
 */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  bankTransactions,
  vendorBillEvents,
  vendorBillLines,
  vendorBills,
  vendorCredits,
  vendorPaymentAllocations,
  vendorPayments,
} from "@workspace/db";
import { HttpError } from "./http";
import { fromCents, sumCents, toCents } from "./money-cents";

/**
 * Serializes every AP balance mutation for the whole deployment. Bill
 * payments, voids, and bill edits all pass through here before taking row
 * locks, which is what makes the lock ordering in rule 3 above achievable —
 * two writers cannot interleave their row-lock acquisition.
 */
const AP_MUTATION_LOCK_NAME = "labtrax:vendor-bill-mutations";

type Tx = any;

export async function lockVendorBillMutations(tx: Tx): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${AP_MUTATION_LOCK_NAME}, 0))`,
  );
}

/** Bank transaction source marking a withdrawal created by Pay Bills. */
export const BILL_PAYMENT_SOURCE = "bill_payment";

export type BillStatus = "open" | "partially_paid" | "paid" | "void";

/**
 * Recompute and persist a bill's settled amounts and status from its
 * allocations. Returns the refreshed figures in cents.
 *
 * The caller must already hold the AP fence and a row lock on the bill.
 */
export async function recomputeBillBalance(
  tx: Tx,
  billId: string,
): Promise<{ paidCents: number; creditedCents: number; balanceCents: number; status: BillStatus }> {
  const [bill] = await tx
    .select()
    .from(vendorBills)
    .where(eq(vendorBills.id, billId));
  if (!bill) throw new HttpError(404, "Bill not found.");

  const allocations = await tx
    .select({
      amount: vendorPaymentAllocations.amount,
      vendorCreditId: vendorPaymentAllocations.vendorCreditId,
      paymentStatus: vendorPayments.status,
    })
    .from(vendorPaymentAllocations)
    .innerJoin(
      vendorPayments,
      eq(vendorPaymentAllocations.vendorPaymentId, vendorPayments.id),
    )
    .where(
      and(
        eq(vendorPaymentAllocations.billId, billId),
        isNull(vendorPaymentAllocations.reversedAt),
      ),
    );

  const live = allocations.filter((row: any) => row.paymentStatus !== "void");
  const paidCents = sumCents(
    live.filter((row: any) => !row.vendorCreditId).map((row: any) => toCents(row.amount)),
  );
  const creditedCents = sumCents(
    live.filter((row: any) => row.vendorCreditId).map((row: any) => toCents(row.amount)),
  );
  const totalCents = toCents(bill.total);
  const settledCents = paidCents + creditedCents;

  if (settledCents > totalCents) {
    throw new HttpError(
      409,
      "Allocations exceed the bill total. The payment was not recorded.",
    );
  }

  const isVoid = !!bill.voidedAt;
  // A void bill carries no outstanding balance from its void date forward.
  const balanceCents = isVoid ? 0 : totalCents - settledCents;
  const status: BillStatus = isVoid
    ? "void"
    : balanceCents <= 0
      ? "paid"
      : settledCents > 0
        ? "partially_paid"
        : "open";

  await tx
    .update(vendorBills)
    .set({
      amountPaid: fromCents(paidCents),
      amountCredited: fromCents(creditedCents),
      balanceDue: fromCents(balanceCents),
      status,
      updatedAt: new Date(),
    })
    .where(eq(vendorBills.id, billId));

  return { paidCents, creditedCents, balanceCents, status };
}

/**
 * Recompute a vendor credit's applied/remaining amounts from its non-reversed
 * allocations. Caller holds the AP fence and a row lock on the credit.
 */
export async function recomputeVendorCreditBalance(
  tx: Tx,
  creditId: string,
): Promise<{ appliedCents: number; remainingCents: number }> {
  const [credit] = await tx
    .select()
    .from(vendorCredits)
    .where(eq(vendorCredits.id, creditId));
  if (!credit) throw new HttpError(404, "Vendor credit not found.");

  const rows = await tx
    .select({
      amount: vendorPaymentAllocations.amount,
      paymentStatus: vendorPayments.status,
    })
    .from(vendorPaymentAllocations)
    .innerJoin(
      vendorPayments,
      eq(vendorPaymentAllocations.vendorPaymentId, vendorPayments.id),
    )
    .where(
      and(
        eq(vendorPaymentAllocations.vendorCreditId, creditId),
        isNull(vendorPaymentAllocations.reversedAt),
      ),
    );

  const appliedCents = sumCents(
    rows
      .filter((row: any) => row.paymentStatus !== "void")
      .map((row: any) => toCents(row.amount)),
  );
  const amountCents = toCents(credit.amount);
  if (appliedCents > amountCents) {
    throw new HttpError(409, "Applied vendor credit exceeds the credit amount.");
  }
  const isVoid = !!credit.voidedAt;
  const remainingCents = isVoid ? 0 : amountCents - appliedCents;

  await tx
    .update(vendorCredits)
    .set({
      amountApplied: fromCents(appliedCents),
      remainingAmount: fromCents(remainingCents),
      status: isVoid ? "void" : remainingCents <= 0 ? "applied" : "open",
      updatedAt: new Date(),
    })
    .where(eq(vendorCredits.id, creditId));

  return { appliedCents, remainingCents };
}

/**
 * Lock a set of bills in a deterministic order and return them.
 * Ascending id ordering is what keeps two concurrent multi-bill payments from
 * deadlocking against each other.
 */
export async function lockBillsForUpdate(
  tx: Tx,
  labOrganizationId: string,
  billIds: string[],
): Promise<any[]> {
  if (!billIds.length) return [];
  const unique = [...new Set(billIds)].sort();
  const rows = await tx
    .select()
    .from(vendorBills)
    .where(
      and(
        inArray(vendorBills.id, unique),
        eq(vendorBills.labOrganizationId, labOrganizationId),
      ),
    )
    .orderBy(asc(vendorBills.id))
    .for("update");
  if (rows.length !== unique.length) {
    throw new HttpError(404, "One or more bills were not found in this lab.");
  }
  return rows;
}

/** Same deterministic ordering for vendor credits. */
export async function lockCreditsForUpdate(
  tx: Tx,
  labOrganizationId: string,
  creditIds: string[],
): Promise<any[]> {
  if (!creditIds.length) return [];
  const unique = [...new Set(creditIds)].sort();
  const rows = await tx
    .select()
    .from(vendorCredits)
    .where(
      and(
        inArray(vendorCredits.id, unique),
        eq(vendorCredits.labOrganizationId, labOrganizationId),
      ),
    )
    .orderBy(asc(vendorCredits.id))
    .for("update");
  if (rows.length !== unique.length) {
    throw new HttpError(404, "One or more vendor credits were not found in this lab.");
  }
  return rows;
}

/**
 * Refuse register-level edits to a bill payment's withdrawal.
 *
 * Editing the amount or account of this row from the register would silently
 * desynchronize it from the allocations that justify it, leaving AP and the
 * bank disagreeing with no audit trail. The correction path is voiding the
 * vendor payment, which reverses both sides together.
 */
export function assertNotBillPaymentTransaction(
  txn: { source?: string | null },
  action: "edit" | "delete",
): void {
  if (txn.source !== BILL_PAYMENT_SOURCE) return;
  throw new HttpError(
    409,
    action === "edit"
      ? "Bill payment entries must be changed through the vendor payment that created them."
      : "Bill payment entries must be voided through the vendor payment that created them.",
  );
}

/**
 * The accounting facts a dated report needs about a bill: when it was billed,
 * when it is due, what it totals, and how it was categorized.
 */
export interface BillAccountingSnapshot {
  billDate: Date;
  dueDate: Date | null;
  total: string;
  lines: Array<{ categoryId: string | null; amount: string }>;
}

/**
 * Read a bill's current accounting facts so they can be frozen onto an event.
 *
 * Reports replay these snapshots instead of the live row, which is what keeps
 * an edit made today out of last quarter's payable and expense figures.
 */
export async function captureBillSnapshot(
  tx: Tx,
  billId: string,
): Promise<BillAccountingSnapshot | null> {
  const [bill] = await tx
    .select({
      billDate: vendorBills.billDate,
      dueDate: vendorBills.dueDate,
      total: vendorBills.total,
    })
    .from(vendorBills)
    .where(eq(vendorBills.id, billId));
  if (!bill) return null;
  const lines = (await tx
    .select({
      categoryId: vendorBillLines.categoryId,
      amount: vendorBillLines.amount,
    })
    .from(vendorBillLines)
    .where(eq(vendorBillLines.billId, billId))) as Array<{
    categoryId: string | null;
    amount: string;
  }>;
  return {
    billDate: bill.billDate as Date,
    dueDate: (bill.dueDate as Date | null) ?? null,
    total: String(bill.total),
    lines: lines.map((line) => ({
      categoryId: line.categoryId ?? null,
      amount: String(line.amount),
    })),
  };
}

/** Append an AP audit event. Append-only; never updated or deleted. */
export async function recordBillEvent(
  tx: Tx,
  event: {
    labOrganizationId: string;
    billId?: string | null;
    vendorPaymentId?: string | null;
    vendorCreditId?: string | null;
    eventType: string;
    actorUserId: string | null;
    metadata?: Record<string, unknown>;
    /**
     * Freeze the bill's accounting facts onto this event. Pass it whenever the
     * event changes what the bill means to the books — creation, edit, void —
     * so later reports can reconstruct the bill as it stood at each date.
     */
    snapshot?: BillAccountingSnapshot | null;
  },
): Promise<void> {
  await tx.insert(vendorBillEvents).values({
    labOrganizationId: event.labOrganizationId,
    billId: event.billId ?? null,
    vendorPaymentId: event.vendorPaymentId ?? null,
    vendorCreditId: event.vendorCreditId ?? null,
    eventType: event.eventType,
    actorUserId: event.actorUserId,
    metadataJson: event.metadata ?? null,
    effectiveBillDate: event.snapshot?.billDate ?? null,
    effectiveDueDate: event.snapshot?.dueDate ?? null,
    effectiveTotal: event.snapshot?.total ?? null,
    effectiveLinesJson: event.snapshot?.lines ?? null,
  });
}

/** Replace a bill's lines and assert they sum to the stated total. */
export async function replaceBillLines(
  tx: Tx,
  billId: string,
  lines: Array<{ categoryId?: string | null; description: string; amount: number }>,
): Promise<number> {
  const totalCents = sumCents(lines.map((line) => toCents(line.amount)));
  if (totalCents <= 0) {
    throw new HttpError(400, "A bill must total more than zero.");
  }
  await tx.delete(vendorBillLines).where(eq(vendorBillLines.billId, billId));
  await tx.insert(vendorBillLines).values(
    lines.map((line, index) => ({
      billId,
      categoryId: line.categoryId ?? null,
      description: line.description,
      amount: fromCents(toCents(line.amount)),
      sortOrder: index,
    })),
  );
  return totalCents;
}

/**
 * Compute due date from a bill date and net terms. Terms are snapshotted onto
 * the bill so a later change to the vendor default cannot move this date.
 */
export function computeDueDate(billDate: Date, termsDays: number | null): Date {
  if (termsDays == null) return new Date(billDate);
  const due = new Date(billDate);
  due.setUTCDate(due.getUTCDate() + termsDays);
  return due;
}

/**
 * Find bills that already use this vendor reference. Returned to the caller as
 * a warning, never as a hard block: a vendor genuinely reusing a reference
 * must stay recordable once the user has seen the conflict.
 */
export async function findDuplicateBillReferences(
  runner: Tx,
  labOrganizationId: string,
  vendorId: string,
  billNumber: string | null,
  excludeBillId?: string,
): Promise<Array<{ id: string; billNumber: string | null; billDate: Date; total: string }>> {
  const reference = billNumber?.trim();
  if (!reference) return [];
  const rows = await runner
    .select({
      id: vendorBills.id,
      billNumber: vendorBills.billNumber,
      billDate: vendorBills.billDate,
      total: vendorBills.total,
    })
    .from(vendorBills)
    .where(
      and(
        eq(vendorBills.labOrganizationId, labOrganizationId),
        eq(vendorBills.vendorId, vendorId),
        sql`lower(${vendorBills.billNumber}) = lower(${reference})`,
        isNull(vendorBills.voidedAt),
      ),
    )
    .limit(10);
  return rows.filter((row: any) => row.id !== excludeBillId);
}

/**
 * Void the bank withdrawal backing a vendor payment.
 *
 * A reconciled withdrawal is never voided — that restriction already exists in
 * the register and is not weakened here.
 */
export async function voidBillPaymentTransaction(
  tx: Tx,
  bankTransactionId: string,
  actorUserId: string,
): Promise<void> {
  const [txn] = await tx
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.id, bankTransactionId))
    .for("update");
  if (!txn) return;
  if (txn.reconciled) {
    throw new HttpError(
      409,
      "This payment's bank entry is reconciled and cannot be reversed.",
    );
  }
  await tx
    .update(bankTransactions)
    .set({
      status: "void",
      deletedAt: new Date(),
      deletedByUserId: actorUserId,
      updatedAt: new Date(),
    })
    .where(eq(bankTransactions.id, bankTransactionId));
}

/** Aging buckets shared by the AP and AR aging reports. */
export const AGING_BUCKETS = [
  { key: "current", label: "Current", minDays: null, maxDays: 0 },
  { key: "d1_30", label: "1 - 30", minDays: 1, maxDays: 30 },
  { key: "d31_60", label: "31 - 60", minDays: 31, maxDays: 60 },
  { key: "d61_90", label: "61 - 90", minDays: 61, maxDays: 90 },
  { key: "d90_plus", label: "Over 90", minDays: 91, maxDays: null },
] as const;

export type AgingBucketKey = (typeof AGING_BUCKETS)[number]["key"];

/**
 * Which bucket an item falls in, by days past its due date.
 * Anything not yet due (including due today) is Current.
 */
export function agingBucketFor(dueDate: Date, asOf: Date): AgingBucketKey {
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysPastDue = Math.floor((asOf.getTime() - dueDate.getTime()) / msPerDay);
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "d1_30";
  if (daysPastDue <= 60) return "d31_60";
  if (daysPastDue <= 90) return "d61_90";
  return "d90_plus";
}

export function emptyBuckets(): Record<AgingBucketKey, number> {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
}
