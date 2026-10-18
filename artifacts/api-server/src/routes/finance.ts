import { assertRecoveryReleased } from "../lib/recovery-billing-hold";
import { GetRegisterAnalyticsQueryParams } from "@workspace/api-zod";
import { registerAnalytics } from "../lib/register-analytics";
import { Router } from "express";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import multer from "multer";
import { db } from "@workspace/db";
import {
  bankAccounts,
  bankImportBatches,
  bankTransactionInvoices,
  bankDepositBatchMembers,
  bankTransactions,
  invoices,
  organizationMemberships,
  organizations,
  payments,
  practiceStatements,
  recurringTransactions,
  reconciliationItems,
  reconciliations,
  transactionCategories,
  users,
  vendors,
  vendorTypes,
} from "@workspace/db";
import * as workspaceDb from "@workspace/db";
import { HttpError, ok, wrapDbError } from "../lib/http";
import { archiveReversedSettlements } from "../lib/settlement-history";
import { softDelete, softDeleteById } from "../lib/soft-delete";
import { writeAuditLog } from "../lib/audit";
import {
  ensureVendorTypesSeeded,
  getBuiltinKindMap,
  getDefaultVendorTypeId,
  listVendorTypes,
  resolveVendorTypeId,
  type VendorTypeRow,
} from "../lib/vendor-types-seed";
import { ensureDefaultCategories } from "../lib/default-categories";
import { ADMIN_ROLES, BILLING_ROLES, hasCapability, OWNER_ROLES, requireAnyRole, requireMembership, type MembershipRole } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth, requireVerifiedAccount } from "../middlewares/auth";
import { createOpenAIClient } from "../lib/ai-openai-client";
import { findDuplicateCandidates, type ExtractedRow } from "../lib/bank-import-duplicates";
import { assertNoActiveCardReversalForTransactions } from "../lib/payment-reversal-guards";
import { pageRows, pageRowsKeyset, parsePagination, sortTime, type Keyset } from "../lib/pagination";
import { assertNotBillPaymentTransaction } from "../lib/vendor-bills";
import {
  BILL_PAYMENT_TXN_SOURCE,
  type InvoiceVersion,
  apBalanceAsOf,
  arBalanceAsOf,
  unappliedCustomerCreditsAsOf,
  billedExpensesInPeriod,
  endOfDayInTz,
  invoiceRecognizedAsOf,
  invoiceVersionsAsOf,
  invoicedRevenueThrough,
} from "../lib/ap-ar-reporting";
import {
  lockDepositBatchMutations,
  releaseBatchForChild,
  releaseDepositBatch,
} from "../lib/deposit-batches";
// pdf-parse@1.1.1 index.js reads a test PDF at require() time (known bug).
// Require the implementation file directly to skip the test-file read.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParseImpl = require("pdf-parse/lib/pdf-parse.js") as (
  buf: Buffer,
  options?: Record<string, unknown>
) => Promise<{ text: string }>;
async function parsePdf(buffer: Buffer): Promise<string> {
  const result = await pdfParseImpl(buffer);
  return result.text ?? "";
}

const router = Router();
const { customerCredits, statementPaymentSessions, statementPaymentReversals } = workspaceDb;
router.use(requireAuth);
router.use(requireVerifiedAccount);


function uid(req: any): string {
  return req.auth.userId as string;
}

function normalizeLegacyDoctorName(name: string | null): string | null {
  return name ? name.trim().replace(/\s+/g, " ").toLocaleLowerCase() : null;
}

function invoiceDoctorDisplayName(invoice: {
  displayMetadataJson: unknown;
}): string | null {
  const metadata =
    invoice.displayMetadataJson &&
    typeof invoice.displayMetadataJson === "object"
      ? (invoice.displayMetadataJson as Record<string, unknown>)
      : null;
  const value = metadata?.billTo ?? metadata?.doctorName;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function doctorAttributionFromLinks(
  links: Array<{
    doctorIdentity?: string | null;
    doctorDisplayName?: string | null;
  }>,
) {
  const stableDoctorIdentities = [
    ...new Set(
      links
        .map((link) => link.doctorIdentity?.trim() || null)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const doctorIdentityKeys = [
    ...new Set(
      links
        .map((link) =>
          link.doctorIdentity ?? normalizeLegacyDoctorName(link.doctorDisplayName ?? null),
        )
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const doctorDisplayNames = [
    ...new Set(
      links
        .map((link) => link.doctorDisplayName?.trim() || null)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  return {
    doctorIdentity:
      stableDoctorIdentities.length === 1 ? stableDoctorIdentities[0] : null,
    doctorDisplayName: doctorDisplayNames.length === 1 ? doctorDisplayNames[0] : null,
    doctorIdentityKeys,
    doctorDisplayNames,
  };
}

async function activeLabIds(userId: string): Promise<string[]> {
  const rows = await db.query.organizationMemberships.findMany({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.status, "active")
    ),
  });
  return Array.from(new Set(rows.map((r: any) => r.labId)));
}

async function requireLabAccess(userId: string, orgId: string) {
  await requireMembership(userId, orgId);
}

async function loadAccountOrThrow(userId: string, accountId: string) {
  const acct = await db.query.bankAccounts.findFirst({
    where: eq(bankAccounts.id, accountId),
  });
  if (!acct) throw new HttpError(404, "Bank account not found.");
  await requireLabAccess(userId, acct.labOrganizationId);
  return acct;
}

async function activeBillingLabIds(userId: string): Promise<string[]> {
  const rows = await db.query.organizationMemberships.findMany({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.status, "active"),
      inArray(organizationMemberships.role, BILLING_ROLES)
    ),
  });
  return Array.from(new Set(rows.map((r: any) => r.labId)));
}

async function loadAccountOrThrowBilling(userId: string, accountId: string) {
  const acct = await db.query.bankAccounts.findFirst({
    where: eq(bankAccounts.id, accountId),
  });
  if (!acct) throw new HttpError(404, "Bank account not found.");
  await requireAnyRole(userId, acct.labOrganizationId, BILLING_ROLES);
  return acct;
}

const orgIdQuery = z.object({ organizationId: z.string().min(1) });

// ───────────────────────────── Finance Settings ──────────────────────────

router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    const { organizationId } = orgIdQuery.parse(req.query);
    await requireAnyRole(uid(req), organizationId, BILLING_ROLES);
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    return ok(res, {
      defaultBankAccountId: org?.defaultBankAccountId ?? null,
    });
  })
);

const updateSettingsSchema = z.object({
  organizationId: z.string().min(1),
  defaultBankAccountId: z.string().nullable(),
});

router.patch(
  "/settings",
  asyncHandler(async (req, res) => {
    const input = updateSettingsSchema.parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, ADMIN_ROLES);
    if (input.defaultBankAccountId) {
      const acct = await db.query.bankAccounts.findFirst({
        where: eq(bankAccounts.id, input.defaultBankAccountId),
      });
      if (!acct || acct.labOrganizationId !== input.organizationId) {
        throw new HttpError(
          400,
          "Default bank account must belong to this organization."
        );
      }
    }
    await db
      .update(organizations)
      .set({
        defaultBankAccountId: input.defaultBankAccountId,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, input.organizationId));
    return ok(res, {
      defaultBankAccountId: input.defaultBankAccountId,
    });
  })
);

// ───────────────────────────── Bank Accounts ─────────────────────────────

router.get(
  "/accounts",
  asyncHandler(async (req, res) => {
    const orgId = (req.query.organizationId as string | undefined) || null;
    const orgIds = orgId ? [orgId] : await activeBillingLabIds(uid(req));
    if (orgId) await requireAnyRole(uid(req), orgId, BILLING_ROLES);
    if (!orgIds.length) return ok(res, []);
    let accounts = await db.query.bankAccounts.findMany({
      where: inArray(bankAccounts.labOrganizationId, orgIds),
      orderBy: [asc(bankAccounts.name)],
    });
    // Lazily create a single default "General Register" and an "Undeposited
    // Funds" holding account when an org has no bank accounts. Serialized
    // by row-locking the org row so concurrent first-load calls cannot race.
    if (!accounts.length && orgId) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`
          );
          const existing = await tx.query.bankAccounts.findMany({
            where: eq(bankAccounts.labOrganizationId, orgId),
            limit: 1,
          });
          if (existing.length) return;
          await tx.insert(bankAccounts).values([
            {
              labOrganizationId: orgId,
              name: "General Register",
              openingBalance: "0.00",
              openingDate: new Date(),
              createdByUserId: uid(req),
            },
            {
              labOrganizationId: orgId,
              name: "Undeposited Funds",
              openingBalance: "0.00",
              openingDate: new Date(),
              accountType: "undeposited_funds",
              createdByUserId: uid(req),
            },
          ]);
          await ensureDefaultCategories(orgId, tx);
        });
        accounts = await db.query.bankAccounts.findMany({
          where: inArray(bankAccounts.labOrganizationId, orgIds),
          orderBy: [asc(bankAccounts.name)],
        });
      } catch (err) {
        req.log.warn({ err, orgId }, "default General Register create failed");
      }
    }
    // Ensure every org has an Undeposited Funds account (handles orgs
    // created before this feature shipped that already have a General Register).
    if (orgId) {
      const hasUF = accounts.some((a: any) => a.accountType === "undeposited_funds");
      if (!hasUF) {
        try {
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`
            );
            const existingUF = await tx.query.bankAccounts.findFirst({
              where: and(
                eq(bankAccounts.labOrganizationId, orgId),
                eq(bankAccounts.accountType, "undeposited_funds")
              ),
            });
            if (existingUF) return;
            await tx.insert(bankAccounts).values({
              labOrganizationId: orgId,
              name: "Undeposited Funds",
              openingBalance: "0.00",
              openingDate: new Date(),
              accountType: "undeposited_funds",
              createdByUserId: uid(req),
            });
          });
          accounts = await db.query.bankAccounts.findMany({
            where: inArray(bankAccounts.labOrganizationId, orgIds),
            orderBy: [asc(bankAccounts.name)],
          });
        } catch (err) {
          req.log.warn({ err, orgId }, "Undeposited Funds account create failed");
        }
      }
    }
    if (!accounts.length) return ok(res, []);
    const acctIds = accounts.map((a: any) => a.id);
    const txns = await db
      .select({
        accountId: bankTransactions.bankAccountId,
        net: sql<string>`COALESCE(SUM(${bankTransactions.netAmount}), 0)::text`,
        cleared: sql<string>`COALESCE(SUM(CASE WHEN ${bankTransactions.cleared} THEN ${bankTransactions.netAmount} ELSE 0 END), 0)::text`,
        unreconciled: sql<string>`COALESCE(SUM(CASE WHEN NOT ${bankTransactions.reconciled} THEN ${bankTransactions.netAmount} ELSE 0 END), 0)::text`,
      })
      .from(bankTransactions)
      .where(
        and(
          inArray(bankTransactions.bankAccountId, acctIds),
          eq(bankTransactions.status, "posted")
        )
      )
      .groupBy(bankTransactions.bankAccountId);
    const byAcct = new Map<string, any>(txns.map((r) => [r.accountId, r]));
    const enriched = accounts.map((a: any) => {
      const sums = byAcct.get(a.id);
      return {
        ...a,
        bookBalance: sums?.net ?? "0.00",
        clearedBalance: sums?.cleared ?? "0.00",
        unreconciledBalance: sums?.unreconciled ?? "0.00",
      };
    });
    return ok(res, enriched);
  })
);

const createAccountSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1),
  institution: z.string().optional().nullable(),
  last4: z.string().max(4).optional().nullable(),
  openingBalance: z.coerce.number().default(0),
  openingDate: z.string().optional(),
});

router.post(
  "/accounts",
  asyncHandler(async (req, res) => {
    const input = createAccountSchema.parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, ADMIN_ROLES);
    const opening = Number(input.openingBalance || 0);
    const openingDate = input.openingDate ? new Date(input.openingDate) : new Date();
    const [acct] = await db
      .insert(bankAccounts)
      .values({
        labOrganizationId: input.organizationId,
        name: input.name,
        institution: input.institution || null,
        last4: input.last4 || null,
        openingBalance: opening.toFixed(2),
        openingDate,
        createdByUserId: uid(req),
      })
      .returning();
    if (opening !== 0) {
      const debit = opening < 0 ? Math.abs(opening) : 0;
      const credit = opening > 0 ? opening : 0;
      await db.insert(bankTransactions).values({
        labOrganizationId: input.organizationId,
        bankAccountId: acct.id,
        txnDate: openingDate,
        type: "other",
        payee: "Opening balance",
        memo: "Opening balance",
        debitAmount: debit.toFixed(2),
        creditAmount: credit.toFixed(2),
        netAmount: opening.toFixed(2),
        cleared: true,
        clearedAt: openingDate,
        reconciled: true,
        source: "opening",
        createdByUserId: uid(req),
      }).catch((err: unknown): never => wrapDbError(err));
    }
    return ok(res, acct, 201);
  })
);

const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  institution: z.string().nullable().optional(),
  last4: z.string().max(4).nullable().optional(),
  isArchived: z.boolean().optional(),
});

router.patch(
  "/accounts/:id",
  asyncHandler(async (req, res) => {
    const acct = await loadAccountOrThrow(uid(req), String(req.params.id));
    await requireAnyRole(uid(req), acct.labOrganizationId, ADMIN_ROLES);
    const input = updateAccountSchema.parse(req.body);
    const [row] = await db
      .update(bankAccounts)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(bankAccounts.id, acct.id))
      .returning();
    return ok(res, row);
  })
);

router.delete(
  "/accounts/:id",
  asyncHandler(async (req, res) => {
    const acct = await loadAccountOrThrow(uid(req), String(req.params.id));
    await requireAnyRole(uid(req), acct.labOrganizationId, ADMIN_ROLES);
    await db
      .update(bankAccounts)
      .set({ isArchived: true, updatedAt: new Date() })
      .where(eq(bankAccounts.id, acct.id));
    return ok(res, { archived: true });
  })
);

// ─────────────────────────────── Categories ──────────────────────────────

router.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const { organizationId } = orgIdQuery.parse(req.query);
    await requireAnyRole(uid(req), organizationId, BILLING_ROLES);
    // Lazily seed AR/AP defaults so every lab that visits the Finance page
    // gets them without requiring a separate migration job.
    try {
      await ensureDefaultCategories(organizationId);
    } catch (err) {
      req.log.warn({ err, organizationId }, "ensureDefaultCategories failed in GET /categories");
    }
    const rows = await db.query.transactionCategories.findMany({
      where: eq(transactionCategories.labOrganizationId, organizationId),
      orderBy: [asc(transactionCategories.name)],
    });
    return ok(res, rows);
  })
);

const createCategorySchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["income", "expense", "transfer"]).default("expense"),
  color: z.string().nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});

router.post(
  "/categories",
  asyncHandler(async (req, res) => {
    const input = createCategorySchema.parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, BILLING_ROLES);
    const [row] = await db
      .insert(transactionCategories)
      .values({
        labOrganizationId: input.organizationId,
        name: input.name,
        kind: input.kind,
        color: input.color || null,
        description: input.description || null,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const existing = await db.query.transactionCategories.findFirst({
        where: and(
          eq(transactionCategories.labOrganizationId, input.organizationId),
          eq(transactionCategories.name, input.name)
        ),
      });
      return ok(res, existing!, 200);
    }
    return ok(res, row, 201);
  })
);

router.patch(
  "/categories/:id",
  asyncHandler(async (req, res) => {
    const cat = await db.query.transactionCategories.findFirst({
      where: eq(transactionCategories.id, String(req.params.id)),
    });
    if (!cat) throw new HttpError(404, "Category not found.");
    await requireAnyRole(uid(req), cat.labOrganizationId, BILLING_ROLES);
    const input = z
      .object({
        name: z.string().min(1).optional(),
        kind: z.enum(["income", "expense", "transfer"]).optional(),
        color: z.string().nullable().optional(),
        description: z.string().max(500).nullable().optional(),
        isArchived: z.boolean().optional(),
      })
      .parse(req.body);
    const [row] = await db
      .update(transactionCategories)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(transactionCategories.id, cat.id))
      .returning();
    return ok(res, row);
  })
);

router.delete(
  "/categories/:id",
  asyncHandler(async (req, res) => {
    const cat = await db.query.transactionCategories.findFirst({
      where: eq(transactionCategories.id, String(req.params.id)),
    });
    if (!cat) throw new HttpError(404, "Category not found.");
    await requireAnyRole(uid(req), cat.labOrganizationId, BILLING_ROLES);
    const [row] = await db
      .update(transactionCategories)
      .set({ isArchived: true, updatedAt: new Date() })
      .where(eq(transactionCategories.id, cat.id))
      .returning();
    return ok(res, row);
  })
);

// ─────────────────────────── Register Transactions ───────────────────────

/**
 * Register and Undeposited Funds both return bank transactions newest-first
 * (txnDate, then createdAt, then id — all descending), so a cursor anchors on
 * those three values.
 */
const bankTransactionKeyset: Keyset<any> = {
  sortValues: (row) => [sortTime(row.txnDate), sortTime(row.createdAt)],
  id: (row) => String(row.id),
  directions: ["desc", "desc"],
  idDirection: "desc",
};

