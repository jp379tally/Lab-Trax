/**
 * Accounts Payable HTTP surface: Enter Bills, vendor credits, Pay Bills,
 * vendor AP detail, and the AP/AR aging reports.
 *
 * Mounted under `/finance` alongside the register routes. Every route requires
 * an authenticated, verified lab member with a billing role — the same bar the
 * rest of the finance module uses. No permission here is looser than the
 * register equivalent.
 *
 * Accounting rules implemented here are specified in
 * docs/ap-ar-workflow-contract.md. The two that drive most of this file:
 *   - Entering a bill recognizes the expense and raises AP. It never touches a
 *     bank account.
 *   - Paying a bill moves cash and lowers AP. It is not an expense, because
 *     entering the bill already was one.
 */

import { createHash } from "node:crypto";
import { Router } from "express";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  bankAccounts,
  bankTransactions,
  customerCreditApplications,
  customerCredits,
  invoiceCredits,
  invoices,
  organizations,
  payments,
  statementPaymentSessions,
  transactionCategories,
  vendorBillEvents,
  vendorBillLines,
  vendorBills,
  vendorCredits,
  vendorPaymentAllocations,
  vendorPayments,
  vendors,
} from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth, requireVerifiedAccount } from "../middlewares/auth";
import { BILLING_ROLES, requireAnyRole } from "../lib/rbac";
import { writeAuditLog } from "../lib/audit";
import { fromCents, sumCents, toCents } from "../lib/money-cents";
import {
  billVersionsAsOf,
  endOfDayInTz,
  invoiceRecognizedAsOf,
  invoiceVersionsAsOf,
  invoicesOutstandingAsOf,
  unappliedVendorCreditsAsOf,
} from "../lib/ap-ar-reporting";
import {
  AGING_BUCKETS,
  BILL_PAYMENT_SOURCE,
  agingBucketFor,
  captureBillSnapshot,
  computeDueDate,
  emptyBuckets,
  findDuplicateBillReferences,
  lockBillsForUpdate,
  lockCreditsForUpdate,
  lockVendorBillMutations,
  recomputeBillBalance,
  recomputeVendorCreditBalance,
  recordBillEvent,
  replaceBillLines,
  voidBillPaymentTransaction,
  type AgingBucketKey,
} from "../lib/vendor-bills";

const router = Router();
router.use(requireAuth);
router.use(requireVerifiedAccount);

function uid(req: any): string {
  return req.auth.userId as string;
}

/**
 * Resolve a vendor within the caller's lab.
 *
 * Inactive vendors are deliberately still resolvable: a lab that stops using a
 * supplier must keep its bills, payments, and history readable and payable.
 * Only soft-deleted vendors are rejected.
 */
async function loadVendorInOrg(
  vendorId: string,
  labOrganizationId: string,
  options: { forNewRecord?: boolean } = {},
) {
  const vendor = await db.query.vendors.findFirst({
    where: eq(vendors.id, vendorId),
  });
  if (
    !vendor ||
    vendor.deletedAt ||
    vendor.labOrganizationId !== labOrganizationId
  ) {
    throw new HttpError(404, "Vendor not found in this lab.");
  }
  if (options.forNewRecord && !vendor.isActive) {
    throw new HttpError(
      400,
      `${vendor.name} is inactive. Reactivate the payee before entering new bills for it.`,
    );
  }
  return vendor;
}

/** Parse an as-of query param into an instant, defaulting to now. */
/**
 * Resolve an `asOf` query value to the instant the report is taken at.
 *
 * A bare `YYYY-MM-DD` means the whole of that day, so it resolves to the end
 * of the day in the caller's zone. Parsing it as midnight would drop the
 * day's own invoices, payments, and voids from a report the user asked for
 * "as of today".
 */
function parseAsOf(raw: unknown, timeZone?: string): Date {
  if (typeof raw !== "string" || !raw.trim()) return new Date();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (dateOnly) {
    const resolved = endOfDayInTz(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
      timeZone,
    );
    if (Number.isNaN(resolved.getTime())) {
      throw new HttpError(400, "asOf must be a valid date.");
    }
    return resolved;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, "asOf must be a valid date.");
  }
  return parsed;
}

const billLineSchema = z.object({
  categoryId: z.string().min(1).nullish(),
  description: z.string().trim().min(1).max(500),
  amount: z.coerce.number().min(-99999999.99).max(99999999.99),
});

const billBodySchema = z.object({
  organizationId: z.string().min(1),
  vendorId: z.string().min(1),
  billNumber: z.string().trim().max(100).nullish(),
  billDate: z.string().min(1),
  dueDate: z.string().min(1).nullish(),
  termsDays: z.coerce.number().int().min(0).max(365).nullish(),
  memo: z.string().max(2000).nullish(),
  lines: z.array(billLineSchema).min(1).max(200),
  // Set after the client has shown the duplicate-reference warning and the
  // user chose to continue anyway.
  acknowledgeDuplicateReference: z.boolean().optional(),
});

function serializeBill(bill: any, lines: any[] = [], vendor?: any) {
  return {
    id: bill.id,
    labOrganizationId: bill.labOrganizationId,
    vendorId: bill.vendorId,
    vendorName: vendor?.name ?? bill.vendorName ?? null,
    vendorIsActive: vendor?.isActive ?? bill.vendorIsActive ?? null,
    billNumber: bill.billNumber,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    termsDays: bill.termsDays,
    memo: bill.memo,
    total: bill.total,
    amountPaid: bill.amountPaid,
    amountCredited: bill.amountCredited,
    balanceDue: bill.balanceDue,
    status: bill.status,
    voidedAt: bill.voidedAt ?? null,
    voidReason: bill.voidReason ?? null,
    createdAt: bill.createdAt,
    updatedAt: bill.updatedAt,
    lines: lines.map((line) => ({
      id: line.id,
      categoryId: line.categoryId,
      description: line.description,
      amount: line.amount,
      sortOrder: line.sortOrder,
    })),
  };
}

// ───────────────────────────── Bills ─────────────────────────────

// GET /finance/bills?organizationId=&vendorId=&status=&dueBefore=&search=
router.get(
  "/bills",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        organizationId: z.string().min(1),
        vendorId: z.string().min(1).optional(),
        // open = anything with a balance; all = include paid and void.
        status: z.enum(["open", "paid", "void", "all"]).optional(),
        dueBefore: z.string().optional(),
        search: z.string().trim().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);
    await requireAnyRole(uid(req), query.organizationId, BILLING_ROLES);

    const conditions = [eq(vendorBills.labOrganizationId, query.organizationId)];
    if (query.vendorId) conditions.push(eq(vendorBills.vendorId, query.vendorId));
    if (!query.status || query.status === "open") {
      conditions.push(isNull(vendorBills.voidedAt));
      conditions.push(sql`${vendorBills.balanceDue} > 0`);
    } else if (query.status === "paid") {
      conditions.push(isNull(vendorBills.voidedAt));
      conditions.push(eq(vendorBills.status, "paid"));
    } else if (query.status === "void") {
      conditions.push(sql`${vendorBills.voidedAt} IS NOT NULL`);
    }
    if (query.dueBefore) {
      const cutoff = new Date(query.dueBefore);
      if (Number.isNaN(cutoff.getTime())) {
        throw new HttpError(400, "dueBefore must be a valid date.");
      }
      conditions.push(lte(vendorBills.dueDate, cutoff));
    }
    if (query.search) {
      const term = `%${query.search}%`;
      conditions.push(
        or(
          sql`${vendorBills.billNumber} ILIKE ${term}`,
          sql`${vendorBills.memo} ILIKE ${term}`,
          sql`${vendors.name} ILIKE ${term}`,
        )!,
      );
    }

    const rows = await db
      .select({
        bill: vendorBills,
        vendorName: vendors.name,
        vendorIsActive: vendors.isActive,
      })
      .from(vendorBills)
      .innerJoin(vendors, eq(vendorBills.vendorId, vendors.id))
      .where(and(...conditions))
      .orderBy(asc(vendorBills.dueDate), asc(vendorBills.id))
      .limit(query.limit ?? 200);

    return ok(
      res,
      rows.map((row) =>
        serializeBill(row.bill, [], {
          name: row.vendorName,
          isActive: row.vendorIsActive,
        }),
      ),
    );
  }),
);

