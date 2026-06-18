/**
 * Integration tests for finance / bank-account routes (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/finance/accounts — creates a bank account (201)
 *  - GET /api/finance/accounts?organizationId=... — returns the account in list
 *  - POST /api/finance/accounts — 403 when caller lacks admin role
 *  - Unauthenticated requests return 401
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-finance"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Finance / bank accounts (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const adminId = rid("u");
  const memberId = rid("m");
  const labOrgId = rid("lab");

  async function makeSession(userId: string): Promise<{ access: string; refresh: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access, refresh };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-finance";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminId, username: `finadmin_${adminId}`, password: "x" },
      { id: memberId, username: `finmem_${memberId}`, password: "x" },
    ]);

    await db.insert(organizations).values({
      id: labOrgId,
      type: "lab",
      name: rid("FinanceTestLab"),
    });

    await db.insert(organizationMemberships).values([
      {
        id: rid("m1"),
        labId: labOrgId,
        userId: adminId,
        role: "owner",
        status: "active",
        approvedByUserId: adminId,
        joinedAt: new Date(),
      },
      {
        id: rid("m2"),
        labId: labOrgId,
        userId: memberId,
        role: "user",
        status: "active",
        approvedByUserId: adminId,
        joinedAt: new Date(),
      },
    ]);
  });

  // Ensure a fresh session exists before each test; per-test sessions created
  // in each it() body are still the authoritative token for that test.
  beforeEach(async () => {
    await makeSession(adminId);
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
    } = dbMod as any;

    // Bank transactions reference bank accounts; delete them first.
    const acctIds = (
      await db.select({ id: bankAccounts.id }).from(bankAccounts).where(
        eq(bankAccounts.labOrganizationId, labOrgId)
      )
    ).map((r: any) => r.id);

    if (acctIds.length) {
      await db.delete(bankTransactions).where(
        inArray(bankTransactions.bankAccountId, acctIds)
      );
    }

    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId]));
    await db.delete(bankAccounts).where(eq(bankAccounts.labOrganizationId, labOrgId));
    await db.delete(userSessions).where(inArray(userSessions.userId, [adminId, memberId]));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [adminId, memberId])
    );
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [adminId, memberId]));
  });

  // ── POST /api/finance/accounts ────────────────────────────────────────────

  it("POST /api/finance/accounts creates a bank account and returns 201", async () => {
    const { access } = await makeSession(adminId);
    const name = rid("Checking");

    const r = await request(appMod.default)
      .post("/api/finance/accounts")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name });

    expect(r.status).toBe(201);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.name).toBe(name);
    expect(r.body.data.labOrganizationId).toBe(labOrgId);
  });

  it("POST /api/finance/accounts — non-admin member returns 403", async () => {
    const { access } = await makeSession(memberId);

    const r = await request(appMod.default)
      .post("/api/finance/accounts")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name: "Savings" });

    expect(r.status).toBe(403);
  });

  it("POST /api/finance/accounts — missing required fields returns 400", async () => {
    const { access } = await makeSession(adminId);

    const r = await request(appMod.default)
      .post("/api/finance/accounts")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId });

    expect(r.status).toBe(400);
  });

  it("unauthenticated POST /api/finance/accounts returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/finance/accounts")
      .send({ organizationId: labOrgId, name: "NoAuth" });
    expect(r.status).toBe(401);
  });

  // ── GET /api/finance/accounts ─────────────────────────────────────────────

  it("GET /api/finance/accounts?organizationId=... returns the created account", async () => {
    const { access } = await makeSession(adminId);
    const name = rid("GetAcct");

    const create = await request(appMod.default)
      .post("/api/finance/accounts")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name });
    expect(create.status).toBe(201);
    const acctId = create.body.data.id;

    const list = await request(appMod.default)
      .get(`/api/finance/accounts?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const ids: string[] = (list.body.data ?? []).map((a: any) => a.id);
    expect(ids).toContain(acctId);
  });

  // ── POST /api/finance/transactions ────────────────────────────────────────

  it("POST /api/finance/transactions creates a deposit transaction and returns 201", async () => {
    const { access } = await makeSession(adminId);
    const acctName = rid("TxnAcct");

    const acct = await request(appMod.default)
      .post("/api/finance/accounts")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name: acctName });
    expect(acct.status).toBe(201);
    const bankAccountId = acct.body.data.id;

    const r = await request(appMod.default)
      .post("/api/finance/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({
        bankAccountId,
        txnDate: new Date().toISOString().split("T")[0],
        type: "deposit",
        payee: "Test Payer",
        deposit: 250,
        status: "posted",
      });

    expect(r.status).toBe(201);
    expect(r.body.data).toBeDefined();
    expect(Number(r.body.data.creditAmount)).toBe(250);
  });

  it("GET /api/finance/transactions returns the created transaction", async () => {
    const { access } = await makeSession(adminId);
    const acctName = rid("ListTxnAcct");

    const acct = await request(appMod.default)
      .post("/api/finance/accounts")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name: acctName });
    expect(acct.status).toBe(201);
    const bankAccountId = acct.body.data.id;

    const create = await request(appMod.default)
      .post("/api/finance/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({
        bankAccountId,
        txnDate: new Date().toISOString().split("T")[0],
        type: "deposit",
        payee: "Listed Payer",
        deposit: 100,
        status: "posted",
      });
    expect(create.status).toBe(201);
    const txnId = create.body.data.id;

    const list = await request(appMod.default)
      .get(`/api/finance/transactions?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const ids: string[] = (list.body.data ?? []).map((t: any) => t.id);
    expect(ids).toContain(txnId);
  });

  it("POST /api/finance/accounts with openingBalance creates an opening transaction", async () => {
    const { access } = await makeSession(adminId);
    const name = rid("OpenBal");

    const r = await request(appMod.default)
      .post("/api/finance/accounts")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name, openingBalance: 500 });

    expect(r.status).toBe(201);
    // The opening balance is stored on the account row.
    expect(Number(r.body.data.openingBalance)).toBe(500);
  });

  // ── Cross-org visibility ──────────────────────────────────────────────────

  it("GET /api/finance/transactions — user with no membership in org returns 403", async () => {
    // The endpoint calls requireAnyRole(uid, organizationId, BILLING_ROLES);
    // a user with no membership must be rejected, not see another lab's data.
    const { db, users, userSessions } = dbMod as any;
    const outsiderId = rid("fout");
    await db.insert(users).values({
      id: outsiderId,
      username: `fout_${outsiderId}`,
      password: "x",
    });

    try {
      const { access } = await makeSession(outsiderId);
      const r = await request(appMod.default)
        .get(`/api/finance/transactions?organizationId=${labOrgId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(403);
    } finally {
      await db.delete(userSessions).where(eq(userSessions.userId, outsiderId));
      await db.delete(users).where(eq(users.id, outsiderId));
    }
  });

  // ── Deposit linked to invoice ─────────────────────────────────────────────

  it("POST /api/finance/transactions — deposit with invoiceIds links the invoice", async () => {
    const { access } = await makeSession(adminId);
    const { db, invoices: invoicesTable, bankTransactionInvoices } = dbMod as any;

    const acct = await request(appMod.default)
      .post("/api/finance/accounts")
      .set("Authorization", `Bearer ${access}`)
      .send({ organizationId: labOrgId, name: rid("LinkedAcct") });
    expect(acct.status).toBe(201);
    const bankAccountId: string = acct.body.data.id;

    // provider_organization_id is NOT NULL — insert a minimal provider org
    const { organizations: orgsTable } = dbMod as any;
    const providerOrgId = rid("provorg");
    await db.insert(orgsTable).values({
      id: providerOrgId,
      name: rid("FinProv"),
      type: "provider",
    });

    const invId = rid("finv");
    await db.insert(invoicesTable).values({
      id: invId,
      invoiceNumber: `INV-${rid("").slice(0, 6)}`,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      createdByUserId: adminId,
    });

    try {
      const r = await request(appMod.default)
        .post("/api/finance/transactions")
        .set("Authorization", `Bearer ${access}`)
        .send({
          bankAccountId,
          txnDate: new Date().toISOString().split("T")[0],
          type: "deposit",
          payee: "Linked Payer",
          deposit: 300,
          status: "posted",
          invoiceIds: [invId],
        });
      expect(r.status).toBe(201);

      const links = await db
        .select()
        .from(bankTransactionInvoices)
        .where(eq(bankTransactionInvoices.invoiceId, invId));
      expect(links.length).toBe(1);
      expect(links[0].invoiceId).toBe(invId);
    } finally {
      await db.delete(bankTransactionInvoices).where(
        eq(bankTransactionInvoices.invoiceId, invId)
      );
      await db.delete(invoicesTable).where(eq(invoicesTable.id, invId));
      await db.delete(orgsTable).where(eq(orgsTable.id, providerOrgId));
    }
  });
});