router.get("/register-analytics", asyncHandler(async (req, res) => {
  const q = GetRegisterAnalyticsQueryParams.extend({
    organizationId: z.string().uuid(),
    bankAccountId: z.string().uuid(),
  }).parse(req.query);
  const from = new Date(`${q.dateFrom}T00:00:00.000Z`);
  const to = new Date(`${q.dateTo}T00:00:00.000Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) ||
      from.toISOString().slice(0, 10) !== q.dateFrom || to.toISOString().slice(0, 10) !== q.dateTo ||
      to < from || to.getTime() - from.getTime() > 365 * 86_400_000) {
    throw new HttpError(400, "Choose a valid range of up to 366 calendar days.");
  }
  await requireAnyRole(uid(req), q.organizationId, BILLING_ROLES);
  const [account] = await db.select({ id: bankAccounts.id }).from(bankAccounts).where(and(
    eq(bankAccounts.id, q.bankAccountId), eq(bankAccounts.labOrganizationId, q.organizationId),
  ));
  if (!account) throw new HttpError(404, "Bank account not found in this lab.");
  ok(res, await registerAnalytics(q));
}));

const txnListQuery = z.object({
  organizationId: z.string().min(1),
  bankAccountId: z.string().optional(),
  status: z.enum(["all", "posted", "projected", "void", "uncleared", "unreconciled"]).default("all"),
  payee: z.string().optional(),
  categoryId: z.string().optional(),
  search: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  amountMin: z.coerce.number().optional(),
  amountMax: z.coerce.number().optional(),
});

router.get(
  "/transactions",
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query);
    const q = txnListQuery.parse(req.query);
    await requireAnyRole(uid(req), q.organizationId, BILLING_ROLES);
    const conds: any[] = [
      eq(bankTransactions.labOrganizationId, q.organizationId),
      ne(bankTransactions.status, "deposited_child"),
      sql`NOT EXISTS (
        SELECT 1 FROM bank_deposit_batch_members dbm
        WHERE dbm.child_bank_transaction_id = ${bankTransactions.id}
          AND dbm.released_at IS NULL
      )`,
    ];
    if (q.bankAccountId) conds.push(eq(bankTransactions.bankAccountId, q.bankAccountId));
    if (q.status === "posted" || q.status === "projected" || q.status === "void") {
      conds.push(eq(bankTransactions.status, q.status));
    } else if (q.status === "uncleared") {
      conds.push(eq(bankTransactions.cleared, false));
      conds.push(eq(bankTransactions.status, "posted"));
    } else if (q.status === "unreconciled") {
      conds.push(eq(bankTransactions.reconciled, false));
      conds.push(eq(bankTransactions.status, "posted"));
    }
    if (q.payee) conds.push(ilike(bankTransactions.payee, `%${q.payee}%`));
    if (q.categoryId) conds.push(eq(bankTransactions.categoryId, q.categoryId));
    if (q.dateFrom) conds.push(gte(bankTransactions.txnDate, new Date(q.dateFrom)));
    if (q.dateTo) conds.push(lte(bankTransactions.txnDate, new Date(q.dateTo)));
    if (q.amountMin !== undefined)
      conds.push(gte(bankTransactions.netAmount, q.amountMin.toFixed(2)));
    if (q.amountMax !== undefined)
      conds.push(lte(bankTransactions.netAmount, q.amountMax.toFixed(2)));
    if (q.search) {
      conds.push(
        or(
          ilike(bankTransactions.payee, `%${q.search}%`),
          ilike(bankTransactions.memo, `%${q.search}%`),
          ilike(bankTransactions.checkNumber, `%${q.search}%`)
        )
      );
    }
    const rows = await db
      .select()
      .from(bankTransactions)
      .where(and(...conds))
      .orderBy(
        asc(bankTransactions.txnDate),
        asc(bankTransactions.createdAt),
        asc(bankTransactions.id),
      );

    const txnIds = rows.map((r: any) => r.id);
    const linkRows = txnIds.length
      ? await db
          .select({
            bankTransactionId: bankTransactionInvoices.bankTransactionId,
            invoiceId: bankTransactionInvoices.invoiceId,
            invoiceNumber: invoices.invoiceNumber,
            doctorIdentity: invoices.doctorIdentity,
            displayMetadataJson: invoices.displayMetadataJson,
          })
          .from(bankTransactionInvoices)
          .innerJoin(
            invoices,
            eq(invoices.id, bankTransactionInvoices.invoiceId)
          )
          .where(inArray(bankTransactionInvoices.bankTransactionId, txnIds))
      : [];
    const linksByTxn = new Map<
      string,
      Array<{
        invoiceId: string;
        invoiceNumber: string;
        doctorIdentity: string | null;
        doctorDisplayName: string | null;
      }>
    >();
    for (const l of linkRows) {
      const arr = linksByTxn.get(l.bankTransactionId) ?? [];
      arr.push({
        invoiceId: l.invoiceId,
        invoiceNumber: l.invoiceNumber,
        doctorIdentity: l.doctorIdentity,
        doctorDisplayName: invoiceDoctorDisplayName(l),
      });
      linksByTxn.set(l.bankTransactionId, arr);
    }

    // Expand aggregate deposits without making their non-posting children
    // visible register rows.  All detail amounts are retained as decimal
    // strings; grouping uses integer cents to avoid floating point drift.
    const aggregateRows = rows.filter((r: any) => r.source === "deposit_batch");
    const aggregateIds = aggregateRows.map((r: any) => r.id);
    const members = aggregateIds.length
      ? await db.select().from(bankDepositBatchMembers)
          .where(inArray(bankDepositBatchMembers.aggregateBankTransactionId, aggregateIds))
      : [];
    const childIds = members.map((m) => m.childBankTransactionId);
    const children = childIds.length
      ? await db.select().from(bankTransactions).where(and(
          inArray(bankTransactions.id, childIds),
          eq(bankTransactions.labOrganizationId, q.organizationId),
        ))
      : [];
    const childById = new Map(children.map((c: any) => [c.id, c]));
    const childSessions = childIds.length
      ? await db.select().from(statementPaymentSessions)
          .where(and(
            inArray(statementPaymentSessions.bankTransactionId, childIds),
            eq(statementPaymentSessions.labOrganizationId, q.organizationId),
          ))
      : [];
    const sessionByTxn = new Map(childSessions.map((s: any) => [s.bankTransactionId, s]));
    const childLinks = childIds.length
      ? await db.select().from(bankTransactionInvoices)
          .where(inArray(bankTransactionInvoices.bankTransactionId, childIds))
      : [];
    const childInvoiceIds = [...new Set(childLinks.map((l: any) => l.invoiceId))];
    const childInvoiceRows = childInvoiceIds.length
      ? await db.select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          providerOrganizationId: invoices.providerOrganizationId,
          doctorIdentity: invoices.doctorIdentity,
          displayMetadataJson: invoices.displayMetadataJson,
        }).from(invoices).where(and(
          inArray(invoices.id, childInvoiceIds),
          eq(invoices.labOrganizationId, q.organizationId),
        ))
      : [];
    const invoiceById = new Map(childInvoiceRows.map((i) => [i.id, i]));
    const providerIds = [...new Set([
      ...childSessions.map((s: any) => s.providerOrganizationId),
      ...childInvoiceRows.map((i) => i.providerOrganizationId),
    ].filter(Boolean))] as string[];
    const providerRows = providerIds.length
      ? await db.select({ id: organizations.id, name: organizations.name, displayName: organizations.displayName })
          .from(organizations).where(and(
            inArray(organizations.id, providerIds),
            eq(organizations.parentLabOrganizationId, q.organizationId),
          ))
      : [];
    const providerById = new Map(providerRows.map((p: any) => [p.id, p]));
    const childLinksByTxn = new Map<string, any[]>();
    for (const link of childLinks) {
      const list = childLinksByTxn.get(link.bankTransactionId) ?? [];
      const invoice = invoiceById.get(link.invoiceId);
      list.push({
        invoiceId: link.invoiceId,
        invoiceNumber: null,
        doctorIdentity: invoice?.doctorIdentity ?? null,
        doctorDisplayName: invoice ? invoiceDoctorDisplayName(invoice) : null,
      });
      childLinksByTxn.set(link.bankTransactionId, list);
    }
    if (childLinks.length) {
      const invs = await db.select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
        .from(invoices).where(and(
          inArray(invoices.id, [...new Set(childLinks.map((l: any) => l.invoiceId))]),
          eq(invoices.labOrganizationId, q.organizationId),
        ));
      const numbers = new Map(invs.map((i) => [i.id, i.invoiceNumber]));
      for (const links of childLinksByTxn.values()) for (const link of links) link.invoiceNumber = numbers.get(link.invoiceId) ?? null;
    }
    const splitGroupsByAggregate = new Map<string, any[]>();
    const aggregateInvoiceLinks = new Map<string, any[]>();
    for (const member of members) {
      const child: any = childById.get(member.childBankTransactionId);
      if (!child) continue;
      const session: any = sessionByTxn.get(child.id);
      const linkedProviders = [...new Set((childLinksByTxn.get(child.id) ?? [])
        .map((link: any) => invoiceById.get(link.invoiceId)?.providerOrganizationId)
        .filter(Boolean))] as string[];
      const invoiceProviderId = !session && linkedProviders.length === 1
        ? linkedProviders[0]
        : null;
      const providerOrganizationId = session?.providerOrganizationId ?? invoiceProviderId;
      const provider: any = providerOrganizationId ? providerById.get(providerOrganizationId) : null;
      const providerName = provider?.displayName || provider?.name || "Unassigned";
      const detail = {
        childTransactionId: child.id,
        amount: child.netAmount,
        payee: child.payee,
        memo: child.memo,
        checkNumber: session?.checkNumber ?? child.checkNumber,
        paymentMethod: session?.paymentMethod ?? null,
        receiptNumber: session?.receiptNumber ?? null,
        statementId: session?.statementId ?? null,
        paymentSessionId: session?.id ?? null,
        providerOrganizationId,
        providerName,
        ...doctorAttributionFromLinks(childLinksByTxn.get(child.id) ?? []),
        invoices: childLinksByTxn.get(child.id) ?? [],
      };
      const groups = splitGroupsByAggregate.get(member.aggregateBankTransactionId) ?? [];
      const aggregateLinks = aggregateInvoiceLinks.get(member.aggregateBankTransactionId) ?? [];
      for (const invoiceLink of childLinksByTxn.get(child.id) ?? []) {
        if (!aggregateLinks.some((link) => link.invoiceId === invoiceLink.invoiceId)) {
          aggregateLinks.push(invoiceLink);
        }
      }
      aggregateInvoiceLinks.set(member.aggregateBankTransactionId, aggregateLinks);
      let group = groups.find((g) => g.providerOrganizationId === providerOrganizationId);
      if (!group) {
        group = { providerOrganizationId, providerName, subtotal: "0.00", payments: [] };
        groups.push(group);
      }
      group.payments.push(detail);
      const cents = Math.round(Number(group.subtotal) * 100) + Math.round(Number(child.netAmount || 0) * 100);
      group.subtotal = (cents / 100).toFixed(2);
      splitGroupsByAggregate.set(member.aggregateBankTransactionId, groups);
    }

    const vendorIds = Array.from(
      new Set(rows.map((r: any) => r.vendorId).filter(Boolean) as string[])
    );
    const vendorRows = vendorIds.length
      ? await db
          .select({ id: vendors.id, name: vendors.name })
          .from(vendors)
          .where(inArray(vendors.id, vendorIds))
      : [];
    const vendorNameById = new Map(vendorRows.map((v) => [v.id, v.name]));

    const depositorIds = Array.from(
      new Set(
        rows
          .map((r: any) => r.depositedByUserId)
          .filter(Boolean) as string[]
      )
    );
    const depositorRows = depositorIds.length
      ? await db
          .select({
            id: users.id,
            username: users.username,
            firstName: users.firstName,
            lastName: users.lastName,
          })
          .from(users)
          .where(inArray(users.id, depositorIds))
      : [];
    const depositorById = new Map(depositorRows.map((u) => [u.id, u]));

    // Compute running balance per-account.
    const running = new Map<string, number>();
    const enriched = rows.map((r: any) => {
      const cur = running.get(r.bankAccountId) ?? 0;
      const next = r.status === "void"
        ? cur
        : cur + Math.round(Number(r.netAmount || 0) * 100);
      running.set(r.bankAccountId, next);
      const liveVendorName = r.vendorId
        ? vendorNameById.get(r.vendorId)
        : undefined;
      const depositor = r.depositedByUserId
        ? depositorById.get(r.depositedByUserId)
        : undefined;
      const depositedByName = depositor
        ? depositor.firstName && depositor.lastName
          ? `${depositor.firstName} ${depositor.lastName}`
          : depositor.username
        : null;
      const splitGroups = splitGroupsByAggregate.get(r.id);
      return {
        ...r,
        payee: liveVendorName ?? r.payee,
        runningBalance: (next / 100).toFixed(2),
        invoices: aggregateInvoiceLinks.get(r.id) ?? linksByTxn.get(r.id) ?? [],
        ...doctorAttributionFromLinks(
          aggregateInvoiceLinks.get(r.id) ?? linksByTxn.get(r.id) ?? [],
        ),
        depositedByName,
        ...(r.source === "deposit_batch"
          ? { isAggregateDeposit: true, splitGroups: splitGroups ?? [] }
          : {}),
      };
    });
    enriched.reverse();
    return ok(
      res,
      pagination.active
        ? pageRowsKeyset(enriched, pagination, bankTransactionKeyset)
        : enriched,
    );
  })
);

// Read-only audit history for Make Deposits batches. This deliberately has its
// own query and endpoint: released child payments must remain visible here
// without changing register balance, filtering, or export semantics.
router.get(
  "/deposit-batches",
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query);
    const { organizationId } = orgIdQuery.parse(req.query);
    await requireAnyRole(uid(req), organizationId, ADMIN_ROLES);

    const parentWhere = and(
      eq(bankTransactions.labOrganizationId, organizationId),
      eq(bankTransactions.source, "deposit_batch"),
    );
    const [{ count: parentCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bankTransactions)
      .where(parentWhere);
    const parentQuery = db
      .select()
      .from(bankTransactions)
      .orderBy(desc(bankTransactions.txnDate), desc(bankTransactions.createdAt), desc(bankTransactions.id));
    const parents = await (pagination.active
      ? parentQuery.where(parentWhere).limit(pagination.limit).offset(pagination.offset)
      : parentQuery.where(parentWhere));
    const parentIds = parents.map((row) => row.id);
    const members = parentIds.length
      ? await db.select().from(bankDepositBatchMembers)
        .where(inArray(bankDepositBatchMembers.aggregateBankTransactionId, parentIds))
      : [];
    const childIds = members.map((member) => member.childBankTransactionId);
    const children = childIds.length
      ? await db.select().from(bankTransactions).where(and(
        inArray(bankTransactions.id, childIds),
        eq(bankTransactions.labOrganizationId, organizationId),
      ))
      : [];
    const childById = new Map(children.map((child) => [child.id, child]));
    const links = childIds.length
      ? await db.select({
        bankTransactionId: bankTransactionInvoices.bankTransactionId,
        invoiceId: bankTransactionInvoices.invoiceId,
        invoiceNumber: invoices.invoiceNumber,
      }).from(bankTransactionInvoices)
        .innerJoin(invoices, eq(invoices.id, bankTransactionInvoices.invoiceId))
        .where(and(
          inArray(bankTransactionInvoices.bankTransactionId, childIds),
          eq(invoices.labOrganizationId, organizationId),
        ))
      : [];
    const linksByChild = new Map<string, Array<{ invoiceId: string; invoiceNumber: string }>>();
    for (const link of links) {
      const list = linksByChild.get(link.bankTransactionId) ?? [];
      list.push({ invoiceId: link.invoiceId, invoiceNumber: link.invoiceNumber });
      linksByChild.set(link.bankTransactionId, list);
    }
    const sessions = childIds.length
      ? await db.select().from(statementPaymentSessions)
        .where(and(
          inArray(statementPaymentSessions.bankTransactionId, childIds),
          eq(statementPaymentSessions.labOrganizationId, organizationId),
        ))
      : [];
    const sessionByChild = new Map(sessions.map((session) => [session.bankTransactionId, session]));
    const membersByParent = new Map<string, typeof members>();
    for (const member of members) {
      const list = membersByParent.get(member.aggregateBankTransactionId) ?? [];
      list.push(member);
      membersByParent.set(member.aggregateBankTransactionId, list);
    }
    const rows = parents.map((parent) => {
      const batchMembers = (membersByParent.get(parent.id) ?? [])
        .map((member) => {
          const child = childById.get(member.childBankTransactionId);
          const session = child ? sessionByChild.get(child.id) : undefined;
          const released = Boolean(member.releasedAt);
          const auditedMember = member as typeof member & {
            snapshot?: unknown;
            releaseOutcome?: string | null;
          };
          const snapshot = (auditedMember.snapshot ?? {}) as {
            amount?: string; payee?: string | null; memo?: string | null;
            checkNumber?: string | null; paymentMethod?: string | null;
            receiptNumber?: string | null; paymentSessionId?: string | null;
            invoiceLinks?: Array<{ invoiceId: string; invoiceNumber: string }>;
            legacyUnverified?: boolean;
          };
          const hasSnapshot = Object.prototype.hasOwnProperty.call(snapshot, "amount");
          const legacyUnverified = snapshot.legacyUnverified === true;
          const correctionState = !released ? "active" : auditedMember.releaseOutcome ?? "unknown";
          return {
            childTransactionId: member.childBankTransactionId,
            amount: hasSnapshot ? (snapshot.amount as string) : child?.netAmount ?? "0.00",
            payee: hasSnapshot ? snapshot.payee : child?.payee ?? null,
            memo: hasSnapshot ? snapshot.memo : child?.memo ?? null,
            checkNumber: hasSnapshot ? snapshot.checkNumber : session?.checkNumber ?? child?.checkNumber ?? null,
            paymentMethod: hasSnapshot ? snapshot.paymentMethod : session?.paymentMethod ?? null,
            receiptNumber: hasSnapshot ? snapshot.receiptNumber : session?.receiptNumber ?? null,
            paymentSessionId: hasSnapshot ? snapshot.paymentSessionId : session?.id ?? null,
            invoiceLinks: hasSnapshot ? snapshot.invoiceLinks ?? [] : linksByChild.get(member.childBankTransactionId) ?? [],
            releasedAt: member.releasedAt,
            childStatus: child?.status ?? null,
            correctionState,
            auditQuality: legacyUnverified ? "legacy_unverified" : "verified",
          };
        });
      const releasedMembers = batchMembers.filter((member) => member.releasedAt);
      return {
        id: parent.id,
        organizationId,
        bankAccountId: parent.bankAccountId,
        createdAt: parent.createdAt,
        txnDate: parent.txnDate,
        status: parent.status,
        originalTotal: parent.netAmount,
        releasedAt: releasedMembers.length
          ? releasedMembers.reduce((latest, member) =>
            !latest || (member.releasedAt && member.releasedAt > latest) ? member.releasedAt : latest,
            null as Date | null)
          : null,
        correctionState: releasedMembers.length
          ? batchMembers.some((member) => member.correctionState === "unknown")
            ? "unknown"
            : batchMembers.some((member) => member.correctionState === "corrected")
              ? "corrected"
              : "restored"
          : "active",
        auditQuality: batchMembers.some((member) => member.auditQuality === "legacy_unverified")
          ? "legacy_unverified"
          : "verified",
        members: batchMembers,
      };
    });
    return ok(res, pagination.active ? {
      rows,
      total: parentCount,
      limit: pagination.limit,
      offset: pagination.offset,
      hasMore: pagination.offset + rows.length < parentCount,
    } : rows);
  }),
);

const txnSchema = z.object({
  bankAccountId: z.string().min(1),
  txnDate: z.string().min(1),
  type: z
    .enum(["check", "deposit", "withdraw", "transfer", "fee", "payment", "other"])
    .default("other"),
  checkNumber: z.string().nullable().optional(),
  payee: z.string().nullable().optional(),
  vendorId: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  payment: z.coerce.number().min(0).default(0),
  deposit: z.coerce.number().min(0).default(0),
  cleared: z.boolean().optional(),
  reconciled: z.boolean().optional(),
  status: z.enum(["posted", "projected", "void"]).default("posted"),
  invoiceIds: z.array(z.string().min(1)).optional(),
});

async function assertVendorBelongsToOrg(
  vendorId: string,
  labOrganizationId: string
) {
  const vendor = await db.query.vendors.findFirst({
    where: eq(vendors.id, vendorId),
    columns: { id: true, labOrganizationId: true, deletedAt: true },
  });
  if (
    !vendor ||
    vendor.deletedAt ||
    vendor.labOrganizationId !== labOrganizationId
  ) {
    throw new HttpError(
      400,
      "Vendor not found or does not belong to this organization."
    );
  }
}

async function syncTxnInvoiceLinks(
  txnId: string,
  labOrganizationId: string,
  invoiceIds: string[] | undefined
) {
  if (!invoiceIds) return;
  const unique = Array.from(new Set(invoiceIds));
  if (unique.length) {
    const found = await db.query.invoices.findMany({
      where: inArray(invoices.id, unique),
    });
    if (found.length !== unique.length) {
      throw new HttpError(400, "One or more invoices were not found.");
    }
    for (const inv of found) {
      assertRecoveryReleased(inv);
      if (inv.labOrganizationId !== labOrganizationId) {
        throw new HttpError(
          400,
          "Invoices must belong to the same lab as the transaction."
        );
      }
    }
  }
  await db
    .delete(bankTransactionInvoices)
    .where(eq(bankTransactionInvoices.bankTransactionId, txnId));
  if (unique.length) {
    await db
      .insert(bankTransactionInvoices)
      .values(
        unique.map((invoiceId) => ({ bankTransactionId: txnId, invoiceId }))
      )
      .onConflictDoNothing();
  }
}

async function computeDepositMismatchWarning(
  txnId: string,
  depositAmount: number
): Promise<string | null> {
  const links = await db.query.bankTransactionInvoices.findMany({
    where: eq(bankTransactionInvoices.bankTransactionId, txnId),
  });
  if (!links.length) return null;
  const invIds = links.map((l) => l.invoiceId);
  const found = await db.query.invoices.findMany({
    where: inArray(invoices.id, invIds),
    columns: { id: true, balanceDue: true, invoiceNumber: true },
  });
  if (!found.length) return null;
  const invoiceTotal = found.reduce(
    (sum, inv) => sum + Number(inv.balanceDue ?? 0),
    0
  );
  const delta = Math.abs(depositAmount - invoiceTotal);
  if (delta < 0.01) return null;
  return (
    `Deposit $${depositAmount.toFixed(2)} does not match linked invoice total ` +
    `$${invoiceTotal.toFixed(2)} (Δ$${delta.toFixed(2)}).`
  );
}

router.post(
  "/transactions",
  asyncHandler(async (req, res) => {
    const input = txnSchema.parse(req.body);
    const acct = await loadAccountOrThrow(uid(req), input.bankAccountId);
    await requireAnyRole(uid(req), acct.labOrganizationId, BILLING_ROLES);
    if (acct.accountType === "undeposited_funds") {
      throw new HttpError(400, "Undeposited Funds entries are created through Receive Payments, not manual register entries.");
    }
    if (input.vendorId) {
      await assertVendorBelongsToOrg(input.vendorId, acct.labOrganizationId);
    }
    const debit = Number(input.payment || 0);
    const credit = Number(input.deposit || 0);
    const net = credit - debit;
    const cleared = input.cleared ?? false;

    // Uncategorized check/payment debits used to be auto-filed under the
    // legacy "Accounts Payable" expense category. Accounts payable is now a
    // real liability tracked by the bill subledger, so stamping a cash expense
    // with that label misstates both the expense and the liability. New
    // register entries stay uncategorized until someone categorizes them;
    // existing rows keep whatever category they already carry.
    const resolvedCategoryId: string | null = input.categoryId || null;

    const [row] = await db
      .insert(bankTransactions)
      .values({
        labOrganizationId: acct.labOrganizationId,
        bankAccountId: acct.id,
        txnDate: new Date(input.txnDate),
        type: input.type,
        checkNumber: input.checkNumber || null,
        payee: input.payee || null,
        vendorId: input.vendorId || null,
        memo: input.memo || null,
        categoryId: resolvedCategoryId,
        debitAmount: debit.toFixed(2),
        creditAmount: credit.toFixed(2),
        netAmount: net.toFixed(2),
        cleared,
        clearedAt: cleared ? new Date() : null,
        status: input.status,
        source: "manual",
        createdByUserId: uid(req),
      })
      .returning();
    if (input.status === "posted" && net !== 0) {
      await replaceMatchingProjected(
        acct.id,
        new Date(input.txnDate),
        net,
        input.payee || null
      );
    }
    await syncTxnInvoiceLinks(row.id, acct.labOrganizationId, input.invoiceIds);
    const depositInvoiceMismatchWarning = input.invoiceIds?.length
      ? await computeDepositMismatchWarning(row.id, credit)
      : null;
    return res.status(201).json({ ok: true, data: { ...row, depositInvoiceMismatchWarning } });
  })
);

router.patch(
  "/transactions/:id",
  asyncHandler(async (req, res) => {
    const txn = await db.query.bankTransactions.findFirst({
      where: eq(bankTransactions.id, String(req.params.id)),
    });
    if (!txn) throw new HttpError(404, "Transaction not found.");
    await requireAnyRole(uid(req), txn.labOrganizationId, BILLING_ROLES);
    const input = txnSchema.partial().parse(req.body);
    const aggregateMemberships = await db.query.bankDepositBatchMembers.findMany({
      where: eq(bankDepositBatchMembers.aggregateBankTransactionId, txn.id),
    });
    const childMembership = await db.query.bankDepositBatchMembers.findFirst({
      where: and(
        eq(bankDepositBatchMembers.childBankTransactionId, txn.id),
        isNull(bankDepositBatchMembers.releasedAt),
      ),
    });
    if (txn.source === "deposit_batch") {
      const forbidden = ["bankAccountId", "txnDate", "type", "payment", "deposit",
        "categoryId", "status", "payee", "memo", "checkNumber", "vendorId"];
      if (forbidden.some((key) => Object.prototype.hasOwnProperty.call(req.body, key))) {
        throw new HttpError(409, "Aggregate deposit accounting fields cannot be edited.");
      }
    }
    if (childMembership || txn.status === "deposited_child") {
      throw new HttpError(409, "Deposited payment children cannot be edited independently.");
    }
    const isClearingStatusOnly =
      Object.keys(req.body as object).every((k) => k === "cleared" || k === "reconciled");
    if (txn.source === "customer_payment" && !isClearingStatusOnly) {
      throw new HttpError(
        409,
        "Statement payment transactions must be changed through their payment session.",
      );
    }
    // A bill payment's bank entry is owned by its vendor payment. Editing it
    // here would desynchronize the bill allocations from the cash that settled
    // them; clearing/reconciling it is still allowed.
    if (!isClearingStatusOnly) {
      assertNotBillPaymentTransaction(txn, "edit");
    }
    if (txn.reconciled && !isClearingStatusOnly) {
      throw new HttpError(400, "Reconciled entries cannot be edited.");
    }
    if (input.vendorId) {
      await assertVendorBelongsToOrg(input.vendorId, txn.labOrganizationId);
    }
    const updates: any = { updatedAt: new Date() };
    if (input.txnDate) updates.txnDate = new Date(input.txnDate);
    if (input.type) updates.type = input.type;
    if (input.checkNumber !== undefined) updates.checkNumber = input.checkNumber;
    if (input.payee !== undefined) updates.payee = input.payee;
    if (input.vendorId !== undefined) updates.vendorId = input.vendorId;
    if (input.memo !== undefined) updates.memo = input.memo;
    if (input.categoryId !== undefined) updates.categoryId = input.categoryId;
    if (input.status) updates.status = input.status;
    if (input.payment !== undefined || input.deposit !== undefined) {
      const debit = Number(input.payment ?? Number(txn.debitAmount));
      const credit = Number(input.deposit ?? Number(txn.creditAmount));
      updates.debitAmount = debit.toFixed(2);
      updates.creditAmount = credit.toFixed(2);
      updates.netAmount = (credit - debit).toFixed(2);
    }
    if (input.cleared !== undefined) {
      updates.cleared = input.cleared;
      updates.clearedAt = input.cleared ? new Date() : null;
    }
    if (input.reconciled !== undefined) {
      updates.reconciled = input.reconciled;
      if (input.reconciled) {
        updates.cleared = true;
        updates.clearedAt = txn.clearedAt ?? new Date();
      }
    }
    const row = await db.transaction(async (tx) => {
      if (txn.source === "deposit_batch") {
        await lockDepositBatchMutations(tx, txn.labOrganizationId);
      }
      const [locked] = await tx.select().from(bankTransactions)
        .where(eq(bankTransactions.id, txn.id)).for("update");
      if (!locked) throw new HttpError(404, "Transaction not found.");
      if (locked.source === "customer_payment") {
        await assertNoActiveCardReversalForTransactions(tx, [locked.id]);
      }
      const [updated] = await tx.update(bankTransactions).set(updates)
        .where(eq(bankTransactions.id, locked.id)).returning();
      return updated;
    });
    await syncTxnInvoiceLinks(
      row.id,
      row.labOrganizationId,
      input.invoiceIds
    );
    const depositCredit =
      input.deposit !== undefined
        ? Number(input.deposit)
        : Number(row.creditAmount);
    const depositInvoiceMismatchWarning = input.invoiceIds?.length
      ? await computeDepositMismatchWarning(row.id, depositCredit)
      : null;
    return res.json({ ok: true, data: { ...row, depositInvoiceMismatchWarning } });
  })
);

router.post(
  "/transactions/:id/clear",
  asyncHandler(async (req, res) => {
    const txn = await db.query.bankTransactions.findFirst({
      where: eq(bankTransactions.id, String(req.params.id)),
    });
    if (!txn) throw new HttpError(404, "Transaction not found.");
    await requireAnyRole(uid(req), txn.labOrganizationId, BILLING_ROLES);
    const cleared = z.object({ cleared: z.boolean() }).parse(req.body).cleared;
    if (await db.query.bankDepositBatchMembers.findFirst({
      where: and(
        eq(bankDepositBatchMembers.childBankTransactionId, txn.id),
        isNull(bankDepositBatchMembers.releasedAt),
      ),
    })) {
      throw new HttpError(409, "Deposited payment children cannot be changed independently.");
    }
    const [row] = await db
      .update(bankTransactions)
      .set({ cleared, clearedAt: cleared ? new Date() : null, updatedAt: new Date() })
      .where(eq(bankTransactions.id, txn.id))
      .returning();
    return ok(res, row);
  })
);

router.post(
  "/transactions/:id/void",
  asyncHandler(async (req, res) => {
    const txn = await db.query.bankTransactions.findFirst({
      where: eq(bankTransactions.id, String(req.params.id)),
    });
    if (!txn) throw new HttpError(404, "Transaction not found.");
    await requireAnyRole(uid(req), txn.labOrganizationId, BILLING_ROLES);
    if (txn.reconciled) throw new HttpError(400, "Reconciled entries cannot be voided.");
    if (txn.source === "customer_payment") {
      throw new HttpError(
        409,
        "Statement payment transactions must be cancelled through their payment session.",
      );
    }
    assertNotBillPaymentTransaction(txn, "delete");
    if (txn.source === "deposit_batch") {
      await db.transaction(async (tx) => {
        await releaseDepositBatch(tx, txn.labOrganizationId, txn.id);
      });
      return ok(res, { ...txn, status: "void" });
    }
    if (txn.status === "deposited_child") {
      throw new HttpError(409, "Deposited payment children cannot be voided independently.");
    }

    if (txn.transferGroupId) {
      const sibling = await db.query.bankTransactions.findFirst({
        where: and(
          eq(bankTransactions.transferGroupId, txn.transferGroupId),
          ne(bankTransactions.id, txn.id),
          isNull(bankTransactions.deletedAt),
        ),
      });
      if (sibling) {
        if (sibling.reconciled)
          throw new HttpError(400, "The linked transfer entry is reconciled and cannot be voided.");
        const [row] = await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(bankTransactions)
            .set({ status: "void", updatedAt: new Date() })
            .where(eq(bankTransactions.id, txn.id))
            .returning();
          await tx
            .update(bankTransactions)
            .set({ status: "void", updatedAt: new Date() })
            .where(eq(bankTransactions.id, sibling.id));
          return [updated];
        });
        return ok(res, row);
      }
    }

    const [row] = await db
      .update(bankTransactions)
      .set({ status: "void", updatedAt: new Date() })
      .where(eq(bankTransactions.id, txn.id))
      .returning();
    return ok(res, row);
  })
);

router.delete(
  "/transactions/:id",
  asyncHandler(async (req, res) => {
    const txn = await db.query.bankTransactions.findFirst({
      where: eq(bankTransactions.id, String(req.params.id)),
    });
    if (!txn) throw new HttpError(404, "Transaction not found.");
    await requireAnyRole(uid(req), txn.labOrganizationId, ADMIN_ROLES);
    if (txn.reconciled)
      throw new HttpError(400, "Reconciled entries cannot be deleted.");
    if (txn.source === "customer_payment") {
      throw new HttpError(
        409,
        "Statement payment transactions must be cancelled through their payment session.",
      );
    }
    assertNotBillPaymentTransaction(txn, "delete");
    if (txn.source === "deposit_batch" || txn.status === "deposited_child") {
      throw new HttpError(409, "Deposit batches and deposited payment children cannot be deleted.");
    }

    if (txn.transferGroupId) {
      const sibling = await db.query.bankTransactions.findFirst({
        where: and(
          eq(bankTransactions.transferGroupId, txn.transferGroupId),
          ne(bankTransactions.id, txn.id),
          isNull(bankTransactions.deletedAt),
        ),
      });
      if (sibling) {
        if (sibling.reconciled)
          throw new HttpError(400, "The linked transfer entry is reconciled and cannot be deleted.");
        const now = new Date();
        const actorId = uid(req);
        // Atomically soft-delete both entries in one transaction.
        // Re-validate reconciled state inside the transaction to close any
        // race window between the pre-check and the actual update.
        await db.transaction(async (tx) => {
          // Lock both rows so concurrent requests can't race past the checks.
          const locked = await tx
            .select({
              id: bankTransactions.id,
              reconciled: bankTransactions.reconciled,
              deletedAt: bankTransactions.deletedAt,
            })
            .from(bankTransactions)
            .where(
              and(
                eq(bankTransactions.transferGroupId, txn.transferGroupId!),
                isNull(bankTransactions.deletedAt),
              )
            )
            .for("update");
          for (const row of locked) {
            if (row.reconciled)
              throw new HttpError(400, "A transfer entry is reconciled and cannot be deleted.");
          }
          await tx
            .update(bankTransactions)
            .set({ deletedAt: now, deletedByUserId: actorId })
            .where(
              and(
                eq(bankTransactions.transferGroupId, txn.transferGroupId!),
                isNull(bankTransactions.deletedAt),
              )
            );
        });
        // Write audit logs outside the transaction (non-critical to atomicity).
        await writeAuditLog({
          req,
          userId: actorId,
          organizationId: txn.labOrganizationId,
          action: "bank_transaction_soft_deleted",
          entityType: "bank_transaction",
          entityId: txn.id,
          beforeJson: txn,
          metadataJson: { rowsAffected: 1, transferGroupId: txn.transferGroupId, pairedWith: sibling.id },
        });
        await writeAuditLog({
          req,
          userId: actorId,
          organizationId: sibling.labOrganizationId,
          action: "bank_transaction_soft_deleted",
          entityType: "bank_transaction",
          entityId: sibling.id,
          beforeJson: sibling,
          metadataJson: { rowsAffected: 1, transferGroupId: sibling.transferGroupId, pairedWith: txn.id },
        });
        return ok(res, { deleted: true });
      }
    }

    await softDeleteById({
      table: bankTransactions,
      id: txn.id,
      actorUserId: uid(req),
      req,
      organizationId: txn.labOrganizationId,
      entityType: "bank_transaction",
      beforeJson: txn,
    });
    return ok(res, { deleted: true });
  })
);

// ─────────────────────────────── Transfers ───────────────────────────────

const transferSchema = z.object({
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  amount: z.coerce.number().positive(),
  txnDate: z.string().min(1),
  memo: z.string().nullable().optional(),
});

router.post(
  "/transactions/transfer",
  asyncHandler(async (req, res) => {
    const input = transferSchema.parse(req.body);
    if (input.fromAccountId === input.toAccountId) {
      throw new HttpError(400, "From and to accounts must differ.");
    }
    const fromAcct = await loadAccountOrThrow(uid(req), input.fromAccountId);
    const toAcct = await loadAccountOrThrow(uid(req), input.toAccountId);
    if (fromAcct.labOrganizationId !== toAcct.labOrganizationId) {
      throw new HttpError(400, "Both accounts must belong to the same organization.");
    }
    await requireAnyRole(uid(req), fromAcct.labOrganizationId, BILLING_ROLES);
    const amount = Number(input.amount);
    const txnDate = new Date(input.txnDate);
    const groupId = `xfer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const memo = input.memo || null;
    const userId = uid(req);
    const rows = await db.transaction(async (tx) => {
      const [outRow] = await tx
        .insert(bankTransactions)
        .values({
          labOrganizationId: fromAcct.labOrganizationId,
          bankAccountId: fromAcct.id,
          txnDate,
          type: "transfer",
          payee: `Transfer to ${toAcct.name}`,
          memo,
          debitAmount: amount.toFixed(2),
          creditAmount: "0.00",
          netAmount: (-amount).toFixed(2),
          source: "transfer",
          transferGroupId: groupId,
          createdByUserId: userId,
        })
        .returning();
      const [inRow] = await tx
        .insert(bankTransactions)
        .values({
          labOrganizationId: toAcct.labOrganizationId,
          bankAccountId: toAcct.id,
          txnDate,
          type: "transfer",
          payee: `Transfer from ${fromAcct.name}`,
          memo,
          debitAmount: "0.00",
          creditAmount: amount.toFixed(2),
          netAmount: amount.toFixed(2),
          source: "transfer",
          transferGroupId: groupId,
          createdByUserId: userId,
        })
        .returning();
      return { outRow, inRow };
    });
    return ok(res, { transferGroupId: groupId, ...rows }, 201);
  })
);

const editTransferSchema = z.object({
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  amount: z.coerce.number().positive(),
  txnDate: z.string().min(1),
  memo: z.string().nullable().optional(),
});

router.patch(
  "/transactions/transfer/:transferGroupId",
  asyncHandler(async (req, res) => {
    const { transferGroupId } = req.params as { transferGroupId: string };
    const rows = await db.query.bankTransactions.findMany({
      where: eq(bankTransactions.transferGroupId, transferGroupId),
    });
    if (rows.length !== 2) throw new HttpError(404, "Transfer not found.");
    const orgId = rows[0].labOrganizationId;
    if (rows.some((r) => r.labOrganizationId !== orgId)) {
      throw new HttpError(400, "Transfer entries span multiple organizations.");
    }
    await requireAnyRole(uid(req), orgId, BILLING_ROLES);
    if (rows.some((r) => r.reconciled)) {
      throw new HttpError(400, "Cannot edit a transfer when either entry is reconciled.");
    }
    const input = editTransferSchema.parse(req.body);
    if (input.fromAccountId === input.toAccountId) {
      throw new HttpError(400, "From and to accounts must differ.");
    }
    const fromAcct = await loadAccountOrThrow(uid(req), input.fromAccountId);
    const toAcct = await loadAccountOrThrow(uid(req), input.toAccountId);
    if (fromAcct.labOrganizationId !== orgId || toAcct.labOrganizationId !== orgId) {
      throw new HttpError(400, "Both accounts must belong to the same organization.");
    }
    const amount = Number(input.amount);
    const txnDate = new Date(input.txnDate);
    const memo = input.memo ?? null;
    const outRow = rows.find((r) => Number(r.debitAmount) > 0) ?? rows[0];
    const inRow = rows.find((r) => r.id !== outRow.id) ?? rows[1];
    const updated = await db.transaction(async (tx) => {
      const [updatedOut] = await tx
        .update(bankTransactions)
        .set({
          bankAccountId: fromAcct.id,
          txnDate,
          payee: `Transfer to ${toAcct.name}`,
          memo,
          debitAmount: amount.toFixed(2),
          creditAmount: "0.00",
          netAmount: (-amount).toFixed(2),
          updatedAt: new Date(),
        })
        .where(eq(bankTransactions.id, outRow.id))
        .returning();
      const [updatedIn] = await tx
        .update(bankTransactions)
        .set({
          bankAccountId: toAcct.id,
          txnDate,
          payee: `Transfer from ${fromAcct.name}`,
          memo,
          debitAmount: "0.00",
          creditAmount: amount.toFixed(2),
          netAmount: amount.toFixed(2),
          updatedAt: new Date(),
        })
        .where(eq(bankTransactions.id, inRow.id))
        .returning();
      return { outRow: updatedOut, inRow: updatedIn };
    });
    return ok(res, updated);
  })
);

// ─────────────────────────── CSV Import & Matching ───────────────────────

const importSchema = z.object({
  bankAccountId: z.string().min(1),
  windowDays: z.coerce.number().int().min(0).max(30).default(5),
  rows: z
    .array(
      z.object({
        date: z.string().min(1),
        payee: z.string().optional().nullable(),
        memo: z.string().optional().nullable(),
        amount: z.coerce.number(),
        checkNumber: z.string().optional().nullable(),
      })
    )
    .min(1),
});

function similarity(a: string, b: string): number {
  const x = (a || "").toLowerCase().trim();
  const y = (b || "").toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const tokensX = new Set(x.split(/\s+/).filter(Boolean));
  const tokensY = new Set(y.split(/\s+/).filter(Boolean));
  let inter = 0;
  for (const t of tokensX) if (tokensY.has(t)) inter += 1;
  const denom = Math.max(tokensX.size, tokensY.size);
  return denom ? inter / denom : 0;
}

router.post(
  "/transactions/import",
  asyncHandler(async (req, res) => {
    const input = importSchema.parse(req.body);
    const acct = await loadAccountOrThrow(uid(req), input.bankAccountId);
    await requireAnyRole(uid(req), acct.labOrganizationId, BILLING_ROLES);
    const batchId = `import-${Date.now()}`;
    const candidates = await db.query.bankTransactions.findMany({
      where: and(
        eq(bankTransactions.bankAccountId, acct.id),
        eq(bankTransactions.cleared, false),
        eq(bankTransactions.status, "posted")
      ),
    });
    const usedIds = new Set<string>();
    let matched = 0;
    let created = 0;
    for (const r of input.rows) {
      const rowDate = new Date(r.date);
      const rowAmount = Number(r.amount);
      const direction = rowAmount >= 0 ? 1 : -1;
      const target = Number(rowAmount.toFixed(2));
      const candidate = candidates.find((c: any) => {
        if (usedIds.has(c.id)) return false;
        const net = Number(c.netAmount);
        if (Math.sign(net) !== direction && net !== 0) return false;
        if (Math.abs(net - target) > 0.005) return false;
        const days = Math.abs(
          (new Date(c.txnDate).getTime() - rowDate.getTime()) /
            (1000 * 60 * 60 * 24)
        );
        if (days > input.windowDays) return false;
        const sim = similarity(c.payee || "", r.payee || "");
        return sim >= 0.4 || !r.payee || !c.payee;
      });
      if (candidate) {
        usedIds.add(candidate.id);
        await db
          .update(bankTransactions)
          .set({
            cleared: true,
            clearedAt: new Date(),
            importBatchId: batchId,
            updatedAt: new Date(),
          })
          .where(eq(bankTransactions.id, candidate.id));
        matched += 1;
      } else {
        const debit = rowAmount < 0 ? Math.abs(rowAmount) : 0;
        const credit = rowAmount > 0 ? rowAmount : 0;
        await db.insert(bankTransactions).values({
          labOrganizationId: acct.labOrganizationId,
          bankAccountId: acct.id,
          txnDate: rowDate,
          type: rowAmount >= 0 ? "deposit" : "withdraw",
          checkNumber: r.checkNumber || null,
          payee: r.payee || null,
          memo: r.memo || null,
          debitAmount: debit.toFixed(2),
          creditAmount: credit.toFixed(2),
          netAmount: rowAmount.toFixed(2),
          cleared: true,
          clearedAt: new Date(),
          source: "import",
          importBatchId: batchId,
          createdByUserId: uid(req),
        }).catch((err: unknown): never => wrapDbError(err));
        await replaceMatchingProjected(
          acct.id,
          rowDate,
          rowAmount,
          r.payee || null,
          input.windowDays
        );
        created += 1;
      }
    }
    return ok(res, { matched, created, batchId, total: input.rows.length });
  })
);

// ───────────────────────────── Reconciliation ────────────────────────────

const reconStartQuery = z.object({
  bankAccountId: z.string().min(1),
  statementDate: z.string().min(1),
});

router.get(
  "/reconciliation/candidates",
  asyncHandler(async (req, res) => {
    const q = reconStartQuery.parse(req.query);
    const acct = await loadAccountOrThrowBilling(uid(req), q.bankAccountId);
    const stmtDate = new Date(q.statementDate);
    const rows = await db.query.bankTransactions.findMany({
      where: and(
        eq(bankTransactions.bankAccountId, acct.id),
        eq(bankTransactions.reconciled, false),
        eq(bankTransactions.status, "posted"),
        lte(bankTransactions.txnDate, stmtDate)
      ),
      orderBy: [asc(bankTransactions.txnDate)],
    });
    const startingRows = await db
      .select({
        v: sql<string>`COALESCE(SUM(${bankTransactions.netAmount}), 0)::text`,
      })
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.bankAccountId, acct.id),
          eq(bankTransactions.reconciled, true),
          eq(bankTransactions.status, "posted")
        )
      );
    const startingBalance = startingRows[0]?.v ?? "0.00";
    return ok(res, { startingBalance, candidates: rows });
  })
);