// GET /finance/bills/:id — full detail including payment history.
router.get(
  "/bills/:id",
  asyncHandler(async (req, res) => {
    const billId = String(req.params.id);
    const [row] = await db
      .select({ bill: vendorBills, vendorName: vendors.name, vendorIsActive: vendors.isActive })
      .from(vendorBills)
      .innerJoin(vendors, eq(vendorBills.vendorId, vendors.id))
      .where(eq(vendorBills.id, billId));
    if (!row) throw new HttpError(404, "Bill not found.");
    await requireAnyRole(uid(req), row.bill.labOrganizationId, BILLING_ROLES);

    const [lines, allocations, events] = await Promise.all([
      db
        .select()
        .from(vendorBillLines)
        .where(eq(vendorBillLines.billId, billId))
        .orderBy(asc(vendorBillLines.sortOrder)),
      db
        .select({
          allocation: vendorPaymentAllocations,
          payment: vendorPayments,
        })
        .from(vendorPaymentAllocations)
        .innerJoin(
          vendorPayments,
          eq(vendorPaymentAllocations.vendorPaymentId, vendorPayments.id),
        )
        .where(eq(vendorPaymentAllocations.billId, billId))
        .orderBy(desc(vendorPaymentAllocations.appliedAt)),
      db
        .select()
        .from(vendorBillEvents)
        .where(eq(vendorBillEvents.billId, billId))
        .orderBy(desc(vendorBillEvents.occurredAt))
        .limit(100),
    ]);

    return ok(res, {
      ...serializeBill(row.bill, lines, {
        name: row.vendorName,
        isActive: row.vendorIsActive,
      }),
      payments: allocations.map(({ allocation, payment }) => ({
        allocationId: allocation.id,
        vendorPaymentId: payment.id,
        amount: allocation.amount,
        appliedAt: allocation.appliedAt,
        reversedAt: allocation.reversedAt,
        fundedByCredit: !!allocation.vendorCreditId,
        vendorCreditId: allocation.vendorCreditId,
        paymentDate: payment.paymentDate,
        paymentMethod: payment.paymentMethod,
        referenceNumber: payment.referenceNumber,
        bankAccountId: payment.bankAccountId,
        bankTransactionId: payment.bankTransactionId,
        status: payment.status,
      })),
      events: events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        actorUserId: event.actorUserId,
        metadata: event.metadataJson,
      })),
    });
  }),
);

// POST /finance/bills — Enter Bills.
//
// Saving an unpaid bill raises the vendor's balance and the AP control
// balance. It deliberately creates no bank transaction.
router.post(
  "/bills",
  asyncHandler(async (req, res) => {
    const input = billBodySchema.parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, BILLING_ROLES);
    const vendor = await loadVendorInOrg(input.vendorId, input.organizationId, {
      forNewRecord: true,
    });

    const billDate = new Date(input.billDate);
    if (Number.isNaN(billDate.getTime())) {
      throw new HttpError(400, "Bill date must be a valid date.");
    }
    const termsDays =
      input.termsDays ?? (vendor.paymentTermsDays as number | null) ?? null;
    const dueDate = input.dueDate
      ? new Date(input.dueDate)
      : computeDueDate(billDate, termsDays);
    if (Number.isNaN(dueDate.getTime())) {
      throw new HttpError(400, "Due date must be a valid date.");
    }
    if (dueDate < billDate) {
      throw new HttpError(400, "Due date cannot be before the bill date.");
    }

    const reference = input.billNumber?.trim() || null;
    const duplicates = await findDuplicateBillReferences(
      db,
      input.organizationId,
      input.vendorId,
      reference,
    );
    if (duplicates.length && !input.acknowledgeDuplicateReference) {
      // Actionable warning, not a block: the client re-submits with
      // acknowledgeDuplicateReference once the user has seen the conflict.
      return res.status(409).json({
        ok: false,
        error: {
          code: "duplicate_bill_reference",
          message: `${vendor.name} already has a bill numbered ${reference}. Confirm to save it anyway.`,
          duplicates,
        },
      });
    }

    await assertCategoriesInOrg(input.organizationId, input.lines);

    const created = await db.transaction(async (tx) => {
      const [bill] = await tx
        .insert(vendorBills)
        .values({
          labOrganizationId: input.organizationId,
          vendorId: input.vendorId,
          billNumber: reference,
          billDate,
          dueDate,
          termsDays,
          memo: input.memo ?? null,
          total: "0.00",
          balanceDue: "0.00",
          status: "open",
          createdByUserId: uid(req),
        })
        .returning();
      const totalCents = await replaceBillLines(tx, bill.id, input.lines);
      await tx
        .update(vendorBills)
        .set({ total: fromCents(totalCents), balanceDue: fromCents(totalCents) })
        .where(eq(vendorBills.id, bill.id));
      await recordBillEvent(tx, {
        labOrganizationId: input.organizationId,
        billId: bill.id,
        eventType: "bill_created",
        actorUserId: uid(req),
        metadata: {
          total: fromCents(totalCents),
          billNumber: reference,
          duplicateReferenceAcknowledged: duplicates.length > 0,
        },
        snapshot: await captureBillSnapshot(tx, bill.id),
      });
      const lines = await tx
        .select()
        .from(vendorBillLines)
        .where(eq(vendorBillLines.billId, bill.id))
        .orderBy(asc(vendorBillLines.sortOrder));
      const [refreshed] = await tx
        .select()
        .from(vendorBills)
        .where(eq(vendorBills.id, bill.id));
      return serializeBill(refreshed, lines, vendor);
    });

    await writeAuditLog({
      userId: uid(req),
      organizationId: input.organizationId,
      action: "vendor_bill.create",
      entityType: "vendor_bill",
      entityId: created.id,
    });
    return res.status(201).json({ ok: true, data: created });
  }),
);

type BillPaymentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Canonical fingerprint of a Pay Bills request. A replay must carry the same
 * accounting request as the run that already posted; the same key with a
 * different payload is a client bug, not a retry, and must not silently
 * return someone else's payments.
 */
