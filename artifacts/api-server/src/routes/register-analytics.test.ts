import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({ restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({ startDailyOrphanedMediaCleanup: vi.fn() }));

const maybe = process.env.DATABASE_URL ? describe : describe.skip;
maybe("account-scoped register analytics", () => {
  let mod: typeof import("@workspace/db");
  let app: import("express").Express;
  const userId = randomUUID(), lab = randomUUID(), foreignLab = randomUUID();
  let account = "", otherAccount = "", foreignAccount = "", token = "";
  beforeAll(async () => {
    mod = await import("@workspace/db");
    app = (await import("../app.js")).default;
    const auth = await import("../lib/auth.js");
    const { db, users, organizations, organizationMemberships, bankAccounts, userSessions, bankTransactions, bankDepositBatchMembers } = mod;
    await db.insert(users).values({ id: userId, username: `analytics_${userId}`, password: "x" });
    await db.insert(organizations).values([
      { id: lab, name: "Analytics test lab", type: "lab" },
      { id: foreignLab, name: "Foreign analytics lab", type: "lab" },
    ]);
    await db.insert(organizationMemberships).values({ labId: lab, userId, role: "owner", status: "active" });
    const created = await db.insert(bankAccounts).values([
      { labOrganizationId: lab, name: "Selected", openingBalance: "-20" },
      { labOrganizationId: lab, name: "Other" },
      { labOrganizationId: foreignLab, name: "Foreign" },
    ]).returning();
    [account, otherAccount, foreignAccount] = created.map((a) => a.id);
    const session = randomUUID();
    const refresh = auth.signRefreshToken(userId, session);
    await db.insert(userSessions).values({ id: session, userId,
      tokenHash: createHash("sha256").update(refresh).digest("hex"),
      expiresAt: new Date(Date.now() + 86400000) });
    token = auth.signAccessToken(userId, session);
    const base = { labOrganizationId: lab, bankAccountId: account, txnDate: new Date("2026-09-01T00:00:00Z") };
    const aggregate = randomUUID(), child = randomUUID();
    await db.insert(bankTransactions).values([
      // More than a register page and decimal amounts that cannot be summed as floats.
      ...Array.from({ length: 25 }, (_, i) => ({ ...base, payee: "Supplier", debitAmount: "0.10", netAmount: "-0.10", cleared: i < 5 })),
      { ...base, id: aggregate, source: "deposit_batch", payee: "Batch", creditAmount: "12.34", netAmount: "12.34" },
      { ...base, id: child, creditAmount: "12.34", netAmount: "12.34" },
      { ...base, status: "deposited_child", creditAmount: "999" },
      { ...base, status: "void", cleared: true, creditAmount: "900" },
      { ...base, status: "projected", cleared: true, creditAmount: "800" },
      { ...base, status: "pending", debitAmount: "700" },
      { ...base, type: "transfer", transferGroupId: randomUUID(), creditAmount: "600", reconciled: true },
      { ...base, type: "transfer", debitAmount: "500" },
      { ...base, payee: "", creditAmount: "1.00", netAmount: "1.00", txnDate: new Date("2026-09-02T23:59:59.999Z") },
      { ...base, debitAmount: "400", deletedAt: new Date() },
      { ...base, txnDate: new Date("2026-09-03T00:00:00Z"), creditAmount: "300" },
      { ...base, bankAccountId: otherAccount, creditAmount: "200" },
      { ...base, bankAccountId: foreignAccount, labOrganizationId: foreignLab, creditAmount: "100" },
    ]);
    await db.insert(bankDepositBatchMembers).values({ aggregateBankTransactionId: aggregate, childBankTransactionId: child });
  });
  afterAll(async () => {
    if (!mod) return;
    const { db, bankDepositBatchMembers, bankTransactions, bankAccounts, userSessions, organizationMemberships, organizations, users } = mod;
    const ids = db.select({ id: bankTransactions.id }).from(bankTransactions).where(eq(bankTransactions.labOrganizationId, lab));
    await db.delete(bankDepositBatchMembers).where(
      // Scope teardown to this fixture, never sweep other labs.
      (await import("drizzle-orm")).inArray(bankDepositBatchMembers.aggregateBankTransactionId, ids));
    for (const org of [lab, foreignLab]) {
      await db.delete(bankTransactions).where(eq(bankTransactions.labOrganizationId, org));
      await db.delete(bankAccounts).where(eq(bankAccounts.labOrganizationId, org));
    }
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
    for (const org of [lab, foreignLab]) await db.delete(organizations).where(eq(organizations.id, org));
    await db.delete(users).where(eq(users.id, userId));
  });
  const fetchAnalytics = (overrides: Record<string, string> = {}) => request(app)
    .get("/api/finance/register-analytics")
    .query({ organizationId: lab, bankAccountId: account, dateFrom: "2026-09-01", dateTo: "2026-09-02", ...overrides })
    .set("Authorization", `Bearer ${token}`);
  it("rejects manual Undeposited Funds entries without writing a transaction", async () => {
    const { db, bankAccounts, bankTransactions } = mod;
    const uf = randomUUID();
    await db.insert(bankAccounts).values({ id: uf, labOrganizationId: lab, name: "Undeposited Funds", accountType: "undeposited_funds" });
    const result = await request(app).post("/api/finance/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ bankAccountId: uf, txnDate: "2026-09-01T00:00:00.000Z", type: "other", deposit: 10 });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("Receive Payments");
    expect(await db.select({ id: bankTransactions.id }).from(bankTransactions).where(eq(bankTransactions.bankAccountId, uf))).toEqual([]);
  });

  it("sums the whole period exactly, counts batches once, excludes transfers only from money, and prioritizes status", async () => {
    const response = await fetchAnalytics({ search: "not a payee", limit: "1", status: "void" });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      daily: [
        { date: "2026-09-01", payments: "2.50", deposits: "12.34" },
        { date: "2026-09-02", payments: "0.00", deposits: "1.00" },
      ],
      totalEntries: 32,
      statuses: { postedCleared: 6, postedUncleared: 23, voided: 1, pending: 2 },
      payees: [
        { payee: "Batch", volume: "12.34", payments: "0.00", deposits: "12.34" },
        { payee: "Supplier", volume: "2.50", payments: "2.50", deposits: "0.00" },
        { payee: "Unspecified payee", volume: "1.00" },
      ],
    });
  });
  it("switches account and dates, and honestly fills empty calendar buckets", async () => {
    const empty = await fetchAnalytics({ dateFrom: "2026-08-01", dateTo: "2026-08-02" });
    expect(empty.body.data).toMatchObject({ totalEntries: 0, payees: [], statuses: { postedCleared: 0, postedUncleared: 0, voided: 0, pending: 0 } });
    expect(empty.body.data.daily).toHaveLength(2);
    expect(empty.body.data.daily.every((d: { payments: string; deposits: string }) => d.payments === "0.00" && d.deposits === "0.00")).toBe(true);
    const other = await fetchAnalytics({ bankAccountId: otherAccount });
    expect(other.body.data.daily[0].deposits).toBe("200.00");
  });
  it("ranks only five payees by combined exact movement with deterministic ties", async () => {
    const { db, bankTransactions } = mod;
    await db.insert(bankTransactions).values(
      Array.from({ length: 7 }, (_, i) => ({
        labOrganizationId: lab, bankAccountId: account, txnDate: new Date("2026-08-15T12:00:00Z"),
        payee: `Payee ${i}`, debitAmount: "1.25", creditAmount: String(i), netAmount: String(i - 1.25),
      })),
    );
    const response = await fetchAnalytics({ dateFrom: "2026-08-15", dateTo: "2026-08-15" });
    expect(response.status).toBe(200);
    expect(response.body.data.totalEntries).toBe(7);
    expect(response.body.data.payees).toHaveLength(5);
    expect(response.body.data.payees.map((p: { payee: string }) => p.payee)).toEqual(["Payee 6", "Payee 5", "Payee 4", "Payee 3", "Payee 2"]);
    expect(response.body.data.payees[0]).toEqual({ payee: "Payee 6", volume: "7.25", deposits: "6.00", payments: "1.25" });
    expect(response.body.data.daily[0]).toEqual({ date: "2026-08-15", payments: "8.75", deposits: "21.00" });
  });
  it("rejects foreign account/lab and unauthenticated access", async () => {
    expect((await fetchAnalytics({ bankAccountId: foreignAccount })).status).toBe(404);
    expect((await fetchAnalytics({ bankAccountId: foreignAccount, organizationId: foreignLab })).status).toBe(403);
    expect((await request(app).get("/api/finance/register-analytics")).status).toBe(401);
  });
  it("rejects impossible, reversed and excessive ranges", async () => {
    for (const dates of [
      { dateFrom: "2026-02-30", dateTo: "2026-03-01" },
      { dateFrom: "2026-09-03", dateTo: "2026-09-01" },
      { dateFrom: "2024-01-01", dateTo: "2026-09-01" },
    ]) expect((await fetchAnalytics(dates)).status).toBe(400);
    expect((await fetchAnalytics({ bankAccountId: "not-an-account-id" })).status).toBe(400);
    expect((await fetchAnalytics({ organizationId: "" })).status).toBe(400);
  });
});