const finishReconciliationSchema = z.object({
  bankAccountId: z.string().min(1),
  statementDate: z.string().min(1),
  endingBalance: z.coerce.number(),
  transactionIds: z.array(z.string().min(1)),
});

router.post(
  "/reconciliation/finish",
  asyncHandler(async (req, res) => {
    const input = finishReconciliationSchema.parse(req.body);
    const acct = await loadAccountOrThrow(uid(req), input.bankAccountId);
    await requireAnyRole(uid(req), acct.labOrganizationId, BILLING_ROLES);

    const startingRows = await db
      .select({
        v: sql<string>`COALESCE(SUM(${bankTransactions.netAmount}), 0)::text`,
      })
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.bankAccountId, acct.id),
          eq(bankTransactions.reconciled, true),
          eq(bankTransactions.status, "posted")
        )
      );
    const startingBalance = Number(startingRows[0]?.v ?? 0);

    const stmtDate = new Date(input.statementDate);
    const items = input.transactionIds.length
      ? await db.query.bankTransactions.findMany({
          where: and(
            eq(bankTransactions.bankAccountId, acct.id),
            inArray(bankTransactions.id, input.transactionIds),
            eq(bankTransactions.reconciled, false),
            eq(bankTransactions.status, "posted"),
            lte(bankTransactions.txnDate, stmtDate)
          ),
        })
      : [];
    if (items.length !== input.transactionIds.length) {
      throw new HttpError(
        400,
        "One or more selected entries are no longer eligible (already reconciled, voided, or dated after the statement date)."
      );
    }
    const cleared = items.reduce((s: number, r: any) => s + Number(r.netAmount), 0);
    const expected = Number(input.endingBalance);
    const difference = +(startingBalance + cleared - expected).toFixed(2);
    if (Math.abs(difference) > 0.005) {
      throw new HttpError(
        400,
        `Cannot finish: difference must be zero (current ${difference.toFixed(2)}).`
      );
    }

    const recon = await db.transaction(async (tx) => {
      await lockDepositBatchMutations(tx, acct.labOrganizationId);
      const verify = input.transactionIds.length
        ? await tx.select().from(bankTransactions).where(and(
              eq(bankTransactions.bankAccountId, acct.id),
              inArray(bankTransactions.id, input.transactionIds),
              eq(bankTransactions.reconciled, false),
              eq(bankTransactions.status, "posted"),
              lte(bankTransactions.txnDate, stmtDate)
            )).for("update")
        : [];
      if (verify.length !== input.transactionIds.length) {
        throw new HttpError(
          409,
          "Selected entries changed during finalize; please reload and retry."
        );
      }
      await assertNoActiveCardReversalForTransactions(
        tx,
        verify.filter((item: any) => item.source === "customer_payment").map((item: any) => item.id),
      );
      const [r] = await tx
        .insert(reconciliations)
        .values({
          labOrganizationId: acct.labOrganizationId,
          bankAccountId: acct.id,
          statementDate: stmtDate,
          startingBalance: startingBalance.toFixed(2),
          endingBalance: expected.toFixed(2),
          clearedTotal: cleared.toFixed(2),
          difference: "0.00",
          status: "completed",
          completedAt: new Date(),
          createdByUserId: uid(req),
        })
        .returning();
      if (verify.length) {
        await tx.insert(reconciliationItems).values(
          verify.map((it: any) => ({
            reconciliationId: r.id,
            transactionId: it.id,
            amount: it.netAmount,
          }))
        );
        await tx
          .update(bankTransactions)
          .set({
            reconciled: true,
            cleared: true,
            clearedAt: new Date(),
            reconciliationId: r.id,
            updatedAt: new Date(),
          })
          .where(inArray(bankTransactions.id, verify.map((it: any) => it.id)));
      }
      return r;
    });

    return ok(res, recon, 201);
  })
);