function billPaymentFingerprint(input: z.infer<typeof billPaymentSchema>): string {
  const canonical = {
    organizationId: input.organizationId,
    paymentDate: new Date(input.paymentDate).toISOString(),
    paymentMethod: input.paymentMethod,
    bankAccountId: input.bankAccountId ?? null,
    referenceNumber: input.referenceNumber ?? null,
    memo: input.memo ?? null,
    vendorPayments: [...input.vendorPayments]
      .sort((a, b) => a.vendorId.localeCompare(b.vendorId))
      .map((entry) => ({
        vendorId: entry.vendorId,
        allocations: [...entry.allocations]
          .sort((a, b) => a.billId.localeCompare(b.billId))
          .map((allocation) => ({
            billId: allocation.billId,
            amount: toCents(allocation.amount),
            creditApplications: [...allocation.creditApplications]
              .sort((a, b) => a.vendorCreditId.localeCompare(b.vendorCreditId))
              .map((credit) => ({
                vendorCreditId: credit.vendorCreditId,
                amount: toCents(credit.amount),
              })),
          })),
      })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Exact replay lookup. The stored `idempotencyKey` is suffixed with a vendor
 * id so one multi-vendor run can write one row per vendor, so replay detection
 * reads the unmodified caller key from `requestKey` instead of matching a
 * prefix — a prefix match can select an unrelated key that merely starts the
 * same way.
 */
async function findBillPaymentReplay(
  database: typeof db | BillPaymentTransaction,
  organizationId: string,
  requestKey: string,
  fingerprint: string,
) {
  const existing = await database
    .select()
    .from(vendorPayments)
    .where(
      and(
        eq(vendorPayments.labOrganizationId, organizationId),
        eq(vendorPayments.requestKey, requestKey),
      ),
    )
    .orderBy(asc(vendorPayments.createdAt), asc(vendorPayments.id));
  if (!existing.length) return null;
  if (existing.some((row: any) => row.requestFingerprint !== fingerprint)) {
    throw new HttpError(
      409,
      "This idempotency key was already used for a different bill payment.",
    );
  }
  return existing;
}

/** Reject line categories that belong to a different lab. */
async function assertCategoriesInOrg(
  organizationId: string,
  lines: Array<{ categoryId?: string | null }>,
) {
  const ids = [...new Set(lines.map((l) => l.categoryId).filter(Boolean))] as string[];
  if (!ids.length) return;
  const rows = await db
    .select({ id: transactionCategories.id })
    .from(transactionCategories)
    .where(
      and(
        inArray(transactionCategories.id, ids),
        eq(transactionCategories.labOrganizationId, organizationId),
      ),
    );
  if (rows.length !== ids.length) {
    throw new HttpError(400, "A selected category does not belong to this lab.");
  }
}

// PATCH /finance/bills/:id
//
// A bill with allocations stays editable at the header level, but its total
// can never fall below what has already been settled — that would leave a
// payment allocated to money the bill no longer owes.
router.patch(
  "/bills/:id",
  asyncHandler(async (req, res) => {
    const billId = String(req.params.id);
    const existing = await db.query.vendorBills.findFirst({
      where: eq(vendorBills.id, billId),
    });
    if (!existing) throw new HttpError(404, "Bill not found.");
    await requireAnyRole(uid(req), existing.labOrganizationId, BILLING_ROLES);
    if (existing.voidedAt) {
      throw new HttpError(409, "A voided bill cannot be edited.");
    }

    const input = billBodySchema
      .omit({ organizationId: true, vendorId: true })
      .partial()
      .parse(req.body);

    if (input.lines) await assertCategoriesInOrg(existing.labOrganizationId, input.lines);

    const reference =
      input.billNumber === undefined
        ? existing.billNumber
        : input.billNumber?.trim() || null;
    if (
      input.billNumber !== undefined &&
      reference &&
      reference.toLowerCase() !== (existing.billNumber ?? "").toLowerCase() &&
      !input.acknowledgeDuplicateReference
    ) {
      const duplicates = await findDuplicateBillReferences(
        db,
        existing.labOrganizationId,
        existing.vendorId,
        reference,
        billId,
      );
      if (duplicates.length) {
        return res.status(409).json({
          ok: false,
          error: {
            code: "duplicate_bill_reference",
            message: `Another bill already uses reference ${reference}. Confirm to save it anyway.`,
            duplicates,
          },
        });
      }
    }

    const updated = await db.transaction(async (tx) => {
      await lockVendorBillMutations(tx);
      const [bill] = await lockBillsForUpdate(tx, existing.labOrganizationId, [billId]);

      const settledCents = toCents(bill.amountPaid) + toCents(bill.amountCredited);
      const updates: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedByUserId: uid(req),
      };
      if (input.billNumber !== undefined) updates.billNumber = reference;
      if (input.memo !== undefined) updates.memo = input.memo ?? null;
      if (input.termsDays !== undefined) updates.termsDays = input.termsDays ?? null;
      if (input.billDate) {
        const billDate = new Date(input.billDate);
        if (Number.isNaN(billDate.getTime())) {
          throw new HttpError(400, "Bill date must be a valid date.");
        }
        updates.billDate = billDate;
      }
      if (input.dueDate) {
        const dueDate = new Date(input.dueDate);
        if (Number.isNaN(dueDate.getTime())) {
          throw new HttpError(400, "Due date must be a valid date.");
        }
        updates.dueDate = dueDate;
      }

      if (input.lines) {
        const totalCents = await replaceBillLines(tx, billId, input.lines);
        if (totalCents < settledCents) {
          throw new HttpError(
            409,
            `This bill already has ${fromCents(settledCents)} applied to it. Reverse those payments before lowering the total below that amount.`,
          );
        }
        updates.total = fromCents(totalCents);
      }

      await tx.update(vendorBills).set(updates).where(eq(vendorBills.id, billId));
      await recomputeBillBalance(tx, billId);
      await recordBillEvent(tx, {
        labOrganizationId: existing.labOrganizationId,
        billId,
        eventType: "bill_updated",
        actorUserId: uid(req),
        metadata: { fields: Object.keys(updates) },
        // Frozen after the edit: reports dated before now keep replaying the
        // previous snapshot, so an edit cannot restate a closed period.
        snapshot: await captureBillSnapshot(tx, billId),
      });

      const [refreshed] = await tx.select().from(vendorBills).where(eq(vendorBills.id, billId));
      const lines = await tx
        .select()
        .from(vendorBillLines)
        .where(eq(vendorBillLines.billId, billId))
        .orderBy(asc(vendorBillLines.sortOrder));
      return serializeBill(refreshed, lines);
    });

    await writeAuditLog({
      userId: uid(req),
      organizationId: existing.labOrganizationId,
      action: "vendor_bill.update",
      entityType: "vendor_bill",
      entityId: billId,
    });
    return ok(res, updated);
  }),
);

// POST /finance/bills/:id/void
//
// Voiding keeps the record and its history. A bill carrying live payment
// allocations must have those reversed first, so the cash side and the
// liability side can never disagree.
router.post(
  "/bills/:id/void",
  asyncHandler(async (req, res) => {
    const billId = String(req.params.id);
    const { reason } = z
      .object({ reason: z.string().trim().max(500).nullish() })
      .parse(req.body ?? {});
    const existing = await db.query.vendorBills.findFirst({
      where: eq(vendorBills.id, billId),
    });
    if (!existing) throw new HttpError(404, "Bill not found.");
    await requireAnyRole(uid(req), existing.labOrganizationId, BILLING_ROLES);
    if (existing.voidedAt) throw new HttpError(409, "This bill is already void.");

    const result = await db.transaction(async (tx) => {
      await lockVendorBillMutations(tx);
      const [bill] = await lockBillsForUpdate(tx, existing.labOrganizationId, [billId]);

      const live = await tx
        .select({ id: vendorPaymentAllocations.id })
        .from(vendorPaymentAllocations)
        .innerJoin(
          vendorPayments,
          eq(vendorPaymentAllocations.vendorPaymentId, vendorPayments.id),
        )
        .where(
          and(
            eq(vendorPaymentAllocations.billId, billId),
            isNull(vendorPaymentAllocations.reversedAt),
            ne(vendorPayments.status, "void"),
          ),
        );
      if (live.length) {
        throw new HttpError(
          409,
          "Reverse this bill's payments before voiding it.",
        );
      }

      await tx
        .update(vendorBills)
        .set({
          voidedAt: new Date(),
          voidedByUserId: uid(req),
          voidReason: reason ?? null,
          status: "void",
          balanceDue: "0.00",
          updatedAt: new Date(),
        })
        .where(eq(vendorBills.id, billId));
      await recomputeBillBalance(tx, billId);
      await recordBillEvent(tx, {
        labOrganizationId: existing.labOrganizationId,
        billId,
        eventType: "bill_voided",
        actorUserId: uid(req),
        metadata: { reason: reason ?? null, totalAtVoid: bill.total },
        snapshot: await captureBillSnapshot(tx, billId),
      });
      const [refreshed] = await tx.select().from(vendorBills).where(eq(vendorBills.id, billId));
      return serializeBill(refreshed);
    });

    await writeAuditLog({
      userId: uid(req),
      organizationId: existing.labOrganizationId,
      action: "vendor_bill.void",
      entityType: "vendor_bill",
      entityId: billId,
    });
    return ok(res, result);
  }),
);

// ─────────────────────────── Vendor credits ───────────────────────────

router.get(
  "/vendor-credits",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        organizationId: z.string().min(1),
        vendorId: z.string().min(1).optional(),
        openOnly: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    await requireAnyRole(uid(req), query.organizationId, BILLING_ROLES);
    const conditions = [eq(vendorCredits.labOrganizationId, query.organizationId)];
    if (query.vendorId) conditions.push(eq(vendorCredits.vendorId, query.vendorId));
    if (query.openOnly !== "false") {
      conditions.push(isNull(vendorCredits.voidedAt));
      conditions.push(sql`${vendorCredits.remainingAmount} > 0`);
    }
    const rows = await db
      .select({ credit: vendorCredits, vendorName: vendors.name })
      .from(vendorCredits)
      .innerJoin(vendors, eq(vendorCredits.vendorId, vendors.id))
      .where(and(...conditions))
      .orderBy(asc(vendorCredits.creditDate), asc(vendorCredits.id));
    return ok(
      res,
      rows.map(({ credit, vendorName }) => ({ ...credit, vendorName })),
    );
  }),
);

router.post(
  "/vendor-credits",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        organizationId: z.string().min(1),
        vendorId: z.string().min(1),
        creditNumber: z.string().trim().max(100).nullish(),
        creditDate: z.string().min(1),
        categoryId: z.string().min(1).nullish(),
        memo: z.string().max(2000).nullish(),
        amount: z.coerce.number().positive().max(99999999.99),
      })
      .parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, BILLING_ROLES);
    await loadVendorInOrg(input.vendorId, input.organizationId, { forNewRecord: true });
    await assertCategoriesInOrg(input.organizationId, [{ categoryId: input.categoryId }]);
    const creditDate = new Date(input.creditDate);
    if (Number.isNaN(creditDate.getTime())) {
      throw new HttpError(400, "Credit date must be a valid date.");
    }
    const amountCents = toCents(input.amount);
    const [row] = await db
      .insert(vendorCredits)
      .values({
        labOrganizationId: input.organizationId,
        vendorId: input.vendorId,
        creditNumber: input.creditNumber?.trim() || null,
        creditDate,
        categoryId: input.categoryId ?? null,
        memo: input.memo ?? null,
        amount: fromCents(amountCents),
        amountApplied: "0.00",
        remainingAmount: fromCents(amountCents),
        status: "open",
        createdByUserId: uid(req),
      })
      .returning();
    await db.insert(vendorBillEvents).values({
      labOrganizationId: input.organizationId,
      vendorCreditId: row.id,
      eventType: "vendor_credit_created",
      actorUserId: uid(req),
      metadataJson: { amount: row.amount },
    });
    await writeAuditLog({
      userId: uid(req),
      organizationId: input.organizationId,
      action: "vendor_credit.create",
      entityType: "vendor_credit",
      entityId: row.id,
    });
    return res.status(201).json({ ok: true, data: row });
  }),
);

