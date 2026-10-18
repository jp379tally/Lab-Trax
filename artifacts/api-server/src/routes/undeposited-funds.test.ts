/**
 * Integration tests for the Undeposited Funds workflow endpoints:
 *   - POST /api/invoices/receive-payments  (auto-routes to UF when no account given)
 *   - GET  /api/finance/undeposited-funds  (returns only UF transactions)
 *   - POST /api/finance/make-deposits      (moves txns from UF to a real account)
 *
 * Skipped when DATABASE_URL is not configured — same convention as other
 * api-server integration tests. All rows inserted during the suite are
 * cleaned up in afterAll so the suite can run in the shared CI database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { cleanupPaymentFixtures } from "../test-utils/payment-cleanup.js";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Undeposited Funds workflow (db integration)", () => {
  type DbMod = typeof import("@workspace/db");

  let dbMod: DbMod;
  let app: Express;
  let auth: typeof import("../lib/auth.js");

  // Org + user identifiers — unique per run via rid() so concurrent CI jobs
  // never collide on the shared database.
  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab2");
  const practiceId = rid("prov");
  const secondPracticeId = rid("prov2");
  const thirdPracticeId = rid("prov3");
  const adminUserId = rid("uadm");
  const otherLabAdminId = rid("uoth");

  let ufAccountId = "";
  let realAccountId = "";
  let otherLabUfAccountId = "";
  let otherLabRealAccountId = "";

  const tokens: { admin: string; otherAdmin: string } = {
    admin: "",
    otherAdmin: "",
  };

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt,
    });
    return token;
  }

  async function waitForDepositFenceWaiters(
    organizationId: string,
    minimumCount: number,
  ) {
    const { pool } = dbMod as any;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await pool.query(
        `SELECT count(*)::int AS count
           FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = hashtext($1)::oid
            AND objid = hashtext($2)::oid
            AND NOT granted`,
        ["labtrax:deposit-batch-mutations", organizationId],
      );
      if (Number(result.rows[0]?.count ?? 0) >= minimumCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Timed out waiting for ${minimumCount} deposit mutation lock waiter(s).`,
    );
  }

  async function insertInvoice(opts: {
    invoiceNumber: string;
    labOrgId?: string;
    practiceId?: string | null;
    status?: string;
    balanceDue?: string;
    total?: string;
  }) {
    const { db, invoices } = dbMod as any;
    const id = rid("inv");
    await db.insert(invoices).values({
      id,
      invoiceNumber: opts.invoiceNumber,
      labOrganizationId: opts.labOrgId ?? labOrgId,
      providerOrganizationId: opts.practiceId === undefined ? practiceId : opts.practiceId,
      status: opts.status ?? "open",
      total: opts.total ?? "100.00",
      balanceDue: opts.balanceDue ?? "100.00",
      createdByUserId: adminUserId,
    });
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-undeposited-funds";

    dbMod = await import("@workspace/db");
    const appMod = await import("../app.js");
    auth = await import("../lib/auth.js");
    app = appMod.default;

    const { db, organizations, users, organizationMemberships, bankAccounts } =
      dbMod as any;

    // Users
    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "x" },
      { id: otherLabAdminId, username: `oth_${otherLabAdminId}`, password: "x" },
    ]);

    // Organizations
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "UF Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Other Lab" },
      {
        id: practiceId,
        type: "provider",
        name: "UF Test Practice",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: secondPracticeId,
        type: "provider",
        name: "Second UF Practice",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: thirdPracticeId,
        type: "provider",
        name: "Third UF Practice",
        parentLabOrganizationId: labOrgId,
      },
    ]);

    // Memberships
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: adminUserId,
        role: "admin",
        status: "active",
      },
      {
        id: rid("m"),
        labId: otherLabOrgId,
        userId: otherLabAdminId,
        role: "admin",
        status: "active",
      },
    ]);

    // Bank accounts
    const [ufRow] = await db
      .insert(bankAccounts)
      .values({
        labOrganizationId: labOrgId,
        name: "Undeposited Funds",
        openingBalance: "0.00",
        openingDate: new Date(),
        accountType: "undeposited_funds",
        createdByUserId: adminUserId,
      })
      .returning();
    ufAccountId = ufRow.id as string;

    const [realRow] = await db
      .insert(bankAccounts)
      .values({
        labOrganizationId: labOrgId,
        name: "Checking Account",
        openingBalance: "0.00",
        openingDate: new Date(),
        createdByUserId: adminUserId,
      })
      .returning();
    realAccountId = realRow.id as string;

    // Other lab's UF account (for cross-org rejection tests)
    const [otherUfRow] = await db
      .insert(bankAccounts)
      .values({
        labOrganizationId: otherLabOrgId,
        name: "Undeposited Funds",
        openingBalance: "0.00",
        openingDate: new Date(),
        accountType: "undeposited_funds",
        createdByUserId: otherLabAdminId,
      })
      .returning();
    otherLabUfAccountId = otherUfRow.id as string;

    const [otherRealRow] = await db
      .insert(bankAccounts)
      .values({
        labOrganizationId: otherLabOrgId,
        name: "Other Checking Account",
        openingBalance: "0.00",
        openingDate: new Date(),
        createdByUserId: otherLabAdminId,
      })
      .returning();
    otherLabRealAccountId = otherRealRow.id as string;

    tokens.admin = await makeSession(adminUserId);
    tokens.otherAdmin = await makeSession(otherLabAdminId);
  });

  // Refresh session tokens before every test so a concurrent user_sessions
  // wipe does not invalidate shared tokens mid-suite.
  beforeEach(async () => {
    tokens.admin = await makeSession(adminUserId);
    tokens.otherAdmin = await makeSession(otherLabAdminId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      bankTransactionInvoices,
      bankDepositBatchMembers,
      bankTransactions,
      bankAccounts,
      invoices,
      organizationMemberships,
      userSessions,
      organizations,
      users,
    } = dbMod as any;

    // Delete in FK-safe order
    await cleanupPaymentFixtures(
      {
        userIds: [adminUserId, otherLabAdminId],
        organizationIds: [
          labOrgId,
          otherLabOrgId,
          practiceId,
          secondPracticeId,
          thirdPracticeId,
        ],
      },
      db,
    );
    await db.delete(bankDepositBatchMembers).where(
      inArray(
        bankDepositBatchMembers.aggregateBankTransactionId,
        db.select({ id: bankTransactions.id }).from(bankTransactions).where(
          inArray(bankTransactions.bankAccountId, [
            ufAccountId,
            realAccountId,
            otherLabUfAccountId,
            otherLabRealAccountId,
          ]),
        ),
      ),
    );
    await db
      .delete(bankTransactionInvoices)
      .where(
        inArray(
          bankTransactionInvoices.bankTransactionId,
          db
            .select({ id: bankTransactions.id })
            .from(bankTransactions)
            .where(
              inArray(bankTransactions.bankAccountId, [
                ufAccountId,
                realAccountId,
                otherLabUfAccountId,
                otherLabRealAccountId,
              ])
            )
        )
      );
    await db
      .delete(bankTransactions)
      .where(
        inArray(bankTransactions.bankAccountId, [
          ufAccountId,
          realAccountId,
          otherLabUfAccountId,
          otherLabRealAccountId,
        ])
      );
    await db
      .delete(invoices)
      .where(eq(invoices.labOrganizationId, labOrgId));
    await db
      .delete(bankAccounts)
      .where(
        inArray(bankAccounts.id, [
          ufAccountId,
          realAccountId,
          otherLabUfAccountId,
          otherLabRealAccountId,
        ])
      );
    await db
      .delete(organizationMemberships)
      .where(
        inArray(organizationMemberships.userId, [adminUserId, otherLabAdminId])
      );
    await db
      .delete(userSessions)
      .where(
        inArray(userSessions.userId, [adminUserId, otherLabAdminId])
      );
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [
          labOrgId, practiceId, secondPracticeId, thirdPracticeId, otherLabOrgId,
        ])
      );
    await db
      .delete(users)
      .where(inArray(users.id, [adminUserId, otherLabAdminId]));
  });

  // ---------------------------------------------------------------------------
  // GET /api/finance/undeposited-funds
  // ---------------------------------------------------------------------------

  it("GET /finance/undeposited-funds: returns 400 without organizationId", async () => {
    const r = await request(app)
      .get("/api/finance/undeposited-funds")
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(r.status).toBe(400);
  });

  it("GET /finance/undeposited-funds: returns empty array when no UF transactions", async () => {
    const r = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(Array.isArray(r.body.data)).toBe(true);
    expect(r.body.data.length).toBe(0);
  });

  it("GET /finance/undeposited-funds: 403 for non-member", async () => {
    // otherLabAdmin is not a member of labOrgId
    const r = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${tokens.otherAdmin}`);
    expect(r.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // POST /api/invoices/receive-payments — auto-routes to Undeposited Funds
  // ---------------------------------------------------------------------------

  it("receive-payments: auto-routes to UF when no depositBankAccountId", async () => {
    const { db, bankTransactions } = dbMod as any;
    const invId = await insertInvoice({ invoiceNumber: rid("RP1") });

    const r = await request(app)
      .post("/api/invoices/receive-payments")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: practiceId,
        paymentMethod: "check",
        applications: [{ invoiceId: invId, amount: 75 }],
      });

    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    const { depositTransactionId, totalApplied } = r.body.data;
    expect(totalApplied).toBe("75.00");

    // Verify the deposit transaction landed in the UF account
    const [txn] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, depositTransactionId));
    expect(txn).toBeDefined();
    expect(txn.bankAccountId).toBe(ufAccountId);
    expect(Number(txn.netAmount)).toBeCloseTo(75, 2);
  });

  it("receive-payments: uses explicit depositBankAccountId when provided", async () => {
    const { db, bankTransactions } = dbMod as any;
    const invId = await insertInvoice({ invoiceNumber: rid("RP2") });

    const r = await request(app)
      .post("/api/invoices/receive-payments")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: practiceId,
        paymentMethod: "ach",
        depositBankAccountId: realAccountId,
        applications: [{ invoiceId: invId, amount: 50 }],
      });

    expect(r.status).toBe(201);
    const { depositTransactionId } = r.body.data;

    const [txn] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, depositTransactionId));
    expect(txn.bankAccountId).toBe(realAccountId);
  });

  it("receive-payments: 400 when applications is empty", async () => {
    const r = await request(app)
      .post("/api/invoices/receive-payments")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: practiceId,
        paymentMethod: "cash",
        applications: [],
      });
    expect(r.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // GET /api/finance/undeposited-funds — after payments land there
  // ---------------------------------------------------------------------------

  it("GET /finance/undeposited-funds: returns only UF transactions (not real-account txns)", async () => {
    // At this point the suite has posted one UF txn (RP1, $75) and one real
    // account txn (RP2, $50). Only the UF txn should appear.
    const r = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const data: any[] = r.body.data;
    // All returned txns must belong to the UF account
    for (const t of data) {
      expect(t.bankAccountId).toBe(ufAccountId);
    }
    // At least the $75 payment is there; the $50 real-account txn must NOT appear
    const amounts = data.map((t: any) => Number(t.netAmount));
    expect(amounts.some((a) => Math.abs(a - 75) < 0.01)).toBe(true);
    expect(amounts.some((a) => Math.abs(a - 50) < 0.01)).toBe(false);
  });

  it("GET /finance/undeposited-funds: includes invoiceLinks for linked invoices", async () => {
    const r = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);

    expect(r.status).toBe(200);
    const data: any[] = r.body.data;
    // Every row must have an invoiceLinks array
    for (const t of data) {
      expect(Array.isArray(t.invoiceLinks)).toBe(true);
    }
    // The $75 payment was linked to an invoice — it must have at least one link
    const ufTxn75 = data.find((t: any) => Math.abs(Number(t.netAmount) - 75) < 0.01);
    expect(ufTxn75).toBeDefined();
    expect(ufTxn75!.invoiceLinks.length).toBeGreaterThan(0);
    expect(ufTxn75!.invoiceLinks[0]).toHaveProperty("invoiceId");
    expect(ufTxn75!.invoiceLinks[0]).toHaveProperty("invoiceNumber");
  });

  it("GET /finance/undeposited-funds: includes staleDays and ageWarning fields", async () => {
    const { db, bankTransactions, bankAccounts } = dbMod as any;

    // Look up the UF account for this lab
    const ufAcc = await db.query.bankAccounts.findFirst({
      where: and(
        eq(bankAccounts.labOrganizationId, labOrgId),
        eq(bankAccounts.accountType, "undeposited_funds")
      ),
    });
    expect(ufAcc).toBeDefined();

    // Insert a stale transaction dated 45 days ago. txnDate is a timestamp
    // column, so it must be a Date — passing a date-only string crashes
    // drizzle's PgTimestamp mapper (value.toISOString is not a function).
    const staleTxnId = rid("txn_stale");
    const staleDate = new Date(Date.now() - 45 * 86_400_000);
    await db.insert(bankTransactions).values({
      id: staleTxnId,
      labOrganizationId: labOrgId,
      bankAccountId: ufAcc.id,
      txnDate: staleDate,
      status: "posted",
      creditAmount: "20.00",
      debitAmount: "0.00",
      netAmount: "20.00",
      payee: "Stale test payment",
    });

    const r = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);

    expect(r.status).toBe(200);
    const data: any[] = r.body.data;

    // Every row must expose staleDays (number) and ageWarning (boolean)
    for (const t of data) {
      expect(typeof t.staleDays).toBe("number");
      expect(t.staleDays).toBeGreaterThanOrEqual(0);
      expect(typeof t.ageWarning).toBe("boolean");
    }

    // The stale txn must report ageWarning=true and staleDays > 30
    const staleTxn = data.find((t: any) => t.id === staleTxnId);
    expect(staleTxn).toBeDefined();
    expect(staleTxn!.ageWarning).toBe(true);
    expect(staleTxn!.staleDays).toBeGreaterThan(30);

    // A recent payment (< 30 days old) must report ageWarning=false
    const recentTxn = data.find(
      (t: any) => t.id !== staleTxnId && typeof t.staleDays === "number"
    );
    if (recentTxn) {
      // Only assert if the payment is genuinely recent (within 30 days)
      if (recentTxn.staleDays <= 30) {
        expect(recentTxn.ageWarning).toBe(false);
      }
    }

    // Clean up the stale test row so subsequent tests don't see it
    await db
      .update(bankTransactions)
      .set({ deletedAt: new Date() })
      .where(eq(bankTransactions.id, staleTxnId));
  });

  it("GET /finance/undeposited-funds keeps the legacy array and pages newest-first", async () => {
    const { db, bankTransactions } = dbMod as any;
    const newestId = rid("txn_uf_newest");
    const olderId = rid("txn_uf_older");
    const now = Date.now();
    await db.insert(bankTransactions).values([
      {
        id: olderId,
        labOrganizationId: labOrgId,
        bankAccountId: ufAccountId,
        txnDate: new Date(now - 2 * 86_400_000),
        status: "posted",
        creditAmount: "31.00",
        debitAmount: "0.00",
        netAmount: "31.00",
        payee: "UF pagination older",
      },
      {
        id: newestId,
        labOrganizationId: labOrgId,
        bankAccountId: ufAccountId,
        txnDate: new Date(now + 86_400_000),
        status: "posted",
        creditAmount: "32.00",
        debitAmount: "0.00",
        netAmount: "32.00",
        payee: "UF pagination newest",
      },
    ]);

    const legacy = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(legacy.status).toBe(200);
    expect(Array.isArray(legacy.body.data)).toBe(true);
    const legacyIds = legacy.body.data.map((row: any) => row.id);
    expect(legacyIds.indexOf(newestId)).toBeLessThan(legacyIds.indexOf(olderId));

    const page = await request(app)
      .get("/api/finance/undeposited-funds")
      .query({ organizationId: labOrgId, limit: 1, offset: 0 })
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(page.status).toBe(200);
    expect(page.body.data).toMatchObject({
      limit: 1,
      offset: 0,
      hasMore: true,
    });
    expect(page.body.data.rows[0].id).toBe(newestId);
    expect(page.body.data.total).toBe(legacy.body.data.length);

    const summary = await request(app)
      .get("/api/finance/undeposited-funds")
      .query({ organizationId: labOrgId, summary: 1 })
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(summary.status).toBe(200);
    expect(summary.body.data).toMatchObject({
      count: legacy.body.data.length,
    });
    expect(Number(summary.body.data.total)).toBeGreaterThanOrEqual(63);

    await db.delete(bankTransactions).where(
      inArray(bankTransactions.id, [newestId, olderId]),
    );
  });

  // ---------------------------------------------------------------------------
  // POST /api/finance/make-deposits
  // ---------------------------------------------------------------------------

  it("make-deposits: creates one parent and hidden child members", async () => {
    const { db, bankTransactions, bankDepositBatchMembers } = dbMod as any;

    // Grab current UF txn ids
    const ufTxns = await db
      .select()
      .from(bankTransactions)
      .where(and(
        eq(bankTransactions.bankAccountId, ufAccountId),
        isNull(bankTransactions.deletedAt),
      ));

    expect(ufTxns.length).toBeGreaterThan(0);
    const txnIds = ufTxns.map((t: any) => t.id);
    const expectedTotal = ufTxns.reduce(
      (s: number, t: any) => s + Number(t.netAmount),
      0
    );

    const r = await request(app)
      .post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        organizationId: labOrgId,
        bankAccountId: realAccountId,
        transactionIds: txnIds,
      });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const { moved, totalAmount, bankAccountId } = r.body.data;
    expect(moved).toBe(txnIds.length);
    expect(Number(totalAmount)).toBeCloseTo(expectedTotal, 2);
    expect(bankAccountId).toBe(realAccountId);

    expect(r.body.data.aggregateTransactionId).toBeTruthy();
    const aggregateId = r.body.data.aggregateTransactionId;
    const movedTxns = await db
      .select()
      .from(bankTransactions)
      .where(inArray(bankTransactions.id, txnIds));
    for (const t of movedTxns) {
      expect(t.bankAccountId).toBe(ufAccountId);
      expect(t.status).toBe("deposited_child");
      expect(t.cleared).toBe(true);
      expect(t.depositedByUserId).toBe(adminUserId);
      expect(t.depositedAt).toBeInstanceOf(Date);
    }
    const [parent] = await db.select().from(bankTransactions)
      .where(eq(bankTransactions.id, aggregateId));
    expect(parent.source).toBe("deposit_batch");
    expect(parent.bankAccountId).toBe(realAccountId);
    expect(parent.creditAmount).toBe(Number(expectedTotal).toFixed(2));
    const members = await db.select().from(bankDepositBatchMembers)
      .where(eq(bankDepositBatchMembers.aggregateBankTransactionId, aggregateId));
    expect(members.map((m: any) => m.childBankTransactionId).sort())
      .toEqual([...txnIds].sort());
    const visible = await request(app).get(`/api/finance/transactions?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(visible.status).toBe(200);
    expect(visible.body.data.filter((t: any) => txnIds.includes(t.id))).toHaveLength(0);
    const aggregateRows = visible.body.data.filter((t: any) => t.id === aggregateId);
    expect(aggregateRows).toHaveLength(1);
    expect(aggregateRows[0].isAggregateDeposit).toBe(true);
    expect(Array.isArray(aggregateRows[0].splitGroups)).toBe(true);
    const splitTotal = aggregateRows[0].splitGroups.reduce(
      (sum: number, group: any) => sum + Math.round(Number(group.subtotal) * 100), 0,
    );
    expect(splitTotal).toBe(Math.round(Number(totalAmount) * 100));
    for (const group of aggregateRows[0].splitGroups) {
      expect(group.payments.reduce(
        (sum: number, detail: any) => sum + Math.round(Number(detail.amount) * 100), 0,
      )).toBe(Math.round(Number(group.subtotal) * 100));
      for (const detail of group.payments) {
        expect(detail).toHaveProperty("childTransactionId");
        expect(detail).toHaveProperty("invoices");
        expect(detail).toHaveProperty("receiptNumber");
      }
    }
  });

  it("make-deposits: after move, UF is empty", async () => {
    const r = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);

    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(0);
  });

  it("deposit-batches history: is admin-only, tenant-scoped, and includes active members", async () => {
    const own = await request(app)
      .get("/api/finance/deposit-batches")
      .query({ organizationId: labOrgId })
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(own.status).toBe(200);
    expect(own.body.ok).toBe(true);
    expect(Array.isArray(own.body.data)).toBe(true);
    const batch = own.body.data.find((row: any) => row.correctionState === "active");
    expect(batch).toBeDefined();
    expect(batch.originalTotal).toBeTruthy();
    expect(batch.releasedAt).toBeNull();
    expect(batch.members.length).toBeGreaterThan(0);
    expect(batch.members[0]).toMatchObject({
      correctionState: "active",
      releasedAt: null,
    });

    const foreign = await request(app)
      .get("/api/finance/deposit-batches")
      .query({ organizationId: labOrgId })
      .set("Authorization", `Bearer ${tokens.otherAdmin}`);
    expect(foreign.status).toBe(403);
  });

  it("deposit-batches history: returns bounded pages with total and hasMore", async () => {
    const first = await request(app)
      .get("/api/finance/deposit-batches")
      .query({ organizationId: labOrgId, limit: 1, offset: 0 })
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      limit: 1,
      offset: 0,
      total: expect.any(Number),
      hasMore: first.body.data.total > 1,
    });
    expect(first.body.data.rows).toHaveLength(1);
    if (first.body.data.total > 1) {
      const second = await request(app)
        .get("/api/finance/deposit-batches")
        .query({ organizationId: labOrgId, limit: 1, offset: 1 })
        .set("Authorization", `Bearer ${tokens.admin}`);
      expect(second.status).toBe(200);
      expect(second.body.data.rows).toHaveLength(1);
      expect(second.body.data.total).toBe(first.body.data.total);
      expect(second.body.data.offset).toBe(1);
      expect(second.body.data.hasMore).toBe(first.body.data.total > 2);
      expect(second.body.data.rows[0].id).not.toBe(first.body.data.rows[0].id);
    }
  });

  it("deposit-batches history: keeps reused legacy memberships explicitly unverified", async () => {
    const { db, bankDepositBatchMembers, bankTransactions } = dbMod as any;
    const childId = rid("legacy_child");
    const firstBatchId = rid("legacy_batch_a");
    const secondBatchId = rid("legacy_batch_b");
    const releasedAt = new Date();

    await db.insert(bankTransactions).values([
      {
        id: childId,
        labOrganizationId: labOrgId,
        bankAccountId: ufAccountId,
        txnDate: releasedAt,
        source: "invoice",
        status: "void",
        debitAmount: "0.00",
        creditAmount: "14.00",
        netAmount: "14.00",
        payee: "Legacy reused payment",
        createdByUserId: adminUserId,
      },
      ...[firstBatchId, secondBatchId].map((id) => ({
        id,
        labOrganizationId: labOrgId,
        bankAccountId: realAccountId,
        txnDate: releasedAt,
        source: "deposit_batch",
        status: "void",
        debitAmount: "0.00",
        creditAmount: "14.00",
        netAmount: "14.00",
        createdByUserId: adminUserId,
      })),
    ]);
    await db.insert(bankDepositBatchMembers).values(
      [firstBatchId, secondBatchId].map((aggregateBankTransactionId) => ({
        aggregateBankTransactionId,
        childBankTransactionId: childId,
        releasedAt,
        snapshot: {
          amount: "14.00",
          payee: "Legacy reused payment",
          memo: null,
          checkNumber: null,
          paymentMethod: null,
          receiptNumber: null,
          paymentSessionId: null,
          invoiceLinks: [],
          legacyUnverified: true,
        },
        releaseOutcome: null,
      })),
    );

    const history = await request(app)
      .get("/api/finance/deposit-batches")
      .query({ organizationId: labOrgId })
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(history.status).toBe(200);
    const legacyBatches = history.body.data.filter((row: any) =>
      row.id === firstBatchId || row.id === secondBatchId
    );
    expect(legacyBatches).toHaveLength(2);
    for (const batch of legacyBatches) {
      expect(batch).toMatchObject({
        correctionState: "unknown",
        auditQuality: "legacy_unverified",
      });
      expect(batch.members).toEqual([
        expect.objectContaining({
          childTransactionId: childId,
          correctionState: "unknown",
          auditQuality: "legacy_unverified",
        }),
      ]);
    }
  });

  it("aggregate details group invoice-only payments by provider and Unassigned", async () => {
    const { db, bankTransactions, bankTransactionInvoices } = dbMod as any;
    const invoiceA = await insertInvoice({ invoiceNumber: rid("A"), practiceId: practiceId, total: "1.01", balanceDue: "1.01" });
    const invoiceB = await insertInvoice({ invoiceNumber: rid("B"), practiceId: practiceId, total: "2.02", balanceDue: "2.02" });
    const invoiceC = await insertInvoice({ invoiceNumber: rid("C"), practiceId: secondPracticeId, total: "3.03", balanceDue: "3.03" });
    const invoiceD = await insertInvoice({ invoiceNumber: rid("D"), practiceId: null, total: "4.04", balanceDue: "4.04" });
    const children = await db.insert(bankTransactions).values([
      { id: rid("split"), labOrganizationId: labOrgId, bankAccountId: ufAccountId, txnDate: new Date(), type: "deposit", source: "invoice", status: "posted", debitAmount: "0.00", creditAmount: "1.01", netAmount: "1.01", payee: "Same One", createdByUserId: adminUserId },
      { id: rid("split"), labOrganizationId: labOrgId, bankAccountId: ufAccountId, txnDate: new Date(), type: "deposit", source: "invoice", status: "posted", debitAmount: "0.00", creditAmount: "2.02", netAmount: "2.02", payee: "Same Two", createdByUserId: adminUserId },
      { id: rid("split"), labOrganizationId: labOrgId, bankAccountId: ufAccountId, txnDate: new Date(), type: "deposit", source: "invoice", status: "posted", debitAmount: "0.00", creditAmount: "3.03", netAmount: "3.03", payee: "Second", createdByUserId: adminUserId },
      { id: rid("split"), labOrganizationId: labOrgId, bankAccountId: ufAccountId, txnDate: new Date(), type: "deposit", source: "invoice", status: "posted", debitAmount: "0.00", creditAmount: "4.04", netAmount: "4.04", payee: "Unknown", createdByUserId: adminUserId },
    ]).returning();
    for (const [child, invoiceId] of children.map((c: any, i: number) => [c, [invoiceA, invoiceB, invoiceC, invoiceD][i]] as const)) {
      await db.insert(bankTransactionInvoices).values({ bankTransactionId: child.id, invoiceId });
    }
    const deposit = await request(app).post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ organizationId: labOrgId, bankAccountId: realAccountId, transactionIds: children.map((c: any) => c.id) });
    expect(deposit.status).toBe(200);
    const register = await request(app).get(`/api/finance/transactions?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    const row = register.body.data.find((t: any) => t.id === deposit.body.data.aggregateTransactionId);
    expect(row.splitGroups.map((g: any) => g.providerName).sort()).toEqual(
      ["Second UF Practice", "UF Test Practice", "Unassigned"].sort(),
    );
    const totals = new Map(row.splitGroups.map((g: any) => [g.providerName, g.subtotal]));
    expect(totals.get("UF Test Practice")).toBe("3.03");
    expect(totals.get("Second UF Practice")).toBe("3.03");
    expect(totals.get("Unassigned")).toBe("4.04");
    expect(row.splitGroups.find((g: any) => g.providerName === "UF Test Practice").payments).toHaveLength(2);
    expect(row.splitGroups.flatMap((g: any) => g.payments).every((d: any) => d.invoices.length === 1)).toBe(true);

    await db.update(bankTransactions).set({ reconciled: true })
      .where(eq(bankTransactions.id, deposit.body.data.aggregateTransactionId));
    const lockedCorrection = await request(app)
      .post(`/api/invoices/${invoiceA}/void`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ reason: "Reconciled batch safety" });
    expect(lockedCorrection.status).toBe(409);

    await db.update(bankTransactions).set({ reconciled: false })
      .where(eq(bankTransactions.id, deposit.body.data.aggregateTransactionId));
    const correction = await request(app)
      .post(`/api/invoices/${invoiceA}/void`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ reason: "Correct deposited invoice" });
    expect(correction.status, JSON.stringify(correction.body)).toBe(200);
    const [releasedParent] = await db.select().from(bankTransactions)
      .where(eq(bankTransactions.id, deposit.body.data.aggregateTransactionId));
    expect(releasedParent.status).toBe("void");
    const correctedChildren = await db.select().from(bankTransactions)
      .where(inArray(bankTransactions.id, children.map((child: any) => child.id)));
    expect(correctedChildren.find((child: any) => child.id === children[0].id)?.status).toBe("void");
    expect(correctedChildren.filter((child: any) => child.id !== children[0].id)
      .every((child: any) => child.status === "posted")).toBe(true);

    const history = await request(app)
      .get("/api/finance/deposit-batches")
      .query({ organizationId: labOrgId })
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(history.status).toBe(200);
    const released = history.body.data.find(
      (row: any) => row.id === deposit.body.data.aggregateTransactionId,
    );
    expect(released).toMatchObject({
      originalTotal: expect.any(String),
      correctionState: "corrected",
    });
    expect(released.releasedAt).toEqual(expect.any(String));
    expect(released.members).toEqual(expect.arrayContaining([
      expect.objectContaining({
        releasedAt: expect.any(String),
        correctionState: "corrected",
        childStatus: "void",
      }),
    ]));
  });

  it("deposit-batches history freezes A as restored when the child is redeposited and corrected in B", async () => {
    const { db, bankTransactions, bankTransactionInvoices } = dbMod as any;
    const invoiceId = await insertInvoice({
      invoiceNumber: rid("immutable"),
      total: "19.99",
      balanceDue: "19.99",
    });
    const [child] = await db.insert(bankTransactions).values({
      id: rid("immutable_child"),
      labOrganizationId: labOrgId,
      bankAccountId: ufAccountId,
      txnDate: new Date(),
      type: "deposit",
      source: "invoice",
      status: "posted",
      debitAmount: "0.00",
      creditAmount: "19.99",
      netAmount: "19.99",
      payee: "Immutable payer",
      memo: null,
      checkNumber: "IMM-1",
      createdByUserId: adminUserId,
    }).returning();
    await db.insert(bankTransactionInvoices).values({
      bankTransactionId: child.id,
      invoiceId,
    });
    const firstDeposit = await request(app).post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ organizationId: labOrgId, bankAccountId: realAccountId, transactionIds: [child.id] });
    expect(firstDeposit.status).toBe(200);
    const batchA = firstDeposit.body.data.aggregateTransactionId;
    const releaseA = await request(app)
      .post(`/api/finance/transactions/${batchA}/void`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    expect(releaseA.status).toBe(200);
    const historyA = await request(app).get("/api/finance/deposit-batches")
      .query({ organizationId: labOrgId }).set("Authorization", `Bearer ${tokens.admin}`);
    const firstA = historyA.body.data.find((row: any) => row.id === batchA);
    expect(firstA).toMatchObject({
      correctionState: "restored",
      members: [expect.objectContaining({
        payee: "Immutable payer",
        memo: null,
        correctionState: "restored",
      })],
    });
    await db.update(bankTransactions).set({ memo: "Edited after release", payee: "Edited payer" })
      .where(eq(bankTransactions.id, child.id));

    const secondDeposit = await request(app).post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ organizationId: labOrgId, bankAccountId: realAccountId, transactionIds: [child.id] });
    expect(secondDeposit.status).toBe(200);
    const batchB = secondDeposit.body.data.aggregateTransactionId;
    const correction = await request(app).post(`/api/invoices/${invoiceId}/void`)
      .set("Authorization", `Bearer ${tokens.admin}`).send({ reason: "Immutable history test" });
    expect(correction.status).toBe(200);
    const historyB = await request(app).get("/api/finance/deposit-batches")
      .query({ organizationId: labOrgId }).set("Authorization", `Bearer ${tokens.admin}`);
    const finalA = historyB.body.data.find((row: any) => row.id === batchA);
    const finalB = historyB.body.data.find((row: any) => row.id === batchB);
    expect(finalA).toMatchObject({
      correctionState: "restored",
      members: [expect.objectContaining({
        payee: "Immutable payer",
        memo: null,
        correctionState: "restored",
      })],
    });
    expect(finalB.correctionState).toBe("corrected");
    expect(finalB.members[0].correctionState).toBe("corrected");
  });

  it("correcting multiple payments in one invoice marks every member corrected", async () => {
    const { db, bankTransactions, payments } = dbMod as any;
    const invoiceId = await insertInvoice({ invoiceNumber: rid("bulk-correct") });
    const children = await db.insert(bankTransactions).values([1, 2].map((index) => ({
      id: rid(`bulk_child_${index}`), labOrganizationId: labOrgId, bankAccountId: ufAccountId,
      txnDate: new Date(), type: "deposit", source: "invoice", status: "posted",
      debitAmount: "0.00", creditAmount: "10.00", netAmount: "10.00",
      payee: `Bulk ${index}`, createdByUserId: adminUserId,
    }))).returning();
    await db.insert(payments).values(children.map((child: any) => ({
      invoiceId, bankTransactionId: child.id, amount: "10.00", paymentMethod: "check",
      recordedByUserId: adminUserId,
    })));
    const deposit = await request(app).post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ organizationId: labOrgId, bankAccountId: realAccountId, transactionIds: children.map((child: any) => child.id) });
    expect(deposit.status).toBe(200);
    const { releaseBatchesForChildren } = await import("../lib/deposit-batches.js");
    await db.transaction((tx: any) =>
      releaseBatchesForChildren(
        tx,
        labOrgId,
        children.map((child: any) => child.id),
      ),
    );
    const history = await request(app).get("/api/finance/deposit-batches")
      .query({ organizationId: labOrgId }).set("Authorization", `Bearer ${tokens.admin}`);
    const batch = history.body.data.find((row: any) => row.id === deposit.body.data.aggregateTransactionId);
    expect(batch.correctionState).toBe("corrected");
    expect(batch.members).toHaveLength(2);
    expect(batch.members.every((member: any) => member.correctionState === "corrected")).toBe(true);
  });

  it("serializes Make Deposits against an invoice correction", async () => {
    const { db, bankDepositBatchMembers, bankTransactions, bankTransactionInvoices } = dbMod as any;
    const invoiceId = await insertInvoice({
      invoiceNumber: rid("race"),
      total: "7.77",
      balanceDue: "7.77",
    });
    const [child] = await db.insert(bankTransactions).values({
      id: rid("race-child"),
      labOrganizationId: labOrgId,
      bankAccountId: ufAccountId,
      txnDate: new Date(),
      type: "deposit",
      source: "invoice",
      status: "posted",
      debitAmount: "0.00",
      creditAmount: "7.77",
      netAmount: "7.77",
      createdByUserId: adminUserId,
    }).returning();
    await db.insert(bankTransactionInvoices).values({
      bankTransactionId: child.id,
      invoiceId,
    });

    let releaseFence!: () => void;
    let markFenceHeld!: () => void;
    const fenceHeld = new Promise<void>((resolve) => { markFenceHeld = resolve; });
    const releaseFencePromise = new Promise<void>((resolve) => { releaseFence = resolve; });
    const blocker = db.transaction(async (tx: any) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(
          hashtext('labtrax:deposit-batch-mutations'),
          hashtext(${labOrgId})
        )`,
      );
      markFenceHeld();
      await releaseFencePromise;
    });
    await fenceHeld;

    const depositPromise = request(app).post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        organizationId: labOrgId,
        bankAccountId: realAccountId,
        transactionIds: [child.id],
      })
      .then((response) => response);
    const correctionPromise = request(app).post(`/api/invoices/${invoiceId}/void`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ reason: "Concurrent correction" })
      .then((response) => response);
    await waitForDepositFenceWaiters(labOrgId, 2);
    releaseFence();
    await blocker;

    const [deposit, correction] = await Promise.all([depositPromise, correctionPromise]);
    expect(correction.status, JSON.stringify(correction.body)).toBe(200);
    expect([200, 400]).toContain(deposit.status);
    const [correctedChild] = await db.select().from(bankTransactions)
      .where(eq(bankTransactions.id, child.id));
    expect(correctedChild.status).toBe("void");
    const activeMemberships = await db.select().from(bankDepositBatchMembers)
      .where(and(
        eq(bankDepositBatchMembers.childBankTransactionId, child.id),
        isNull(bankDepositBatchMembers.releasedAt),
      ));
    expect(activeMemberships).toHaveLength(0);
    if (deposit.status === 200) {
      const [parent] = await db.select().from(bankTransactions)
        .where(eq(bankTransactions.id, deposit.body.data.aggregateTransactionId));
      expect(parent.status).toBe("void");
    }
  });

  it("serializes Make Deposits against payment deletion", async () => {
    const { db, bankDepositBatchMembers, bankTransactions } = dbMod as any;
    const invoiceId = await insertInvoice({
      invoiceNumber: rid("delete-race"),
      total: "8.88",
      balanceDue: "8.88",
    });
    const received = await request(app)
      .post("/api/invoices/receive-payments")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: practiceId,
        paymentMethod: "check",
        applications: [{ invoiceId, amount: 8.88 }],
      });
    expect(received.status, JSON.stringify(received.body)).toBe(201);
    const childId = received.body.data.depositTransactionId as string;

    let releaseFence!: () => void;
    let markFenceHeld!: () => void;
    const fenceHeld = new Promise<void>((resolve) => { markFenceHeld = resolve; });
    const releaseFencePromise = new Promise<void>((resolve) => { releaseFence = resolve; });
    const blocker = db.transaction(async (tx: any) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(
          hashtext('labtrax:deposit-batch-mutations'),
          hashtext(${labOrgId})
        )`,
      );
      markFenceHeld();
      await releaseFencePromise;
    });
    await fenceHeld;

    const depositPromise = request(app).post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        organizationId: labOrgId,
        bankAccountId: realAccountId,
        transactionIds: [childId],
      })
      .then((response) => response);
    const deletionPromise = request(app)
      .delete(`/api/finance/payments/${childId}`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .then((response) => response);
    await waitForDepositFenceWaiters(labOrgId, 2);
    releaseFence();
    await blocker;

    const [deposit, deletion] = await Promise.all([depositPromise, deletionPromise]);
    expect(deletion.status, JSON.stringify(deletion.body)).toBe(200);
    expect([200, 400]).toContain(deposit.status);
    const [correctedChild] = await db.select().from(bankTransactions)
      .where(eq(bankTransactions.id, childId));
    expect(correctedChild.deletedAt).toBeInstanceOf(Date);
    const activeMemberships = await db.select().from(bankDepositBatchMembers)
      .where(and(
        eq(bankDepositBatchMembers.childBankTransactionId, childId),
        isNull(bankDepositBatchMembers.releasedAt),
      ));
    expect(activeMemberships).toHaveLength(0);
    if (deposit.status === 200) {
      const [parent] = await db.select().from(bankTransactions)
        .where(eq(bankTransactions.id, deposit.body.data.aggregateTransactionId));
      expect(parent.status).toBe("void");
    }
  });

  it("lets another lab make a deposit while this lab's mutation fence is held", async () => {
    const { db, bankTransactions } = dbMod as any;
    const [sameLabChild, otherLabChild] = await db.insert(bankTransactions).values([
      {
        id: rid("scoped-child"),
        labOrganizationId: labOrgId,
        bankAccountId: ufAccountId,
        txnDate: new Date(),
        type: "deposit",
        source: "invoice",
        status: "posted",
        debitAmount: "0.00",
        creditAmount: "1.11",
        netAmount: "1.11",
        createdByUserId: adminUserId,
      },
      {
        id: rid("scoped-child"),
        labOrganizationId: otherLabOrgId,
        bankAccountId: otherLabUfAccountId,
        txnDate: new Date(),
        type: "deposit",
        source: "invoice",
        status: "posted",
        debitAmount: "0.00",
        creditAmount: "2.22",
        netAmount: "2.22",
        createdByUserId: otherLabAdminId,
      },
    ]).returning();

    let releaseFence!: () => void;
    let markFenceHeld!: () => void;
    const fenceHeld = new Promise<void>((resolve) => { markFenceHeld = resolve; });
    const releaseFencePromise = new Promise<void>((resolve) => { releaseFence = resolve; });
    const blocker = db.transaction(async (tx: any) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(
          hashtext('labtrax:deposit-batch-mutations'),
          hashtext(${labOrgId})
        )`,
      );
      markFenceHeld();
      await releaseFencePromise;
    });
    await fenceHeld;

    const sameLabDeposit = request(app).post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        organizationId: labOrgId,
        bankAccountId: realAccountId,
        transactionIds: [sameLabChild.id],
      })
      .then((response) => response);
    await waitForDepositFenceWaiters(labOrgId, 1);
    const otherLabDeposit = request(app).post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.otherAdmin}`)
      .send({
        organizationId: otherLabOrgId,
        bankAccountId: otherLabRealAccountId,
        transactionIds: [otherLabChild.id],
      })
      .then((response) => response);

    const firstCompleted = await Promise.race([
      sameLabDeposit.then(() => "same"),
      otherLabDeposit.then(() => "other"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);
    expect(firstCompleted).toBe("other");
    const otherResult = await otherLabDeposit;
    expect(otherResult.status, JSON.stringify(otherResult.body)).toBe(200);

    releaseFence();
    await blocker;
    const sameResult = await sameLabDeposit;
    expect(sameResult.status, JSON.stringify(sameResult.body)).toBe(200);
  });

  it("make-deposits: rejects unknown transaction IDs", async () => {
    const r = await request(app)
      .post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        organizationId: labOrgId,
        bankAccountId: realAccountId,
        transactionIds: [rid("nonexistent")],
      });

    expect(r.status).toBe(400);
    expect(r.body.error ?? r.body.message ?? "").toMatch(/not found|Undeposited Funds/i);
  });

  it("make-deposits: rejects cross-org transaction IDs", async () => {
    // Create a UF transaction in the other lab, then try to deposit it
    // using the first lab's credentials + bankAccountId.
    const { db, bankTransactions } = dbMod as any;
    const [crossTxn] = await db
      .insert(bankTransactions)
      .values({
        labOrganizationId: otherLabOrgId,
        bankAccountId: otherLabUfAccountId,
        txnDate: new Date(),
        type: "deposit",
        payee: "Cross-org payment",
        debitAmount: "0.00",
        creditAmount: "99.00",
        netAmount: "99.00",
        status: "posted",
        source: "invoice",
        createdByUserId: otherLabAdminId,
      })
      .returning();

    const r = await request(app)
      .post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        organizationId: labOrgId,
        bankAccountId: realAccountId,
        transactionIds: [crossTxn.id],
      });

    // The other lab's txn is not in our UF account — must be rejected
    expect(r.status).toBe(400);

    // Cleanup the cross-org txn
    await db
      .delete(bankTransactions)
      .where(eq(bankTransactions.id, crossTxn.id));
  });

  it("make-deposits: rejects depositing into the UF account itself", async () => {
    // Seed a fresh UF txn so we have something to try to deposit
    const { db, bankTransactions } = dbMod as any;
    const [freshTxn] = await db
      .insert(bankTransactions)
      .values({
        labOrganizationId: labOrgId,
        bankAccountId: ufAccountId,
        txnDate: new Date(),
        type: "deposit",
        payee: "Test payment",
        debitAmount: "0.00",
        creditAmount: "10.00",
        netAmount: "10.00",
        status: "posted",
        source: "invoice",
        createdByUserId: adminUserId,
      })
      .returning();

    const r = await request(app)
      .post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        organizationId: labOrgId,
        bankAccountId: ufAccountId,
        transactionIds: [freshTxn.id],
      });

    expect(r.status).toBe(400);
    expect(r.body.error ?? r.body.message ?? "").toMatch(/Undeposited Funds/i);
  });

  it("make-deposits: rejects an empty transactionIds array", async () => {
    const r = await request(app)
      .post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        organizationId: labOrgId,
        bankAccountId: realAccountId,
        transactionIds: [],
      });

    expect(r.status).toBe(400);
  });

  it("make-deposits: 403 for non-member", async () => {
    const r = await request(app)
      .post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.otherAdmin}`)
      .send({
        organizationId: labOrgId,
        bankAccountId: realAccountId,
        transactionIds: [rid("any")],
      });

    expect(r.status).toBe(403);
  });

  it("make-deposits: second call with same transactionIds returns 400 already-deposited", async () => {
    // Seed a fresh UF transaction for this sub-test.
    const { db, bankTransactions } = dbMod as any;
    const [freshTxn] = await db
      .insert(bankTransactions)
      .values({
        labOrganizationId: labOrgId,
        bankAccountId: ufAccountId,
        txnDate: new Date(),
        type: "deposit",
        payee: "Double-deposit test payment",
        debitAmount: "0.00",
        creditAmount: "200.00",
        netAmount: "200.00",
        status: "posted",
        source: "invoice",
        createdByUserId: adminUserId,
      })
      .returning();

    const payload = {
      organizationId: labOrgId,
      bankAccountId: realAccountId,
      transactionIds: [freshTxn.id],
    };

    // First call — must succeed.
    const first = await request(app)
      .post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send(payload);

    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.data.moved).toBe(1);

    // Second call with the same IDs — the transaction has already left UF.
    const second = await request(app)
      .post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send(payload);

    expect(second.status).toBe(400);
    expect(second.body.error ?? second.body.message ?? "").toMatch(
      /already deposited/i
    );
  });

  it("make-deposits: exact cents, concurrent claims, and parent safeguards", async () => {
    const { db, bankTransactions, bankDepositBatchMembers } = dbMod as any;
    const [a, b] = await db.insert(bankTransactions).values([
      {
        id: rid("child"), labOrganizationId: labOrgId, bankAccountId: ufAccountId,
        txnDate: new Date(), type: "deposit", source: "invoice", status: "posted",
        debitAmount: "0.00", creditAmount: "0.10", netAmount: "0.10",
        createdByUserId: adminUserId,
      },
      {
        id: rid("child"), labOrganizationId: labOrgId, bankAccountId: ufAccountId,
        txnDate: new Date(), type: "deposit", source: "invoice", status: "posted",
        debitAmount: "0.00", creditAmount: "0.20", netAmount: "0.20",
        createdByUserId: adminUserId,
      },
    ]).returning();
    const payload = {
      organizationId: labOrgId, bankAccountId: realAccountId,
      transactionIds: [a.id, b.id],
    };
    const results = await Promise.all([
      request(app).post("/api/finance/make-deposits").set("Authorization", `Bearer ${tokens.admin}`).send(payload),
      request(app).post("/api/finance/make-deposits").set("Authorization", `Bearer ${tokens.admin}`).send(payload),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);
    const aggregateId = results.find((r) => r.status === 200)!.body.data.aggregateTransactionId;
    expect(results.find((r) => r.status === 200)!.body.data.totalAmount).toBe("0.30");
    const members = await db.select().from(bankDepositBatchMembers)
      .where(eq(bankDepositBatchMembers.aggregateBankTransactionId, aggregateId));
    expect(members).toHaveLength(2);
    const [parent] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, aggregateId));
    const patch = await request(app).patch(`/api/finance/transactions/${aggregateId}`)
      .set("Authorization", `Bearer ${tokens.admin}`).send({ deposit: 9.99 });
    expect(patch.status).toBe(409);
    const deletion = await request(app).delete(`/api/finance/transactions/${aggregateId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(deletion.status).toBe(409);
    await db.update(bankTransactions).set({ reconciled: true }).where(eq(bankTransactions.id, aggregateId));
    const lockedVoid = await request(app).post(`/api/finance/transactions/${aggregateId}/void`)
      .set("Authorization", `Bearer ${tokens.admin}`).send({});
    expect(lockedVoid.status).toBe(400);
    await db.update(bankTransactions).set({ reconciled: false }).where(eq(bankTransactions.id, aggregateId));
    const voided = await request(app).post(`/api/finance/transactions/${aggregateId}/void`)
      .set("Authorization", `Bearer ${tokens.admin}`).send({});
    expect(voided.status).toBe(200);
    const releasedMembers = await db.select().from(bankDepositBatchMembers)
      .where(eq(bankDepositBatchMembers.aggregateBankTransactionId, aggregateId));
    expect(releasedMembers).toHaveLength(2);
    expect(releasedMembers.every((member: any) => member.releasedAt instanceof Date)).toBe(true);
    const restoredChildren = await db.select().from(bankTransactions)
      .where(inArray(bankTransactions.id, [a.id, b.id]));
    expect(restoredChildren.every((child: any) =>
      child.status === "posted" &&
      child.bankAccountId === ufAccountId &&
      child.cleared === false &&
      child.depositedAt === null
    )).toBe(true);
    expect(parent.netAmount).toBe("0.30");
    const redeposit = await request(app).post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`).send(payload);
    expect(redeposit.status).toBe(200);
    expect(redeposit.body.data.aggregateTransactionId).not.toBe(aggregateId);
  });

  it("make-deposits: cross-org selected IDs never create a parent", async () => {
    const { db, bankTransactions } = dbMod as any;
    const [cross] = await db.insert(bankTransactions).values({
      id: rid("cross"), labOrganizationId: otherLabOrgId, bankAccountId: otherLabUfAccountId,
      txnDate: new Date(), type: "deposit", source: "invoice", status: "posted",
      debitAmount: "0.00", creditAmount: "1.00", netAmount: "1.00",
      createdByUserId: otherLabAdminId,
    }).returning();
    const result = await request(app).post("/api/finance/make-deposits")
      .set("Authorization", `Bearer ${tokens.admin}`).send({
        organizationId: labOrgId, bankAccountId: realAccountId, transactionIds: [cross.id],
      });
    expect(result.status).toBe(400);
    const parents = await db.select().from(bankTransactions).where(eq(bankTransactions.source, "deposit_batch"));
    expect(parents.some((p: any) => p.id === cross.id)).toBe(false);
  });
});
