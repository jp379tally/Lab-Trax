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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import type { Express } from "express";

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
  const adminUserId = rid("uadm");
  const otherLabAdminId = rid("uoth");

  let ufAccountId = "";
  let realAccountId = "";
  let otherLabUfAccountId = "";

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

  async function insertInvoice(opts: {
    invoiceNumber: string;
    labOrgId?: string;
    practiceId?: string;
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
      providerOrganizationId: opts.practiceId ?? practiceId,
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

    tokens.admin = await makeSession(adminUserId);
    tokens.otherAdmin = await makeSession(otherLabAdminId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      bankTransactionInvoices,
      bankTransactions,
      bankAccounts,
      invoices,
      payments,
      organizationMemberships,
      userSessions,
      organizations,
      users,
    } = dbMod as any;

    // Delete in FK-safe order
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
        ])
      );
    await db
      .delete(payments)
      .where(inArray(payments.invoiceId, db.select({ id: invoices.id }).from(invoices).where(eq(invoices.labOrganizationId, labOrgId))));
    await db
      .delete(invoices)
      .where(eq(invoices.labOrganizationId, labOrgId));
    await db
      .delete(bankAccounts)
      .where(
        inArray(bankAccounts.id, [ufAccountId, realAccountId, otherLabUfAccountId])
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
        inArray(organizations.id, [labOrgId, practiceId, otherLabOrgId])
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

    // Insert a stale transaction dated 45 days ago
    const staleTxnId = rid("txn_stale");
    const staleDate = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
    await db.insert(bankTransactions).values({
      id: staleTxnId,
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

  // ---------------------------------------------------------------------------
  // POST /api/finance/make-deposits
  // ---------------------------------------------------------------------------

  it("make-deposits: moves selected UF transactions to target account", async () => {
    const { db, bankTransactions } = dbMod as any;

    // Grab current UF txn ids
    const ufTxns = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.bankAccountId, ufAccountId));

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

    // Verify rows were moved to the real account in the DB and
    // deposit audit fields were stamped
    const movedTxns = await db
      .select()
      .from(bankTransactions)
      .where(inArray(bankTransactions.id, txnIds));
    for (const t of movedTxns) {
      expect(t.bankAccountId).toBe(realAccountId);
      expect(t.cleared).toBe(true);
      expect(t.depositedByUserId).toBe(adminUserId);
      expect(t.depositedAt).toBeInstanceOf(Date);
    }
  });

  it("make-deposits: after move, UF is empty", async () => {
    const r = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);

    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(0);
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
});