router.post(
  "/vendor-credits/:id/void",
  asyncHandler(async (req, res) => {
    const creditId = String(req.params.id);
    const { reason } = z
      .object({ reason: z.string().trim().max(500).nullish() })
      .parse(req.body ?? {});
    const existing = await db.query.vendorCredits.findFirst({
      where: eq(vendorCredits.id, creditId),
    });
    if (!existing) throw new HttpError(404, "Vendor credit not found.");
    await requireAnyRole(uid(req), existing.labOrganizationId, BILLING_ROLES);
    if (existing.voidedAt) throw new HttpError(409, "This credit is already void.");

    const result = await db.transaction(async (tx) => {
      await lockVendorBillMutations(tx);
      await lockCreditsForUpdate(tx, existing.labOrganizationId, [creditId]);
      const applied = await tx
        .select({ id: vendorPaymentAllocations.id })
        .from(vendorPaymentAllocations)
        .innerJoin(
          vendorPayments,
          eq(vendorPaymentAllocations.vendorPaymentId, vendorPayments.id),
        )
        .where(
          and(
            eq(vendorPaymentAllocations.vendorCreditId, creditId),
            isNull(vendorPaymentAllocations.reversedAt),
            ne(vendorPayments.status, "void"),
          ),
        );
      if (applied.length) {
        throw new HttpError(
          409,
          "Reverse the payments that used this credit before voiding it.",
        );
      }
      await tx
        .update(vendorCredits)
        .set({
          voidedAt: new Date(),
          voidedByUserId: uid(req),
          voidReason: reason ?? null,
          status: "void",
          remainingAmount: "0.00",
          updatedAt: new Date(),
        })
        .where(eq(vendorCredits.id, creditId));
      const [refreshed] = await tx
        .select()
        .from(vendorCredits)
        .where(eq(vendorCredits.id, creditId));
      return refreshed;
    });
    return ok(res, result);
  }),
);

/**
 * Aging groups by customer, but a legacy invoice may carry no provider
 * organization. Such invoices are still owed, so they are grouped under a
 * placeholder rather than dropped, keeping aging tied to the receivable.
 */
const UNASSIGNED_CUSTOMER_ID = "unassigned";
const UNASSIGNED_CUSTOMER_NAME = "No customer on record";

// ─────────────────────────── Vendor AP detail ───────────────────────────

// GET /finance/vendors/:id/ap-summary
// Bills, credits, payments, amount due, and overdue for one vendor.
router.get(
  "/vendors/:id/ap-summary",
  asyncHandler(async (req, res) => {
    const vendorId = String(req.params.id);
    const query = z
      .object({
        organizationId: z.string().min(1),
        asOf: z.string().optional(),
        timeZone: z.string().max(64).optional(),
      })
      .parse(req.query);
    await requireAnyRole(uid(req), query.organizationId, BILLING_ROLES);
    const vendor = await loadVendorInOrg(vendorId, query.organizationId);
    const asOf = parseAsOf(query.asOf, query.timeZone);

    const [bills, credits, payments] = await Promise.all([
      db
        .select()
        .from(vendorBills)
        .where(
          and(
            eq(vendorBills.labOrganizationId, query.organizationId),
            eq(vendorBills.vendorId, vendorId),
          ),
        )
        .orderBy(desc(vendorBills.billDate), desc(vendorBills.id))
        .limit(500),
      db
        .select()
        .from(vendorCredits)
        .where(
          and(
            eq(vendorCredits.labOrganizationId, query.organizationId),
            eq(vendorCredits.vendorId, vendorId),
          ),
        )
        .orderBy(desc(vendorCredits.creditDate))
        .limit(500),
      db
        .select()
        .from(vendorPayments)
        .where(
          and(
            eq(vendorPayments.labOrganizationId, query.organizationId),
            eq(vendorPayments.vendorId, vendorId),
          ),
        )
        .orderBy(desc(vendorPayments.paymentDate))
        .limit(500),
    ]);

    // Figures are reconstructed for the as-of date rather than read off the
    // live balances, so a past-dated request answers with what the vendor
    // was owed then. At today's date the reconstruction and the live
    // balances agree.
    const [billVersions, creditRemainingAsOf] = await Promise.all([
      billVersionsAsOf(query.organizationId, asOf),
      unappliedVendorCreditsAsOf(query.organizationId, asOf),
    ]);
    const datedBills = bills.filter((bill) => {
      const version = billVersions.get(bill.id);
      if (!version || version.billDate > asOf) return false;
      const voidedAt = bill.voidedAt ? new Date(bill.voidedAt) : null;
      return !voidedAt || voidedAt > asOf;
    });
    const datedBillIds = datedBills.map((bill) => bill.id);
    const allocations = datedBillIds.length
      ? await db
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
              inArray(vendorPaymentAllocations.billId, datedBillIds),
              lte(vendorPaymentAllocations.appliedAt, asOf),
            ),
          )
      : [];
    const settledByBill = new Map<string, number>();
    for (const allocation of allocations) {
      // A reversal or void dated after the report had not happened yet.
      const undoneByAsOf =
        (allocation.reversedAt && new Date(allocation.reversedAt) <= asOf) ||
        (allocation.paymentVoidedAt &&
          new Date(allocation.paymentVoidedAt) <= asOf);
      if (undoneByAsOf) continue;
      settledByBill.set(
        allocation.billId,
        (settledByBill.get(allocation.billId) ?? 0) + toCents(allocation.amount),
      );
    }

    const outstandingByBill = new Map<string, number>();
    for (const bill of datedBills) {
      const version = billVersions.get(bill.id)!;
      const outstanding = version.totalCents - (settledByBill.get(bill.id) ?? 0);
      outstandingByBill.set(bill.id, outstanding);
    }
    const openBills = datedBills.filter(
      (bill) => (outstandingByBill.get(bill.id) ?? 0) > 0,
    );
    const amountDueCents = sumCents(
      openBills.map((bill) => outstandingByBill.get(bill.id) ?? 0),
    );
    const overdueCents = sumCents(
      openBills
        .filter((bill) => {
          const dueDate =
            billVersions.get(bill.id)?.dueDate ?? new Date(bill.dueDate);
          return new Date(dueDate).getTime() < asOf.getTime();
        })
        .map((bill) => outstandingByBill.get(bill.id) ?? 0),
    );
    const vendorCreditIds = new Set(credits.map((credit) => credit.id));
    let openCreditCents = 0;
    for (const [creditId, remaining] of creditRemainingAsOf) {
      if (vendorCreditIds.has(creditId) && remaining > 0) openCreditCents += remaining;
    }

    return ok(res, {
      vendor: {
        id: vendor.id,
        name: vendor.name,
        isActive: vendor.isActive,
        paymentTermsDays: vendor.paymentTermsDays ?? null,
      },
      asOf: asOf.toISOString(),
      // Unapplied credit is reported separately, never netted into the
      // payable — it is an asset and the payable is a liability.
      amountDue: fromCents(amountDueCents),
      overdueAmount: fromCents(overdueCents),
      unappliedCreditAmount: fromCents(openCreditCents),
      openBillCount: openBills.length,
      // Each bill carries the amount and balance it had on the as-of date,
      // and bills entered after it are not yet part of the vendor's history.
      bills: datedBills.map((bill) => {
        const version = billVersions.get(bill.id)!;
        return serializeBill(
          {
            ...bill,
            billDate: version.billDate,
            dueDate: version.dueDate ?? bill.dueDate,
            total: fromCents(version.totalCents),
            balanceDue: fromCents(Math.max(0, outstandingByBill.get(bill.id) ?? 0)),
          },
          [],
          vendor,
        );
      }),
      credits: credits.filter(
        (credit) =>
          new Date(credit.creditDate) <= asOf &&
          (!credit.voidedAt || new Date(credit.voidedAt) > asOf),
      ),
      payments: payments.filter(
        (payment) => new Date(payment.paymentDate) <= asOf,
      ),
    });
  }),
);

// ───────────────────────────── Pay Bills ─────────────────────────────

// GET /finance/pay-bills?organizationId=&dueBefore=&vendorId=
// Outstanding bills grouped by vendor, plus each vendor's available credit.
router.get(
  "/pay-bills",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        organizationId: z.string().min(1),
        vendorId: z.string().min(1).optional(),
        dueBefore: z.string().optional(),
        showAll: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    await requireAnyRole(uid(req), query.organizationId, BILLING_ROLES);

    const conditions = [
      eq(vendorBills.labOrganizationId, query.organizationId),
      isNull(vendorBills.voidedAt),
      sql`${vendorBills.balanceDue} > 0`,
    ];
    if (query.vendorId) conditions.push(eq(vendorBills.vendorId, query.vendorId));
    if (query.dueBefore && query.showAll !== "true") {
      const cutoff = new Date(query.dueBefore);
      if (Number.isNaN(cutoff.getTime())) {
        throw new HttpError(400, "dueBefore must be a valid date.");
      }
      conditions.push(lte(vendorBills.dueDate, cutoff));
    }

    const rows = await db
      .select({ bill: vendorBills, vendorName: vendors.name, vendorIsActive: vendors.isActive })
      .from(vendorBills)
      .innerJoin(vendors, eq(vendorBills.vendorId, vendors.id))
      .where(and(...conditions))
      .orderBy(asc(vendorBills.dueDate), asc(vendorBills.id));

    const vendorIds = [...new Set(rows.map((row) => row.bill.vendorId))];
    const credits = vendorIds.length
      ? await db
          .select()
          .from(vendorCredits)
          .where(
            and(
              eq(vendorCredits.labOrganizationId, query.organizationId),
              inArray(vendorCredits.vendorId, vendorIds),
              isNull(vendorCredits.voidedAt),
              sql`${vendorCredits.remainingAmount} > 0`,
            ),
          )
          .orderBy(asc(vendorCredits.creditDate))
      : [];

    const byVendor = new Map<string, any>();
    for (const row of rows) {
      const entry = byVendor.get(row.bill.vendorId) ?? {
        vendorId: row.bill.vendorId,
        vendorName: row.vendorName,
        vendorIsActive: row.vendorIsActive,
        bills: [],
        credits: [],
        totalDue: 0,
        availableCredit: 0,
      };
      entry.bills.push(serializeBill(row.bill, [], { name: row.vendorName }));
      entry.totalDue += toCents(row.bill.balanceDue);
      byVendor.set(row.bill.vendorId, entry);
    }
    for (const credit of credits) {
      const entry = byVendor.get(credit.vendorId);
      if (!entry) continue;
      entry.credits.push(credit);
      entry.availableCredit += toCents(credit.remainingAmount);
    }

    return ok(res, {
      vendors: [...byVendor.values()].map((entry) => ({
        ...entry,
        totalDue: fromCents(entry.totalDue),
        availableCredit: fromCents(entry.availableCredit),
      })),
    });
  }),
);