router.get(
  "/reconciliation/history",
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query);
    const q = z
      .object({
        bankAccountId: z.string().optional(),
        organizationId: z.string().optional(),
      })
      .parse(req.query);
    let conds: any[] = [];
    if (q.bankAccountId) {
      const acct = await loadAccountOrThrowBilling(uid(req), q.bankAccountId);
      conds.push(eq(reconciliations.bankAccountId, acct.id));
    } else if (q.organizationId) {
      await requireAnyRole(uid(req), q.organizationId, BILLING_ROLES);
      conds.push(eq(reconciliations.labOrganizationId, q.organizationId));
    } else {
      const ids = await activeBillingLabIds(uid(req));
      if (!ids.length) {
         return ok(res, pagination.active ? { ...pageRows([], pagination), nextCursor: null } : []);
       }
      conds.push(inArray(reconciliations.labOrganizationId, ids));
    }
    const rows = await db
      .select()
      .from(reconciliations)
      .where(and(...conds))
      .orderBy(desc(reconciliations.statementDate), desc(reconciliations.id));
    return ok(
      res,
      pagination.active
        ? pageRowsKeyset(rows, pagination, {
            sortValues: (row) => [sortTime(row.statementDate)],
            id: (row) => String(row.id),
            directions: ["desc"],
            idDirection: "desc",
          })
        : rows,
    );
  })
);

// ─────────────────────────── Recurring Transactions ──────────────────────

router.get(
  "/recurring",
  asyncHandler(async (req, res) => {
    const { organizationId } = orgIdQuery.parse(req.query);
    await requireAnyRole(uid(req), organizationId, BILLING_ROLES);
    const rows = await db.query.recurringTransactions.findMany({
      where: eq(recurringTransactions.labOrganizationId, organizationId),
      orderBy: [asc(recurringTransactions.name)],
    });
    const vendorIds = Array.from(
      new Set(rows.map((r) => r.vendorId).filter((v): v is string => !!v))
    );
    const vendorMap = new Map<
      string,
      { id: string; name: string; vendorType: string; vendorTypeId: string | null }
    >();
    if (vendorIds.length > 0) {
      const vendorRows = await db
        .select({
          id: vendors.id,
          name: vendors.name,
          vendorType: vendors.vendorType,
          vendorTypeId: vendors.vendorTypeId,
        })
        .from(vendors)
        .where(inArray(vendors.id, vendorIds));
      for (const v of vendorRows) vendorMap.set(v.id, v);
    }
    // Look up the per-lab type names for any vendors referenced here.
    const typesById = new Map<string, { id: string; name: string; builtinKind: string | null }>();
    const typeIds = Array.from(
      new Set(
        Array.from(vendorMap.values())
          .map((v) => v.vendorTypeId)
          .filter((id): id is string => !!id),
      ),
    );
    if (typeIds.length > 0) {
      const typeRows = await db
        .select({
          id: vendorTypes.id,
          name: vendorTypes.name,
          builtinKind: vendorTypes.builtinKind,
        })
        .from(vendorTypes)
        .where(inArray(vendorTypes.id, typeIds));
      for (const t of typeRows) typesById.set(t.id, t);
    }
    const enriched = rows.map((r) => {
      const v = r.vendorId ? vendorMap.get(r.vendorId) : null;
      const t = v?.vendorTypeId ? typesById.get(v.vendorTypeId) : null;
      return {
        ...r,
        vendorName: v?.name ?? null,
        vendorType: v?.vendorType ?? null,
        vendorTypeId: v?.vendorTypeId ?? null,
        vendorTypeName: t?.name ?? null,
      };
    });
    return ok(res, enriched);
  })
);

const recurringSchema = z.object({
  organizationId: z.string().min(1),
  bankAccountId: z.string().min(1),
  name: z.string().min(1),
  payee: z.string().nullable().optional(),
  vendorId: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  direction: z.enum(["debit", "credit"]),
  amount: z.coerce.number().nullable().optional(),
  estimateMethod: z.enum(["fixed", "avg_last_3"]).default("fixed"),
  frequency: z
    .enum(["weekly", "biweekly", "monthly", "quarterly", "annual"])
    .default("monthly"),
  dayOfMonth: z.coerce.number().int().min(1).max(31).default(1),
  startDate: z.string().min(1),
  endDate: z.string().nullable().optional(),
  autoCreate: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

router.post(
  "/recurring",
  asyncHandler(async (req, res) => {
    const input = recurringSchema.parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, BILLING_ROLES);
    const acct = await loadAccountOrThrow(uid(req), input.bankAccountId);
    if (acct.labOrganizationId !== input.organizationId)
      throw new HttpError(400, "Account does not belong to this organization.");
    if (input.vendorId) {
      const vendor = await db.query.vendors.findFirst({
        where: eq(vendors.id, input.vendorId),
        columns: { id: true, labOrganizationId: true, deletedAt: true },
      });
      if (!vendor || vendor.deletedAt || vendor.labOrganizationId !== input.organizationId)
        throw new HttpError(400, "Vendor not found or does not belong to this organization.");
    }
    const [row] = await db
      .insert(recurringTransactions)
      .values({
        labOrganizationId: input.organizationId,
        bankAccountId: input.bankAccountId,
        name: input.name,
        payee: input.payee || null,
        vendorId: input.vendorId || null,
        memo: input.memo || null,
        categoryId: input.categoryId || null,
        direction: input.direction,
        amount: input.amount != null ? Number(input.amount).toFixed(2) : null,
        estimateMethod: input.estimateMethod,
        frequency: input.frequency,
        dayOfMonth: input.dayOfMonth,
        startDate: new Date(input.startDate),
        endDate: input.endDate ? new Date(input.endDate) : null,
        autoCreate: input.autoCreate,
        isActive: input.isActive,
        createdByUserId: uid(req),
      })
      .returning();
    return ok(res, row, 201);
  })
);

router.get(
  "/recurring/:id",
  asyncHandler(async (req, res) => {
    const rule = await db.query.recurringTransactions.findFirst({
      where: eq(recurringTransactions.id, String(req.params.id)),
    });
    if (!rule) throw new HttpError(404, "Recurring rule not found.");
    await requireAnyRole(uid(req), rule.labOrganizationId, BILLING_ROLES);
    return ok(res, rule);
  })
);

router.patch(
  "/recurring/:id",
  asyncHandler(async (req, res) => {
    const rule = await db.query.recurringTransactions.findFirst({
      where: eq(recurringTransactions.id, String(req.params.id)),
    });
    if (!rule) throw new HttpError(404, "Recurring rule not found.");
    await requireAnyRole(uid(req), rule.labOrganizationId, BILLING_ROLES);
    const input = recurringSchema.partial().parse(req.body);
    if (input.vendorId) {
      const vendor = await db.query.vendors.findFirst({
        where: eq(vendors.id, input.vendorId),
        columns: { id: true, labOrganizationId: true, deletedAt: true },
      });
      if (!vendor || vendor.deletedAt || vendor.labOrganizationId !== rule.labOrganizationId)
        throw new HttpError(400, "Vendor not found or does not belong to this organization.");
    }
    const updates: any = { updatedAt: new Date() };
    for (const k of [
      "name",
      "payee",
      "vendorId",
      "memo",
      "categoryId",
      "direction",
      "estimateMethod",
      "frequency",
      "dayOfMonth",
      "autoCreate",
      "isActive",
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k];
    }
    if (input.amount !== undefined)
      updates.amount = input.amount == null ? null : Number(input.amount).toFixed(2);
    if (input.startDate) updates.startDate = new Date(input.startDate);
    if (input.endDate !== undefined)
      updates.endDate = input.endDate ? new Date(input.endDate) : null;
    const [row] = await db
      .update(recurringTransactions)
      .set(updates)
      .where(eq(recurringTransactions.id, rule.id))
      .returning();
    return ok(res, row);
  })
);

router.delete(
  "/recurring/:id",
  asyncHandler(async (req, res) => {
    const rule = await db.query.recurringTransactions.findFirst({
      where: eq(recurringTransactions.id, String(req.params.id)),
    });
    if (!rule) throw new HttpError(404, "Recurring rule not found.");
    await requireAnyRole(uid(req), rule.labOrganizationId, ADMIN_ROLES);
    await db
      .delete(recurringTransactions)
      .where(eq(recurringTransactions.id, rule.id));
    return ok(res, { deleted: true });
  })
);

function lastDayOfMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

function* iterateOccurrences(
  rule: any,
  fromDate: Date,
  toDate: Date
): Generator<Date> {
  const start = new Date(rule.startDate);
  const end = rule.endDate ? new Date(rule.endDate) : null;
  const winFrom = fromDate.getTime() < start.getTime() ? start : fromDate;
  const winTo = end && end.getTime() < toDate.getTime() ? end : toDate;
  if (winFrom.getTime() > winTo.getTime()) return;

  if (rule.frequency === "weekly" || rule.frequency === "biweekly") {
    const stride = (rule.frequency === "weekly" ? 7 : 14) * 86400000;
    const startMs = start.getTime();
    const n = Math.max(0, Math.ceil((winFrom.getTime() - startMs) / stride));
    let t = startMs + n * stride;
    while (t <= winTo.getTime()) {
      yield new Date(t);
      t += stride;
    }
    return;
  }

  const monthStep =
    rule.frequency === "monthly"
      ? 1
      : rule.frequency === "quarterly"
        ? 3
        : 12;
  const anchorMonth = start.getUTCMonth();
  let y = winFrom.getUTCFullYear();
  let m = winFrom.getUTCMonth();
  for (let i = 0; i < 36; i++) {
    const monthOk =
      (((m - anchorMonth) % monthStep) + monthStep) % monthStep === 0;
    if (monthOk) {
      const day = Math.min(rule.dayOfMonth, lastDayOfMonth(y, m));
      const d = new Date(Date.UTC(y, m, day));
      if (d.getTime() > winTo.getTime()) return;
      if (d.getTime() >= winFrom.getTime()) yield d;
    }
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
    if (new Date(Date.UTC(y, m, 1)).getTime() > winTo.getTime()) return;
  }
}

async function avgOfLastThree(rule: any): Promise<number> {
  const recent = await db
    .select({ v: bankTransactions.netAmount })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.bankAccountId, rule.bankAccountId),
        eq(bankTransactions.status, "posted"),
        ilike(bankTransactions.payee, `%${rule.payee || rule.name}%`)
      )
    )
    .orderBy(desc(bankTransactions.txnDate))
    .limit(3);
  if (!recent.length) return 0;
  return (
    recent.reduce((s, r) => s + Math.abs(Number(r.v || 0)), 0) / recent.length
  );
}

async function findPostedNear(
  accountId: string,
  occDate: Date,
  amount: number,
  payee: string | null,
  windowDays = 5
) {
  const from = new Date(occDate.getTime() - windowDays * 86400000);
  const to = new Date(occDate.getTime() + windowDays * 86400000);
  const rows = await db.query.bankTransactions.findMany({
    where: and(
      eq(bankTransactions.bankAccountId, accountId),
      eq(bankTransactions.status, "posted"),
      gte(bankTransactions.txnDate, from),
      lte(bankTransactions.txnDate, to)
    ),
  });
  return rows.find((r: any) => {
    if (Math.abs(Math.abs(Number(r.netAmount)) - amount) > 0.01) return false;
    if (!payee || !r.payee) return true;
    return similarity(r.payee, payee) >= 0.4;
  });
}

async function replaceMatchingProjected(
  accountId: string,
  occDate: Date,
  net: number,
  payee: string | null,
  windowDays = 5
) {
  if (!net) return;
  const from = new Date(occDate.getTime() - windowDays * 86400000);
  const to = new Date(occDate.getTime() + windowDays * 86400000);
  const candidates = await db.query.bankTransactions.findMany({
    where: and(
      eq(bankTransactions.bankAccountId, accountId),
      eq(bankTransactions.status, "projected"),
      gte(bankTransactions.txnDate, from),
      lte(bankTransactions.txnDate, to)
    ),
  });
  const ids: string[] = [];
  for (const c of candidates as any[]) {
    if (Math.sign(Number(c.netAmount)) !== Math.sign(net)) continue;
    if (Math.abs(Math.abs(Number(c.netAmount)) - Math.abs(net)) > 0.01) continue;
    if (payee && c.payee && similarity(c.payee, payee) < 0.4) continue;
    ids.push(c.id);
  }
  if (ids.length) {
    await softDelete({
      table: bankTransactions,
      where: inArray(bankTransactions.id, ids),
      actorUserId: null,
      entityType: "bank_transaction",
    });
  }
}

export async function generateForOrganization(
  organizationId: string,
  userId: string | null,
  asOf: Date = new Date()
) {
  const rules = await db.query.recurringTransactions.findMany({
    where: and(
      eq(recurringTransactions.labOrganizationId, organizationId),
      eq(recurringTransactions.isActive, true)
    ),
  });
  const monthEnd = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, 0, 23, 59, 59)
  );
  let created = 0;
  for (const rule of rules) {
    const lastDate =
      rule.lastGeneratedFor && /^\d{4}-\d{2}-\d{2}/.test(rule.lastGeneratedFor)
        ? new Date(rule.lastGeneratedFor)
        : null;
    const winFrom = lastDate
      ? new Date(lastDate.getTime() + 86400000)
      : new Date(rule.startDate);
    const occurrences = Array.from(
      iterateOccurrences(rule, winFrom, monthEnd)
    );
    if (!occurrences.length) continue;
    let lastGen: Date | null = lastDate;
    for (const occDate of occurrences) {
      let amount = rule.amount != null ? Number(rule.amount) : 0;
      if (rule.estimateMethod === "avg_last_3") {
        const avg = await avgOfLastThree(rule);
        if (avg) amount = avg;
      }
      amount = Math.abs(Number(amount) || 0);
      if (!amount) {
        lastGen = occDate;
        continue;
      }
      let resolvedPayee = rule.payee || rule.name;
      if (rule.vendorId) {
        const vendor = await db.query.vendors.findFirst({
          where: eq(vendors.id, rule.vendorId),
          columns: { name: true },
        });
        if (vendor) resolvedPayee = vendor.name;
      }
      const existing = await findPostedNear(
        rule.bankAccountId,
        occDate,
        amount,
        resolvedPayee
      );
      if (existing) {
        lastGen = occDate;
        continue;
      }
      const debit = rule.direction === "debit" ? amount : 0;
      const credit = rule.direction === "credit" ? amount : 0;
      const net = credit - debit;
      await db.insert(bankTransactions).values({
        labOrganizationId: organizationId,
        bankAccountId: rule.bankAccountId,
        txnDate: occDate,
        type: rule.direction === "credit" ? "deposit" : "payment",
        payee: resolvedPayee,
        memo: rule.memo || `Projected: ${rule.name}`,
        categoryId: rule.categoryId,
        debitAmount: debit.toFixed(2),
        creditAmount: credit.toFixed(2),
        netAmount: net.toFixed(2),
        cleared: false,
        status: "projected",
        source: "recurring",
        recurringRuleId: rule.id,
        createdByUserId: userId,
      }).catch((err: unknown): never => wrapDbError(err));
      created += 1;
      lastGen = occDate;
    }
    if (lastGen) {
      await db
        .update(recurringTransactions)
        .set({
          lastGeneratedFor: lastGen.toISOString().slice(0, 10),
          updatedAt: new Date(),
        })
        .where(eq(recurringTransactions.id, rule.id));
    }
  }
  return { created, ruleCount: rules.length };
}

// Post a single, immediate occurrence of a recurring rule as a real
// (status="posted") bank_transactions row. UI surfaces this as
// "Post next entry now" so an operator can fire a one-off without
// waiting for the scheduled generator. Idempotent within a 5-day window
// via findPostedNear().
router.post(
  "/recurring/:id/post-next",
  asyncHandler(async (req, res) => {
    const rule = await db.query.recurringTransactions.findFirst({
      where: eq(recurringTransactions.id, String(req.params.id)),
    });
    if (!rule) throw new HttpError(404, "Rule not found.");
    await requireAnyRole(uid(req), rule.labOrganizationId, BILLING_ROLES);
    let amount = rule.amount != null ? Number(rule.amount) : 0;
    if (rule.estimateMethod === "avg_last_3") {
      const avg = await avgOfLastThree(rule);
      if (avg) amount = avg;
    }
    amount = Math.abs(Number(amount) || 0);
    if (!amount)
      throw new HttpError(400, "Rule has no amount to post.");
    const occDate = new Date();
    let resolvedPostPayee = rule.payee || rule.name;
    if (rule.vendorId) {
      const vendor = await db.query.vendors.findFirst({
        where: eq(vendors.id, rule.vendorId),
        columns: { name: true },
      });
      if (vendor) resolvedPostPayee = vendor.name;
    }
    const dup = await findPostedNear(
      rule.bankAccountId,
      occDate,
      amount,
      resolvedPostPayee
    );
    if (dup)
      return ok(res, { posted: false, bankTransactionId: dup.id });
    const debit = rule.direction === "debit" ? amount : 0;
    const credit = rule.direction === "credit" ? amount : 0;
    const net = credit - debit;
    const [row] = await db
      .insert(bankTransactions)
      .values({
        labOrganizationId: rule.labOrganizationId,
        bankAccountId: rule.bankAccountId,
        txnDate: occDate,
        type: rule.direction === "credit" ? "deposit" : "payment",
        payee: resolvedPostPayee,
        memo: rule.memo || rule.name,
        categoryId: rule.categoryId,
        debitAmount: debit.toFixed(2),
        creditAmount: credit.toFixed(2),
        netAmount: net.toFixed(2),
        cleared: false,
        status: "posted",
        source: "recurring",
        recurringRuleId: rule.id,
        createdByUserId: uid(req),
      })
      .returning({ id: bankTransactions.id });
    await db
      .update(recurringTransactions)
      .set({
        lastGeneratedFor: occDate.toISOString().slice(0, 10),
        updatedAt: new Date(),
      })
      .where(eq(recurringTransactions.id, rule.id));
    return ok(res, { posted: true, bankTransactionId: row.id });
  })
);

