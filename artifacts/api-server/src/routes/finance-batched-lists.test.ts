import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { cleanupPaymentFixtures } from "../test-utils/payment-cleanup.js";

vi.mock("../lib/backup.js", () => ({ restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({ startDailyOrphanedMediaCleanup: vi.fn() }));

const maybe = process.env.DATABASE_URL ? describe : describe.skip;
const rid = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

maybe("finance batched lists", () => {
  let mod: typeof import("@workspace/db");
  let app: import("express").Express;
  let token = "";
  const userId = rid("batch_u");
  const labId = rid("batch_lab");
  const practiceA = rid("batch_pa");
  const practiceB = rid("batch_pb");
  let checkingId = "";
  let ufId = "";
  const transactionIds: string[] = [];
  const sessionIds: string[] = [];

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "finance-batched-test-secret";
    mod = await import("@workspace/db");
    app = (await import("../app.js")).default;
    const auth = await import("../lib/auth.js");
    const { db, users, organizations, organizationMemberships, bankAccounts, userSessions } = mod as any;
    await db.insert(users).values({ id: userId, username: rid("batch"), password: "x" });
    await db.insert(organizations).values([
      { id: labId, type: "lab", name: "Batch Lab" },
      { id: practiceA, type: "provider", name: "Practice A", parentLabOrganizationId: labId },
      { id: practiceB, type: "provider", name: "Practice B", parentLabOrganizationId: labId },
    ]);
    await db.insert(organizationMemberships).values({ id: rid("mem"), labId, userId, role: "owner", status: "active" });
    const accounts = await db.insert(bankAccounts).values([
      { labOrganizationId: labId, name: "Checking", accountType: "checking", openingBalance: "0", openingDate: new Date(), createdByUserId: userId },
      { labOrganizationId: labId, name: "UF", accountType: "undeposited_funds", openingBalance: "0", openingDate: new Date(), createdByUserId: userId },
    ]).returning();
    checkingId = accounts[0].id;
    ufId = accounts[1].id;
    const sessionId = rid("sess");
    const refresh = auth.signRefreshToken(userId, sessionId);
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: createHash("sha256").update(refresh).digest("hex"), expiresAt: new Date(Date.now() + 86400000) });
    token = auth.signAccessToken(userId, sessionId);
  });

  afterAll(async () => {
    if (!process.env.DATABASE_URL) return;
    const { db, bankTransactions, bankAccounts, reconciliations, userSessions, organizationMemberships, organizations, users } = mod as any;
    await cleanupPaymentFixtures({ paymentSessionIds: sessionIds }, db);
    if (transactionIds.length) await db.delete(bankTransactions).where(inArray(bankTransactions.id, transactionIds));
    await db.delete(reconciliations).where(eq(reconciliations.labOrganizationId, labId));
    await db.delete(bankAccounts).where(eq(bankAccounts.labOrganizationId, labId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
    await db.delete(organizations).where(inArray(organizations.id, [practiceA, practiceB, labId]));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("pages transactions newest-first while retaining the legacy array", async () => {
    const { db, bankTransactions } = mod as any;
    const ids = [rid("old"), rid("mid"), rid("new")]; transactionIds.push(...ids);
    await db.insert(bankTransactions).values(ids.map((id, index) => ({
      id, labOrganizationId: labId, bankAccountId: checkingId, txnDate: new Date(`2026-01-0${index + 1}T00:00:00Z`),
      status: "posted", debitAmount: "0", creditAmount: String(index + 1), netAmount: String(index + 1),
    })));
    const legacy = await request(app).get(`/api/finance/transactions?organizationId=${labId}&bankAccountId=${checkingId}`).set("Authorization", `Bearer ${token}`);
    expect(Array.isArray(legacy.body.data)).toBe(true);
    expect(legacy.body.data.slice(0, 3).map((row: any) => row.id)).toEqual([...ids].reverse());
    const page = await request(app).get(`/api/finance/transactions?organizationId=${labId}&bankAccountId=${checkingId}&limit=1&offset=1`).set("Authorization", `Bearer ${token}`);
    expect(page.body.data).toMatchObject({ total: 3, hasMore: true, offset: 1 });
    expect(page.body.data.rows[0].id).toBe(ids[1]);
  });

  it("filters and aggregates paged undeposited funds over the full match", async () => {
    const { db, bankTransactions, statementPaymentSessions } = mod as any;
    const now = Date.now();
    const rows = [
      { id: rid("ufa1"), practice: practiceA, doctor: "dr-a", amount: "10.00", date: new Date(now) },
      { id: rid("ufa2"), practice: practiceA, doctor: "dr-a", amount: "20.00", date: new Date(now - 40 * 86400000) },
      { id: rid("ufentire"), practice: practiceA, doctor: null, amount: "30.00", date: new Date(now - 1000) },
      { id: rid("ufb"), practice: practiceB, doctor: "dr-b", amount: "40.00", date: new Date(now - 2000) },
    ];
    transactionIds.push(...rows.map(row => row.id));
    await db.insert(bankTransactions).values(rows.map(row => ({ id: row.id, labOrganizationId: labId, bankAccountId: ufId, txnDate: row.date, status: "posted", debitAmount: "0", creditAmount: row.amount, netAmount: row.amount })));
    const sessions = rows.map(row => ({ id: rid("ps"), row })); sessionIds.push(...sessions.map(item => item.id));
    await db.insert(statementPaymentSessions).values(sessions.map(({ id, row }) => ({
      id, labOrganizationId: labId, providerOrganizationId: row.practice, bankTransactionId: row.id,
      doctorIdentity: row.doctor, requestFingerprint: rid("fp"), receiptNumber: rid("r"), receivedAmount: row.amount,
      appliedAmount: row.amount, customerCreditAmount: "0", accountBalanceAfter: "0", paymentMethod: "check",
      labName: "Batch Lab", createdByUserId: userId,
    })));
    const filtered = await request(app).get(`/api/finance/undeposited-funds?organizationId=${labId}&practiceId=${practiceA}&doctorKey=dr-a&limit=1&offset=0`).set("Authorization", `Bearer ${token}`);
    expect(filtered.body.data).toMatchObject({ total: 2, hasMore: true, amountTotal: "30.00", staleCount: 1 });
    expect(filtered.body.data.rows).toHaveLength(1);
    const entire = await request(app).get(`/api/finance/undeposited-funds?organizationId=${labId}&practiceId=${practiceA}&doctorKey=entire&limit=10&offset=0`).set("Authorization", `Bearer ${token}`);
    expect(entire.body.data.total).toBe(1);
    expect(entire.body.data.rows[0].id).toBe(rows[2].id);

    // Selection mode answers with every matching id so a paged client can
    // select the full filtered set, even alongside a page window.
    const selection = await request(app).get(`/api/finance/undeposited-funds?organizationId=${labId}&practiceId=${practiceA}&doctorKey=dr-a&selection=ids&limit=1&offset=0`).set("Authorization", `Bearer ${token}`);
    expect(selection.body.data).toMatchObject({ total: 2, amountTotal: "30.00" });
    expect(selection.body.data.selection.map((row: any) => row.id).sort()).toEqual([rows[0].id, rows[1].id].sort());
    expect(selection.body.data.selection.map((row: any) => row.creditAmount).sort()).toEqual(["10.00", "20.00"]);
    const everything = await request(app).get(`/api/finance/undeposited-funds?organizationId=${labId}&selection=ids`).set("Authorization", `Bearer ${token}`);
    expect(everything.body.data.total).toBe(4);
    expect(everything.body.data.amountTotal).toBe("100.00");
    const summary = await request(app).get(`/api/finance/undeposited-funds?organizationId=${labId}&selection=ids&summary=1`).set("Authorization", `Bearer ${token}`);
    expect(summary.body.data).toMatchObject({ count: 4 });
  });

  it("pages reconciliation history newest-first", async () => {
    for (const date of ["2025-01-01", "2026-01-01"]) {
      const response = await request(app).post("/api/finance/reconciliation/finish").set("Authorization", `Bearer ${token}`)
        .send({ bankAccountId: checkingId, statementDate: new Date(date).toISOString(), endingBalance: 0, transactionIds: [] });
      expect(response.status).toBe(201);
    }
    const page = await request(app).get(`/api/finance/reconciliation/history?bankAccountId=${checkingId}&limit=1&offset=0`).set("Authorization", `Bearer ${token}`);
    expect(page.body.data).toMatchObject({ total: 2, hasMore: true });
    expect(String(page.body.data.rows[0].statementDate)).toContain("2026");
  });
});