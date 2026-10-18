/**
 * The desktop finance lists open with a bounded batch and fetch older ones
 * through Load more. With offset paging, a record created (or re-sorted)
 * between two of those requests shifts the window: the row that would have
 * started the next batch is pushed past it and never seen, or a row is served
 * twice. These tests page each list with a cursor while inserting a record
 * between the two fetches, and assert the combined batches still cover the
 * full set exactly once.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({ restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({ startDailyOrphanedMediaCleanup: vi.fn() }));

const maybe = process.env["DATABASE_URL"] ? describe : describe.skip;
const rid = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

maybe("finance lists page without skipping records", () => {
  let dbMod: typeof import("@workspace/db");
  let app: import("express").Express;
  let token = "";
  const labId = rid("keyset_lab");
  const practiceId = rid("keyset_practice");
  const userId = rid("keyset_user");
  const invoiceIds: string[] = [];
  const transactionIds: string[] = [];
  let checkingId = "";

  beforeAll(async () => {
    process.env["JWT_SECRET"] ??= "keyset-paging-test-secret";
    dbMod = await import("@workspace/db");
    app = (await import("../app.js")).default;
    const auth = await import("../lib/auth.js");
    const {
      db, users, organizations, organizationMemberships, userSessions, invoices, bankAccounts,
    } = dbMod;
    await db.insert(users).values({ id: userId, username: rid("keyset"), password: "x" });
    await db.insert(organizations).values([
      { id: labId, type: "lab", name: "Keyset Lab" },
      { id: practiceId, type: "provider", name: "Keyset Practice", parentLabOrganizationId: labId },
    ]);
    await db.insert(organizationMemberships).values({
      id: rid("keyset_mem"), labId, userId, role: "admin", status: "active",
    });
    const sessionId = rid("keyset_session");
    token = auth.signAccessToken(userId, sessionId);
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    // Six invoices, oldest to newest, so the list orders them KEYSET-5 … 0.
    for (let index = 0; index < 6; index++) {
      const id = rid("keyset_invoice");
      invoiceIds.push(id);
      await db.insert(invoices).values({
        id,
        invoiceNumber: `KEYSET-${index}`,
        labOrganizationId: labId,
        providerOrganizationId: practiceId,
        status: "open",
        total: "100.00",
        balanceDue: "100.00",
        issuedAt: new Date(2026, 0, index + 1),
        createdAt: new Date(2026, 0, index + 1),
        createdByUserId: userId,
      });
    }

    const accounts = await db.insert(bankAccounts).values({
      labOrganizationId: labId,
      name: "Keyset Checking",
      accountType: "checking",
      openingBalance: "0",
      openingDate: new Date(),
      createdByUserId: userId,
    }).returning();
    checkingId = accounts[0]!.id;
    for (let index = 0; index < 6; index++) {
      const id = rid("keyset_txn");
      transactionIds.push(id);
      await db.insert(dbMod.bankTransactions).values({
        id,
        labOrganizationId: labId,
        bankAccountId: checkingId,
        txnDate: new Date(Date.UTC(2026, 0, index + 1)),
        status: "posted",
        payee: `Keyset ${index}`,
        debitAmount: "0",
        creditAmount: "1.00",
        netAmount: "1.00",
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (!process.env["DATABASE_URL"]) return;
    const {
      db, invoices, bankTransactions, bankAccounts, userSessions,
      organizationMemberships, organizations, users,
    } = dbMod;
    await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
    await db.delete(bankTransactions).where(eq(bankTransactions.labOrganizationId, labId));
    await db.delete(bankAccounts).where(eq(bankAccounts.labOrganizationId, labId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
    await db.delete(organizations).where(inArray(organizations.id, [practiceId, labId]));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("covers every invoice exactly once when one is created between batches", async () => {
    const get = (query: Record<string, string | number>) =>
      request(app).get("/api/invoices").set("Authorization", `Bearer ${token}`)
        .query({ search: "KEYSET-", limit: 2, ...query });

    const first = await get({});
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.total).toBe(6);
    expect(first.body.data.rows.map((row: { invoiceNumber: string }) => row.invoiceNumber))
      .toEqual(["KEYSET-5", "KEYSET-4"]);
    expect(first.body.data.nextCursor).toBeTruthy();

    // A new invoice lands at the head of the list between the two requests.
    const insertedId = rid("keyset_invoice");
    invoiceIds.push(insertedId);
    await dbMod.db.insert(dbMod.invoices).values({
      id: insertedId,
      invoiceNumber: "KEYSET-NEW",
      labOrganizationId: labId,
      providerOrganizationId: practiceId,
      status: "open",
      total: "100.00",
      balanceDue: "100.00",
      issuedAt: new Date(2026, 1, 1),
      createdAt: new Date(2026, 1, 1),
      createdByUserId: userId,
    });

    const seen = first.body.data.rows.map((row: { invoiceNumber: string }) => row.invoiceNumber);
    let cursor: string | null = first.body.data.nextCursor;
    let hasMore = first.body.data.hasMore;
    while (hasMore && cursor) {
      const next: { body: { data: { rows: { invoiceNumber: string }[]; hasMore: boolean; nextCursor: string | null } } } =
        await get({ cursor });
      seen.push(...next.body.data.rows.map((row) => row.invoiceNumber));
      hasMore = next.body.data.hasMore;
      cursor = next.body.data.nextCursor;
    }

    // Every pre-existing invoice appears exactly once. Under offset paging the
    // insertion would have pushed KEYSET-3 out of the second window.
    expect([...seen].sort()).toEqual([
      "KEYSET-0", "KEYSET-1", "KEYSET-2", "KEYSET-3", "KEYSET-4", "KEYSET-5",
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("covers every register transaction exactly once when one is created between batches", async () => {
    const get = (query: Record<string, string | number>) =>
      request(app).get("/api/finance/transactions").set("Authorization", `Bearer ${token}`)
        .query({ organizationId: labId, bankAccountId: checkingId, limit: 2, ...query });

    const first = await get({});
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.total).toBe(6);
    expect(first.body.data.rows.map((row: { payee: string }) => row.payee))
      .toEqual(["Keyset 5", "Keyset 4"]);

    const insertedId = rid("keyset_txn");
    transactionIds.push(insertedId);
    await dbMod.db.insert(dbMod.bankTransactions).values({
      id: insertedId,
      labOrganizationId: labId,
      bankAccountId: checkingId,
      txnDate: new Date(Date.UTC(2026, 1, 1)),
      status: "posted",
      payee: "Keyset NEW",
      debitAmount: "0",
      creditAmount: "1.00",
      netAmount: "1.00",
    });

    const seen = first.body.data.rows.map((row: { payee: string }) => row.payee);
    let cursor: string | null = first.body.data.nextCursor;
    let hasMore = first.body.data.hasMore;
    while (hasMore && cursor) {
      const next: { body: { data: { rows: { payee: string }[]; hasMore: boolean; nextCursor: string | null } } } =
        await get({ cursor });
      seen.push(...next.body.data.rows.map((row) => row.payee));
      hasMore = next.body.data.hasMore;
      cursor = next.body.data.nextCursor;
    }

    expect([...seen].sort()).toEqual([
      "Keyset 0", "Keyset 1", "Keyset 2", "Keyset 3", "Keyset 4", "Keyset 5",
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("rejects a malformed cursor", async () => {
    const response = await request(app).get("/api/finance/transactions")
      .set("Authorization", `Bearer ${token}`)
      .query({ organizationId: labId, bankAccountId: checkingId, limit: 2, cursor: "nonsense" });
    expect(response.status).toBe(400);
  });
});
