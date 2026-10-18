/**
 * Integration tests for the accounts-payable subledger and the AP/AR reports
 * that read from it.
 *
 * Skipped when DATABASE_URL is not configured. Every row this suite inserts is
 * removed in afterAll, and each test creates its own vendor/account fixtures so
 * the suite is safe against a shared dev database.
 *
 * Coverage:
 *  - Enter Bills: creation, terms-derived due dates, duplicate-reference
 *    warnings, the settled-amount edit floor, voiding
 *  - Pay Bills: the $500 bill paid $200 then $300 journey, credit-funded
 *    payments posting no cash, multi-vendor runs producing distinct payments,
 *    idempotent replay, stale-eligibility rejection
 *  - Register integration: bill-payment transactions are not editable or
 *    deletable from the register
 *  - Reporting: AP aging buckets by due date, dated historical balances,
 *    unapplied credit shown separately, cross-tenant refusal
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-ap"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function isoDay(offsetDays: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

maybe("Accounts payable subledger (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const ownerId = rid("apowner");
  const memberId = rid("apmember");
  const outsiderId = rid("apoutsider");
  const labOrgId = rid("aplab");
  const otherLabOrgId = rid("aplab2");

  let ownerToken = "";
  let memberToken = "";
  let outsiderToken = "";
  let bankAccountId = "";
  let categoryId = "";

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return authLib.signAccessToken(userId, sessionId);
  }

  const app = () => appMod.default;

  async function createVendor(name: string, extra: Record<string, unknown> = {}) {
    const r = await request(app())
      .post("/api/finance/vendors")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ organizationId: labOrgId, name, ...extra });
    expect([200, 201]).toContain(r.status);
    return r.body.data.id as string;
  }

  async function createBill(body: Record<string, unknown>) {
    return request(app())
      .post("/api/finance/bills")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ organizationId: labOrgId, ...body });
  }

  async function payBills(body: Record<string, unknown>) {
    return request(app())
      .post("/api/finance/bill-payments")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        organizationId: labOrgId,
        paymentDate: isoDay(0),
        paymentMethod: "check",
        idempotencyKey: rid("idem"),
        ...body,
      });
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-ap";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: ownerId, username: `apowner_${ownerId}`, password: "x" },
      { id: memberId, username: `apmember_${memberId}`, password: "x" },
      { id: outsiderId, username: `apout_${outsiderId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("ApTestLab") },
      { id: otherLabOrgId, type: "lab", name: rid("ApOtherLab") },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m1"),
        labId: labOrgId,
        userId: ownerId,
        role: "owner",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
      {
        id: rid("m2"),
        labId: labOrgId,
        userId: memberId,
        role: "user",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
      {
        id: rid("m3"),
        labId: otherLabOrgId,
        userId: outsiderId,
        role: "owner",
        status: "active",
        approvedByUserId: outsiderId,
        joinedAt: new Date(),
      },
    ]);

    ownerToken = await makeSession(ownerId);

    const acct = await request(app())
      .post("/api/finance/accounts")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ organizationId: labOrgId, name: rid("ApChecking") });
    expect(acct.status).toBe(201);
    bankAccountId = acct.body.data.id;

    const cats = await request(app())
      .get(`/api/finance/categories?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(cats.status).toBe(200);
    const expense = (cats.body.data ?? []).find((c: any) => c.kind === "expense");
    categoryId = expense?.id ?? "";
    expect(categoryId).toBeTruthy();
  });

  beforeEach(async () => {
    ownerToken = await makeSession(ownerId);
    memberToken = await makeSession(memberId);
    outsiderToken = await makeSession(outsiderId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      bankTransactions,
      bankAccounts,
      userSessions,
      organizationMemberships,
      organizations,
      users,
      vendors,
      vendorBills,
      vendorBillLines,
      vendorBillEvents,
      vendorCredits,
      vendorPayments,
      vendorPaymentAllocations,
      transactionCategories,
    } = dbMod as any;

    const orgIds = [labOrgId, otherLabOrgId];
    const billIds = (
      await db
        .select({ id: vendorBills.id })
        .from(vendorBills)
        .where(inArray(vendorBills.labOrganizationId, orgIds))
    ).map((r: any) => r.id);
    const paymentIds = (
      await db
        .select({ id: vendorPayments.id })
        .from(vendorPayments)
        .where(inArray(vendorPayments.labOrganizationId, orgIds))
    ).map((r: any) => r.id);

    if (paymentIds.length) {
      await db
        .delete(vendorPaymentAllocations)
        .where(inArray(vendorPaymentAllocations.vendorPaymentId, paymentIds));
    }
    if (billIds.length) {
      await db.delete(vendorBillLines).where(inArray(vendorBillLines.billId, billIds));
      await db.delete(vendorBillEvents).where(inArray(vendorBillEvents.billId, billIds));
    }
    await db.delete(vendorPayments).where(inArray(vendorPayments.labOrganizationId, orgIds));
    await db.delete(vendorCredits).where(inArray(vendorCredits.labOrganizationId, orgIds));
    await db.delete(vendorBills).where(inArray(vendorBills.labOrganizationId, orgIds));

    const acctIds = (
      await db
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(inArray(bankAccounts.labOrganizationId, orgIds))
    ).map((r: any) => r.id);
    if (acctIds.length) {
      await db
        .delete(bankTransactions)
        .where(inArray(bankTransactions.bankAccountId, acctIds));
    }
    await db.delete(bankAccounts).where(inArray(bankAccounts.labOrganizationId, orgIds));
    await db.delete(vendors).where(inArray(vendors.labOrganizationId, orgIds));
    await db
      .delete(transactionCategories)
      .where(inArray(transactionCategories.labOrganizationId, orgIds));
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgIds));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [ownerId, memberId, outsiderId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [ownerId, memberId, outsiderId]));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await db
      .delete(users)
      .where(inArray(users.id, [ownerId, memberId, outsiderId]));
  });

  // ── Enter Bills ───────────────────────────────────────────────────────────

  it("saving an unpaid bill raises the payable without withdrawing cash", async () => {
    const vendorId = await createVendor(rid("Supplier"));

    const before = await request(app())
      .get(`/api/finance/transactions?bankAccountId=${bankAccountId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const beforeCount = (before.body.data?.transactions ?? before.body.data ?? []).length;

    const bill = await createBill({
      vendorId,
      billNumber: "INV-100",
      billDate: isoDay(-5),
      termsDays: 30,
      lines: [{ categoryId, description: "Alloy", amount: 500 }],
    });
    expect(bill.status).toBe(201);
    expect(Number(bill.body.data.total)).toBe(500);
    expect(Number(bill.body.data.balanceDue)).toBe(500);
    expect(bill.body.data.status).toBe("open");
    // Terms of 30 days from a bill dated 5 days ago.
    expect(bill.body.data.dueDate.slice(0, 10)).toBe(isoDay(25));

    const after = await request(app())
      .get(`/api/finance/transactions?bankAccountId=${bankAccountId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const afterCount = (after.body.data?.transactions ?? after.body.data ?? []).length;
    expect(afterCount).toBe(beforeCount);

    const summary = await request(app())
      .get(`/api/finance/vendors/${vendorId}/ap-summary?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(summary.status).toBe(200);
    expect(Number(summary.body.data.amountDue)).toBe(500);
    expect(summary.body.data.openBillCount).toBe(1);
  });

  it("answers a past-dated vendor summary with what was owed then", async () => {
    const vendorId = await createVendor(rid("DatedVendor"));
    const bill = await createBill({
      vendorId,
      billNumber: rid("DATED"),
      billDate: isoDay(-20),
      dueDate: isoDay(-5),
      lines: [{ categoryId, amount: "400.00", description: "Supplies" }],
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const billId = bill.body.data.id as string;

    const summaryAt = async (offsetDays: number) => {
      const r = await request(app())
        .get(
          `/api/finance/vendors/${vendorId}/ap-summary?organizationId=${labOrgId}&asOf=${isoDay(offsetDays)}`,
        )
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.data;
    };

    // Before the bill was entered the vendor was owed nothing.
    const beforeBill = await summaryAt(-25);
    expect(Number(beforeBill.amountDue)).toBe(0);
    expect(beforeBill.openBillCount).toBe(0);
    expect(beforeBill.bills).toHaveLength(0);

    // Entered but not yet due.
    const beforeDue = await summaryAt(-10);
    expect(Number(beforeDue.amountDue)).toBe(400);
    expect(Number(beforeDue.overdueAmount)).toBe(0);

    // Overdue, still unpaid.
    const overdue = await summaryAt(-1);
    expect(Number(overdue.amountDue)).toBe(400);
    expect(Number(overdue.overdueAmount)).toBe(400);

    const payment = await payBills({
      bankAccountId,
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 400, creditApplications: [] }] },
      ],
    });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);

    // Paying today settles the bill today; it does not unwind what the
    // vendor was owed last week.
    const afterPayment = await summaryAt(0);
    expect(Number(afterPayment.amountDue)).toBe(0);
    expect(Number((await summaryAt(-1)).amountDue)).toBe(400);
    expect(Number((await summaryAt(-1)).overdueAmount)).toBe(400);
  });

  it("a duplicate vendor invoice reference warns but can be acknowledged", async () => {
    const vendorId = await createVendor(rid("DupVendor"));
    const body = {
      vendorId,
      billNumber: "DUP-1",
      billDate: isoDay(-1),
      lines: [{ categoryId, description: "Wax", amount: 40 }],
    };

    const first = await createBill(body);
    expect(first.status).toBe(201);

    const second = await createBill(body);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("duplicate_bill_reference");
    expect(second.body.error.duplicates?.length).toBeGreaterThan(0);

    const acknowledged = await createBill({ ...body, acknowledgeDuplicateReference: true });
    expect(acknowledged.status).toBe(201);
  });

  it("a bill's total cannot be edited below what has already been settled", async () => {
    const vendorId = await createVendor(rid("EditVendor"));
    const bill = await createBill({
      vendorId,
      billDate: isoDay(-2),
      dueDate: isoDay(10),
      lines: [{ categoryId, description: "Porcelain", amount: 300 }],
    });
    const billId = bill.body.data.id;

    const paid = await payBills({
      bankAccountId,
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 200, creditApplications: [] }] },
      ],
    });
    expect(paid.status).toBe(201);

    const shrink = await request(app())
      .patch(`/api/finance/bills/${billId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        organizationId: labOrgId,
        lines: [{ categoryId, description: "Porcelain", amount: 150 }],
      });
    expect([400, 409]).toContain(shrink.status);

    const grow = await request(app())
      .patch(`/api/finance/bills/${billId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        organizationId: labOrgId,
        lines: [{ categoryId, description: "Porcelain", amount: 350 }],
      });
    expect(grow.status).toBe(200);
    expect(Number(grow.body.data.balanceDue)).toBe(150);
  });

  // ── Pay Bills ─────────────────────────────────────────────────────────────

  it("a $500 bill paid $200 then $300 settles exactly once with two withdrawals", async () => {
    const vendorId = await createVendor(rid("PartialVendor"));
    const bill = await createBill({
      vendorId,
      billNumber: "PART-1",
      billDate: isoDay(-10),
      dueDate: isoDay(-1),
      lines: [{ categoryId, description: "Zirconia", amount: 500 }],
    });
    const billId = bill.body.data.id;

    const first = await payBills({
      bankAccountId,
      referenceNumber: "1001",
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 200, creditApplications: [] }] },
      ],
    });
    expect(first.status).toBe(201);

    let detail = await request(app())
      .get(`/api/finance/bills/${billId}?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(detail.body.data.amountPaid)).toBe(200);
    expect(Number(detail.body.data.balanceDue)).toBe(300);
    expect(detail.body.data.status).toBe("partially_paid");

    const second = await payBills({
      bankAccountId,
      referenceNumber: "1002",
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 300, creditApplications: [] }] },
      ],
    });
    expect(second.status).toBe(201);

    detail = await request(app())
      .get(`/api/finance/bills/${billId}?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(detail.body.data.amountPaid)).toBe(500);
    expect(Number(detail.body.data.balanceDue)).toBe(0);
    expect(detail.body.data.status).toBe("paid");

    // Overpaying a settled bill is refused rather than silently absorbed.
    const third = await payBills({
      bankAccountId,
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 1, creditApplications: [] }] },
      ],
    });
    expect(third.status).toBe(409);

    // Exactly two register withdrawals, totalling the bill.
    const { db, bankTransactions } = dbMod as any;
    const rows = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.bankAccountId, bankAccountId));
    const forThisBill = rows.filter(
      (r: any) =>
        r.source === "bill_payment" && ["1001", "1002"].includes(r.checkNumber ?? ""),
    );
    expect(forThisBill).toHaveLength(2);
    const withdrawn = forThisBill.reduce(
      (sum: number, r: any) => sum + Number(r.debitAmount),
      0,
    );
    expect(withdrawn).toBe(500);
  });

  it("applying a vendor credit reduces the payable without moving cash", async () => {
    const vendorId = await createVendor(rid("CreditVendor"));
    const bill = await createBill({
      vendorId,
      billDate: isoDay(-3),
      dueDate: isoDay(5),
      lines: [{ categoryId, description: "Returned goods", amount: 120 }],
    });
    const billId = bill.body.data.id;

    const credit = await request(app())
      .post("/api/finance/vendor-credits")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        organizationId: labOrgId,
        vendorId,
        creditDate: isoDay(-2),
        categoryId,
        amount: 120,
      });
    expect(credit.status).toBe(201);
    const creditId = credit.body.data.id;

    const { db, bankTransactions } = dbMod as any;
    const before = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.bankAccountId, bankAccountId));

    const applied = await payBills({
      bankAccountId: null,
      vendorPayments: [
        {
          vendorId,
          allocations: [
            {
              billId,
              amount: 0,
              creditApplications: [{ vendorCreditId: creditId, amount: 120 }],
            },
          ],
        },
      ],
    });
    expect(applied.status).toBe(201);

    const detail = await request(app())
      .get(`/api/finance/bills/${billId}?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(detail.body.data.balanceDue)).toBe(0);
    expect(Number(detail.body.data.amountCredited)).toBe(120);
    expect(Number(detail.body.data.amountPaid)).toBe(0);

    const after = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.bankAccountId, bankAccountId));
    expect(after.length).toBe(before.length);

    // The credit is spent and cannot be applied twice.
    const reuse = await payBills({
      bankAccountId: null,
      vendorPayments: [
        {
          vendorId,
          allocations: [
            {
              billId,
              amount: 0,
              creditApplications: [{ vendorCreditId: creditId, amount: 10 }],
            },
          ],
        },
      ],
    });
    expect(reuse.status).toBe(409);
  });

  it("paying several vendors at once records one payment per vendor", async () => {
    const vendorA = await createVendor(rid("MultiA"));
    const vendorB = await createVendor(rid("MultiB"));
    const billA = (
      await createBill({
        vendorId: vendorA,
        billDate: isoDay(-4),
        dueDate: isoDay(2),
        lines: [{ categoryId, description: "A", amount: 75 }],
      })
    ).body.data.id;
    const billB = (
      await createBill({
        vendorId: vendorB,
        billDate: isoDay(-4),
        dueDate: isoDay(2),
        lines: [{ categoryId, description: "B", amount: 25 }],
      })
    ).body.data.id;

    const paid = await payBills({
      bankAccountId,
      vendorPayments: [
        { vendorId: vendorA, allocations: [{ billId: billA, amount: 75, creditApplications: [] }] },
        { vendorId: vendorB, allocations: [{ billId: billB, amount: 25, creditApplications: [] }] },
      ],
    });
    expect(paid.status).toBe(201);
    expect(paid.body.data.payments).toHaveLength(2);
    const vendorIds = paid.body.data.payments.map((p: any) => p.vendorId).sort();
    expect(vendorIds).toEqual([vendorA, vendorB].sort());
    const txnIds = paid.body.data.payments.map((p: any) => p.bankTransactionId);
    expect(new Set(txnIds).size).toBe(2);
  });

  it("replaying the same idempotency key does not pay twice", async () => {
    const vendorId = await createVendor(rid("IdemVendor"));
    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-4),
        dueDate: isoDay(3),
        lines: [{ categoryId, description: "Once", amount: 60 }],
      })
    ).body.data.id;

    const key = rid("idem");
    const body = {
      bankAccountId,
      idempotencyKey: key,
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 60, creditApplications: [] }] },
      ],
    };

    const first = await payBills(body);
    expect(first.status).toBe(201);
    const replay = await payBills(body);
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data.payments[0].id).toBe(
      first.body.data.payments[0].id,
    );

    const detail = await request(app())
      .get(`/api/finance/bills/${billId}?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(detail.body.data.amountPaid)).toBe(60);
    expect(Number(detail.body.data.balanceDue)).toBe(0);
  });

  it("matches idempotency keys exactly and rejects a reused key with a different request", async () => {
    const vendorId = await createVendor(rid("ExactIdemVendor"));
    const billOne = (
      await createBill({
        vendorId,
        billDate: isoDay(-5),
        dueDate: isoDay(4),
        lines: [{ categoryId, description: "First", amount: 40 }],
      })
    ).body.data.id;
    const billTwo = (
      await createBill({
        vendorId,
        billDate: isoDay(-5),
        dueDate: isoDay(4),
        lines: [{ categoryId, description: "Second", amount: 20 }],
      })
    ).body.data.id;

    // A second key that merely starts with the first must never replay it.
    const key = rid("idem");
    const longerKey = `${key}:extra`;

    const first = await payBills({
      bankAccountId,
      idempotencyKey: key,
      vendorPayments: [
        { vendorId, allocations: [{ billId: billOne, amount: 40, creditApplications: [] }] },
      ],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const other = await payBills({
      bankAccountId,
      idempotencyKey: longerKey,
      vendorPayments: [
        { vendorId, allocations: [{ billId: billTwo, amount: 20, creditApplications: [] }] },
      ],
    });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    expect(other.body.data.replayed).toBe(false);
    expect(other.body.data.payments[0].id).not.toBe(first.body.data.payments[0].id);
    const twoDetail = await request(app())
      .get(`/api/finance/bills/${billTwo}?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(twoDetail.body.data.balanceDue)).toBe(0);

    // The same key carrying a different request is a client bug, not a retry.
    const mismatched = await payBills({
      bankAccountId,
      idempotencyKey: key,
      vendorPayments: [
        { vendorId, allocations: [{ billId: billTwo, amount: 20, creditApplications: [] }] },
      ],
    });
    expect(mismatched.status, JSON.stringify(mismatched.body)).toBe(409);
  });

  it("replays concurrent retries of one submit instead of failing on the unique key", async () => {
    const vendorId = await createVendor(rid("RaceIdemVendor"));
    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-3),
        dueDate: isoDay(5),
        lines: [{ categoryId, description: "Raced", amount: 55 }],
      })
    ).body.data.id;

    const body = {
      bankAccountId,
      idempotencyKey: rid("idem"),
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 55, creditApplications: [] }] },
      ],
    };

    const [a, b] = await Promise.all([payBills(body), payBills(body)]);
    expect([a.status, b.status].sort(), JSON.stringify([a.body, b.body])).toEqual([200, 201]);
    expect(a.body.data.payments[0].id).toBe(b.body.data.payments[0].id);

    const detail = await request(app())
      .get(`/api/finance/bills/${billId}?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(detail.body.data.amountPaid)).toBe(55);
    expect(Number(detail.body.data.balanceDue)).toBe(0);
  });

  it("voiding a bill payment restores the bill balance and reverses the withdrawal", async () => {
    const vendorId = await createVendor(rid("VoidVendor"));
    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-6),
        dueDate: isoDay(1),
        lines: [{ categoryId, description: "Reversible", amount: 90 }],
      })
    ).body.data.id;

    const paid = await payBills({
      bankAccountId,
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 90, creditApplications: [] }] },
      ],
    });
    const paymentId = paid.body.data.payments[0].id;

    const voided = await request(app())
      .post(`/api/finance/bill-payments/${paymentId}/void`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ organizationId: labOrgId, reason: "wrong vendor" });
    expect(voided.status).toBe(200);

    const detail = await request(app())
      .get(`/api/finance/bills/${billId}?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(detail.body.data.balanceDue)).toBe(90);
    expect(detail.body.data.status).not.toBe("paid");
    expect(
      detail.body.data.events.some((e: any) => String(e.eventType).includes("void")),
    ).toBe(true);
  });

  it("a voided bill has no outstanding balance and cannot be paid", async () => {
    const vendorId = await createVendor(rid("VoidBillVendor"));
    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-6),
        dueDate: isoDay(1),
        lines: [{ categoryId, description: "Mistake", amount: 42 }],
      })
    ).body.data.id;

    const voided = await request(app())
      .post(`/api/finance/bills/${billId}/void`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ organizationId: labOrgId, reason: "entered twice" });
    expect(voided.status).toBe(200);
    expect(Number(voided.body.data.balanceDue)).toBe(0);
    expect(voided.body.data.status).toBe("void");

    const pay = await payBills({
      bankAccountId,
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 42, creditApplications: [] }] },
      ],
    });
    expect(pay.status).toBe(409);
  });

  // ── Register integration ──────────────────────────────────────────────────

  it("a bill-payment register entry cannot be edited or deleted from the register", async () => {
    const vendorId = await createVendor(rid("RegisterVendor"));
    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-2),
        dueDate: isoDay(4),
        lines: [{ categoryId, description: "Guarded", amount: 33 }],
      })
    ).body.data.id;

    const paid = await payBills({
      bankAccountId,
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 33, creditApplications: [] }] },
      ],
    });
    const txnId = paid.body.data.payments[0].bankTransactionId;
    expect(txnId).toBeTruthy();

    const edit = await request(app())
      .patch(`/api/finance/transactions/${txnId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ payment: 1 });
    expect(edit.status).toBe(409);

    const removed = await request(app())
      .delete(`/api/finance/transactions/${txnId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(removed.status).toBe(409);

    // Reconciling it is still allowed — that is a register task, not an edit.
    const cleared = await request(app())
      .patch(`/api/finance/transactions/${txnId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ cleared: true });
    expect(cleared.status).toBe(200);
  });

  it("an immediate check still posts without inventing a bill", async () => {
    const r = await request(app())
      .post("/api/finance/transactions")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        bankAccountId,
        txnDate: isoDay(0),
        type: "check",
        payee: "Utility Co",
        payment: 80,
        status: "posted",
      });
    expect(r.status).toBe(201);
    expect(Number(r.body.data.debitAmount)).toBe(80);
    expect(r.body.data.source).not.toBe("bill_payment");
    // No longer auto-filed under the legacy "Accounts Payable" expense label.
    expect(r.body.data.categoryId).toBeNull();
  });

  // ── Permissions and tenancy ───────────────────────────────────────────────

  it("a non-billing member cannot enter or pay bills", async () => {
    const vendorId = await createVendor(rid("PermVendor"));
    const denied = await request(app())
      .post("/api/finance/bills")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        organizationId: labOrgId,
        vendorId,
        billDate: isoDay(0),
        lines: [{ categoryId, description: "Nope", amount: 10 }],
      });
    expect(denied.status).toBe(403);

    const deniedList = await request(app())
      .get(`/api/finance/pay-bills?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(deniedList.status).toBe(403);
  });

  it("another lab cannot read this lab's bills or aging", async () => {
    const bills = await request(app())
      .get(`/api/finance/bills?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(bills.status).toBe(403);

    const aging = await request(app())
      .get(`/api/finance/reports/ap-aging?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(aging.status).toBe(403);
  });

  it("an inactive vendor keeps its history and can still be paid, but takes no new bills", async () => {
    const vendorId = await createVendor(rid("RetiredVendor"));
    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-20),
        dueDate: isoDay(-5),
        lines: [{ categoryId, description: "Legacy order", amount: 55 }],
      })
    ).body.data.id;

    const deactivate = await request(app())
      .patch(`/api/finance/vendors/${vendorId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ isActive: false });
    expect(deactivate.status).toBe(200);

    const summary = await request(app())
      .get(`/api/finance/vendors/${vendorId}/ap-summary?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(summary.status).toBe(200);
    expect(summary.body.data.vendor.isActive).toBe(false);
    expect(Number(summary.body.data.amountDue)).toBe(55);

    const newBill = await createBill({
      vendorId,
      billDate: isoDay(0),
      lines: [{ categoryId, description: "Too late", amount: 5 }],
    });
    expect(newBill.status).toBe(400);

    const paid = await payBills({
      bankAccountId,
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 55, creditApplications: [] }] },
      ],
    });
    expect(paid.status).toBe(201);
  });

  // ── Aging and historical reporting ────────────────────────────────────────

  it("AP aging buckets by due date and keeps unapplied credit separate", async () => {
    const vendorId = await createVendor(rid("AgingVendor"));
    await createBill({
      vendorId,
      billDate: isoDay(-120),
      dueDate: isoDay(-100),
      lines: [{ categoryId, description: "Very old", amount: 100 }],
    });
    await createBill({
      vendorId,
      billDate: isoDay(-50),
      dueDate: isoDay(-45),
      lines: [{ categoryId, description: "Mid", amount: 200 }],
    });
    await createBill({
      vendorId,
      billDate: isoDay(-1),
      dueDate: isoDay(20),
      lines: [{ categoryId, description: "Not yet due", amount: 300 }],
    });
    await request(app())
      .post("/api/finance/vendor-credits")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        organizationId: labOrgId,
        vendorId,
        creditDate: isoDay(-2),
        categoryId,
        amount: 25,
      });

    const aging = await request(app())
      .get(`/api/finance/reports/ap-aging?organizationId=${labOrgId}&detail=true`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(aging.status).toBe(200);
    const row = aging.body.data.rows.find((r: any) => r.vendorId === vendorId);
    expect(row).toBeDefined();
    expect(Number(row.buckets.d90_plus)).toBe(100);
    expect(Number(row.buckets.d31_60)).toBe(200);
    expect(Number(row.buckets.current)).toBe(300);
    expect(Number(row.total)).toBe(600);
    // Credit is reported beside the payable, never netted into it.
    expect(Number(row.unappliedCredit)).toBe(25);
    expect(row.bills).toHaveLength(3);
  });

  it("aging as of a past date ignores payments made after that date", async () => {
    const vendorId = await createVendor(rid("HistoryVendor"));
    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-30),
        dueDate: isoDay(-20),
        lines: [{ categoryId, description: "Historical", amount: 400 }],
      })
    ).body.data.id;
    expect(billId).toBeTruthy();

    await payBills({
      bankAccountId,
      paymentDate: isoDay(0),
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 400, creditApplications: [] }] },
      ],
    });

    const today = await request(app())
      .get(`/api/finance/reports/ap-aging?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(
      today.body.data.rows.find((r: any) => r.vendorId === vendorId),
    ).toBeUndefined();

    const past = await request(app())
      .get(
        `/api/finance/reports/ap-aging?organizationId=${labOrgId}&asOf=${isoDay(-10)}`,
      )
      .set("Authorization", `Bearer ${ownerToken}`);
    const pastRow = past.body.data.rows.find((r: any) => r.vendorId === vendorId);
    expect(pastRow).toBeDefined();
    expect(Number(pastRow.total)).toBe(400);

    // And a date before the bill existed shows nothing at all.
    const earlier = await request(app())
      .get(
        `/api/finance/reports/ap-aging?organizationId=${labOrgId}&asOf=${isoDay(-40)}`,
      )
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(
      earlier.body.data.rows.find((r: any) => r.vendorId === vendorId),
    ).toBeUndefined();
  });

  it("the balance sheet reports entered bills as a liability, not an expense-only figure", async () => {
    const vendorId = await createVendor(rid("BalanceVendor"));
    const before = await request(app())
      .get(
        `/api/finance/reports/balance-sheet?organizationId=${labOrgId}&asOfDate=${isoDay(0)}`,
      )
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(before.status).toBe(200);
    expect(before.body.data.basis).toBe("accrual");
    const apBefore = Number(before.body.data.liabilities.accountsPayable ?? 0);

    await createBill({
      vendorId,
      billDate: isoDay(0),
      dueDate: isoDay(30),
      lines: [{ categoryId, description: "Liability", amount: 250 }],
    });

    const after = await request(app())
      .get(
        `/api/finance/reports/balance-sheet?organizationId=${labOrgId}&asOfDate=${isoDay(0)}`,
      )
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(after.body.data.liabilities.accountsPayable)).toBeCloseTo(
      apBefore + 250,
      2,
    );
    expect(
      after.body.data.liabilities.items.some((i: any) => i.name === "Accounts payable"),
    ).toBe(true);
    expect(Array.isArray(after.body.data.limitations)).toBe(true);
  });

  it("unapplied vendor credit is an asset on the balance sheet, not netted into AP", async () => {
    const vendorId = await createVendor(rid("CreditAssetVendor"));
    const before = await request(app())
      .get(
        `/api/finance/reports/balance-sheet?organizationId=${labOrgId}&asOfDate=${isoDay(0)}`,
      )
      .set("Authorization", `Bearer ${ownerToken}`);
    const creditsBefore = Number(before.body.data.assets.vendorCredits ?? 0);
    const apBefore = Number(before.body.data.liabilities.accountsPayable ?? 0);
    const assetsBefore = Number(before.body.data.assets.total);

    await request(app())
      .post("/api/finance/vendor-credits")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        organizationId: labOrgId,
        vendorId,
        creditDate: isoDay(0),
        categoryId,
        amount: 75,
      });

    const after = await request(app())
      .get(
        `/api/finance/reports/balance-sheet?organizationId=${labOrgId}&asOfDate=${isoDay(0)}`,
      )
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(after.body.data.assets.vendorCredits)).toBeCloseTo(
      creditsBefore + 75,
      2,
    );
    expect(Number(after.body.data.assets.total)).toBeCloseTo(assetsBefore + 75, 2);
    // The credit is spendable value, never a reduction of what is owed.
    expect(Number(after.body.data.liabilities.accountsPayable)).toBeCloseTo(apBefore, 2);
  });

  it("applying a credit today leaves earlier aging reports unchanged", async () => {
    const vendorId = await createVendor(rid("DatedCreditVendor"));
    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-20),
        dueDate: isoDay(-5),
        lines: [{ categoryId, description: "Dated credit bill", amount: 120 }],
      })
    ).body.data.id;
    const creditId = (
      await request(app())
        .post("/api/finance/vendor-credits")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          organizationId: labOrgId,
          vendorId,
          creditDate: isoDay(-15),
          categoryId,
          amount: 50,
        })
    ).body.data.id;

    const asOfPast = `asOf=${isoDay(-3)}`;
    const beforeApply = await request(app())
      .get(`/api/finance/reports/ap-aging?organizationId=${labOrgId}&${asOfPast}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const pastRowBefore = beforeApply.body.data.rows.find(
      (r: any) => r.vendorId === vendorId,
    );
    expect(Number(pastRowBefore.unappliedCredit)).toBe(50);

    await payBills({
      bankAccountId,
      paymentDate: isoDay(0),
      vendorPayments: [
        {
          vendorId,
          allocations: [
            {
              billId,
              amount: 0,
              creditApplications: [{ vendorCreditId: creditId, amount: 50 }],
            },
          ],
        },
      ],
    });

    const afterApply = await request(app())
      .get(`/api/finance/reports/ap-aging?organizationId=${labOrgId}&${asOfPast}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const pastRowAfter = afterApply.body.data.rows.find(
      (r: any) => r.vendorId === vendorId,
    );
    // The credit was still unapplied then, so the dated report must not move.
    expect(Number(pastRowAfter.unappliedCredit)).toBe(50);
    expect(Number(pastRowAfter.total)).toBe(120);

    const todayRow = (
      await request(app())
        .get(`/api/finance/reports/ap-aging?organizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
    ).body.data.rows.find((r: any) => r.vendorId === vendorId);
    expect(Number(todayRow?.unappliedCredit ?? 0)).toBe(0);
    expect(Number(todayRow?.total ?? 0)).toBe(70);
  });

  it("a report dated before a payment void still shows the cash leaving the bank", async () => {
    const vendorId = await createVendor(rid("VoidCashVendor"));
    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-10),
        dueDate: isoDay(-2),
        lines: [{ categoryId, description: "Void cash", amount: 90 }],
      })
    ).body.data.id;
    const payment = await payBills({
      bankAccountId,
      paymentDate: isoDay(-1),
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 90, creditApplications: [] }] },
      ],
    });
    expect([200, 201]).toContain(payment.status);
    const paymentId = payment.body.data.payments[0].id as string;

    const datedUrl =
      `/api/finance/reports/balance-sheet?organizationId=${labOrgId}&asOfDate=${isoDay(-1)}`;
    const todayUrl =
      `/api/finance/reports/balance-sheet?organizationId=${labOrgId}&asOfDate=${isoDay(0)}`;
    const beforeVoid = await request(app())
      .get(datedUrl)
      .set("Authorization", `Bearer ${ownerToken}`);
    const cashBefore = Number(beforeVoid.body.data.assets.cashTotal);
    const apBefore = Number(beforeVoid.body.data.liabilities.accountsPayable);
    const todayCashBeforeVoid = Number(
      (
        await request(app())
          .get(todayUrl)
          .set("Authorization", `Bearer ${ownerToken}`)
      ).body.data.assets.cashTotal,
    );

    const voided = await request(app())
      .post(`/api/finance/bill-payments/${paymentId}/void`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "Wrong account" });
    expect(voided.status).toBe(200);

    const afterVoid = await request(app())
      .get(datedUrl)
      .set("Authorization", `Bearer ${ownerToken}`);
    // Voiding today does not rewrite yesterday: the withdrawal and the
    // settled payable both stood as of the report date.
    expect(Number(afterVoid.body.data.assets.cashTotal)).toBeCloseTo(cashBefore, 2);
    expect(Number(afterVoid.body.data.liabilities.accountsPayable)).toBeCloseTo(
      apBefore,
      2,
    );

    const today = await request(app())
      .get(todayUrl)
      .set("Authorization", `Bearer ${ownerToken}`);
    // As of today the void has happened, so the cash is back in the bank.
    expect(Number(today.body.data.assets.cashTotal)).toBeCloseTo(
      todayCashBeforeVoid + 90,
      2,
    );
  });

  it("a vendor's payment terms are saved and default the bill due date", async () => {
    const vendorId = await createVendor(rid("TermsVendor"), { paymentTermsDays: 45 });
    const listed = await request(app())
      .get(`/api/finance/vendors?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const saved = listed.body.data.find((v: any) => v.id === vendorId);
    expect(saved.paymentTermsDays).toBe(45);

    const bill = await createBill({
      vendorId,
      billDate: isoDay(0),
      lines: [{ categoryId, description: "Terms default", amount: 60 }],
    });
    expect([200, 201]).toContain(bill.status);
    const billDate = new Date(bill.body.data.billDate);
    const dueDate = new Date(bill.body.data.dueDate);
    const days = Math.round((dueDate.getTime() - billDate.getTime()) / 86400000);
    expect(days).toBe(45);

    const patched = await request(app())
      .patch(`/api/finance/vendors/${vendorId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ paymentTermsDays: 15 });
    expect(patched.status).toBe(200);
    expect(patched.body.data.paymentTermsDays).toBe(15);
  });

  it("a bill is expensed once at the bill date and not again when it is paid", async () => {
    const vendorId = await createVendor(rid("AccrualVendor"));
    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-1),
        dueDate: isoDay(10),
        lines: [{ categoryId, description: "Accrued", amount: 180 }],
      })
    ).body.data.id;

    const range = `dateFrom=${isoDay(-3)}&dateTo=${isoDay(1)}`;
    const beforePayment = await request(app())
      .get(`/api/finance/reports/profit-loss?organizationId=${labOrgId}&${range}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(beforePayment.status).toBe(200);
    expect(beforePayment.body.data.basis).toBe("accrual");
    const expenseBefore =
      Number(beforePayment.body.data.cogsTotal) + Number(beforePayment.body.data.opexTotal);

    await payBills({
      bankAccountId,
      paymentDate: isoDay(0),
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 180, creditApplications: [] }] },
      ],
    });

    const afterPayment = await request(app())
      .get(`/api/finance/reports/profit-loss?organizationId=${labOrgId}&${range}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const expenseAfter =
      Number(afterPayment.body.data.cogsTotal) + Number(afterPayment.body.data.opexTotal);
    // Paying the bill moves cash; it does not create a second expense.
    expect(expenseAfter).toBeCloseTo(expenseBefore, 2);
  });

  it("a report dated today includes bills, payments, and voids recorded today", async () => {
    const vendorId = await createVendor(rid("SameDayVendor"));
    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(0),
        dueDate: isoDay(0),
        lines: [{ categoryId, description: "Same-day supplies", amount: 400 }],
      })
    ).body.data.id;

    const zone = "America/Los_Angeles";
    const agingUrl = `/api/finance/reports/ap-aging?organizationId=${labOrgId}&asOf=${isoDay(0)}&timeZone=${encodeURIComponent(zone)}&detail=true`;
    const issued = await request(app())
      .get(agingUrl)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(issued.status).toBe(200);
    const rowAfterIssue = issued.body.data.rows.find(
      (row: any) => row.vendorId === vendorId,
    );
    // "As of today" means the end of today: a bill entered this morning has
    // to appear, which it would not if the server read the date as midnight.
    expect(Number(rowAfterIssue.total)).toBeCloseTo(400, 2);

    const payment = await payBills({
      bankAccountId,
      paymentDate: isoDay(0),
      vendorPayments: [
        { vendorId, allocations: [{ billId, amount: 150, creditApplications: [] }] },
      ],
    });
    expect(payment.status).toBe(201);
    const paymentId = payment.body.data.payments[0].id;

    const afterPayment = await request(app())
      .get(agingUrl)
      .set("Authorization", `Bearer ${ownerToken}`);
    const rowAfterPayment = afterPayment.body.data.rows.find(
      (row: any) => row.vendorId === vendorId,
    );
    expect(Number(rowAfterPayment.total)).toBeCloseTo(250, 2);

    const voided = await request(app())
      .post(`/api/finance/bill-payments/${paymentId}/void`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "wrong account" });
    expect(voided.status).toBe(200);

    const afterVoid = await request(app())
      .get(agingUrl)
      .set("Authorization", `Bearer ${ownerToken}`);
    const rowAfterVoid = afterVoid.body.data.rows.find(
      (row: any) => row.vendorId === vendorId,
    );
    // The void happened today too, so today's report reflects it.
    expect(Number(rowAfterVoid.total)).toBeCloseTo(400, 2);
  });

  it("editing a bill today does not restate an earlier period's payable or expense", async () => {
    const vendorId = await createVendor(rid("EditedBillVendor"));
    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-20),
        dueDate: isoDay(-5),
        lines: [{ categoryId, description: "Original scope", amount: 300 }],
      })
    ).body.data.id;

    const pastRange = `dateFrom=${isoDay(-25)}&dateTo=${isoDay(-10)}`;
    const historicAsOf = isoDay(-10);
    const agingBefore = await request(app())
      .get(
        `/api/finance/reports/ap-aging?organizationId=${labOrgId}&asOf=${historicAsOf}&detail=true`,
      )
      .set("Authorization", `Bearer ${ownerToken}`);
    const beforeRow = agingBefore.body.data.rows.find(
      (row: any) => row.vendorId === vendorId,
    );
    expect(Number(beforeRow.total)).toBeCloseTo(300, 2);

    const pnlBefore = await request(app())
      .get(`/api/finance/reports/profit-loss?organizationId=${labOrgId}&${pastRange}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const expenseBefore =
      Number(pnlBefore.body.data.cogsTotal) + Number(pnlBefore.body.data.opexTotal);

    const edited = await request(app())
      .patch(`/api/finance/bills/${billId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ lines: [{ categoryId, description: "Revised scope", amount: 900 }] });
    expect(edited.status).toBe(200);

    const agingAfter = await request(app())
      .get(
        `/api/finance/reports/ap-aging?organizationId=${labOrgId}&asOf=${historicAsOf}&detail=true`,
      )
      .set("Authorization", `Bearer ${ownerToken}`);
    const afterRow = agingAfter.body.data.rows.find(
      (row: any) => row.vendorId === vendorId,
    );
    // The edit was made today, so the closed period keeps the old figure.
    expect(Number(afterRow.total)).toBeCloseTo(300, 2);
    expect(Number(afterRow.bills[0].total)).toBeCloseTo(300, 2);

    const pnlAfter = await request(app())
      .get(`/api/finance/reports/profit-loss?organizationId=${labOrgId}&${pastRange}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const expenseAfter =
      Number(pnlAfter.body.data.cogsTotal) + Number(pnlAfter.body.data.opexTotal);
    expect(expenseAfter).toBeCloseTo(expenseBefore, 2);

    // Today's view does show the revised amount.
    const agingToday = await request(app())
      .get(`/api/finance/reports/ap-aging?organizationId=${labOrgId}&asOf=${isoDay(0)}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const todayRow = agingToday.body.data.rows.find(
      (row: any) => row.vendorId === vendorId,
    );
    expect(Number(todayRow.total)).toBeCloseTo(900, 2);
  });

  // A period report has to be able to stand next to its neighbours: the two
  // halves of a range must add up to the whole, or nothing downstream of the
  // P&L reconciles.
  async function periodExpense(from: string, to: string) {
    const response = await request(app())
      .get(
        `/api/finance/reports/profit-loss?organizationId=${labOrgId}&dateFrom=${from}&dateTo=${to}`,
      )
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(response.status).toBe(200);
    return (
      Number(response.body.data.cogsTotal) + Number(response.body.data.opexTotal)
    );
  }

  it("recognizes a later bill edit in the period of the edit, so periods stay additive", async () => {
    const vendorId = await createVendor(rid("AdditiveEditVendor"));
    const earlyFrom = isoDay(-25);
    const earlyTo = isoDay(-10);
    const lateFrom = isoDay(-9);
    // dateTo parses as midnight, so today's edits and voids need tomorrow's
    // boundary to fall inside the closing period.
    const lateTo = isoDay(1);

    const baselineEarly = await periodExpense(earlyFrom, earlyTo);
    const baselineLate = await periodExpense(lateFrom, lateTo);
    const baselineSpan = await periodExpense(earlyFrom, lateTo);

    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-20),
        dueDate: isoDay(-5),
        lines: [{ categoryId, description: "Original scope", amount: 300 }],
      })
    ).body.data.id;

    const edited = await request(app())
      .patch(`/api/finance/bills/${billId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ lines: [{ categoryId, description: "Revised scope", amount: 900 }] });
    expect(edited.status).toBe(200);

    const early = await periodExpense(earlyFrom, earlyTo);
    const late = await periodExpense(lateFrom, lateTo);
    const span = await periodExpense(earlyFrom, lateTo);

    // The closed period keeps the amount as entered; the increase belongs to
    // the period the edit happened in; the combined range shows the total.
    expect(early - baselineEarly).toBeCloseTo(300, 2);
    expect(late - baselineLate).toBeCloseTo(600, 2);
    expect(span - baselineSpan).toBeCloseTo(900, 2);
    expect(early - baselineEarly + (late - baselineLate)).toBeCloseTo(
      span - baselineSpan,
      2,
    );
  });

  it("reverses a voided bill in the period of the void, leaving the combined range at zero", async () => {
    const vendorId = await createVendor(rid("AdditiveVoidVendor"));
    const earlyFrom = isoDay(-25);
    const earlyTo = isoDay(-10);
    const lateFrom = isoDay(-9);
    // dateTo parses as midnight, so today's edits and voids need tomorrow's
    // boundary to fall inside the closing period.
    const lateTo = isoDay(1);

    const baselineEarly = await periodExpense(earlyFrom, earlyTo);
    const baselineLate = await periodExpense(lateFrom, lateTo);
    const baselineSpan = await periodExpense(earlyFrom, lateTo);

    const billId = (
      await createBill({
        vendorId,
        billDate: isoDay(-20),
        dueDate: isoDay(-5),
        lines: [{ categoryId, description: "Cancelled order", amount: 500 }],
      })
    ).body.data.id;

    const voided = await request(app())
      .post(`/api/finance/bills/${billId}/void`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "ordered in error" });
    expect(voided.status).toBe(200);

    const early = await periodExpense(earlyFrom, earlyTo);
    const late = await periodExpense(lateFrom, lateTo);
    const span = await periodExpense(earlyFrom, lateTo);

    expect(early - baselineEarly).toBeCloseTo(500, 2);
    expect(late - baselineLate).toBeCloseTo(-500, 2);
    expect(span - baselineSpan).toBeCloseTo(0, 2);
  });

  it("ties cumulative billed expense to the sum of its periods", async () => {
    const vendorId = await createVendor(rid("CumulativeVendor"));
    const start = isoDay(-25);
    const mid = isoDay(-10);
    const midNext = isoDay(-9);
    const today = isoDay(1);

    await createBill({
      vendorId,
      billDate: isoDay(-18),
      dueDate: isoDay(-3),
      lines: [{ categoryId, description: "First", amount: 120 }],
    });
    await createBill({
      vendorId,
      billDate: isoDay(-2),
      dueDate: isoDay(12),
      lines: [{ categoryId, description: "Second", amount: 80 }],
    });

    const first = await periodExpense(start, mid);
    const second = await periodExpense(midNext, today);
    const whole = await periodExpense(start, today);
    expect(first + second).toBeCloseTo(whole, 2);
  });
});