router.post(
  "/recurring/generate",
  asyncHandler(async (req, res) => {
    const { organizationId } = orgIdQuery.parse(req.body);
    await requireAnyRole(uid(req), organizationId, BILLING_ROLES);
    const result = await generateForOrganization(organizationId, uid(req));
    return ok(res, result);
  })
);

// ───────────────────────────────── Cash Flow ─────────────────────────────

const cashflowQuery = z.object({
  organizationId: z.string().min(1),
  range: z
    .enum([
      "current_month",
      "prior_month",
      "next_30",
      "next_60",
      "next_90",
      "custom",
    ])
    .default("current_month"),
  bankAccountId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

function rangeWindow(range: string, dateFrom?: string, dateTo?: string) {
  const now = new Date();
  const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const endMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59)
  );
  if (range === "current_month") return { from: startMonth, to: endMonth };
  if (range === "prior_month") {
    const f = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const t = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59)
    );
    return { from: f, to: t };
  }
  if (range === "next_30" || range === "next_60" || range === "next_90") {
    const days = range === "next_30" ? 30 : range === "next_60" ? 60 : 90;
    const t = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return { from: now, to: t };
  }
  return {
    from: dateFrom ? new Date(dateFrom) : startMonth,
    to: dateTo ? new Date(dateTo) : endMonth,
  };
}

router.get(
  "/cashflow",
  asyncHandler(async (req, res) => {
    const q = cashflowQuery.parse(req.query);
    await requireAnyRole(uid(req), q.organizationId, BILLING_ROLES);
    const { from, to } = rangeWindow(q.range, q.dateFrom, q.dateTo);
    const conds: any[] = [
      eq(bankTransactions.labOrganizationId, q.organizationId),
      gte(bankTransactions.txnDate, from),
      lte(bankTransactions.txnDate, to),
      ne(bankTransactions.status, "deposited_child"),
    ];
    if (q.bankAccountId) conds.push(eq(bankTransactions.bankAccountId, q.bankAccountId));
    const rows = await db
      .select()
      .from(bankTransactions)
      .where(and(...conds));
    const rowIds = (rows as any[]).map((r) => r.id);
    const invoiceLinkedIds = new Set<string>();
    if (rowIds.length) {
      const links = await db
        .select({
          bankTransactionId: bankTransactionInvoices.bankTransactionId,
        })
        .from(bankTransactionInvoices)
        .where(inArray(bankTransactionInvoices.bankTransactionId, rowIds));
      for (const l of links) invoiceLinkedIds.add(l.bankTransactionId);
    }
    let revenue = 0;
    let expenses = 0;
    let projectedRevenue = 0;
    let projectedExpenses = 0;
    let net = 0;
    const INVOICE_BUCKET = "__invoice_payments__";
    const UNCATEGORIZED_BUCKET = "__uncategorized__";
    const byCategory = new Map<
      string,
      {
        id: string | null;
        name: string | null;
        income: number;
        expense: number;
      }
    >();
    for (const r of rows as any[]) {
      if (r.status === "void") continue;
      // Net change tracks the actual movement on every non-void entry,
      // including transfers — so account-scoped views still reflect the
      // amount moved in or out of the selected account.
      net += Number(r.netAmount);
      // Inter-account transfers are excluded from revenue/expense totals
      // and from the category breakdown so they don't double-count as
      // earned income or paid expense at the organization level.
      if (r.transferGroupId) continue;
      const credit = Number(r.creditAmount);
      const debit = Number(r.debitAmount);
      if (r.status === "projected") {
        projectedRevenue += credit;
        projectedExpenses += debit;
      } else {
        revenue += credit;
        expenses += debit;
      }
      let key: string;
      let bucketName: string | null = null;
      let bucketId: string | null = null;
      if (r.categoryId) {
        key = r.categoryId;
        bucketId = r.categoryId;
      } else if (invoiceLinkedIds.has(r.id) || r.source === "invoice") {
        key = INVOICE_BUCKET;
        bucketName = "Invoice payments";
      } else {
        key = UNCATEGORIZED_BUCKET;
      }
      const cur = byCategory.get(key) ?? {
        id: bucketId,
        name: bucketName,
        income: 0,
        expense: 0,
      };
      cur.income += credit;
      cur.expense += debit;
      byCategory.set(key, cur);
    }
    const startConds: any[] = [
      eq(bankTransactions.labOrganizationId, q.organizationId),
      lte(bankTransactions.txnDate, from),
      ne(bankTransactions.status, "deposited_child"),
    ];
    if (q.bankAccountId) startConds.push(eq(bankTransactions.bankAccountId, q.bankAccountId));
    const startRows = await db
      .select({
        v: sql<string>`COALESCE(SUM(CASE WHEN ${bankTransactions.status} <> 'void' THEN ${bankTransactions.netAmount} ELSE 0 END), 0)::text`,
      })
      .from(bankTransactions)
      .where(and(...startConds));
    const startingBalance = Number(startRows[0]?.v ?? 0);
    const endingBalance = startingBalance + net;

    const cats = (await db.query.transactionCategories.findMany({
      where: eq(transactionCategories.labOrganizationId, q.organizationId),
    })) as any[];
    const catNameById = new Map(cats.map((c) => [c.id, c.name]));
    const categoryBreakdown = Array.from(byCategory.entries()).map(([k, v]) => ({
      bucketKey: k,
      categoryId: v.id,
      name:
        v.name ||
        (v.id ? catNameById.get(v.id) || "Unknown" : "Uncategorized"),
      income: v.income.toFixed(2),
      expense: v.expense.toFixed(2),
      net: (v.income - v.expense).toFixed(2),
    }));

    return ok(res, {
      from: from.toISOString(),
      to: to.toISOString(),
      revenue: revenue.toFixed(2),
      expenses: expenses.toFixed(2),
      projectedRevenue: projectedRevenue.toFixed(2),
      projectedExpenses: projectedExpenses.toFixed(2),
      net: net.toFixed(2),
      startingBalance: startingBalance.toFixed(2),
      endingBalance: endingBalance.toFixed(2),
      categoryBreakdown,
    });
  })
);

// ─────────────────── Reports: Profit & Loss (Task #381) ───────────────────
//
// Revenue: invoices issued in the window (excluding void / soft-deleted).
// Expenses: posted, non-transfer bank transactions whose category is of
// kind "expense", grouped by category name. Categories whose name matches
// /cogs|material|outsourc|lab supply/i are treated as Cost of Goods Sold;
// the remainder count as Operating Expenses. Uncategorised expenses fall
// into a single "Uncategorized" OpEx bucket so nothing is silently lost.
const COGS_PATTERN = /cogs|material|outsourc|lab supply|lab supplies/i;

router.get(
  "/reports/profit-loss",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        organizationId: z.string().min(1),
        dateFrom: z.string().min(1),
        dateTo: z.string().min(1),
        comparePrevious: z
          .union([z.literal("true"), z.literal("false"), z.boolean()])
          .optional()
          .transform((v) => v === true || v === "true"),
      })
      .parse(req.query);
    // view_financial_reports capability: billing-role members pass via their
    // existing role; non-billing members may also view reports with an explicit
    // capability grant (owners and admins always pass via hasCapability).
    const _plMembership = await requireMembership(uid(req), q.organizationId);
    if (!BILLING_ROLES.includes(_plMembership.role as MembershipRole)) {
      const _allowed = await hasCapability(uid(req), q.organizationId, "view_financial_reports");
      if (!_allowed) {
        throw new HttpError(403, "You do not have permission to view financial reports.");
      }
    }
    const from = new Date(q.dateFrom);
    const to = new Date(q.dateTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new HttpError(400, "Invalid dateFrom/dateTo.");
    }

    const cats = (await db.query.transactionCategories.findMany({
      where: eq(transactionCategories.labOrganizationId, q.organizationId),
    })) as Array<{ id: string; name: string; kind: string }>;
    const catById = new Map(cats.map((c) => [c.id, c]));

    const main = await computePnl(q.organizationId, from, to, catById);
    let previous: PnlBlock | null = null;
    if (q.comparePrevious) {
      // Previous window of the same number of whole days, ending the
      // day before `from`. The DateRangePicker sends `to` as end-of-day,
      // so days = round((to - from) / 1d). Example: May 1 00:00 –
      // May 31 23:59:59.999 → 31 days, prev = Mar 31 – Apr 30 (also 31).
      const dayMs = 86_400_000;
      const days = Math.max(
        1,
        Math.round((to.getTime() - from.getTime()) / dayMs),
      );
      const prevFrom = new Date(from.getTime() - days * dayMs);
      const prevTo = new Date(from.getTime() - 1);
      previous = await computePnl(q.organizationId, prevFrom, prevTo, catById);
    }

    return ok(res, {
      ...main,
      previous,
    });
  }),
);

interface PnlBlock {
  basis: "accrual";
  from: string;
  to: string;
  revenue: string;
  invoiceCount: number;
  cogs: Array<{ name: string; amount: string }>;
  cogsTotal: string;
  grossProfit: string;
  grossMargin: number;
  opex: Array<{ name: string; amount: string }>;
  opexTotal: string;
  netIncome: string;
  netMargin: number;
}

async function computePnl(
  organizationId: string,
  from: Date,
  to: Date,
  catById: Map<string, { id: string; name: string; kind: string }>,
): Promise<PnlBlock> {
  // Revenue is recognized when an invoice is issued, and the period figure is
  // the difference between two dated reconstructions: what the books had
  // recognized by the period end, less what they had recognized the instant
  // before it began. Issuing recognizes the invoice on its issue date;
  // raising or voiding it later lands in the period of that change, so
  // adjacent periods add up to the combined range.
  const priorEnd = new Date(from.getTime() - 1);
  const [versionsAtEnd, versionsBefore] = await Promise.all([
    invoiceVersionsAsOf(organizationId, to),
    priorEnd.getTime() > 0
      ? invoiceVersionsAsOf(organizationId, priorEnd)
      : Promise.resolve(new Map<string, InvoiceVersion>()),
  ]);
  let revenue = 0;
  let invoiceCount = 0;
  for (const [invoiceId, version] of versionsAtEnd) {
    const nowRecognized = invoiceRecognizedAsOf(version, to);
    const before = versionsBefore.get(invoiceId);
    const wasRecognized = before ? invoiceRecognizedAsOf(before, priorEnd) : false;
    const nowCents = nowRecognized ? version.totalCents : 0;
    const beforeCents = wasRecognized && before ? before.totalCents : 0;
    revenue += (nowCents - beforeCents) / 100;
    // The count reports documents issued during this period, so reversing or
    // revising an earlier invoice moves money without inflating the count.
    if (nowRecognized && !wasRecognized && version.issuedAt && version.issuedAt >= from) {
      invoiceCount += 1;
    }
  }

  const txnRows = (await db
    .select({
      categoryId: bankTransactions.categoryId,
      debit: bankTransactions.debitAmount,
      transferGroupId: bankTransactions.transferGroupId,
      source: bankTransactions.source,
    })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.labOrganizationId, organizationId),
        sql`${bankTransactions.deletedAt} IS NULL`,
        eq(bankTransactions.status, "posted"),
        gte(bankTransactions.txnDate, from),
        lte(bankTransactions.txnDate, to),
      ),
    )) as Array<{
    categoryId: string | null;
    debit: string;
    transferGroupId: string | null;
    source: string | null;
  }>;

  const cogsByName = new Map<string, number>();
  const opexByName = new Map<string, number>();
  let cogsTotal = 0;
  let opexTotal = 0;
  const addExpense = (name: string, amount: number, isCogs: boolean) => {
    if (isCogs) {
      cogsByName.set(name, (cogsByName.get(name) ?? 0) + amount);
      cogsTotal += amount;
    } else {
      opexByName.set(name, (opexByName.get(name) ?? 0) + amount);
      opexTotal += amount;
    }
  };
  for (const t of txnRows) {
    if (t.transferGroupId) continue;
    // Cash that settled a vendor bill is not an expense: entering the bill
    // already recognized one. Counting both would double the cost.
    if (t.source === BILL_PAYMENT_TXN_SOURCE) continue;
    const debit = Number(t.debit || 0);
    if (debit <= 0) continue;
    const cat = t.categoryId ? catById.get(t.categoryId) : null;
    // Only categorise expense-kind categories. Income/transfer-kind
    // categories that somehow have a debit are ignored to avoid
    // distorting the P&L.
    if (cat && cat.kind !== "expense") continue;
    const name = cat?.name ?? "Uncategorized";
    addExpense(name, debit, cat ? COGS_PATTERN.test(name) : false);
  }

  // Vendor bills recognize their expense on the bill date, whether or not
  // they have been paid yet. This is the accrual half of the basis.
  const billed = await billedExpensesInPeriod(organizationId, from, to);
  for (const [categoryId, cents] of billed.byCategoryId) {
    const cat = categoryId ? catById.get(categoryId) : null;
    const name = cat?.name ?? "Uncategorized";
    addExpense(name, cents / 100, cat ? COGS_PATTERN.test(name) : false);
  }

  const cogs = Array.from(cogsByName.entries())
    .map(([name, amount]) => ({ name, amount: amount.toFixed(2) }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));
  const opex = Array.from(opexByName.entries())
    .map(([name, amount]) => ({ name, amount: amount.toFixed(2) }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));

  const grossProfit = revenue - cogsTotal;
  const netIncome = grossProfit - opexTotal;

  return {
    // Revenue is recognized when an invoice is issued and expense when a bill
    // is entered; cash movement afterwards is not recognized again. Immediate
    // register expenses without a bill are recognized on their own date.
    basis: "accrual" as const,
    from: from.toISOString(),
    to: to.toISOString(),
    revenue: revenue.toFixed(2),
    invoiceCount,
    cogs,
    cogsTotal: cogsTotal.toFixed(2),
    grossProfit: grossProfit.toFixed(2),
    grossMargin: revenue > 0 ? grossProfit / revenue : 0,
    opex,
    opexTotal: opexTotal.toFixed(2),
    netIncome: netIncome.toFixed(2),
    netMargin: revenue > 0 ? netIncome / revenue : 0,
  };
}

// Reports: Balance Sheet — assets/liabilities/equity snapshot at asOf.
// retainedEarnings = cumulative net income to date; ownerContributions
// is the residual that keeps assets = liabilities + equity.
router.get(
  "/reports/balance-sheet",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        organizationId: z.string().min(1),
        asOfDate: z.string().min(1),
        timeZone: z.string().min(1).max(64).optional(),
      })
      .parse(req.query);
    // export_data capability: billing-role members pass via their existing role;
    // non-billing members may also export balance-sheet data with an explicit
    // capability grant (owners and admins always pass via hasCapability).
    const _bsMembership = await requireMembership(uid(req), q.organizationId);
    if (!BILLING_ROLES.includes(_bsMembership.role as MembershipRole)) {
      const _allowed = await hasCapability(uid(req), q.organizationId, "export_data");
      if (!_allowed) {
        throw new HttpError(403, "You do not have permission to export financial data.");
      }
    }
    const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(q.asOfDate);
    if (!ymdMatch) throw new HttpError(400, "Invalid asOfDate.");
    const [, ys, ms, ds] = ymdMatch;
    const yr = Number(ys);
    const mo = Number(ms) - 1;
    const day = Number(ds);
    // Resolve end-of-day for the asOfDate in the caller's IANA tz so
    // labs in non-UTC zones don't lose evening transactions or roll
    // into the next day. Falls back to UTC if no tz is supplied.
    const asOfEnd = endOfDayInTz(yr, mo, day, q.timeZone);
    if (Number.isNaN(asOfEnd.getTime())) {
      throw new HttpError(400, "Invalid asOfDate.");
    }

    const accts = (await db.query.bankAccounts.findMany({
      where: eq(bankAccounts.labOrganizationId, q.organizationId),
    })) as Array<{
      id: string;
      name: string;
      last4: string | null;
      openingBalance: string;
      isArchived: boolean;
    }>;
    const acctSums = accts.length
      ? ((await db
          .select({
            bankAccountId: bankTransactions.bankAccountId,
            // A bill-payment withdrawal voided after this date was still live
            // then, so it counts here even though it is void today.
            sum: sql<string>`COALESCE(SUM(CASE WHEN ${bankTransactions.status} = 'posted' OR (${bankTransactions.source} = ${BILL_PAYMENT_TXN_SOURCE} AND ${bankTransactions.deletedAt} > ${asOfEnd}) THEN ${bankTransactions.netAmount} ELSE 0 END), 0)::text`,
          })
          .from(bankTransactions)
          .where(
            and(
              eq(bankTransactions.labOrganizationId, q.organizationId),
              // Voiding a bill payment soft-deletes its withdrawal on the void
              // date. A report dated before that void must still see the cash
              // leave, because the AP allocation history treats it as live
              // then. Other deletions stay hidden: they are corrections of
              // entries that should never have existed.
              sql`(${bankTransactions.deletedAt} IS NULL OR (${bankTransactions.source} = ${BILL_PAYMENT_TXN_SOURCE} AND ${bankTransactions.deletedAt} > ${asOfEnd}))`,
              lte(bankTransactions.txnDate, asOfEnd),
              inArray(
                bankTransactions.bankAccountId,
                accts.map((a) => a.id),
              ),
            ),
          )
          .groupBy(bankTransactions.bankAccountId)) as Array<{
          bankAccountId: string;
          sum: string;
        }>)
      : [];
    const txnSumByAcct = new Map(
      acctSums.map((s) => [s.bankAccountId, Number(s.sum)]),
    );
    // Account creation already writes an "Opening balance" row into
    // bank_transactions (see POST /accounts), so the txn sum already
    // contains the opening balance — don't add it again.
    const cashAccounts = accts
      .filter((a) => !a.isArchived)
      .map((a) => {
        const balance = txnSumByAcct.get(a.id) ?? 0;
        return {
          accountId: a.id,
          name: a.name + (a.last4 ? ` ··${a.last4}` : ""),
          balance: balance.toFixed(2),
        };
      });
    const cashTotal = cashAccounts.reduce(
      (sum, a) => sum + Number(a.balance),
      0,
    );

    const issued = sql<Date>`COALESCE(${invoices.issuedAt}, ${invoices.createdAt})`;
    // Cumulative revenue replays the same dated invoice snapshots the P&L
    // uses, so retained earnings ties back to the periods that produced it:
    // drafts have recognized nothing, an invoice voided after this date was
    // still revenue as of it, and a later edit has not happened yet.
    const cumulativeRevenue =
      (await invoicedRevenueThrough(q.organizationId, asOfEnd)) / 100;
    // Receivable at the as-of date comes from dated payments and dated credit
    // applications, not from today's remaining balance on each invoice.
    const datedAr = await arBalanceAsOf(q.organizationId, asOfEnd);
    const accountsReceivable = datedAr.receivableCents / 100;
    // Overpayment sits in two places: on an invoice that was paid past its
    // total, and in the customer-credit subledger when a session routed the
    // excess there. Both are money owed back to the customer.
    const unappliedCustomerCredit = await unappliedCustomerCreditsAsOf(
      q.organizationId,
      asOfEnd,
    );
    const customerCredits =
      datedAr.invoiceOverpaymentCents / 100 + unappliedCustomerCredit / 100;

    const cats = (await db.query.transactionCategories.findMany({
      where: eq(transactionCategories.labOrganizationId, q.organizationId),
    })) as Array<{ id: string; kind: string }>;
    const catKindById = new Map(cats.map((c) => [c.id, c.kind]));
    const expenseRows = (await db
      .select({
        categoryId: bankTransactions.categoryId,
        debit: bankTransactions.debitAmount,
        transferGroupId: bankTransactions.transferGroupId,
        source: bankTransactions.source,
      })
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.labOrganizationId, q.organizationId),
          sql`${bankTransactions.deletedAt} IS NULL`,
          eq(bankTransactions.status, "posted"),
          lte(bankTransactions.txnDate, asOfEnd),
        ),
      )) as Array<{
      categoryId: string | null;
      debit: string;
      transferGroupId: string | null;
      source: string | null;
    }>;
    let cumulativeExpenses = 0;
    for (const t of expenseRows) {
      if (t.transferGroupId) continue;
      // Settling a vendor bill moves cash; the expense was recognized when
      // the bill was entered and is added below from the bill records.
      if (t.source === BILL_PAYMENT_TXN_SOURCE) continue;
      const debit = Number(t.debit || 0);
      if (debit <= 0) continue;
      const kind = t.categoryId ? catKindById.get(t.categoryId) : null;
      if (kind && kind !== "expense") continue;
      cumulativeExpenses += debit;
    }
    const billedToDate = await billedExpensesInPeriod(
      q.organizationId,
      new Date(0),
      asOfEnd,
    );
    cumulativeExpenses += billedToDate.totalCents / 100;

    // Accounts payable is a liability: what the lab owes on entered bills that
    // were not yet settled as of this date. It is not derived from the legacy
    // "Accounts Payable" expense category.
    const datedAp = await apBalanceAsOf(q.organizationId, asOfEnd);
    const accountsPayable = datedAp.balanceCents / 100;
    // Unapplied vendor credit is value the lab can still spend with that
    // vendor, so it is an asset until it settles a bill. It is never netted
    // into the payable, which would understate both sides.
    const vendorCredits = datedAp.unappliedVendorCreditCents / 100;

    const retainedEarnings = cumulativeRevenue - cumulativeExpenses;
    const assetsTotal = cashTotal + accountsReceivable + vendorCredits;
    const liabilityItems: Array<{ name: string; amount: string }> = [];
    if (accountsPayable > 0) {
      liabilityItems.push({
        name: "Accounts payable",
        amount: accountsPayable.toFixed(2),
      });
    }
    if (customerCredits > 0) {
      liabilityItems.push({
        name: "Customer credits",
        amount: customerCredits.toFixed(2),
      });
    }
    const liabilitiesTotal = customerCredits + accountsPayable;
    const ownerContributions =
      assetsTotal - liabilitiesTotal - retainedEarnings;
    const equityTotal = retainedEarnings + ownerContributions;

    return ok(res, {
      basis: "accrual",
      asOf: asOfEnd.toISOString(),
      assets: {
        cashAccounts,
        cashTotal: cashTotal.toFixed(2),
        accountsReceivable: accountsReceivable.toFixed(2),
        vendorCredits: vendorCredits.toFixed(2),
        total: assetsTotal.toFixed(2),
      },
      liabilities: {
        items: liabilityItems,
        accountsPayable: accountsPayable.toFixed(2),
        customerCredits: customerCredits.toFixed(2),
        total: liabilitiesTotal.toFixed(2),
      },
      equity: {
        retainedEarnings: retainedEarnings.toFixed(2),
        ownerContributions: ownerContributions.toFixed(2),
        total: equityTotal.toFixed(2),
      },
      // Owner contributions is still the residual that balances the sheet,
      // and reversed payments can leave AR without dated evidence. Say so
      // rather than presenting these figures as audited.
      limitations: [
        ...(datedAr.approximate
          ? [
              {
                code: "reversed_payments_not_dated",
                message:
                  "Some invoices are settled today but have no dated payment record, " +
                  "usually because a payment was reversed. Receivable figures for " +
                  "past dates are approximate.",
              },
            ]
          : []),
        // Invoices settled before payment history existed, where no payment,
        // deposit, or receipt dates the settlement. Their current balance is
        // carried at every date; inventing an opening balance for them would
        // put a number in the report that nothing recorded.
        ...(datedAr.unreconstructedInvoiceCount
          ? [
              {
                code: "legacy_settlements_not_dated",
                message:
                  `${datedAr.unreconstructedInvoiceCount} invoice` +
                  `${datedAr.unreconstructedInvoiceCount === 1 ? "" : "s"} carrying ` +
                  `${(datedAr.unreconstructedSettlementCents / 100).toFixed(2)} of settlement ` +
                  "predate payment history, and nothing records when they were settled. " +
                  "Their current balances are used at every date.",
                affectedInvoiceCount: datedAr.unreconstructedInvoiceCount,
                affectedAmount: (
                  datedAr.unreconstructedSettlementCents / 100
                ).toFixed(2),
              },
            ]
          : []),
        {
          code: "owner_contributions_residual",
          message:
            "Owner contributions is a balancing residual, not a recorded equity " +
            "account. LabTrax does not keep a general ledger for capital activity.",
        },
      ],
    });
  }),
);