const billPaymentSchema = z.object({
  organizationId: z.string().min(1),
  paymentDate: z.string().min(1),
  paymentMethod: z.enum(["check", "ach", "card", "cash", "other"]),
  bankAccountId: z.string().min(1).nullish(),
  referenceNumber: z.string().trim().max(100).nullish(),
  memo: z.string().max(2000).nullish(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
  // One entry per vendor. Selecting several vendors in Pay Bills produces
  // several vendor payment records, each with its own bank withdrawal, so a
  // multi-vendor run is never one indistinguishable payment.
  vendorPayments: z
    .array(
      z.object({
        vendorId: z.string().min(1),
        allocations: z
          .array(
            z.object({
              billId: z.string().min(1),
              amount: z.coerce.number().min(0).max(99999999.99).default(0),
              // Credit applications are listed separately so the API can post
              // them without any cash movement.
              creditApplications: z
                .array(
                  z.object({
                    vendorCreditId: z.string().min(1),
                    amount: z.coerce.number().positive().max(99999999.99),
                  }),
                )
                .max(50)
                .default([]),
            }),
          )
          .min(1)
          .max(200),
      }),
    )
    .min(1)
    .max(100),
});

// POST /finance/bill-payments — Pay Bills.
//
// Atomically: reduces each selected bill's balance, consumes any applied
// vendor credit, and posts exactly one bank withdrawal per vendor for the
// cash portion. A payment funded entirely by credit posts no withdrawal at
// all, because applying a credit moves no money.
router.post(
  "/bill-payments",
  asyncHandler(async (req, res) => {
    const input = billPaymentSchema.parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, BILLING_ROLES);

    const paymentDate = new Date(input.paymentDate);
    if (Number.isNaN(paymentDate.getTime())) {
      throw new HttpError(400, "Payment date must be a valid date.");
    }

    const vendorIds = input.vendorPayments.map((entry) => entry.vendorId);
    if (new Set(vendorIds).size !== vendorIds.length) {
      throw new HttpError(400, "Each vendor may appear only once in a payment run.");
    }

    // Cash totals need a funding account; a pure-credit run does not.
    const totalCashCents = sumCents(
      input.vendorPayments.flatMap((entry) =>
        entry.allocations.map((allocation) => toCents(allocation.amount)),
      ),
    );
    let account: any = null;
    if (totalCashCents > 0) {
      if (!input.bankAccountId) {
        throw new HttpError(400, "Select the account these bills are paid from.");
      }
      account = await db.query.bankAccounts.findFirst({
        where: eq(bankAccounts.id, input.bankAccountId),
      });
      if (!account || account.labOrganizationId !== input.organizationId) {
        throw new HttpError(404, "Funding account not found in this lab.");
      }
      if (account.accountType === "undeposited_funds") {
        throw new HttpError(
          400,
          "Undeposited Funds holds customer receipts and cannot fund a bill payment.",
        );
      }
    }

    const fingerprint = input.idempotencyKey ? billPaymentFingerprint(input) : null;
    if (input.idempotencyKey && fingerprint) {
      // Fast path: a replay of a submit the client already completed.
      // Returning the original records keeps a double-tap from double-paying.
      const existing = await findBillPaymentReplay(
        db,
        input.organizationId,
        input.idempotencyKey,
        fingerprint,
      );
      if (existing) {
        return res.status(200).json({ ok: true, data: { payments: existing, replayed: true } });
      }
    }

    let replayedPayments: Array<Record<string, unknown>> | null = null;
    const result = await db.transaction(async (tx) => {
      await lockVendorBillMutations(tx);

      // Concurrent retries of the same submit both reach here; the first to
      // take the bill-mutation lock posts, and the second sees its rows and
      // replays cleanly instead of failing on the idempotency unique index.
      if (input.idempotencyKey && fingerprint) {
        const replayed = await findBillPaymentReplay(
          tx,
          input.organizationId,
          input.idempotencyKey,
          fingerprint,
        );
        if (replayed) {
          replayedPayments = replayed;
          return replayed;
        }
      }

      const allBillIds = input.vendorPayments.flatMap((entry) =>
        entry.allocations.map((allocation) => allocation.billId),
      );
      const allCreditIds = input.vendorPayments.flatMap((entry) =>
        entry.allocations.flatMap((allocation) =>
          allocation.creditApplications.map((c) => c.vendorCreditId),
        ),
      );
      // Deterministic lock order: bills, then credits, both ascending by id.
      const bills = await lockBillsForUpdate(tx, input.organizationId, allBillIds);
      const credits = await lockCreditsForUpdate(tx, input.organizationId, allCreditIds);
      const billById = new Map(bills.map((bill: any) => [bill.id, bill]));
      const creditById = new Map(credits.map((credit: any) => [credit.id, credit]));

      // Eligibility is rechecked against the freshly locked rows, not the
      // snapshot the client rendered from.
      const remainingByBill = new Map<string, number>();
      for (const bill of bills) {
        if (bill.voidedAt) {
          throw new HttpError(409, `Bill ${bill.billNumber ?? bill.id} is void and cannot be paid.`);
        }
        remainingByBill.set(bill.id, toCents(bill.balanceDue));
      }
      const remainingByCredit = new Map<string, number>();
      for (const credit of credits) {
        if (credit.voidedAt) {
          throw new HttpError(409, "A selected vendor credit is void.");
        }
        remainingByCredit.set(credit.id, toCents(credit.remainingAmount));
      }

      const createdPayments: any[] = [];
      for (const entry of input.vendorPayments) {
        const vendor = await tx.query.vendors.findFirst({
          where: eq(vendors.id, entry.vendorId),
        });
        if (!vendor || vendor.deletedAt || vendor.labOrganizationId !== input.organizationId) {
          throw new HttpError(404, "Vendor not found in this lab.");
        }

        let cashCents = 0;
        let creditCents = 0;
        const plannedAllocations: Array<{
          billId: string;
          vendorCreditId: string | null;
          cents: number;
        }> = [];

        for (const allocation of entry.allocations) {
          const bill = billById.get(allocation.billId);
          if (!bill) throw new HttpError(404, "A selected bill was not found.");
          if (bill.vendorId !== entry.vendorId) {
            throw new HttpError(
              400,
              "A bill was allocated under the wrong vendor. Bills can only be paid to their own vendor.",
            );
          }
          const cash = toCents(allocation.amount);
          if (cash < 0) throw new HttpError(400, "Allocation amounts cannot be negative.");

          let applied = cash;
          for (const application of allocation.creditApplications) {
            const credit = creditById.get(application.vendorCreditId);
            if (!credit) throw new HttpError(404, "A selected vendor credit was not found.");
            if (credit.vendorId !== entry.vendorId) {
              throw new HttpError(
                400,
                "A vendor credit can only be applied to its own vendor's bills.",
              );
            }
            const creditAmount = toCents(application.amount);
            const creditRemaining = remainingByCredit.get(credit.id) ?? 0;
            if (creditAmount > creditRemaining) {
              throw new HttpError(
                409,
                "A vendor credit no longer has enough remaining balance. Refresh and try again.",
              );
            }
            remainingByCredit.set(credit.id, creditRemaining - creditAmount);
            applied += creditAmount;
            creditCents += creditAmount;
            plannedAllocations.push({
              billId: bill.id,
              vendorCreditId: credit.id,
              cents: creditAmount,
            });
          }

          if (applied <= 0) {
            throw new HttpError(400, "Each selected bill needs a payment or credit amount.");
          }
          const billRemaining = remainingByBill.get(bill.id) ?? 0;
          if (applied > billRemaining) {
            throw new HttpError(
              409,
              `Bill ${bill.billNumber ?? bill.id} only has ${fromCents(billRemaining)} outstanding. Refresh and try again.`,
            );
          }
          remainingByBill.set(bill.id, billRemaining - applied);
          if (cash > 0) {
            cashCents += cash;
            plannedAllocations.push({ billId: bill.id, vendorCreditId: null, cents: cash });
          }
        }

        // One bank withdrawal per vendor, for the cash portion only.
        let bankTransactionId: string | null = null;
        if (cashCents > 0) {
          const [txn] = await tx
            .insert(bankTransactions)
            .values({
              labOrganizationId: input.organizationId,
              bankAccountId: account.id,
              txnDate: paymentDate,
              type: input.paymentMethod === "check" ? "check" : "payment",
              checkNumber:
                input.paymentMethod === "check" ? input.referenceNumber ?? null : null,
              payee: vendor.name,
              vendorId: vendor.id,
              memo: input.memo ?? `Bill payment — ${vendor.name}`,
              // Intentionally uncategorized: the expense was already
              // categorized on the bill's lines. Categorizing the withdrawal
              // too would count the same spend twice on the P&L.
              categoryId: null,
              debitAmount: fromCents(cashCents),
              creditAmount: "0.00",
              netAmount: fromCents(-cashCents),
              status: "posted",
              source: BILL_PAYMENT_SOURCE,
              createdByUserId: uid(req),
            })
            .returning();
          bankTransactionId = txn.id;
        }

        const [payment] = await tx
          .insert(vendorPayments)
          .values({
            labOrganizationId: input.organizationId,
            vendorId: vendor.id,
            paymentDate,
            paymentMethod: input.paymentMethod,
            referenceNumber: input.referenceNumber ?? null,
            memo: input.memo ?? null,
            bankAccountId: cashCents > 0 ? account.id : null,
            bankTransactionId,
            cashAmount: fromCents(cashCents),
            creditAmount: fromCents(creditCents),
            totalAmount: fromCents(cashCents + creditCents),
            // Scope the key per vendor so a multi-vendor run stores one key
            // per record without colliding inside the same request.
            idempotencyKey: input.idempotencyKey
              ? `${input.idempotencyKey}:${vendor.id}`
              : null,
            requestKey: input.idempotencyKey ?? null,
            requestFingerprint: fingerprint,
            status: "posted",
            createdByUserId: uid(req),
          })
          .returning();

        for (const planned of plannedAllocations) {
          await tx.insert(vendorPaymentAllocations).values({
            vendorPaymentId: payment.id,
            billId: planned.billId,
            vendorCreditId: planned.vendorCreditId,
            amount: fromCents(planned.cents),
            appliedAt: paymentDate,
          });
        }

        const touchedBills = [...new Set(plannedAllocations.map((p) => p.billId))].sort();
        for (const billId of touchedBills) await recomputeBillBalance(tx, billId);
        const touchedCredits = [
          ...new Set(
            plannedAllocations
              .map((p) => p.vendorCreditId)
              .filter((id): id is string => !!id),
          ),
        ].sort();
        for (const creditId of touchedCredits) {
          await recomputeVendorCreditBalance(tx, creditId);
        }

        await recordBillEvent(tx, {
          labOrganizationId: input.organizationId,
          vendorPaymentId: payment.id,
          eventType: "bill_payment_recorded",
          actorUserId: uid(req),
          metadata: {
            vendorId: vendor.id,
            cashAmount: payment.cashAmount,
            creditAmount: payment.creditAmount,
            billIds: touchedBills,
            bankTransactionId,
          },
        });
        // Also stamp each bill so its own history shows the settlement
        // without the reader having to find the payment record first.
        for (const billId of touchedBills) {
          const forThisBill = plannedAllocations.filter((p) => p.billId === billId);
          await recordBillEvent(tx, {
            labOrganizationId: input.organizationId,
            billId,
            vendorPaymentId: payment.id,
            eventType: "bill_payment_applied",
            actorUserId: uid(req),
            metadata: {
              cashAmount: fromCents(
                sumCents(
                  forThisBill.filter((p) => !p.vendorCreditId).map((p) => p.cents),
                ),
              ),
              creditAmount: fromCents(
                sumCents(
                  forThisBill.filter((p) => p.vendorCreditId).map((p) => p.cents),
                ),
              ),
            },
          });
        }
        createdPayments.push(payment);
      }

      return createdPayments;
    });

    if (replayedPayments) {
      // A replay posted nothing; it returns the original run's records.
      return res.status(200).json({ ok: true, data: { payments: result, replayed: true } });
    }
    await writeAuditLog({
      userId: uid(req),
      organizationId: input.organizationId,
      action: "vendor_bill_payment.create",
      entityType: "vendor_payment",
      entityId: result.map((p: any) => p.id).join(","),
    });
    return res.status(201).json({ ok: true, data: { payments: result, replayed: false } });
  }),
);

