import { Router } from "express";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  bankAccounts,
  bankTransactionInvoices,
  bankTransactions,
  invoices,
  organizationMemberships,
  organizations,
  recurringTransactions,
  reconciliationItems,
  reconciliations,
  transactionCategories,
} from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { softDelete, softDeleteById } from "../lib/soft-delete";
import { ADMIN_ROLES, BILLING_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

function uid(req: any): string {
  return req.auth.userId as string;
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
    const accounts = await db.query.bankAccounts.findMany({
      where: inArray(bankAccounts.labOrganizationId, orgIds),
      orderBy: [asc(bankAccounts.name)],
    });
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
      });
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

// ─────────────────────────── Register Transactions ───────────────────────

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
    const q = txnListQuery.parse(req.query);
    await requireAnyRole(uid(req), q.organizationId, BILLING_ROLES);
    const conds: any[] = [eq(bankTransactions.labOrganizationId, q.organizationId)];
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
      .orderBy(asc(bankTransactions.txnDate), asc(bankTransactions.createdAt));

    const txnIds = rows.map((r: any) => r.id);
    const linkRows = txnIds.length
      ? await db
          .select({
            bankTransactionId: bankTransactionInvoices.bankTransactionId,
            invoiceId: bankTransactionInvoices.invoiceId,
            invoiceNumber: invoices.invoiceNumber,
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
      Array<{ invoiceId: string; invoiceNumber: string }>
    >();
    for (const l of linkRows) {
      const arr = linksByTxn.get(l.bankTransactionId) ?? [];
      arr.push({ invoiceId: l.invoiceId, invoiceNumber: l.invoiceNumber });
      linksByTxn.set(l.bankTransactionId, arr);
    }

    // Compute running balance per-account.
    const running = new Map<string, number>();
    const enriched = rows.map((r: any) => {
      const cur = running.get(r.bankAccountId) ?? 0;
      const next = r.status === "void" ? cur : cur + Number(r.netAmount || 0);
      running.set(r.bankAccountId, next);
      return {
        ...r,
        runningBalance: next.toFixed(2),
        invoices: linksByTxn.get(r.id) ?? [],
      };
    });
    enriched.reverse();
    return ok(res, enriched);
  })
);

const txnSchema = z.object({
  bankAccountId: z.string().min(1),
  txnDate: z.string().min(1),
  type: z
    .enum(["check", "deposit", "withdraw", "transfer", "fee", "payment", "other"])
    .default("other"),
  checkNumber: z.string().nullable().optional(),
  payee: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  payment: z.coerce.number().min(0).default(0),
  deposit: z.coerce.number().min(0).default(0),
  cleared: z.boolean().optional(),
  status: z.enum(["posted", "projected", "void"]).default("posted"),
  invoiceIds: z.array(z.string().min(1)).optional(),
});

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

router.post(
  "/transactions",
  asyncHandler(async (req, res) => {
    const input = txnSchema.parse(req.body);
    const acct = await loadAccountOrThrow(uid(req), input.bankAccountId);
    await requireAnyRole(uid(req), acct.labOrganizationId, BILLING_ROLES);
    const debit = Number(input.payment || 0);
    const credit = Number(input.deposit || 0);
    const net = credit - debit;
    const cleared = input.cleared ?? false;
    const [row] = await db
      .insert(bankTransactions)
      .values({
        labOrganizationId: acct.labOrganizationId,
        bankAccountId: acct.id,
        txnDate: new Date(input.txnDate),
        type: input.type,
        checkNumber: input.checkNumber || null,
        payee: input.payee || null,
        memo: input.memo || null,
        categoryId: input.categoryId || null,
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
    return ok(res, row, 201);
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
    if (txn.reconciled) throw new HttpError(400, "Reconciled entries cannot be edited.");
    const input = txnSchema.partial().parse(req.body);
    const updates: any = { updatedAt: new Date() };
    if (input.txnDate) updates.txnDate = new Date(input.txnDate);
    if (input.type) updates.type = input.type;
    if (input.checkNumber !== undefined) updates.checkNumber = input.checkNumber;
    if (input.payee !== undefined) updates.payee = input.payee;
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
    const [row] = await db
      .update(bankTransactions)
      .set(updates)
      .where(eq(bankTransactions.id, txn.id))
      .returning();
    await syncTxnInvoiceLinks(
      row.id,
      row.labOrganizationId,
      input.invoiceIds
    );
    return ok(res, row);
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
        });
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
      const verify = input.transactionIds.length
        ? await tx.query.bankTransactions.findMany({
            where: and(
              eq(bankTransactions.bankAccountId, acct.id),
              inArray(bankTransactions.id, input.transactionIds),
              eq(bankTransactions.reconciled, false),
              eq(bankTransactions.status, "posted"),
              lte(bankTransactions.txnDate, stmtDate)
            ),
          })
        : [];
      if (verify.length !== input.transactionIds.length) {
        throw new HttpError(
          409,
          "Selected entries changed during finalize; please reload and retry."
        );
      }
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
      if (!ids.length) return ok(res, []);
      conds.push(inArray(reconciliations.labOrganizationId, ids));
    }
    const rows = await db
      .select()
      .from(reconciliations)
      .where(and(...conds))
      .orderBy(desc(reconciliations.statementDate));
    return ok(res, rows);
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
    return ok(res, rows);
  })
);

const recurringSchema = z.object({
  organizationId: z.string().min(1),
  bankAccountId: z.string().min(1),
  name: z.string().min(1),
  payee: z.string().nullable().optional(),
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
    const [row] = await db
      .insert(recurringTransactions)
      .values({
        labOrganizationId: input.organizationId,
        bankAccountId: input.bankAccountId,
        name: input.name,
        payee: input.payee || null,
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

router.patch(
  "/recurring/:id",
  asyncHandler(async (req, res) => {
    const rule = await db.query.recurringTransactions.findFirst({
      where: eq(recurringTransactions.id, String(req.params.id)),
    });
    if (!rule) throw new HttpError(404, "Recurring rule not found.");
    await requireAnyRole(uid(req), rule.labOrganizationId, BILLING_ROLES);
    const input = recurringSchema.partial().parse(req.body);
    const updates: any = { updatedAt: new Date() };
    for (const k of [
      "name",
      "payee",
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
      const existing = await findPostedNear(
        rule.bankAccountId,
        occDate,
        amount,
        rule.payee || rule.name
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
        payee: rule.payee || rule.name,
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
      });
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

export default router;