// ─── Vendor Types (per-lab customizable payee categories) ────────────────────
//
// Task #1188: replaces the hard-coded ["vendor","employee","item"] enum that
// used to live on vendors.vendor_type. Each lab gets the three built-in rows
// seeded on first call via ensureVendorTypesSeeded(), and admins can add /
// rename / remove additional types from Lists → Payee Types.

// Enrich a raw vendor row with `vendorTypeName` + `builtinKind` so clients
// can render badges and labels without a second lookup. Falls back to the
// legacy `vendorType` text column if the FK has not been backfilled yet.
function enrichVendor(
  row: typeof vendors.$inferSelect,
  typesById: Map<string, VendorTypeRow>,
): typeof vendors.$inferSelect & {
  vendorTypeName: string;
  builtinKind: string | null;
} {
  const t = row.vendorTypeId ? typesById.get(row.vendorTypeId) : undefined;
  return {
    ...row,
    vendorTypeName: t?.name ?? capitalize(row.vendorType),
    builtinKind: t?.builtinKind ?? row.vendorType,
  };
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

router.get(
  "/vendor-types",
  asyncHandler(async (req, res) => {
    const { organizationId } = z
      .object({ organizationId: z.string().min(1) })
      .parse(req.query);
    await requireAnyRole(uid(req), organizationId, BILLING_ROLES);
    await ensureVendorTypesSeeded(organizationId);
    const rows = await listVendorTypes(organizationId);
    return ok(res, rows);
  }),
);

const vendorTypeBodySchema = z.object({
  organizationId: z.string().min(1).optional(),
  name: z.string().min(1).max(80).optional(),
});

router.post(
  "/vendor-types",
  asyncHandler(async (req, res) => {
    const input = vendorTypeBodySchema
      .required({ organizationId: true, name: true })
      .parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, BILLING_ROLES);
    await ensureVendorTypesSeeded(input.organizationId);
    const trimmed = input.name.trim();
    const [dupe] = await db
      .select({ id: vendorTypes.id })
      .from(vendorTypes)
      .where(
        and(
          eq(vendorTypes.labOrganizationId, input.organizationId),
          sql`lower(${vendorTypes.name}) = lower(${trimmed})`,
          sql`${vendorTypes.deletedAt} IS NULL`,
        ),
      )
      .limit(1);
    if (dupe) {
      throw new HttpError(409, "A payee type with this name already exists.");
    }
    // Stick custom rows at the end of the list (max sortOrder + 1).
    const [{ maxSort } = { maxSort: 0 }] = await db
      .select({ maxSort: sql<number>`coalesce(max(${vendorTypes.sortOrder}), 0)` })
      .from(vendorTypes)
      .where(eq(vendorTypes.labOrganizationId, input.organizationId));
    const [row] = await db
      .insert(vendorTypes)
      .values({
        labOrganizationId: input.organizationId,
        name: trimmed,
        sortOrder: Number(maxSort) + 1,
        isBuiltin: false,
        builtinKind: null,
      })
      .returning();
    return ok(res, row);
  }),
);

router.patch(
  "/vendor-types/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const input = vendorTypeBodySchema.parse(req.body);
    const [existing] = await db
      .select()
      .from(vendorTypes)
      .where(eq(vendorTypes.id, id))
      .limit(1);
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, "Vendor type not found");
    }
    await requireAnyRole(uid(req), existing.labOrganizationId, BILLING_ROLES);
    if (input.name === undefined) return ok(res, existing);
    const trimmed = input.name.trim();
    const [dupe] = await db
      .select({ id: vendorTypes.id })
      .from(vendorTypes)
      .where(
        and(
          eq(vendorTypes.labOrganizationId, existing.labOrganizationId),
          sql`lower(${vendorTypes.name}) = lower(${trimmed})`,
          sql`${vendorTypes.deletedAt} IS NULL`,
          ne(vendorTypes.id, id),
        ),
      )
      .limit(1);
    if (dupe) {
      throw new HttpError(409, "A payee type with this name already exists.");
    }
    const [updated] = await db
      .update(vendorTypes)
      .set({ name: trimmed, updatedAt: new Date() })
      .where(eq(vendorTypes.id, id))
      .returning();
    return ok(res, updated);
  }),
);

router.delete(
  "/vendor-types/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reassignToVendorTypeId } = z
      .object({ reassignToVendorTypeId: z.string().min(1).optional() })
      .parse(req.query);
    const [existing] = await db
      .select()
      .from(vendorTypes)
      .where(eq(vendorTypes.id, id))
      .limit(1);
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, "Vendor type not found");
    }
    await requireAnyRole(uid(req), existing.labOrganizationId, BILLING_ROLES);
    if (existing.isBuiltin) {
      throw new HttpError(400, "Built-in payee types cannot be deleted.");
    }

    // Count vendors still pointing at this type.
    const [{ inUseCount }] = await db
      .select({ inUseCount: sql<number>`count(*)::int` })
      .from(vendors)
      .where(
        and(
          eq(vendors.vendorTypeId, id),
          sql`${vendors.deletedAt} IS NULL`,
        ),
      );
    const used = Number(inUseCount);

    if (used > 0) {
      if (!reassignToVendorTypeId) {
        throw new HttpError(
          409,
          `${used} payee${used === 1 ? "" : "s"} still use this type. ` +
            `Provide reassignToVendorTypeId to move them before deleting.`,
          { inUseCount: used, vendorTypeId: id },
        );
      }
      const [target] = await db
        .select({
          id: vendorTypes.id,
          builtinKind: vendorTypes.builtinKind,
          labOrganizationId: vendorTypes.labOrganizationId,
        })
        .from(vendorTypes)
        .where(eq(vendorTypes.id, reassignToVendorTypeId))
        .limit(1);
      if (
        !target ||
        target.labOrganizationId !== existing.labOrganizationId
      ) {
        throw new HttpError(
          400,
          "Reassignment target must be a vendor type in the same lab.",
        );
      }
      await db.transaction(async (tx) => {
        await tx
          .update(vendors)
          .set({
            vendorTypeId: target.id,
            vendorType: target.builtinKind ?? "vendor",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(vendors.vendorTypeId, id),
              sql`${vendors.deletedAt} IS NULL`,
            ),
          );
        await tx
          .update(vendorTypes)
          .set({
            deletedAt: new Date(),
            deletedByUserId: uid(req),
            updatedAt: new Date(),
          })
          .where(eq(vendorTypes.id, id));
      });
    } else {
      await db
        .update(vendorTypes)
        .set({
          deletedAt: new Date(),
          deletedByUserId: uid(req),
          updatedAt: new Date(),
        })
        .where(eq(vendorTypes.id, id));
    }
    return ok(res, { ok: true, reassigned: used });
  }),
);

// ─── Vendors ──────────────────────────────────────────────────────────────────

router.get(
  "/vendors",
  asyncHandler(async (req, res) => {
    const { organizationId, vendorType, vendorTypeId, includeInactive } = z
      .object({
        organizationId: z.string().min(1),
        // Legacy kind filter — still accepted; maps to a builtin row id.
        vendorType: z.string().optional(),
        vendorTypeId: z.string().optional(),
        includeInactive: z
          .enum(["true", "false"])
          .transform((v) => v === "true")
          .optional(),
      })
      .parse(req.query);
    await requireAnyRole(uid(req), organizationId, BILLING_ROLES);
    await ensureVendorTypesSeeded(organizationId);
    const types = await listVendorTypes(organizationId);
    const typesById = new Map(types.map((t) => [t.id, t]));

    const conditions = [
      eq(vendors.labOrganizationId, organizationId),
      sql`${vendors.deletedAt} IS NULL`,
    ];
    if (vendorTypeId) {
      conditions.push(eq(vendors.vendorTypeId, vendorTypeId));
    } else if (vendorType) {
      // Legacy filter: resolve to the builtin row id for this lab.
      const match = types.find((t) => t.builtinKind === vendorType);
      if (match) conditions.push(eq(vendors.vendorTypeId, match.id));
      else conditions.push(eq(vendors.vendorType, vendorType));
    }
    if (!includeInactive) conditions.push(eq(vendors.isActive, true));
    const rows = await db
      .select()
      .from(vendors)
      .where(and(...conditions))
      .orderBy(asc(vendors.name));
    return ok(res, rows.map((r) => enrichVendor(r, typesById)));
  }),
);

const vendorBodySchema = z.object({
  organizationId: z.string().min(1).optional(),
  name: z.string().min(1).max(200).optional(),
  address: z.string().max(500).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  zip: z.string().max(20).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  unitPrice: z.string().max(20).nullable().optional(),
  priceKey: z.string().trim().min(1).max(120).nullable().optional(),
  itemCategory: z.enum(["Restorative", "Removable", "Appliance"]).nullable().optional(),
  vendorType: z.string().optional(),
  vendorTypeId: z.string().optional(),
  // Default net terms used when entering a bill for this vendor. Null means
  // "no standing terms" and the bill form asks for a due date instead.
  paymentTermsDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
  isActive: z.boolean().optional(),
});

router.post(
  "/vendors",
  asyncHandler(async (req, res) => {
    const input = vendorBodySchema.required({ organizationId: true, name: true }).parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, BILLING_ROLES);
    await ensureVendorTypesSeeded(input.organizationId);
    const trimmedName = input.name.trim();
    const [dupe] = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(
        and(
          eq(vendors.labOrganizationId, input.organizationId),
          sql`lower(${vendors.name}) = lower(${trimmedName})`,
          sql`${vendors.deletedAt} IS NULL`
        )
      )
      .limit(1);
    if (dupe) throw new HttpError(409, "A payee with this name already exists in this lab.");
    const resolved = await resolveVendorTypeId(input.organizationId, {
      vendorTypeId: input.vendorTypeId,
      vendorType: input.vendorType,
    });
    let typeId = resolved?.id;
    let kind = resolved?.builtinKind ?? input.vendorType ?? "vendor";
    if (!typeId) {
      // No type provided — fall back to the lab's "Vendor" builtin.
      typeId = await getDefaultVendorTypeId(input.organizationId);
      kind = "vendor";
    }
    const normalizeUnitPrice = (raw: string | null | undefined): string | null => {
      if (raw == null) return null;
      const cleaned = String(raw).replace(/[$,\s]/g, "").trim();
      if (!cleaned) return null;
      const n = Number(cleaned);
      if (!Number.isFinite(n)) return null;
      return n.toFixed(2);
    };
    const [row] = await db
      .insert(vendors)
      .values({
        labOrganizationId: input.organizationId,
        name: input.name.trim(),
        address: input.address ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        zip: input.zip ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        website: input.website ?? null,
        notes: input.notes ?? null,
        unitPrice: normalizeUnitPrice(input.unitPrice),
        priceKey: kind === "item" ? (input.priceKey ?? null) : null,
        itemCategory: kind === "item" ? (input.itemCategory ?? null) : null,
        vendorType: kind ?? "vendor",
        vendorTypeId: typeId,
        paymentTermsDays: input.paymentTermsDays ?? null,
        isActive: input.isActive ?? true,
      })
      .returning();
    const types = await listVendorTypes(input.organizationId);
    const typesById = new Map(types.map((t) => [t.id, t]));
    return ok(res, enrichVendor(row, typesById));
  }),
);

const importRecordSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  zip: z.string().max(20).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  unitPrice: z.string().max(20).nullable().optional(),
  priceKey: z.string().trim().min(1).max(120).nullable().optional(),
});

async function importVendorRecords(
  organizationId: string,
  builtinKind: "vendor" | "employee" | "item",
  records: z.infer<typeof importRecordSchema>[]
): Promise<{ imported: number; skipped: number; skippedSameType: number; skippedCrossType: number }> {
  await ensureVendorTypesSeeded(organizationId);
  const kindMap = await getBuiltinKindMap(organizationId);
  const vendorTypeId = kindMap.get(builtinKind);
  if (!vendorTypeId) {
    throw new HttpError(500, `Built-in vendor type "${builtinKind}" missing for lab`);
  }

  const allExisting = await db
    .select({ name: vendors.name, vendorType: vendors.vendorType })
    .from(vendors)
    .where(
      and(
        eq(vendors.labOrganizationId, organizationId),
        eq(vendors.isActive, true),
        sql`${vendors.deletedAt} IS NULL`
      )
    );

  const sameTypeNames = new Set(
    allExisting
      .filter((r) => r.vendorType === builtinKind)
      .map((r) => r.name.toLowerCase())
  );
  const crossTypeNames = new Set(
    allExisting
      .filter((r) => r.vendorType !== builtinKind)
      .map((r) => r.name.toLowerCase())
  );

  let skippedSameType = 0;
  let skippedCrossType = 0;
  const toInsert = records.filter((r) => {
    const lower = r.name.trim().toLowerCase();
    if (sameTypeNames.has(lower)) {
      skippedSameType++;
      return false;
    }
    if (crossTypeNames.has(lower)) {
      skippedCrossType++;
      return false;
    }
    return true;
  });
  const skipped = skippedSameType + skippedCrossType;

  if (toInsert.length === 0) {
    return { imported: 0, skipped, skippedSameType, skippedCrossType };
  }

  const normalizePrice = (raw: string | null | undefined): string | null => {
    if (raw == null) return null;
    const cleaned = String(raw).replace(/[$,\s]/g, "").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return null;
    return n.toFixed(2);
  };

  const inserted = await db
    .insert(vendors)
    .values(
      toInsert.map((r) => ({
        labOrganizationId: organizationId,
        name: r.name.trim(),
        address: r.address ?? null,
        city: r.city ?? null,
        state: r.state ?? null,
        zip: r.zip ?? null,
        phone: r.phone ?? null,
        email: r.email ?? null,
        website: r.website ?? null,
        notes: r.notes ?? null,
        unitPrice: builtinKind === "item" ? normalizePrice(r.unitPrice) : null,
        priceKey: builtinKind === "item" ? (r.priceKey ?? null) : null,
        vendorType: builtinKind,
        vendorTypeId,
        isActive: true,
      }))
    )
    .returning({ id: vendors.id });
  return { imported: inserted.length, skipped, skippedSameType, skippedCrossType };
}

router.post(
  "/vendors/import",
  asyncHandler(async (req, res) => {
    const input = z.object({
      organizationId: z.string().min(1),
      records: z.array(importRecordSchema).min(1).max(1000),
    }).parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, BILLING_ROLES);
    const result = await importVendorRecords(input.organizationId, "vendor", input.records);
    return ok(res, result);
  }),
);

router.post(
  "/employees/import",
  asyncHandler(async (req, res) => {
    const input = z.object({
      organizationId: z.string().min(1),
      records: z.array(importRecordSchema).min(1).max(1000),
    }).parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, BILLING_ROLES);
    const result = await importVendorRecords(input.organizationId, "employee", input.records);
    return ok(res, result);
  }),
);

router.post(
  "/items/import",
  asyncHandler(async (req, res) => {
    const input = z.object({
      organizationId: z.string().min(1),
      records: z.array(importRecordSchema).min(1).max(1000),
    }).parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, BILLING_ROLES);
    const result = await importVendorRecords(input.organizationId, "item", input.records);
    return ok(res, result);
  }),
);

router.post(
  "/vendors/:vendorId/merge",
  asyncHandler(async (req, res) => {
    const { vendorId } = req.params;
    const { canonicalVendorId, dryRun } = z.object({
      canonicalVendorId: z.string().min(1),
      dryRun: z.boolean().optional().default(false),
    }).parse(req.body);

    if (vendorId === canonicalVendorId) {
      throw new HttpError(400, "Cannot merge a vendor into itself.");
    }

    const [source] = await db
      .select()
      .from(vendors)
      .where(eq(vendors.id, vendorId))
      .limit(1);
    if (!source || source.deletedAt) throw new HttpError(404, "Vendor not found");

    const [canonical] = await db
      .select()
      .from(vendors)
      .where(eq(vendors.id, canonicalVendorId))
      .limit(1);
    if (!canonical || canonical.deletedAt) throw new HttpError(404, "Canonical vendor not found");

    if (source.labOrganizationId !== canonical.labOrganizationId) {
      throw new HttpError(400, "Both vendors must belong to the same lab.");
    }

    await requireAnyRole(uid(req), source.labOrganizationId, BILLING_ROLES);

    const [txRow] = await db
      .select({ count: sql<string>`count(*)` })
      .from(bankTransactions)
      .where(and(eq(bankTransactions.vendorId, vendorId), sql`${bankTransactions.deletedAt} IS NULL`));
    const transactionsRelinked = Number(txRow?.count ?? 0);

    const [recurRow] = await db
      .select({ count: sql<string>`count(*)` })
      .from(recurringTransactions)
      .where(eq(recurringTransactions.vendorId, vendorId));
    const recurringRelinked = Number(recurRow?.count ?? 0);

    if (dryRun) {
      return ok(res, { transactionsRelinked, recurringRelinked, dryRun: true });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      if (transactionsRelinked > 0) {
        await tx
          .update(bankTransactions)
          .set({ vendorId: canonicalVendorId, updatedAt: now })
          .where(and(eq(bankTransactions.vendorId, vendorId), sql`${bankTransactions.deletedAt} IS NULL`));
      }

      if (recurringRelinked > 0) {
        await tx
          .update(recurringTransactions)
          .set({ vendorId: canonicalVendorId, updatedAt: now })
          .where(eq(recurringTransactions.vendorId, vendorId));
      }

      await tx
        .update(vendors)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(vendors.id, vendorId));
    });

    return ok(res, { transactionsRelinked, recurringRelinked, dryRun: false });
  }),
);