router.get(
  "/bill-payments",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        organizationId: z.string().min(1),
        vendorId: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);
    await requireAnyRole(uid(req), query.organizationId, BILLING_ROLES);
    const conditions = [eq(vendorPayments.labOrganizationId, query.organizationId)];
    if (query.vendorId) conditions.push(eq(vendorPayments.vendorId, query.vendorId));
    const rows = await db
      .select({ payment: vendorPayments, vendorName: vendors.name })
      .from(vendorPayments)
      .innerJoin(vendors, eq(vendorPayments.vendorId, vendors.id))
      .where(and(...conditions))
      .orderBy(desc(vendorPayments.paymentDate), desc(vendorPayments.id))
      .limit(query.limit ?? 200);
    const paymentIds = rows.map((row) => row.payment.id);
    const allocations = paymentIds.length
      ? await db
          .select({
            allocation: vendorPaymentAllocations,
            billNumber: vendorBills.billNumber,
          })
          .from(vendorPaymentAllocations)
          .innerJoin(vendorBills, eq(vendorPaymentAllocations.billId, vendorBills.id))
          .where(inArray(vendorPaymentAllocations.vendorPaymentId, paymentIds))
      : [];
    const byPayment = new Map<string, any[]>();
    for (const { allocation, billNumber } of allocations) {
      const list = byPayment.get(allocation.vendorPaymentId) ?? [];
      list.push({ ...allocation, billNumber });
      byPayment.set(allocation.vendorPaymentId, list);
    }
    return ok(
      res,
      rows.map(({ payment, vendorName }) => ({
        ...payment,
        vendorName,
        allocations: byPayment.get(payment.id) ?? [],
      })),
    );
  }),
);

// POST /finance/bill-payments/:id/void
//
// Reverses the allocations, restores the bill and credit balances, and voids
// the bank withdrawal — all in one transaction, so the cash side and the
// liability side can never end up disagreeing.
router.post(
  "/bill-payments/:id/void",
  asyncHandler(async (req, res) => {
    const paymentId = String(req.params.id);
    const { reason } = z
      .object({ reason: z.string().trim().max(500).nullish() })
      .parse(req.body ?? {});
    const existing = await db.query.vendorPayments.findFirst({
      where: eq(vendorPayments.id, paymentId),
    });
    if (!existing) throw new HttpError(404, "Vendor payment not found.");
    await requireAnyRole(uid(req), existing.labOrganizationId, BILLING_ROLES);
    if (existing.status === "void") {
      throw new HttpError(409, "This payment is already void.");
    }

    const result = await db.transaction(async (tx) => {
      await lockVendorBillMutations(tx);
      const [payment] = await tx
        .select()
        .from(vendorPayments)
        .where(eq(vendorPayments.id, paymentId))
        .for("update");
      if (payment.status === "void") {
        throw new HttpError(409, "This payment is already void.");
      }

      const allocations = await tx
        .select()
        .from(vendorPaymentAllocations)
        .where(
          and(
            eq(vendorPaymentAllocations.vendorPaymentId, paymentId),
            isNull(vendorPaymentAllocations.reversedAt),
          ),
        );

      const billIds = [...new Set(allocations.map((a: any) => a.billId))].sort();
      const creditIds = [
        ...new Set(
          allocations.map((a: any) => a.vendorCreditId).filter((id: any): id is string => !!id),
        ),
      ].sort();
      await lockBillsForUpdate(tx, existing.labOrganizationId, billIds);
      await lockCreditsForUpdate(tx, existing.labOrganizationId, creditIds);

      // The reconciled check happens before anything is mutated, so a
      // rejected reversal leaves no partial state behind.
      if (payment.bankTransactionId) {
        await voidBillPaymentTransaction(tx, payment.bankTransactionId, uid(req));
      }

      const now = new Date();
      await tx
        .update(vendorPaymentAllocations)
        .set({ reversedAt: now })
        .where(
          and(
            eq(vendorPaymentAllocations.vendorPaymentId, paymentId),
            isNull(vendorPaymentAllocations.reversedAt),
          ),
        );
      await tx
        .update(vendorPayments)
        .set({
          status: "void",
          voidedAt: now,
          voidedByUserId: uid(req),
          voidReason: reason ?? null,
          updatedAt: now,
        })
        .where(eq(vendorPayments.id, paymentId));

      for (const billId of billIds) await recomputeBillBalance(tx, billId);
      for (const creditId of creditIds) await recomputeVendorCreditBalance(tx, creditId);

      for (const billId of billIds) {
        await recordBillEvent(tx, {
          labOrganizationId: existing.labOrganizationId,
          billId,
          vendorPaymentId: paymentId,
          eventType: "bill_payment_void_reversed",
          actorUserId: uid(req),
          metadata: { reason: reason ?? null },
        });
      }
      await recordBillEvent(tx, {
        labOrganizationId: existing.labOrganizationId,
        vendorPaymentId: paymentId,
        eventType: "bill_payment_voided",
        actorUserId: uid(req),
        metadata: { reason: reason ?? null, billIds, creditIds },
      });

      const [refreshed] = await tx
        .select()
        .from(vendorPayments)
        .where(eq(vendorPayments.id, paymentId));
      return refreshed;
    });

    await writeAuditLog({
      userId: uid(req),
      organizationId: existing.labOrganizationId,
      action: "vendor_bill_payment.void",
      entityType: "vendor_payment",
      entityId: paymentId,
    });
    return ok(res, result);
  }),
);

// ───────────────────────────── Aging reports ─────────────────────────────

/**
 * AP aging as of a date, bucketed by how far past its due date each bill is.
 *
 * Balances are reconstructed from dated allocations rather than from today's
 * remaining balance, so an as-of date in the past shows what was actually
 * outstanding then.
 */
router.get(
  "/reports/ap-aging",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        organizationId: z.string().min(1),
        asOf: z.string().optional(),
        timeZone: z.string().max(64).optional(),
        detail: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    await requireAnyRole(uid(req), query.organizationId, BILLING_ROLES);
    const asOf = parseAsOf(query.asOf, query.timeZone);

    // Bills are replayed from their dated snapshots, so editing an old bill
    // today cannot change what this report says about an earlier date. Only
    // the labels (number, vendor) come from the live row.
    const [billRows, versions] = await Promise.all([
      db
        .select({ bill: vendorBills, vendorName: vendors.name, vendorIsActive: vendors.isActive })
        .from(vendorBills)
        .innerJoin(vendors, eq(vendorBills.vendorId, vendors.id))
        .where(eq(vendorBills.labOrganizationId, query.organizationId)),
      billVersionsAsOf(query.organizationId, asOf),
    ]);
    const bills = billRows
      .filter((row) => {
        const version = versions.get(row.bill.id);
        if (!version || version.billDate > asOf) return false;
        const voidedAt = row.bill.voidedAt ? new Date(row.bill.voidedAt) : null;
        return !voidedAt || voidedAt > asOf;
      })
      .map((row) => {
        const version = versions.get(row.bill.id)!;
        return {
          ...row,
          bill: {
            ...row.bill,
            billDate: version.billDate,
            dueDate: version.dueDate ?? row.bill.dueDate,
            total: fromCents(version.totalCents),
          },
        };
      })
      .sort(
        (a, b) =>
          new Date(a.bill.dueDate).getTime() - new Date(b.bill.dueDate).getTime(),
      );

    const billIds = bills.map((row) => row.bill.id);
    // Only allocations dated on or before the as-of instant reduce the
    // historical balance. A payment made last week does not retroactively
    // settle a bill as of last month.
    const allocations = billIds.length
      ? await db
          .select({
            billId: vendorPaymentAllocations.billId,
            amount: vendorPaymentAllocations.amount,
            appliedAt: vendorPaymentAllocations.appliedAt,
            reversedAt: vendorPaymentAllocations.reversedAt,
            paymentStatus: vendorPayments.status,
            paymentVoidedAt: vendorPayments.voidedAt,
          })
          .from(vendorPaymentAllocations)
          .innerJoin(
            vendorPayments,
            eq(vendorPaymentAllocations.vendorPaymentId, vendorPayments.id),
          )
          .where(
            and(
              inArray(vendorPaymentAllocations.billId, billIds),
              lte(vendorPaymentAllocations.appliedAt, asOf),
            ),
          )
      : [];

    const settledByBill = new Map<string, number>();
    for (const allocation of allocations) {
      // A reversal or void that happened after the as-of date had not
      // happened yet from this report's point of view.
      const reversedBeforeAsOf =
        (allocation.reversedAt && new Date(allocation.reversedAt) <= asOf) ||
        (allocation.paymentVoidedAt && new Date(allocation.paymentVoidedAt) <= asOf);
      if (reversedBeforeAsOf) continue;
      settledByBill.set(
        allocation.billId,
        (settledByBill.get(allocation.billId) ?? 0) + toCents(allocation.amount),
      );
    }

    const credits = await db
      .select({ credit: vendorCredits, vendorName: vendors.name })
      .from(vendorCredits)
      .innerJoin(vendors, eq(vendorCredits.vendorId, vendors.id))
      .where(
        and(
          eq(vendorCredits.labOrganizationId, query.organizationId),
          lte(vendorCredits.creditDate, asOf),
          or(isNull(vendorCredits.voidedAt), sql`${vendorCredits.voidedAt} > ${asOf}`)!,
        ),
      );
    // `remainingAmount` is today's figure. A dated report needs what was left
    // then, so rebuild each credit from its applications up to `asOf`.
    const creditRemainingAsOf = await unappliedVendorCreditsAsOf(
      query.organizationId,
      asOf,
    );

    const perVendor = new Map<string, any>();
    let totalCents = 0;
    const totals = emptyBuckets();

    for (const { bill, vendorName, vendorIsActive } of bills) {
      const outstanding = toCents(bill.total) - (settledByBill.get(bill.id) ?? 0);
      if (outstanding <= 0) continue;
      const bucket = agingBucketFor(new Date(bill.dueDate), asOf);
      const entry =
        perVendor.get(bill.vendorId) ??
        {
          vendorId: bill.vendorId,
          vendorName,
          vendorIsActive,
          buckets: emptyBuckets(),
          total: 0,
          unappliedCredit: 0,
          bills: [] as any[],
        };
      entry.buckets[bucket] += outstanding;
      entry.total += outstanding;
      if (query.detail === "true") {
        entry.bills.push({
          id: bill.id,
          billNumber: bill.billNumber,
          billDate: bill.billDate,
          dueDate: bill.dueDate,
          total: bill.total,
          outstanding: fromCents(outstanding),
          bucket,
        });
      }
      perVendor.set(bill.vendorId, entry);
      totals[bucket] += outstanding;
      totalCents += outstanding;
    }

    // Unapplied credits are listed alongside, never netted into the payable.
    let unappliedCreditCents = 0;
    for (const { credit, vendorName } of credits) {
      const remaining = creditRemainingAsOf.get(credit.id) ?? 0;
      if (remaining <= 0) continue;
      unappliedCreditCents += remaining;
      const entry =
        perVendor.get(credit.vendorId) ??
        {
          vendorId: credit.vendorId,
          vendorName,
          vendorIsActive: true,
          buckets: emptyBuckets(),
          total: 0,
          unappliedCredit: 0,
          bills: [] as any[],
        };
      entry.unappliedCredit += remaining;
      perVendor.set(credit.vendorId, entry);
    }

    return ok(res, {
      basis: "accrual",
      asOf: asOf.toISOString(),
      buckets: AGING_BUCKETS.map((bucket) => ({ key: bucket.key, label: bucket.label })),
      rows: [...perVendor.values()]
        .map((entry) => ({
          ...entry,
          buckets: formatBuckets(entry.buckets),
          total: fromCents(entry.total),
          unappliedCredit: fromCents(entry.unappliedCredit),
        }))
        .sort((a, b) => a.vendorName.localeCompare(b.vendorName)),
      totals: formatBuckets(totals),
      total: fromCents(totalCents),
      unappliedCreditTotal: fromCents(unappliedCreditCents),
    });
  }),
);

/**
 * AR aging as of a date, bucketed by how far past its due date each invoice is.
 *
 * Like AP aging, this reconstructs balances from dated records rather than
 * reading today's `invoices.balanceDue`, so a past as-of date reflects what
 * was outstanding then.
 *
 * Honest limitation: invoice payment rows carry a payment date but no reversal
 * date — a reversal removes the row outright. An as-of date earlier than a
 * reversal therefore cannot see the payment that existed at the time, and the
 * invoice reads as outstanding for the whole period. Rather than manufacture
 * certainty, the response reports the affected accounts in `limitations` so a
 * reader knows which historical figures are approximate.
 */