router.patch(
  "/vendors/:vendorId",
  asyncHandler(async (req, res) => {
    const { vendorId } = req.params;
    const input = vendorBodySchema.parse(req.body);
    const [existing] = await db
      .select()
      .from(vendors)
      .where(eq(vendors.id, vendorId))
      .limit(1);
    if (!existing || existing.deletedAt) throw new HttpError(404, "Vendor not found");
    await requireAnyRole(uid(req), existing.labOrganizationId, BILLING_ROLES);
    if (input.name !== undefined) {
      const trimmedName = input.name.trim();
      const [dupe] = await db
        .select({ id: vendors.id })
        .from(vendors)
        .where(
          and(
            eq(vendors.labOrganizationId, existing.labOrganizationId),
            sql`lower(${vendors.name}) = lower(${trimmedName})`,
            sql`${vendors.deletedAt} IS NULL`,
            ne(vendors.id, vendorId)
          )
        )
        .limit(1);
      if (dupe) throw new HttpError(409, "A payee with this name already exists in this lab.");
    }
    const updates: Partial<typeof vendors.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.address !== undefined) updates.address = input.address;
    if (input.city !== undefined) updates.city = input.city;
    if (input.state !== undefined) updates.state = input.state;
    if (input.zip !== undefined) updates.zip = input.zip;
    if (input.phone !== undefined) updates.phone = input.phone;
    if (input.email !== undefined) updates.email = input.email;
    if (input.website !== undefined) updates.website = input.website;
    if (input.notes !== undefined) updates.notes = input.notes;
    if (input.vendorTypeId !== undefined || input.vendorType !== undefined) {
      await ensureVendorTypesSeeded(existing.labOrganizationId);
      const resolved = await resolveVendorTypeId(
        existing.labOrganizationId,
        { vendorTypeId: input.vendorTypeId, vendorType: input.vendorType },
      );
      if (!resolved) {
        throw new HttpError(400, "Unknown vendor type for this lab.");
      }
      updates.vendorTypeId = resolved.id;
      updates.vendorType = resolved.builtinKind ?? "vendor";
    }
    if (input.paymentTermsDays !== undefined) {
      updates.paymentTermsDays = input.paymentTermsDays;
    }
    if (input.isActive !== undefined) updates.isActive = input.isActive;
    if (input.unitPrice !== undefined) {
      const normalizePatchPrice = (raw: string | null | undefined): string | null => {
        if (raw == null) return null;
        const cleaned = String(raw).replace(/[$,\s]/g, "").trim();
        if (!cleaned) return null;
        const n = Number(cleaned);
        if (!Number.isFinite(n)) return null;
        return n.toFixed(2);
      };
      updates.unitPrice = normalizePatchPrice(input.unitPrice);
    }
    if (input.itemCategory !== undefined) updates.itemCategory = input.itemCategory;
    const [updated] = await db
      .update(vendors)
      .set(updates)
      .where(eq(vendors.id, vendorId))
      .returning();
    const types = await listVendorTypes(existing.labOrganizationId);
    const typesById = new Map(types.map((t) => [t.id, t]));
    return ok(res, enrichVendor(updated, typesById));
  }),
);

router.delete(
  "/vendors/:vendorId",
  asyncHandler(async (req, res) => {
    const { vendorId } = req.params;
    // `?hard=true` removes the row from all lists (soft-delete via deletedAt),
    // versus the default which only deactivates it (isActive=false, still shown
    // greyed-out). The FKs that point at vendors use ON DELETE SET NULL, so
    // referencing transactions are preserved; the row is recoverable via
    // deletedAt.
    const hard = req.query.hard === "true";
    const [existing] = await db
      .select()
      .from(vendors)
      .where(eq(vendors.id, vendorId))
      .limit(1);
    if (!existing || existing.deletedAt) throw new HttpError(404, "Vendor not found");
    await requireAnyRole(uid(req), existing.labOrganizationId, BILLING_ROLES);
    const [updated] = await db
      .update(vendors)
      .set(
        hard
          ? {
              deletedAt: new Date(),
              deletedByUserId: uid(req),
              isActive: false,
              updatedAt: new Date(),
            }
          : { isActive: false, updatedAt: new Date() },
      )
      .where(eq(vendors.id, vendorId))
      .returning();
    return ok(res, updated);
  }),
);

// ─────────────────── Vendor-link backfill helper ───────────────────
// Shared logic used by the admin preview/run endpoints in labtrax-routes.ts.
// Mirrors the matching rules in scripts/src/backfill-vendor-links.ts.

function normalisePayee(s: string): string {
  return s.trim().toLowerCase();
}

export interface BackfillLabSummary {
  labId: string;
  matched: number;
  ambiguous: number;
  noMatch: number;
}

export interface BackfillReport {
  labs: BackfillLabSummary[];
  totals: { matched: number; ambiguous: number; noMatch: number };
}

/**
 * Scan unlinked bank_transactions for every supplied labId and match them
 * against each lab's active vendor names (case-insensitive, exact).
 *
 * When `applyChanges` is false the function is a pure dry-run: it counts
 * what would change but writes nothing.  When `applyChanges` is true each
 * unambiguously matched row is updated (vendorId set) with a re-run guard.
 */
export async function runVendorLinkBackfill(
  labIds: string[],
  applyChanges: boolean
): Promise<BackfillReport> {
  const labs: BackfillLabSummary[] = [];
  let totalMatched = 0;
  let totalAmbiguous = 0;
  let totalNoMatch = 0;

  for (const labId of labIds) {
    const rows = await db
      .select({ id: bankTransactions.id, payee: bankTransactions.payee })
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.labOrganizationId, labId),
          isNotNull(bankTransactions.payee),
          isNull(bankTransactions.vendorId),
          isNull(bankTransactions.deletedAt)
        )
      );

    const summary: BackfillLabSummary = {
      labId,
      matched: 0,
      ambiguous: 0,
      noMatch: 0,
    };

    if (rows.length === 0) {
      labs.push(summary);
      continue;
    }

    const labVendors = await db
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(
        and(
          eq(vendors.labOrganizationId, labId),
          eq(vendors.isActive, true),
          isNull(vendors.deletedAt)
        )
      );

    if (labVendors.length === 0) {
      summary.noMatch = rows.length;
      labs.push(summary);
      totalNoMatch += rows.length;
      continue;
    }

    // Build normalised-name → vendor-id map.
    // null value = two or more vendors share the same normalised name (ambiguous).
    const nameMap = new Map<string, string | null>();
    for (const v of labVendors) {
      const key = normalisePayee(v.name);
      if (nameMap.has(key)) {
        nameMap.set(key, null);
      } else {
        nameMap.set(key, v.id);
      }
    }

    for (const row of rows) {
      if (!row.payee) continue;
      const key = normalisePayee(row.payee);
      if (!nameMap.has(key)) {
        summary.noMatch++;
        continue;
      }
      const vendorId = nameMap.get(key)!;
      if (vendorId === null) {
        summary.ambiguous++;
        continue;
      }
      if (applyChanges) {
        // Re-run guard: only write if vendor_id is still null
        await db
          .update(bankTransactions)
          .set({ vendorId, updatedAt: sql`now()` })
          .where(
            and(
              eq(bankTransactions.id, row.id),
              isNull(bankTransactions.vendorId)
            )
          );
      }
      summary.matched++;
    }

    labs.push(summary);
    totalMatched += summary.matched;
    totalAmbiguous += summary.ambiguous;
    totalNoMatch += summary.noMatch;
  }

  return {
    labs,
    totals: { matched: totalMatched, ambiguous: totalAmbiguous, noMatch: totalNoMatch },
  };
}

// ---------------------------------------------------------------------------
// Undeposited Funds workflow
// ---------------------------------------------------------------------------

// GET /finance/undeposited-funds?organizationId=&summary=1
// With ?summary=1 returns { count, total } for sidebar badge use.
// With ?selection=ids returns the identifiers and amounts of every match, so a
// paged client can select the whole filtered set rather than the loaded batch.
// Without either, returns transactions enriched with invoice info.
const emptyUndepositedSelection = { selection: [] as Array<{ id: string; creditAmount: string }>, total: 0, amountTotal: "0.00" };
router.get(
  "/undeposited-funds",
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query);
    const orgId = req.query.organizationId as string | undefined;
    const practiceId = typeof req.query.practiceId === "string" ? req.query.practiceId : undefined;
    const doctorKey = typeof req.query.doctorKey === "string" ? req.query.doctorKey : undefined;
    if (!orgId) throw new HttpError(400, "organizationId is required.");
    await requireAnyRole(uid(req), orgId, ADMIN_ROLES);

    const isSummary = req.query.summary === "1";
    const isSelection = !isSummary && req.query.selection === "ids";

    const ufAccount = await db.query.bankAccounts.findFirst({
      where: and(
        eq(bankAccounts.labOrganizationId, orgId),
        eq(bankAccounts.accountType, "undeposited_funds")
      ),
    });
    if (!ufAccount) {
      return ok(
        res,
        isSummary
          ? { count: 0, total: 0 }
          : isSelection
            ? emptyUndepositedSelection
            : pagination.active
              ? { ...pageRowsKeyset([], pagination, bankTransactionKeyset), amountTotal: "0.00", staleCount: 0 }
              : [],
      );
    }

    const txns = await db.query.bankTransactions.findMany({
      where: and(
        eq(bankTransactions.bankAccountId, ufAccount.id),
        eq(bankTransactions.status, "posted"),
        ne(bankTransactions.status, "deposited_child"),
        isNull(bankTransactions.deletedAt)
      ),
      orderBy: [
        desc(bankTransactions.txnDate),
        desc(bankTransactions.createdAt),
        desc(bankTransactions.id),
      ],
    });

    if (isSummary) {
      const count = txns.length;
      const total = txns.reduce(
        (sum: number, t: any) => sum + parseFloat(t.creditAmount ?? "0"),
        0
      );
      return ok(res, { count, total });
    }

    if (!txns.length) {
      return ok(res, isSelection
        ? emptyUndepositedSelection
        : pagination.active
          ? { ...pageRowsKeyset([], pagination, bankTransactionKeyset), amountTotal: "0.00", staleCount: 0 }
          : []);
    }

    const txnIds = txns.map((t: any) => t.id);
    const paymentSessions = await db
      .select()
      .from(statementPaymentSessions)
      .where(inArray(statementPaymentSessions.bankTransactionId, txnIds));
    const paymentSessionByTxn = new Map(
      paymentSessions
        .filter((session) => !!session.bankTransactionId)
        .map((session) => [session.bankTransactionId!, session]),
    );
    const paymentSessionIds = paymentSessions.map((session) => session.id);
    const accountCreditRows = paymentSessionIds.length
      ? await db
          .select()
          .from(customerCredits)
          .where(inArray(customerCredits.paymentSessionId, paymentSessionIds))
      : [];
    const accountCreditBySession = new Map(
      accountCreditRows.map((credit) => [credit.paymentSessionId, credit]),
    );
    const links = await db
      .select()
      .from(bankTransactionInvoices)
      .where(inArray(bankTransactionInvoices.bankTransactionId, txnIds));
    const invoiceIds = [...new Set(links.map((l: any) => l.invoiceId))];
    let invMap = new Map<string, any>();
    if (invoiceIds.length) {
      const invRows = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          doctorIdentity: invoices.doctorIdentity,
          displayMetadataJson: invoices.displayMetadataJson,
        })
        .from(invoices)
        .where(inArray(invoices.id, invoiceIds));
      for (const r of invRows) invMap.set(r.id, r);
    }
    const linksByTxn = new Map<string, string[]>();
    for (const l of links) {
      const list = linksByTxn.get(l.bankTransactionId) ?? [];
      list.push(l.invoiceId);
      linksByTxn.set(l.bankTransactionId, list);
    }

    // Build a map from invoiceId → latest statement periodEnd so each
    // transaction can surface the statement date that covers its invoices.
    const invoiceIdSet = new Set(invoiceIds);
    const statementDateByInvoiceId = new Map<string, Date>();
    if (invoiceIdSet.size > 0) {
      const stmts = await db.query.practiceStatements.findMany({
        where: eq(practiceStatements.labOrganizationId, orgId),
        columns: { periodEnd: true, invoiceIdsJson: true },
      });
      for (const stmt of stmts) {
        const ids = Array.isArray(stmt.invoiceIdsJson)
          ? (stmt.invoiceIdsJson as unknown as string[])
          : [];
        for (const id of ids) {
          if (invoiceIdSet.has(id)) {
            const existing = statementDateByInvoiceId.get(id);
            if (!existing || stmt.periodEnd > existing) {
              statementDateByInvoiceId.set(id, stmt.periodEnd);
            }
          }
        }
      }
    }

    const now = Date.now();
    const MS_PER_DAY = 86_400_000;
    const STALE_THRESHOLD_DAYS = 30;

    const enriched = txns.map((t: any) => {
      const txnMs = new Date(t.txnDate).getTime();
      const staleDays = Math.floor((now - txnMs) / MS_PER_DAY);
      const txnInvoiceIds = linksByTxn.get(t.id) ?? [];
      // Pick the latest statement periodEnd across all linked invoices.
      let statementDate: string | null = null;
      for (const id of txnInvoiceIds) {
        const d = statementDateByInvoiceId.get(id);
        if (d) {
          if (!statementDate || d.toISOString() > statementDate) {
            statementDate = d.toISOString();
          }
        }
      }
      return {
        ...t,
        staleDays,
        ageWarning: staleDays > STALE_THRESHOLD_DAYS,
        statementDate,
        invoiceLinks: txnInvoiceIds.map((id) => ({
          invoiceId: id,
          invoiceNumber: invMap.get(id)?.invoiceNumber ?? null,
          doctorIdentity: invMap.get(id)?.doctorIdentity ?? null,
          doctorDisplayName: invMap.get(id)
            ? invoiceDoctorDisplayName(invMap.get(id))
            : null,
        })),
        ...doctorAttributionFromLinks(
          txnInvoiceIds.map((id) => {
            const invoice = invMap.get(id);
            return {
              doctorIdentity: invoice?.doctorIdentity ?? null,
              doctorDisplayName: invoice ? invoiceDoctorDisplayName(invoice) : null,
            };
          }),
        ),
        paymentSession: (() => {
          const session = paymentSessionByTxn.get(t.id);
          if (!session) return null;
          const credit = accountCreditBySession.get(session.id);
          return {
            id: session.id,
            receiptNumber: session.receiptNumber,
            statementId: session.statementId,
            providerOrganizationId: session.providerOrganizationId,
            practiceName: session.customerName,
            doctorIdentity: session.doctorIdentity,
            doctorDisplayName: session.doctorDisplayName,
            receivedAmount: session.receivedAmount,
            appliedAmount: session.appliedAmount,
            customerCreditAmount: session.customerCreditAmount,
            customerCreditRemaining: credit?.remainingAmount ?? "0.00",
            paymentMethod: session.paymentMethod,
            checkNumber: session.checkNumber,
            cardLast4: session.cardLast4,
            status: session.status,
          };
        })(),
      };
    });

    // Mirror the desktop's compatibility predicate exactly. Filtering after
    // enrichment is intentional because practice and doctor attribution comes
    // from payment sessions and linked invoice snapshots.
    const filtered = enriched.filter((row) => {
      const rowPracticeId =
        row.practiceId ||
        row.providerOrganizationId ||
        row.paymentSession?.providerOrganizationId ||
        "";
      if (practiceId && practiceId !== "all" && rowPracticeId !== practiceId) return false;
      const doctorKeys = (row.doctorIdentityKeys?.length
        ? row.doctorIdentityKeys
        : [
            row.doctorIdentity,
            row.paymentSession?.doctorIdentity,
            row.doctorName,
            row.paymentSession?.doctorName,
          ])
        .map((value: string | null | undefined) => normalizeLegacyDoctorName(value ?? null))
        .filter((value: string | null): value is string => Boolean(value));
      if (doctorKey === "entire") return doctorKeys.length === 0;
      return !doctorKey || doctorKey === "all" ||
        doctorKeys.includes(normalizeLegacyDoctorName(doctorKey) ?? "");
    });
    const amountTotal = filtered.reduce(
      (sum, row) => sum + Number(row.creditAmount ?? 0),
      0,
    );
    // Selection mode answers "which payments does this filter match?" without
    // shipping the enriched rows, so Select all can cover matches the client
    // has not paged in yet.
    if (isSelection) {
      return ok(res, {
        selection: filtered.map((row) => ({
          id: row.id,
          creditAmount: String(row.creditAmount ?? "0"),
        })),
        total: filtered.length,
        amountTotal: amountTotal.toFixed(2),
      });
    }
    if (!pagination.active) return ok(res, filtered);
    const practices = new Map<string, string>();
    const doctors = new Map<string, { practiceId: string; identity: string; displayName: string }>();
    for (const row of enriched) {
      const rowPracticeId =
        row.practiceId ||
        row.providerOrganizationId ||
        row.paymentSession?.providerOrganizationId ||
        "";
      const practiceName =
        row.practiceName ||
        row.providerName ||
        row.paymentSession?.practiceName ||
        "Unknown practice";
      if (rowPracticeId) practices.set(rowPracticeId, practiceName);
      const identities: string[] = row.doctorIdentityKeys?.length
        ? row.doctorIdentityKeys
        : [
            row.doctorIdentity,
            row.paymentSession?.doctorIdentity,
            row.doctorName,
            row.paymentSession?.doctorName,
          ].filter((value: string | null | undefined): value is string => Boolean(value));
      const displayNames: string[] = row.doctorDisplayNames ?? [];
      identities.forEach((identity, index) => {
        const normalized = normalizeLegacyDoctorName(identity);
        if (!normalized) return;
        doctors.set(`${rowPracticeId}:${normalized}`, {
          practiceId: rowPracticeId,
          identity: normalized,
          displayName: displayNames[index] || row.doctorDisplayName || identity,
        });
      });
    }
    return ok(res, {
      ...pageRowsKeyset(filtered, pagination, bankTransactionKeyset),
      amountTotal: amountTotal.toFixed(2),
      staleCount: filtered.filter((row) => row.ageWarning).length,
      filterOptions: {
        practices: [...practices].map(([id, name]) => ({ id, name })),
        doctors: [...doctors.values()],
      },
    });
  })
);

// POST /finance/make-deposits
// Moves transactions from Undeposited Funds into a real bank account.
const makeDepositsSchema = z.object({
  organizationId: z.string().min(1),
  bankAccountId: z.string().min(1),
  depositDate: z.string().optional(),
  transactionIds: z.array(z.string().min(1)).min(1).max(500)
    .refine((ids) => new Set(ids).size === ids.length, "transactionIds must be unique"),
});

router.post(
  "/make-deposits",
  asyncHandler(async (req, res) => {
    const input = makeDepositsSchema.parse(req.body);
    await requireAnyRole(uid(req), input.organizationId, ADMIN_ROLES);
    if (new Set(input.transactionIds).size !== input.transactionIds.length) {
      throw new HttpError(400, "Each payment can only be selected once.");
    }
    const transactionIds = [...input.transactionIds].sort();

    const targetAccount = await db.query.bankAccounts.findFirst({
      where: eq(bankAccounts.id, input.bankAccountId),
    });
    if (
      !targetAccount ||
      targetAccount.labOrganizationId !== input.organizationId ||
      targetAccount.isArchived
    ) {
      throw new HttpError(400, "Target account not found or archived.");
    }
    if (targetAccount.accountType === "undeposited_funds") {
      throw new HttpError(400, "Cannot deposit into the Undeposited Funds account.");
    }

    const ufAccount = await db.query.bankAccounts.findFirst({
      where: and(
        eq(bankAccounts.labOrganizationId, input.organizationId),
        eq(bankAccounts.accountType, "undeposited_funds")
      ),
    });
    if (!ufAccount) throw new HttpError(404, "Undeposited Funds account not found.");

    const depositDate = input.depositDate
      ? new Date(input.depositDate)
      : new Date();
    const requestedDay = input.depositDate?.slice(0, 10);
    if (
      Number.isNaN(depositDate.getTime()) ||
      (requestedDay !== undefined &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDay) ||
          depositDate.toISOString().slice(0, 10) !== requestedDay))
    ) {
      throw new HttpError(400, "Invalid deposit date.");
    }

    const depositorId = uid(req);
    const depositedAt = new Date();
    let movedTxns: (typeof bankTransactions.$inferSelect)[] = [];
    let aggregateTransactionId: string | null = null;


    await db.transaction(async (tx) => {
      await lockDepositBatchMutations(tx, input.organizationId);
      // Lock the requested rows for update so that two concurrent duplicate
      // POSTs for the same transactionIds serialize here rather than both
      // passing the "still in UF?" check and double-depositing.
      const lockedRows = await tx
        .select()
        .from(bankTransactions)
        .where(inArray(bankTransactions.id, transactionIds))
        .orderBy(asc(bankTransactions.id))
        .for("update");

      // Detect any IDs that don't exist in the DB at all.
      const foundIds = new Set(lockedRows.map((r) => r.id));
      const missingCount = transactionIds.filter(
        (id) => !foundIds.has(id)
      ).length;
      if (missingCount > 0) {
        throw new HttpError(
          400,
          "One or more transactions were not found in Undeposited Funds."
        );
      }

      // After acquiring the lock, verify every row is still in THIS org's UF
      // account with status=posted.  A row that has already been moved (e.g. by
      // a concurrent first call) will no longer satisfy this condition.
      const notInUf = lockedRows.filter(
        (r) => r.labOrganizationId !== input.organizationId ||
          r.bankAccountId !== ufAccount.id ||
          r.status !== "posted" ||
          r.deletedAt !== null
      );
      if (notInUf.length > 0) {
        throw new HttpError(
          400,
          "One or more transactions are already deposited."
        );
      }
      const reserved = await tx
        .select({ transactionId: statementPaymentSessions.bankTransactionId })
        .from(statementPaymentSessions)
        .innerJoin(
          statementPaymentReversals,
          eq(statementPaymentReversals.paymentSessionId, statementPaymentSessions.id),
        )
        .where(and(
          inArray(statementPaymentSessions.bankTransactionId, transactionIds),
          inArray(statementPaymentReversals.status, [
            "pending_processor", "processing", "processor_succeeded",
          ]),
        ));
      if (reserved.length > 0) {
        throw new HttpError(
          409,
          "One or more card payments have a reversal in progress and cannot be deposited.",
        );
      }

      movedTxns = lockedRows;
      const totalCents = movedTxns.reduce(
        (sum, t) => sum + Math.round(Number(t.netAmount || "0") * 100), 0,
      );
      const movedIds = movedTxns.map((transaction) => transaction.id);
      const [movedLinks, movedSessions] = await Promise.all([
        tx.select({
          bankTransactionId: bankTransactionInvoices.bankTransactionId,
          invoiceId: bankTransactionInvoices.invoiceId,
          invoiceNumber: invoices.invoiceNumber,
        }).from(bankTransactionInvoices)
          .innerJoin(invoices, eq(invoices.id, bankTransactionInvoices.invoiceId))
          .where(inArray(bankTransactionInvoices.bankTransactionId, movedIds)),
        tx.select().from(statementPaymentSessions)
          .where(inArray(statementPaymentSessions.bankTransactionId, movedIds)),
      ]);
      const linksByTxn = new Map<string, Array<{ invoiceId: string; invoiceNumber: string }>>();
      for (const link of movedLinks) {
        const links = linksByTxn.get(link.bankTransactionId) ?? [];
        links.push({ invoiceId: link.invoiceId, invoiceNumber: link.invoiceNumber });
        linksByTxn.set(link.bankTransactionId, links);
      }
      const sessionsByTxn = new Map(movedSessions.map((session) => [session.bankTransactionId, session]));
      const [aggregate] = await tx.insert(bankTransactions).values({
        labOrganizationId: input.organizationId,
        bankAccountId: targetAccount.id,
        txnDate: depositDate,
        type: "deposit",
        payee: "Deposit batch",
        memo: `Deposit batch (${movedTxns.length} payments)`,
        debitAmount: "0.00",
        creditAmount: (totalCents / 100).toFixed(2),
        netAmount: (totalCents / 100).toFixed(2),
        cleared: true,
        clearedAt: depositedAt,
        status: "posted",
        source: "deposit_batch",
        createdByUserId: depositorId,
        depositedByUserId: depositorId,
        depositedAt,
      }).returning();
      aggregateTransactionId = aggregate.id;
      await tx.insert(bankDepositBatchMembers).values(
        movedTxns.map((t) => ({
          aggregateBankTransactionId: aggregate.id,
          childBankTransactionId: t.id,
          snapshot: {
            amount: t.netAmount,
            payee: t.payee,
            memo: t.memo,
            checkNumber: sessionsByTxn.get(t.id)?.checkNumber ?? t.checkNumber,
            paymentMethod: sessionsByTxn.get(t.id)?.paymentMethod ?? null,
            receiptNumber: sessionsByTxn.get(t.id)?.receiptNumber ?? null,
            paymentSessionId: sessionsByTxn.get(t.id)?.id ?? null,
            invoiceLinks: linksByTxn.get(t.id) ?? [],
          },
        })),
      );
      await tx.update(bankTransactions)
        .set({ status: "deposited_child", cleared: true, depositedByUserId: depositorId,
          depositedAt, updatedAt: new Date() })
        .where(inArray(bankTransactions.id, movedTxns.map((t) => t.id)));
      await tx
        .update(statementPaymentSessions)
        .set({ status: "deposited", updatedAt: new Date() })
        .where(
          inArray(
            statementPaymentSessions.bankTransactionId,
            movedTxns.map((transaction) => transaction.id),
          ),
        );
    });

    const totalAmount = movedTxns.reduce(
      (s: number, t: any) => s + Math.round(Number(t.netAmount) * 100), 0
    );
    return ok(res, {
      moved: movedTxns.length,
      totalAmount: (totalAmount / 100).toFixed(2),
      bankAccountId: targetAccount.id,
      aggregateTransactionId,
    });
  })
);

// DELETE /finance/payments/:bankTransactionId
// Reverses a "Receive Payment" batch: restores each invoice's balance, deletes
// the payment rows, and soft-deletes the bank transaction.
// Only undeposited (still in the Undeposited Funds account) and non-reconciled
// transactions can be deleted.
router.delete(
  "/payments/:bankTransactionId",
  asyncHandler(async (req, res) => {
    const callerId = uid(req);
    const txnId = String(req.params.bankTransactionId);

    // Load the bank transaction and verify it belongs to an org the caller
    // has admin access to.
    const txn = await db.query.bankTransactions.findFirst({
      where: and(
        eq(bankTransactions.id, txnId),
        isNull(bankTransactions.deletedAt)
      ),
    });
    if (!txn) throw new HttpError(404, "Payment transaction not found.");
    await requireAnyRole(callerId, txn.labOrganizationId, ADMIN_ROLES);

    // Only receive-payment (source="invoice") transactions can be reversed via
    // this endpoint. Other undeposited entries (manual credits, transfers, etc.)
    // are not backed by payments rows and must be edited through the register.
    if (txn.source !== "invoice") {
      throw new HttpError(
        400,
        "Only payments recorded via Receive Payments can be deleted from this screen."
      );
    }

    // Reconciled transactions cannot be deleted.
    if (txn.reconciled) {
      throw new HttpError(
        400,
        "Cannot delete a reconciled payment. Reconciled transactions require a journal entry to reverse."
      );
    }

    // Only allow deleting from the Undeposited Funds account — once a
    // payment has been moved to a real bank account it is "deposited" and
    // requires a reversal workflow instead.
    const ufAccount = await db.query.bankAccounts.findFirst({
      where: and(
        eq(bankAccounts.labOrganizationId, txn.labOrganizationId),
        eq(bankAccounts.accountType, "undeposited_funds")
      ),
    });
    if (!ufAccount || txn.bankAccountId !== ufAccount.id) {
      throw new HttpError(
        400,
        "Only undeposited payments can be deleted. Payments that have already been deposited require a reversal."
      );
    }

    await db.transaction(async (tx) => {
      await releaseBatchForChild(tx, txn.labOrganizationId, txnId);
      // Lock and re-read the bank transaction inside the transaction to
      // prevent a TOCTOU race where a concurrent Make Deposit moves the row
      // out of Undeposited Funds between our pre-check and the DELETE.
      const [lockedTxn] = await tx
        .select()
        .from(bankTransactions)
        .where(
          and(
            eq(bankTransactions.id, txnId),
            isNull(bankTransactions.deletedAt)
          )
        )
        .for("update");
      if (!lockedTxn) {
        throw new HttpError(404, "Payment transaction not found.");
      }
      if (lockedTxn.source !== "invoice") {
        throw new HttpError(
          400,
          "Only payments recorded via Receive Payments can be deleted from this screen."
        );
      }
      if (lockedTxn.reconciled) {
        throw new HttpError(
          400,
          "Cannot delete a reconciled payment. Reconciled transactions require a journal entry to reverse."
        );
      }
      if (lockedTxn.bankAccountId !== ufAccount.id) {
        throw new HttpError(
          400,
          "Only undeposited payments can be deleted. Payments that have already been deposited require a reversal."
        );
      }

      // Find all payment rows linked to this bank transaction.
      const linkedPayments = await tx
        .select()
        .from(payments)
        .where(eq(payments.bankTransactionId, txnId))
        .for("update");

      // Require at least one payment row — if none exist, this transaction
      // is not a receive-payment batch and should not be deleted via this path.
      if (linkedPayments.length === 0) {
        throw new HttpError(
          400,
          "No payment records are linked to this transaction. Use the register to edit it."
        );
      }

      // For each payment, restore the invoice balance and recalculate status.
      for (const pmt of linkedPayments) {
        const [inv] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, pmt.invoiceId))
          .for("update");
        if (!inv) continue;
        assertRecoveryReleased(inv);

        const restoredBalance =
          Number(inv.balanceDue) + Number(pmt.amount);
        const totalAmount = Number(inv.total ?? restoredBalance);
        let newStatus: string;
        if (restoredBalance < 0.005) {
          newStatus = "paid";
        } else if (restoredBalance >= totalAmount - 0.005) {
          newStatus = "open";
        } else {
          newStatus = "partially_paid";
        }

        await tx
          .update(invoices)
          .set({
            balanceDue: restoredBalance.toFixed(2),
            status: newStatus,
            updatedAt: new Date(),
          })
          .where(eq(invoices.id, inv.id));
      }

      // Hard-delete the payment rows, keeping a dated record that they
      // settled their invoices up to this moment.
      await archiveReversedSettlements(
        tx,
        linkedPayments.map((payment) => ({
          labOrganizationId: txn.labOrganizationId,
          invoiceId: payment.invoiceId,
          sourceType: "payment" as const,
          sourceId: payment.id,
          paymentSessionId: payment.paymentSessionId ?? null,
          amount: payment.amount,
          settledAt: payment.paidAt ?? new Date(),
          reversedByUserId: callerId,
        })),
      );
      await tx
        .delete(payments)
        .where(
          inArray(
            payments.id,
            linkedPayments.map((p) => p.id)
          )
        );

      // Remove the invoice↔transaction links so the deleted transaction no
      // longer surfaces in invoice-linked queries.
      await tx
        .delete(bankTransactionInvoices)
        .where(eq(bankTransactionInvoices.bankTransactionId, txnId));

      // Soft-delete the bank transaction.
      await tx
        .update(bankTransactions)
        .set({
          deletedAt: new Date(),
          deletedByUserId: callerId,
          updatedAt: new Date(),
        })
        .where(eq(bankTransactions.id, txnId));

      // Legacy Receive Payment batches now have a durable payment session as
      // well. Keep its lifecycle aligned with the existing reversal semantics
      // instead of leaving a cancelled payment looking active to other finance
      // readers that address sessions directly.
      await tx
        .update(statementPaymentSessions)
        .set({
          status: "cancelled",
          cancelledByUserId: callerId,
          cancelledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(statementPaymentSessions.bankTransactionId, txnId));
    });

    await writeAuditLog({
      req,
      organizationId: txn.labOrganizationId,
      action: "payment_deleted",
      entityType: "bank_transaction",
      entityId: txnId,
      metadataJson: { bankTransactionId: txnId },
    });

    return ok(res, { deleted: true });
  })
);

// ─────────────────────── AI Bank Statement Import ────────────────────────

const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"];
    cb(null, allowed.includes(file.mimetype) || file.originalname.match(/\.(pdf|png|jpg|jpeg|webp)$/i) !== null);
  },
});

// In-memory preview token store (TTL 30 min)
interface PreviewEntry {
  rows: ExtractedRow[];
  orgId: string;
  userId: string;
  expiresAt: number;
}
const previewStore = new Map<string, PreviewEntry>();

function genPreviewToken(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function cleanExpiredPreviews() {
  const now = Date.now();
  for (const [k, v] of previewStore) {
    if (v.expiresAt < now) previewStore.delete(k);
  }
}

const BANK_STATEMENT_SYSTEM_PROMPT = `You are a bank statement parser. Extract all transactions from the provided bank statement.
Return ONLY a JSON array of transaction objects. Each object must have these exact fields:
- txnDate: ISO date string "YYYY-MM-DD"
- description: payee/description text (string)
- checkNumber: check number if present, else null
- debit: withdrawal/payment amount as a positive number, or 0 if it is a deposit/credit
- credit: deposit/credit amount as a positive number, or 0 if it is a withdrawal/debit
- confidence: "high", "medium", or "low"

Rules:
- Amounts must be positive numbers (no negative values)
- If a row is a debit/withdrawal/payment: set debit > 0, credit = 0
- If a row is a credit/deposit: set credit > 0, debit = 0
- Skip header rows, balance rows, and summary lines — only include actual transactions
- confidence = "high" when date+amount are clearly readable, "medium" when either is estimated, "low" when both are uncertain

Return ONLY the JSON array, no markdown, no explanation.`;

async function extractTransactionsWithAI(
  fileBuffer: Buffer,
  mimeType: string,
  filename: string,
  logger: any
): Promise<ExtractedRow[]> {
  const openai = createOpenAIClient();
  if (!openai) throw new HttpError(422, "AI key not configured — only text-based PDFs are supported in this environment");

  let rawRows: any[] = [];

  if (mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
    // Text PDF: extract text with pdf-parse, then send to gpt-4o as text
    let pdfText = "";
    try {
      pdfText = await parsePdf(fileBuffer);
    } catch (err) {
      logger.warn({ err }, "pdf-parse failed, falling back to vision");
    }
    if (pdfText.trim().length > 100) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: BANK_STATEMENT_SYSTEM_PROMPT },
          { role: "user", content: `Bank statement text:\n\n${pdfText.slice(0, 50000)}` },
        ],
        temperature: 0,
        max_tokens: 4096,
      });
      const content = completion.choices[0]?.message?.content ?? "[]";
      rawRows = JSON.parse(content.replace(/```json\n?|```\n?/g, "").trim());
    } else {
      // Scanned PDF or empty text — send PDF bytes with the correct MIME type.
      // GPT-4o natively accepts application/pdf data URIs in the image_url field.
      const b64 = fileBuffer.toString("base64");
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: BANK_STATEMENT_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract all transactions from this scanned bank statement PDF:" },
              { type: "image_url", image_url: { url: `data:application/pdf;base64,${b64}`, detail: "high" } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 4096,
      });
      const content = completion.choices[0]?.message?.content ?? "[]";
      rawRows = JSON.parse(content.replace(/```json\n?|```\n?/g, "").trim());
    }
  } else {
    // Image file — send directly to vision
    const b64 = fileBuffer.toString("base64");
    const imgMime = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: BANK_STATEMENT_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract all transactions from this bank statement:" },
            { type: "image_url", image_url: { url: `data:${imgMime};base64,${b64}`, detail: "high" } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 4096,
    });
    const content = completion.choices[0]?.message?.content ?? "[]";
    rawRows = JSON.parse(content.replace(/```json\n?|```\n?/g, "").trim());
  }

  const extracted: ExtractedRow[] = [];
  let idx = 0;
  for (const r of rawRows) {
    if (!r || typeof r !== "object") continue;
    const dateStr = String(r.txnDate ?? r.date ?? "").slice(0, 10);
    if (!dateStr || isNaN(Date.parse(dateStr))) continue;
    extracted.push({
      rowIndex: idx++,
      txnDate: dateStr,
      description: String(r.description ?? r.payee ?? r.memo ?? "").slice(0, 500),
      checkNumber: r.checkNumber ? String(r.checkNumber).slice(0, 20) : null,
      debit: Math.max(0, Number(r.debit ?? 0)),
      credit: Math.max(0, Number(r.credit ?? 0)),
      confidence: (["high", "medium", "low"].includes(r.confidence) ? r.confidence : "medium") as "high" | "medium" | "low",
    });
  }
  return extracted;
}

// POST /finance/transactions/import/preview
// Admin+: upload a bank statement, extract transactions via AI, return preview
router.post(
  "/transactions/import/preview",
  statementUpload.single("file"),
  asyncHandler(async (req, res) => {
    const { organizationId, bankAccountId } = z
      .object({ organizationId: z.string().min(1), bankAccountId: z.string().min(1) })
      .parse(req.body);

    await requireAnyRole(uid(req), organizationId, ADMIN_ROLES);

    const acct = await db.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, bankAccountId) });
    if (!acct || acct.labOrganizationId !== organizationId) {
      throw new HttpError(404, "Bank account not found for this organization.");
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) throw new HttpError(400, "No file uploaded.");

    cleanExpiredPreviews();

    const rows = await extractTransactionsWithAI(
      file.buffer,
      file.mimetype,
      file.originalname,
      req.log
    );

    const annotated = await findDuplicateCandidates(organizationId, bankAccountId, rows);

    const previewToken = genPreviewToken();
    previewStore.set(previewToken, {
      rows,
      orgId: organizationId,
      userId: uid(req),
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    return ok(res, {
      previewToken,
      rows: annotated,
      filename: file.originalname,
      totalCount: annotated.length,
    });
  })
);

const confirmImportSchema = z.object({
  previewToken: z.string().min(1),
  organizationId: z.string().min(1),
  bankAccountId: z.string().min(1),
  sourceFilename: z.string().min(1),
  approvedRows: z.array(
    z.object({
      rowIndex: z.number().int(),
      txnDate: z.string(),
      description: z.string(),
      checkNumber: z.string().nullable().optional(),
      debit: z.number().min(0),
      credit: z.number().min(0),
    })
  ),
  skippedCount: z.number().int().min(0).default(0),
});

// POST /finance/transactions/import/confirm
// Admin+: commit approved rows from a preview session into the register
router.post(
  "/transactions/import/confirm",
  asyncHandler(async (req, res) => {
    const input = confirmImportSchema.parse(req.body);

    await requireAnyRole(uid(req), input.organizationId, ADMIN_ROLES);

    const acct = await db.query.bankAccounts.findFirst({ where: eq(bankAccounts.id, input.bankAccountId) });
    if (!acct || acct.labOrganizationId !== input.organizationId) {
      throw new HttpError(404, "Bank account not found.");
    }

    cleanExpiredPreviews();
    const preview = previewStore.get(input.previewToken);
    if (!preview) throw new HttpError(400, "Preview session expired or not found. Please re-upload the file.");
    if (preview.orgId !== input.organizationId) throw new HttpError(403, "Preview token does not match organization.");
    if (preview.userId !== uid(req)) throw new HttpError(403, "Preview token belongs to a different user.");
    if (preview.expiresAt < Date.now()) {
      previewStore.delete(input.previewToken);
      throw new HttpError(400, "Preview session has expired. Please re-upload the file.");
    }

    if (!input.approvedRows.length) {
      previewStore.delete(input.previewToken);
      return ok(res, { imported: 0, batchId: null });
    }

    const [batch] = await db.insert(bankImportBatches).values({
      organizationId: input.organizationId,
      bankAccountId: input.bankAccountId,
      sourceFilename: input.sourceFilename,
      importedByUserId: uid(req),
      transactionCount: input.approvedRows.length,
      skippedCount: input.skippedCount,
    }).returning();

    const insertValues = input.approvedRows.map((r) => {
      const debit = Math.max(0, r.debit);
      const credit = Math.max(0, r.credit);
      const net = credit - debit;
      const txnDate = new Date(r.txnDate);
      return {
        labOrganizationId: input.organizationId,
        bankAccountId: input.bankAccountId,
        txnDate,
        type: debit > 0 ? "payment" : "deposit",
        checkNumber: r.checkNumber ?? null,
        payee: r.description ?? null,
        memo: null as string | null,
        debitAmount: debit.toFixed(2),
        creditAmount: credit.toFixed(2),
        netAmount: net.toFixed(2),
        cleared: false,
        status: "posted" as const,
        source: "import" as const,
        importBatchId: batch.id,
        aiImportSource: input.sourceFilename,
        createdByUserId: uid(req),
      };
    });

    await db.insert(bankTransactions).values(insertValues).catch((err: unknown): never => wrapDbError(err));

    // Mirror the existing transaction-creation pipeline: soft-delete any
    // projected recurring transaction that matches each newly imported row.
    for (const v of insertValues) {
      const net = Number(v.creditAmount) - Number(v.debitAmount);
      if (net !== 0) {
        await replaceMatchingProjected(
          v.bankAccountId,
          v.txnDate,
          net,
          v.payee ?? null
        );
      }
    }

    previewStore.delete(input.previewToken);

    await writeAuditLog({
      userId: uid(req),
      organizationId: input.organizationId,
      action: "bank_import_confirmed",
      entityType: "bank_import_batch",
      entityId: batch.id,
      metadataJson: {
        batchId: batch.id,
        sourceFilename: input.sourceFilename,
        bankAccountId: input.bankAccountId,
        transactionCount: input.approvedRows.length,
        skippedCount: input.skippedCount,
      },
    });

    return ok(res, { imported: input.approvedRows.length, batchId: batch.id }, 201);
  })
);

export default router;