router.get(
  "/reports/ar-aging",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        organizationId: z.string().min(1),
        asOf: z.string().optional(),
        timeZone: z.string().max(64).optional(),
        detail: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    await requireAnyRole(uid(req), query.organizationId, BILLING_ROLES);
    const asOf = parseAsOf(query.asOf, query.timeZone);
    const wantsDetail = query.detail === "true";

    // Aging replays the one dated reconstruction the balance sheet and the
    // P&L also use, so the three cannot disagree about which invoices were on
    // the books or what was owed on them. Amounts, issue dates, due dates,
    // and void state are the ones in force on the as-of date, not the ones a
    // later edit left behind. Only the labels come from the live row.
    const [outstandingRows, identityRows] = await Promise.all([
      invoicesOutstandingAsOf(query.organizationId, asOf),
      db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          providerOrganizationId: invoices.providerOrganizationId,
          customerName: organizations.name,
        })
        .from(invoices)
        // Left join: legacy invoices carry no provider organization, and an
        // inner join would drop them from aging while the receivable control
        // balance still counted them.
        .leftJoin(
          organizations,
          eq(invoices.providerOrganizationId, organizations.id),
        )
        .where(
          and(
            eq(invoices.labOrganizationId, query.organizationId),
            isNull(invoices.deletedAt),
          ),
        ),
    ]);
    const identityById = new Map(identityRows.map((row) => [row.id, row]));
    const invoiceRows = outstandingRows
      .map((row) => ({ ...row, identity: identityById.get(row.invoiceId) ?? null }))
      .sort((a, b) => {
        const byDue = (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0);
        if (byDue !== 0) return byDue;
        return (a.issuedAt?.getTime() ?? 0) - (b.issuedAt?.getTime() ?? 0);
      });

    // Unapplied customer credit, reconstructed from the credit's own payment
    // date less the credit applications recorded on or before the as-of date.
    const customerCreditRows = await db
      .select({
        id: customerCredits.id,
        providerOrganizationId: customerCredits.providerOrganizationId,
        customerName: organizations.name,
        amount: customerCredits.amount,
        reversedAt: customerCredits.reversedAt,
        paymentDate: statementPaymentSessions.paymentDate,
      })
      .from(customerCredits)
      .innerJoin(
        statementPaymentSessions,
        eq(customerCredits.paymentSessionId, statementPaymentSessions.id),
      )
      .innerJoin(
        organizations,
        eq(customerCredits.providerOrganizationId, organizations.id),
      )
      .where(
        and(
          eq(customerCredits.labOrganizationId, query.organizationId),
          lte(statementPaymentSessions.paymentDate, asOf),
          or(
            isNull(customerCredits.reversedAt),
            sql`${customerCredits.reversedAt} > ${asOf}`,
          )!,
        ),
      );

    const creditIds = customerCreditRows.map((row) => row.id);
    const creditApplicationRows = creditIds.length
      ? await db
          .select({
            customerCreditId: customerCreditApplications.customerCreditId,
            amount: customerCreditApplications.amount,
          })
          .from(customerCreditApplications)
          .innerJoin(
            statementPaymentSessions,
            eq(
              customerCreditApplications.paymentSessionId,
              statementPaymentSessions.id,
            ),
          )
          .where(
            and(
              inArray(customerCreditApplications.customerCreditId, creditIds),
              // Consumption is dated by the consuming session's payment date,
              // the same basis the credit itself is dated on.
              lte(statementPaymentSessions.paymentDate, asOf),
            ),
          )
      : [];
    const appliedByCredit = new Map<string, number>();
    for (const row of creditApplicationRows) {
      appliedByCredit.set(
        row.customerCreditId,
        (appliedByCredit.get(row.customerCreditId) ?? 0) + toCents(row.amount),
      );
    }

    type ArEntry = {
      customerId: string;
      customerName: string;
      buckets: Record<AgingBucketKey, number>;
      total: number;
      unappliedCredit: number;
      invoices: Array<Record<string, unknown>>;
    };
    const perCustomer = new Map<string, ArEntry>();
    const entryFor = (customerId: string, customerName: string): ArEntry => {
      const existing = perCustomer.get(customerId);
      if (existing) return existing;
      const created: ArEntry = {
        customerId,
        customerName,
        buckets: emptyBuckets(),
        total: 0,
        unappliedCredit: 0,
        invoices: [],
      };
      perCustomer.set(customerId, created);
      return created;
    };

    const totals = emptyBuckets();
    let totalCents = 0;
    // Invoices whose historical balance could be overstated because a payment
    // reversal erased the dated payment row it would have relied on.
    const approximateCustomers = new Set<string>();
    // Invoices settled before any of that history was recorded, where no
    // payment, deposit, or receipt can say when. Their balances are today's,
    // carried back, so the report names how many there are and how much they
    // account for instead of implying the date is known.
    const unreconstructedCustomers = new Set<string>();
    let unreconstructedInvoiceCount = 0;
    let unreconstructedCents = 0;

    for (const invoice of invoiceRows) {
      const outstanding = invoice.outstandingCents;
      // A legacy invoice with no customer of record is still receivable, so
      // it is aged under a placeholder rather than dropped — otherwise the
      // report would not tie to the receivable control balance.
      const customerId =
        invoice.identity?.providerOrganizationId ?? UNASSIGNED_CUSTOMER_ID;
      const customerName =
        invoice.identity?.customerName ?? UNASSIGNED_CUSTOMER_NAME;
      // Counted before the zero-balance skip below: an invoice this report
      // leaves out entirely because undated settlement cleared it is exactly
      // the invoice whose history cannot be proved.
      if (invoice.unreconstructedSettlementCents > 0) {
        unreconstructedCustomers.add(customerId);
        unreconstructedInvoiceCount += 1;
        unreconstructedCents += invoice.unreconstructedSettlementCents;
      }
      if (outstanding <= 0) continue;
      // The invoice recorded a settlement whose dated payment no longer
      // exists, so its historical balance is a reconstruction.
      if (invoice.approximate) approximateCustomers.add(customerId);
      // Undated invoices cannot be aged by due date; treat them as current
      // rather than inventing an overdue age.
      const dueDate = invoice.dueAt ?? invoice.issuedAt ?? asOf;
      const bucket = agingBucketFor(new Date(dueDate), asOf);
      const entry = entryFor(customerId, customerName);
      entry.buckets[bucket] += outstanding;
      entry.total += outstanding;
      if (wantsDetail) {
        entry.invoices.push({
          id: invoice.invoiceId,
          invoiceNumber: invoice.identity?.invoiceNumber ?? null,
          issuedAt: invoice.issuedAt,
          dueAt: invoice.dueAt,
          total: fromCents(invoice.totalCents),
          outstanding: fromCents(outstanding),
          bucket,
          approximate: invoice.approximate,
          // The balance shown is today's, carried back: nothing records when
          // the rest of this invoice was settled.
          unreconstructed: invoice.unreconstructedSettlementCents > 0,
        });
      }
      totals[bucket] += outstanding;
      totalCents += outstanding;
    }

    let unappliedCreditCents = 0;
    for (const credit of customerCreditRows) {
      const remaining =
        toCents(credit.amount) - (appliedByCredit.get(credit.id) ?? 0);
      if (remaining <= 0) continue;
      unappliedCreditCents += remaining;
      entryFor(credit.providerOrganizationId, credit.customerName).unappliedCredit +=
        remaining;
    }

    return ok(res, {
      basis: "accrual",
      asOf: asOf.toISOString(),
      buckets: AGING_BUCKETS.map((bucket) => ({ key: bucket.key, label: bucket.label })),
      rows: [...perCustomer.values()]
        .map((entry) => ({
          ...entry,
          buckets: formatBuckets(entry.buckets),
          total: fromCents(entry.total),
          unappliedCredit: fromCents(entry.unappliedCredit),
        }))
        .sort((a, b) => a.customerName.localeCompare(b.customerName)),
      totals: formatBuckets(totals),
      total: fromCents(totalCents),
      unappliedCreditTotal: fromCents(unappliedCreditCents),
      limitations: [
        ...(approximateCustomers.size
          ? [
              {
                code: "reversed_payments_not_dated",
                message:
                  "Some invoices are settled today but have no dated payment record, " +
                  "usually because a payment was reversed. Their historical balances " +
                  "on this report are approximate.",
                affectedCustomerIds: [...approximateCustomers],
              },
            ]
          : []),
        ...(unreconstructedInvoiceCount
          ? [
              {
                code: "legacy_settlements_not_dated",
                message:
                  `${unreconstructedInvoiceCount} invoice${unreconstructedInvoiceCount === 1 ? "" : "s"} ` +
                  `carrying ${fromCents(unreconstructedCents)} of settlement predate payment history, and no ` +
                  "payment, deposit, or receipt records when they were settled. Their " +
                  "current balances are shown at every date; no opening balance has been " +
                  "assumed for them.",
                affectedInvoiceCount: unreconstructedInvoiceCount,
                affectedAmount: fromCents(unreconstructedCents),
                affectedCustomerIds: [...unreconstructedCustomers],
              },
            ]
          : []),
      ],
    });
  }),
);

function formatBuckets(buckets: Record<AgingBucketKey, number>) {
  return Object.fromEntries(
    Object.entries(buckets).map(([key, cents]) => [key, fromCents(cents)]),
  ) as Record<AgingBucketKey, string>;
}

export default router;
