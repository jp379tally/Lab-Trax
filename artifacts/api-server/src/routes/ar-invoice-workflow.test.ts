/**
 * Customer -> Invoice -> Receive Payment -> Undeposited Funds -> Make Deposits
 * -> permitted correction, driven without a statement.
 *
 * These cover the invoice-led half of the AP/AR alignment work: receiving
 * payment against an eligible outstanding invoice with no statement in sight,
 * an overpayment becoming an unapplied customer credit, applying that credit
 * without creating new cash, depositing without recognizing revenue twice, and
 * the correction rules that still apply afterwards.
 */
import { createHash, randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupPaymentFixtures } from "../test-utils/payment-cleanup.js";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/statements.js")>();
  return { ...actual, startStatementScheduler: vi.fn() };
});
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-ar"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env.DATABASE_URL;
const maybe = SHOULD_RUN ? describe : describe.skip;
const rid = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;

maybe("invoice-led receive payments (db integration)", () => {
  let dbMod: any;
  let app: Express;
  let token = "";

  const labId = rid("ar_lab");
  const providerId = rid("ar_provider");
  const adminId = rid("ar_admin");
  let ufAccountId = "";
  let checkingId = "";
  const invoiceIds: string[] = [];

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function createInvoice(total: string) {
    const id = rid("ar_inv");
    await dbMod.db.insert(dbMod.invoices).values({
      id,
      invoiceNumber: rid("INV"),
      labOrganizationId: labId,
      providerOrganizationId: providerId,
      status: "open",
      total,
      balanceDue: total,
      createdByUserId: adminId,
    });
    invoiceIds.push(id);
    return id;
  }

  async function invoiceRow(id: string) {
    return dbMod.db.query.invoices.findFirst({
      where: eq(dbMod.invoices.id, id),
    });
  }

  async function receivePayment(body: Record<string, unknown>) {
    return request(app)
      .post("/api/billing/payment-sessions")
      .set(auth())
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        paymentMethod: "cash",
        ...body,
      });
  }

  beforeAll(async () => {
    if (!SHOULD_RUN) return;
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-ar";
    dbMod = await import("@workspace/db");
    app = (await import("../app.js")).default as Express;
    await (await import("./index.js")).labtraxRoutesReady;
    const auth = await import("../lib/auth.js");
    const { db, users, organizations, organizationMemberships, bankAccounts, userSessions } =
      dbMod;

    await db.insert(users).values({ id: adminId, username: adminId, password: "x" });
    await db.insert(organizations).values([
      { id: labId, type: "lab", name: "AR Flow Lab" },
      {
        id: providerId,
        type: "provider",
        name: "AR Flow Practice",
        parentLabOrganizationId: labId,
      },
    ]);
    await db.insert(organizationMemberships).values({
      id: rid("ar_member"),
      labId,
      userId: adminId,
      role: "owner",
      status: "active",
    });
    const [uf] = await db
      .insert(bankAccounts)
      .values({
        labOrganizationId: labId,
        name: "Undeposited Funds",
        openingBalance: "0.00",
        openingDate: new Date(),
        accountType: "undeposited_funds",
        createdByUserId: adminId,
      })
      .returning();
    ufAccountId = uf.id;
    const [checking] = await db
      .insert(bankAccounts)
      .values({
        labOrganizationId: labId,
        name: "Checking",
        openingBalance: "0.00",
        openingDate: new Date(),
        accountType: "checking",
        createdByUserId: adminId,
      })
      .returning();
    checkingId = checking.id;

    const sessionId = rid("ar_session");
    token = auth.signAccessToken(adminId, sessionId);
    await db.insert(userSessions).values({
      id: sessionId,
      userId: adminId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN || !dbMod) return;
    const {
      db,
      users,
      organizations,
      organizationMemberships,
      userSessions,
      bankAccounts,
      bankTransactions,
      bankTransactionInvoices,
      bankDepositBatchMembers,
      invoices,
      customerCredits,
    } = dbMod;

    const txnRows = await db
      .select({ id: bankTransactions.id })
      .from(bankTransactions)
      .where(eq(bankTransactions.labOrganizationId, labId));
    const txnIds = txnRows.map((row: any) => row.id);

    await cleanupPaymentFixtures(
      {
        organizationIds: [labId, providerId],
        invoiceIds,
        transactionIds: txnIds,
      },
      db,
    );
    await db
      .delete(customerCredits)
      .where(eq(customerCredits.labOrganizationId, labId));
    if (txnIds.length) {
      await db
        .delete(bankDepositBatchMembers)
        .where(inArray(bankDepositBatchMembers.childBankTransactionId, txnIds));
      await db
        .delete(bankDepositBatchMembers)
        .where(inArray(bankDepositBatchMembers.aggregateBankTransactionId, txnIds));
      await db
        .delete(bankTransactionInvoices)
        .where(inArray(bankTransactionInvoices.bankTransactionId, txnIds));
    }
    await db
      .delete(bankTransactions)
      .where(eq(bankTransactions.labOrganizationId, labId));
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labId));
    await db
      .delete(dbMod.practiceStatements)
      .where(eq(dbMod.practiceStatements.labOrganizationId, labId));
    await db
      .delete(bankAccounts)
      .where(inArray(bankAccounts.id, [ufAccountId, checkingId]));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, adminId));
    await db.delete(userSessions).where(eq(userSessions.userId, adminId));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labId, providerId]));
    await db.delete(users).where(eq(users.id, adminId));
  });

  it("lists outstanding invoices as payable accounts without any statement", async () => {
    const invoiceId = await createInvoice("120.00");
    const eligible = await request(app)
      .get(`/api/billing/${labId}/eligible-invoice-accounts`)
      .set(auth());
    expect(eligible.status, JSON.stringify(eligible.body)).toBe(200);
    const account = eligible.body.data.find(
      (row: any) => row.providerOrganizationId === providerId,
    );
    expect(account).toBeTruthy();
    expect(
      account.outstandingInvoices.some((invoice: any) => invoice.id === invoiceId),
    ).toBe(true);
  });

  it("receives $550 against a $500 invoice, leaving $50 of unapplied credit in Undeposited Funds", async () => {
    const invoiceId = await createInvoice("500.00");

    const paid = await receivePayment({
      receivedAmount: 550,
      applications: [{ invoiceId, amount: 500 }],
      memo: "Overpaid check",
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const sessionId = paid.body.data.paymentSession?.id ?? paid.body.data.id;
    expect(sessionId).toBeTruthy();

    const invoice = await invoiceRow(invoiceId);
    expect(Number(invoice.balanceDue)).toBe(0);
    expect(invoice.status).toBe("paid");

    // The extra $50 is a customer credit, not revenue and not a negative
    // invoice balance.
    const credits = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/customer-credits`)
      .set(auth());
    expect(credits.status).toBe(200);
    expect(Number(credits.body.data.totalAvailable)).toBe(50);

    // The whole $550 sits in Undeposited Funds until it is deposited.
    const undeposited = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labId}`)
      .set(auth());
    expect(undeposited.status).toBe(200);
    const entry = undeposited.body.data.find(
      (row: any) => Number(row.creditAmount ?? row.deposit) === 550,
    );
    expect(entry, JSON.stringify(undeposited.body.data)).toBeTruthy();
    expect(entry.bankAccountId).toBe(ufAccountId);

    // The unapplied $50 is money owed back to the customer, so it has to
    // appear as a liability rather than vanishing from the balance sheet.
    const asOf = new Date().toISOString().slice(0, 10);
    const sheet = await request(app)
      .get(`/api/finance/reports/balance-sheet?organizationId=${labId}&asOfDate=${asOf}`)
      .set(auth());
    expect(sheet.status, JSON.stringify(sheet.body)).toBe(200);
    expect(Number(sheet.body.data.liabilities.customerCredits)).toBeGreaterThanOrEqual(50);
    expect(
      sheet.body.data.liabilities.items.some((item: any) => item.name === "Customer credits"),
    ).toBe(true);
  });

  it("applies an existing credit without creating any new cash", async () => {
    const invoiceId = await createInvoice("300.00");
    const before = await dbMod.db
      .select({ id: dbMod.bankTransactions.id })
      .from(dbMod.bankTransactions)
      .where(eq(dbMod.bankTransactions.labOrganizationId, labId));

    const applied = await receivePayment({
      receivedAmount: 0,
      existingCreditAmount: 50,
      applications: [{ invoiceId, amount: 0, creditAmount: 50 }],
      memo: "Apply unapplied credit",
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);

    const invoice = await invoiceRow(invoiceId);
    expect(Number(invoice.balanceDue)).toBe(250);

    const after = await dbMod.db
      .select({ id: dbMod.bankTransactions.id })
      .from(dbMod.bankTransactions)
      .where(eq(dbMod.bankTransactions.labOrganizationId, labId));
    expect(after.length).toBe(before.length);

    const credits = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/customer-credits`)
      .set(auth());
    expect(Number(credits.body.data.totalAvailable)).toBe(0);
  });

  it("moves the receipt into a bank account on deposit without recognizing revenue twice", async () => {
    const invoiceId = await createInvoice("500.00");
    const paid = await receivePayment({
      receivedAmount: 500,
      applications: [{ invoiceId, amount: 500 }],
    });
    expect(paid.status).toBe(201);

    const asOf = new Date().toISOString().slice(0, 10);
    const pnlBefore = await request(app)
      .get(`/api/finance/reports/profit-loss?organizationId=${labId}&dateFrom=2000-01-01&dateTo=${asOf}`)
      .set(auth());
    expect(pnlBefore.status).toBe(200);
    const incomeBefore = Number(pnlBefore.body.data.totalIncome);

    const undeposited = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labId}`)
      .set(auth());
    const target = undeposited.body.data.find(
      (row: any) =>
        Number(row.creditAmount ?? row.deposit) === 500 &&
        (row.invoiceLinks ?? []).some((link: any) => link.invoiceId === invoiceId),
    );
    expect(target, JSON.stringify(undeposited.body.data)).toBeTruthy();

    const deposit = await request(app)
      .post("/api/finance/make-deposits")
      .set(auth())
      .send({
        organizationId: labId,
        bankAccountId: checkingId,
        transactionIds: [target.id],
      });
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(200);
    expect(Number(deposit.body.data.totalAmount)).toBe(500);

    // The receipt becomes a child of one aggregate deposit posted to the
    // bank account; the money leaves Undeposited Funds exactly once.
    const child = await dbMod.db.query.bankTransactions.findFirst({
      where: eq(dbMod.bankTransactions.id, target.id),
    });
    expect(child.status).toBe("deposited_child");
    const aggregate = await dbMod.db.query.bankTransactions.findFirst({
      where: eq(dbMod.bankTransactions.id, deposit.body.data.aggregateTransactionId),
    });
    expect(aggregate.bankAccountId).toBe(checkingId);
    expect(Number(aggregate.creditAmount)).toBe(500);

    const stillUndeposited = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labId}`)
      .set(auth());
    expect(
      stillUndeposited.body.data.some((row: any) => row.id === target.id),
    ).toBe(false);

    // Depositing is a transfer of money already recognized when the invoice
    // was paid; the P&L must not move.
    const pnlAfter = await request(app)
      .get(`/api/finance/reports/profit-loss?organizationId=${labId}&dateFrom=2000-01-01&dateTo=${asOf}`)
      .set(auth());
    expect(Number(pnlAfter.body.data.totalIncome)).toBe(incomeBefore);
  });

  it("permits reversing a deposited receipt and restores the invoice balance", async () => {
    const invoiceId = await createInvoice("400.00");
    const paid = await receivePayment({
      receivedAmount: 400,
      applications: [{ invoiceId, amount: 400 }],
    });
    expect(paid.status).toBe(201);
    const sessionId = paid.body.data.paymentSession?.id ?? paid.body.data.id;

    const undeposited = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labId}`)
      .set(auth());
    const target = undeposited.body.data.find(
      (row: any) =>
        Number(row.creditAmount ?? row.deposit) === 400 &&
        (row.invoiceLinks ?? []).some((link: any) => link.invoiceId === invoiceId),
    );
    expect(target).toBeTruthy();
    const deposit = await request(app)
      .post("/api/finance/make-deposits")
      .set(auth())
      .send({
        organizationId: labId,
        bankAccountId: checkingId,
        transactionIds: [target.id],
      });
    expect(deposit.status).toBe(200);

    const reversal = await request(app)
      .post(`/api/billing/payment-sessions/${sessionId}/reversal`)
      .set(auth());
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(200);

    const invoice = await invoiceRow(invoiceId);
    expect(Number(invoice.balanceDue)).toBe(400);
    expect(invoice.status).not.toBe("paid");

    const cash = await dbMod.db.query.bankTransactions.findFirst({
      where: eq(dbMod.bankTransactions.id, target.id),
    });
    expect(cash?.deletedAt ?? null).not.toBeNull();
  });

  it("refuses to reverse a reconciled receipt", async () => {
    const invoiceId = await createInvoice("200.00");
    const paid = await receivePayment({
      receivedAmount: 200,
      applications: [{ invoiceId, amount: 200 }],
    });
    expect(paid.status).toBe(201);
    const sessionId = paid.body.data.paymentSession?.id ?? paid.body.data.id;
    const session = await dbMod.db.query.statementPaymentSessions.findFirst({
      where: eq(dbMod.statementPaymentSessions.id, sessionId),
    });
    await dbMod.db
      .update(dbMod.bankTransactions)
      .set({ reconciled: true, cleared: true, clearedAt: new Date() })
      .where(eq(dbMod.bankTransactions.id, session.bankTransactionId));

    const reversal = await request(app)
      .post(`/api/billing/payment-sessions/${sessionId}/reversal`)
      .set(auth());
    expect([400, 409]).toContain(reversal.status);

    const invoice = await invoiceRow(invoiceId);
    expect(Number(invoice.balanceDue)).toBe(0);

    // Leave the fixture reconcilable for cleanup.
    await dbMod.db
      .update(dbMod.bankTransactions)
      .set({ reconciled: false })
      .where(eq(dbMod.bankTransactions.id, session.bankTransactionId));
  });

  it("refuses to pay an invoice that belongs to another customer", async () => {
    const otherProviderId = rid("ar_other_provider");
    await dbMod.db.insert(dbMod.organizations).values({
      id: otherProviderId,
      type: "provider",
      name: "Other AR Practice",
      parentLabOrganizationId: labId,
    });
    const foreignInvoiceId = rid("ar_inv");
    await dbMod.db.insert(dbMod.invoices).values({
      id: foreignInvoiceId,
      invoiceNumber: rid("INV"),
      labOrganizationId: labId,
      providerOrganizationId: otherProviderId,
      status: "open",
      total: "75.00",
      balanceDue: "75.00",
      createdByUserId: adminId,
    });
    invoiceIds.push(foreignInvoiceId);

    const paid = await receivePayment({
      receivedAmount: 75,
      applications: [{ invoiceId: foreignInvoiceId, amount: 75 }],
    });
    expect([400, 403, 404, 409]).toContain(paid.status);

    const invoice = await invoiceRow(foreignInvoiceId);
    expect(Number(invoice.balanceDue)).toBe(75);

    await dbMod.db
      .delete(dbMod.invoices)
      .where(eq(dbMod.invoices.id, foreignInvoiceId));
    await dbMod.db
      .delete(dbMod.organizations)
      .where(eq(dbMod.organizations.id, otherProviderId));
  });

  it("refuses to pay a voided invoice", async () => {
    const invoiceId = await createInvoice("90.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({ status: "void", balanceDue: "0.00" })
      .where(eq(dbMod.invoices.id, invoiceId));

    const paid = await receivePayment({
      receivedAmount: 90,
      applications: [{ invoiceId, amount: 90 }],
    });
    expect([400, 404, 409]).toContain(paid.status);
  });

  it("denies invoice-led receive payments to members without billing access", async () => {
    const viewerId = rid("ar_viewer");
    await dbMod.db.insert(dbMod.users).values({
      id: viewerId,
      username: viewerId,
      password: "x",
    });
    await dbMod.db.insert(dbMod.organizationMemberships).values({
      id: rid("ar_viewer_member"),
      labId,
      userId: viewerId,
      role: "technician",
      status: "active",
    });
    const authLib = await import("../lib/auth.js");
    const viewerSessionId = rid("ar_viewer_session");
    const viewerToken = authLib.signAccessToken(viewerId, viewerSessionId);
    await dbMod.db.insert(dbMod.userSessions).values({
      id: viewerSessionId,
      userId: viewerId,
      tokenHash: createHash("sha256").update(viewerToken).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const invoiceId = await createInvoice("45.00");
    const denied = await request(app)
      .post("/api/billing/payment-sessions")
      .set({ Authorization: `Bearer ${viewerToken}` })
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        paymentMethod: "cash",
        receivedAmount: 45,
        applications: [{ invoiceId, amount: 45 }],
      });
    expect(denied.status).toBe(403);

    const listing = await request(app)
      .get(`/api/billing/${labId}/eligible-invoice-accounts`)
      .set({ Authorization: `Bearer ${viewerToken}` });
    expect(listing.status).toBe(403);

    await dbMod.db
      .delete(dbMod.userSessions)
      .where(eq(dbMod.userSessions.userId, viewerId));
    await dbMod.db
      .delete(dbMod.organizationMemberships)
      .where(
        and(
          eq(dbMod.organizationMemberships.userId, viewerId),
          eq(dbMod.organizationMemberships.labId, labId),
        ),
      );
    await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, viewerId));
  });

  it("keeps a backdated overpayment credit in the period it was dated to", async () => {
    const invoiceId = await createInvoice("500.00");
    const backdated = new Date();
    backdated.setDate(backdated.getDate() - 20);
    const backdatedIso = backdated.toISOString().slice(0, 10);

    const paid = await receivePayment({
      receivedAmount: 550,
      paymentDate: backdated.toISOString(),
      applications: [{ invoiceId, amount: 500 }],
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);

    const zone = "America/Los_Angeles";
    const balanceSheet = async (asOfDate: string) =>
      request(app)
        .get(
          `/api/finance/reports/balance-sheet?organizationId=${labId}&asOfDate=${asOfDate}&timeZone=${encodeURIComponent(zone)}`,
        )
        .set(auth());

    const afterCredit = await balanceSheet(backdatedIso);
    expect(afterCredit.status, JSON.stringify(afterCredit.body)).toBe(200);
    const creditsOnPaymentDate = Number(afterCredit.body.data.liabilities.customerCredits);
    // The credit belongs to the day the payment was dated to, not the day the
    // row happened to be inserted.
    expect(creditsOnPaymentDate).toBeGreaterThanOrEqual(50);

    const before = new Date(backdated);
    before.setDate(before.getDate() - 5);
    const earlier = await balanceSheet(before.toISOString().slice(0, 10));
    expect(earlier.status).toBe(200);
    // Before the payment existed there is no such liability.
    expect(Number(earlier.body.data.liabilities.customerCredits)).toBeLessThanOrEqual(
      creditsOnPaymentDate - 50,
    );
  });

  it("keeps revenue on an invoice that is voided in a later period", async () => {
    const invoiceId = await createInvoice("640.00");
    const issued = new Date();
    issued.setDate(issued.getDate() - 30);
    await dbMod.db
      .update(dbMod.invoices)
      .set({ issuedAt: issued })
      .where(eq(dbMod.invoices.id, invoiceId));

    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const periodStart = new Date(issued);
    periodStart.setDate(periodStart.getDate() - 3);
    const periodEnd = new Date(issued);
    periodEnd.setDate(periodEnd.getDate() + 3);
    const range = `dateFrom=${iso(periodStart)}&dateTo=${iso(periodEnd)}`;

    const pnlBefore = await request(app)
      .get(`/api/finance/reports/profit-loss?organizationId=${labId}&${range}`)
      .set(auth());
    expect(pnlBefore.status).toBe(200);
    const revenueBefore = Number(pnlBefore.body.data.revenue);

    const voidedOn = new Date(issued);
    voidedOn.setDate(voidedOn.getDate() + 10);
    await dbMod.db
      .update(dbMod.invoices)
      .set({ status: "void", balanceDue: "0.00", voidedAt: voidedOn })
      .where(eq(dbMod.invoices.id, invoiceId));

    const pnlAfter = await request(app)
      .get(`/api/finance/reports/profit-loss?organizationId=${labId}&${range}`)
      .set(auth());
    // Voided today, so the period it was issued in still recognizes it.
    expect(Number(pnlAfter.body.data.revenue)).toBeCloseTo(revenueBefore, 2);

    const throughVoid = new Date(voidedOn);
    throughVoid.setDate(throughVoid.getDate() + 3);
    const currentRange = `dateFrom=${iso(periodStart)}&dateTo=${iso(throughVoid)}`;
    const pnlThroughVoid = await request(app)
      .get(`/api/finance/reports/profit-loss?organizationId=${labId}&${currentRange}`)
      .set(auth());
    // A period that contains the void no longer counts it.
    expect(Number(pnlThroughVoid.body.data.revenue)).toBeLessThan(revenueBefore);
  });

  it("reverses a void in its own period so adjacent P&L periods add up", async () => {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const revenueFor = async (fromDate: Date, toDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/profit-loss?organizationId=${labId}&dateFrom=${iso(fromDate)}&dateTo=${iso(toDate)}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.revenue);
    };
    const shift = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };
    const earlyFrom = shift(-40);
    const earlyTo = shift(-21);
    const lateFrom = shift(-20);
    const lateTo = shift(0);

    const baselineEarly = await revenueFor(earlyFrom, earlyTo);
    const baselineLate = await revenueFor(lateFrom, lateTo);
    const baselineSpan = await revenueFor(earlyFrom, lateTo);

    const invoiceId = await createInvoice("700.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({ issuedAt: shift(-30) })
      .where(eq(dbMod.invoices.id, invoiceId));
    await dbMod.db
      .update(dbMod.invoices)
      .set({ status: "void", balanceDue: "0.00", voidedAt: shift(-10) })
      .where(eq(dbMod.invoices.id, invoiceId));

    const early = await revenueFor(earlyFrom, earlyTo);
    const late = await revenueFor(lateFrom, lateTo);
    const span = await revenueFor(earlyFrom, lateTo);

    // The period that earned the revenue keeps it, the period of the void
    // carries the reversal, and the two together net to nothing.
    expect(early - baselineEarly).toBeCloseTo(700, 2);
    expect(late - baselineLate).toBeCloseTo(-700, 2);
    expect(span - baselineSpan).toBeCloseTo(0, 2);
  });

  it("keeps a closed period at the amount the invoice was issued for and books the raise in the period of the edit", async () => {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const shift = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };
    const revenueFor = async (fromDate: Date, toDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/profit-loss?organizationId=${labId}&dateFrom=${iso(fromDate)}&dateTo=${iso(toDate)}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.revenue);
    };
    const receivableAsOf = async (asOfDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/balance-sheet?organizationId=${labId}&asOfDate=${iso(asOfDate)}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.assets.accountsReceivable);
    };

    const earlyFrom = shift(-40);
    const earlyTo = shift(-21);
    const lateFrom = shift(-20);
    const lateTo = shift(1);
    const historic = shift(-25);

    const baselineEarly = await revenueFor(earlyFrom, earlyTo);
    const baselineLate = await revenueFor(lateFrom, lateTo);
    const baselineSpan = await revenueFor(earlyFrom, lateTo);
    const baselineReceivable = await receivableAsOf(historic);

    const invoiceId = await createInvoice("100.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({ issuedAt: shift(-30), dueAt: shift(-30) })
      .where(eq(dbMod.invoices.id, invoiceId));

    // Raising the invoice today, from any writer at all — the snapshot is
    // recorded by the database, not by one route.
    await dbMod.db
      .update(dbMod.invoices)
      .set({ total: "150.00", balanceDue: "150.00" })
      .where(eq(dbMod.invoices.id, invoiceId));

    const early = await revenueFor(earlyFrom, earlyTo);
    const late = await revenueFor(lateFrom, lateTo);
    const span = await revenueFor(earlyFrom, lateTo);

    expect(early - baselineEarly).toBeCloseTo(100, 2);
    expect(late - baselineLate).toBeCloseTo(50, 2);
    expect(span - baselineSpan).toBeCloseTo(150, 2);
    expect(early - baselineEarly + (late - baselineLate)).toBeCloseTo(
      span - baselineSpan,
      2,
    );

    // The historical receivable is what the invoice said then, not what it
    // says after today's edit.
    expect((await receivableAsOf(historic)) - baselineReceivable).toBeCloseTo(
      100,
      2,
    );
  });

  it("keeps a backdated payment on the books for the dates it was in force after the session is cancelled", async () => {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const shift = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };
    const arAt = async (asOfDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/balance-sheet?organizationId=${labId}&asOfDate=${iso(asOfDate)}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.assets.accountsReceivable);
    };
    const outstandingAt = async (asOfDate: Date, invoiceId: string) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/ar-aging?organizationId=${labId}&asOf=${iso(asOfDate)}&detail=true`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const row = response.body.data.rows
        .flatMap((group: any) => group.invoices ?? [])
        .find((entry: any) => entry.id === invoiceId);
      return row ? Number(row.outstanding) : 0;
    };

    const before = {
      beforePayment: await arAt(shift(-15)),
      inForce: await arAt(shift(-7)),
      today: await arAt(new Date()),
    };

    const invoiceId = await createInvoice("500.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({ issuedAt: shift(-20), dueAt: shift(-20) })
      .where(eq(dbMod.invoices.id, invoiceId));

    // A real payment, recorded for a date in the past, through the route
    // users actually use.
    const paid = await receivePayment({
      receivedAmount: 200,
      paymentDate: iso(shift(-10)),
      applications: [{ invoiceId, amount: 200 }],
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const sessionId = paid.body.data.paymentSession?.id ?? paid.body.data.id;
    expect(sessionId).toBeTruthy();

    expect((await arAt(shift(-7))) - before.inForce).toBeCloseTo(300, 2);

    // Cancelling it through the route deletes the payment rows.
    const cancelled = await request(app)
      .delete(`/api/billing/payment-sessions/${sessionId}`)
      .set(auth());
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(Number((await invoiceRow(invoiceId)).balanceDue)).toBe(500);

    // The seven days it was settled still read as settled, without any
    // timestamp surgery in this test.
    expect((await arAt(shift(-7))) - before.inForce).toBeCloseTo(300, 2);
    expect(await outstandingAt(shift(-7), invoiceId)).toBe(300);
    // Before the payment date, and today, the whole invoice is owed.
    expect((await arAt(shift(-15))) - before.beforePayment).toBeCloseTo(500, 2);
    expect((await arAt(new Date())) - before.today).toBeCloseTo(500, 2);
    expect(await outstandingAt(new Date(), invoiceId)).toBe(500);
  });

  it("keeps a reversed partial payment visible in the history it belongs to", async () => {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const shift = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };
    const agingAt = async (asOfDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/ar-aging?organizationId=${labId}&asOf=${iso(asOfDate)}&detail=true`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const invoice = response.body.data.rows
        .flatMap((row: any) => row.invoices ?? [])
        .find((row: any) => row.id === invoiceId);
      return { body: response.body.data, invoice };
    };
    const arBalanceAt = async (asOfDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/balance-sheet?organizationId=${labId}&asOfDate=${iso(asOfDate)}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.assets.accountsReceivable);
    };

    const beforeInvoice = await arBalanceAt(shift(-10));
    const invoiceId = await createInvoice("500.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({ issuedAt: shift(-40), dueAt: shift(-40) })
      .where(eq(dbMod.invoices.id, invoiceId));

    // A $200 payment lands, leaving $300 owed.
    const paymentId = rid("ar_pay");
    await dbMod.db.insert(dbMod.payments).values({
      id: paymentId,
      invoiceId,
      labOrganizationId: labId,
      amount: "200.00",
      paymentMethod: "cash",
      paidAt: shift(-20),
      recordedByUserId: adminId,
    });
    await dbMod.db
      .update(dbMod.invoices)
      .set({ balanceDue: "300.00", status: "partially_paid" })
      .where(eq(dbMod.invoices.id, invoiceId));
    // The snapshot the trigger just wrote stands for a moment 20 days ago;
    // tests cannot wait, so its recorded time is moved back to then.
    await dbMod.pool.query(
      `UPDATE invoice_accounting_events SET occurred_at = $2
         WHERE invoice_id = $1 AND effective_balance_due = '300.00'`,
      [invoiceId, shift(-20).toISOString()],
    );

    // Cancelling the payment session deletes the payment row outright, so
    // nothing dated survives to show the invoice was ever part-paid.
    await dbMod.db
      .delete(dbMod.payments)
      .where(eq(dbMod.payments.id, paymentId));
    await dbMod.db
      .update(dbMod.invoices)
      .set({ balanceDue: "500.00", status: "open" })
      .where(eq(dbMod.invoices.id, invoiceId));

    // Ten days ago the invoice was part-paid, and the books said so at the
    // time even though the payment row is gone.
    const historical = await agingAt(shift(-10));
    expect(Number(historical.invoice.outstanding)).toBe(300);
    expect(historical.invoice.approximate).toBe(true);
    expect(
      historical.body.limitations.map((limitation: any) => limitation.code),
    ).toContain("reversed_payments_not_dated");
    expect((await arBalanceAt(shift(-10))) - beforeInvoice).toBeCloseTo(300, 2);

    // Today the payment is gone and the whole invoice is owed again.
    const now = await agingAt(new Date());
    expect(Number(now.invoice.outstanding)).toBe(500);
    expect(now.invoice.approximate).toBe(false);
  });

  it("ages an invoice with no customer of record instead of dropping it", async () => {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const today = iso(new Date());
    const agingTotal = async () => {
      const response = await request(app)
        .get(
          `/api/finance/reports/ar-aging?organizationId=${labId}&asOf=${today}&detail=true`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data;
    };
    const arBalance = async () => {
      const response = await request(app)
        .get(`/api/finance/reports/balance-sheet?organizationId=${labId}&asOfDate=${today}`)
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.assets.accountsReceivable);
    };

    const beforeAging = Number((await agingTotal()).total);
    const beforeAr = await arBalance();

    // Legacy invoices can carry no provider organization at all.
    const invoiceId = rid("ar_inv");
    await dbMod.db.insert(dbMod.invoices).values({
      id: invoiceId,
      invoiceNumber: rid("INV"),
      labOrganizationId: labId,
      providerOrganizationId: null,
      status: "open",
      total: "125.00",
      balanceDue: "125.00",
      issuedAt: new Date(),
      dueAt: new Date(),
      createdByUserId: adminId,
    });
    invoiceIds.push(invoiceId);

    const aging = await agingTotal();
    const orphanRow = aging.rows.find((row: any) => row.customerId === "unassigned");
    expect(orphanRow, "invoice without a customer was dropped from aging").toBeTruthy();
    expect(
      orphanRow.invoices.some((invoice: any) => invoice.id === invoiceId),
    ).toBe(true);
    // Aging and the receivable control balance move by the same amount.
    expect(Number(aging.total) - beforeAging).toBeCloseTo(125, 2);
    expect((await arBalance()) - beforeAr).toBeCloseTo(125, 2);
  });

  it("seeds a baseline for invoices that predate the accounting trigger so a later edit cannot restate a closed period", async () => {
    const { INVOICE_ACCOUNTING_BASELINE_SQL } = await import(
      "../lib/db-constraints"
    );
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const shift = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };
    const revenueFor = async (fromDate: Date, toDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/profit-loss?organizationId=${labId}&dateFrom=${iso(fromDate)}&dateTo=${iso(toDate)}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.revenue);
    };

    const earlyFrom = shift(-40);
    const earlyTo = shift(-21);
    const lateFrom = shift(-20);
    const lateTo = shift(1);
    const baselineEarly = await revenueFor(earlyFrom, earlyTo);
    const baselineLate = await revenueFor(lateFrom, lateTo);

    const invoiceId = await createInvoice("300.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({ issuedAt: shift(-30), dueAt: shift(-30) })
      .where(eq(dbMod.invoices.id, invoiceId));

    // An invoice that existed before snapshots did has no history of its own.
    await dbMod.db
      .delete(dbMod.invoiceAccountingEvents)
      .where(eq(dbMod.invoiceAccountingEvents.invoiceId, invoiceId));

    // Rolling the feature out seeds a baseline in the same transaction that
    // installs the trigger, so the edit that follows is an edit and not
    // mistaken for the original issuance. This runs the very statement the
    // installer runs.
    await dbMod.pool.query(INVOICE_ACCOUNTING_BASELINE_SQL);
    const seeded = await dbMod.db
      .select({ eventType: dbMod.invoiceAccountingEvents.eventType })
      .from(dbMod.invoiceAccountingEvents)
      .where(eq(dbMod.invoiceAccountingEvents.invoiceId, invoiceId));
    expect(seeded.map((row: any) => row.eventType)).toEqual(["baseline"]);

    await dbMod.db
      .update(dbMod.invoices)
      .set({ total: "450.00", balanceDue: "450.00" })
      .where(eq(dbMod.invoices.id, invoiceId));

    expect((await revenueFor(earlyFrom, earlyTo)) - baselineEarly).toBeCloseTo(
      300,
      2,
    );
    expect((await revenueFor(lateFrom, lateTo)) - baselineLate).toBeCloseTo(
      150,
      2,
    );
  });

  it("does not backdate a pre-rollout invoice's settled state to its issue date", async () => {
    const { INVOICE_ACCOUNTING_BASELINE_SQL } = await import("../lib/db-constraints");
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const shift = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };
    const arAt = async (asOfDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/balance-sheet?organizationId=${labId}&asOfDate=${iso(asOfDate)}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.assets.accountsReceivable);
    };

    const beforeAll = {
      issue: await arAt(shift(-25)),
      afterPayment: await arAt(shift(-5)),
    };

    // Two invoices from before snapshots existed: one paid in full, one
    // half paid. Their payments are dated; their invoice rows are not.
    const paidId = await createInvoice("400.00");
    const partialId = await createInvoice("600.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({ issuedAt: shift(-30), dueAt: shift(-30) })
      .where(inArray(dbMod.invoices.id, [paidId, partialId]));
    await dbMod.db.insert(dbMod.payments).values([
      {
        id: rid("ar_pay"),
        invoiceId: paidId,
        labOrganizationId: labId,
        amount: "400.00",
        paymentMethod: "cash",
        paidAt: shift(-10),
        recordedByUserId: adminId,
      },
      {
        id: rid("ar_pay"),
        invoiceId: partialId,
        labOrganizationId: labId,
        amount: "250.00",
        paymentMethod: "cash",
        paidAt: shift(-10),
        recordedByUserId: adminId,
      },
    ]);
    await dbMod.db
      .update(dbMod.invoices)
      .set({ balanceDue: "0.00", status: "paid" })
      .where(eq(dbMod.invoices.id, paidId));
    await dbMod.db
      .update(dbMod.invoices)
      .set({ balanceDue: "350.00", status: "partially_paid" })
      .where(eq(dbMod.invoices.id, partialId));

    // The rollout finds them with no history at all.
    await dbMod.db
      .delete(dbMod.invoiceAccountingEvents)
      .where(inArray(dbMod.invoiceAccountingEvents.invoiceId, [paidId, partialId]));
    await dbMod.pool.query(INVOICE_ACCOUNTING_BASELINE_SQL);

    // Between issue and payment both invoices were owed in full.
    expect((await arAt(shift(-25))) - beforeAll.issue).toBeCloseTo(1000, 2);
    // After the payments, only the unpaid remainder is owed.
    expect((await arAt(shift(-5))) - beforeAll.afterPayment).toBeCloseTo(350, 2);
  });

  it("keeps a pre-rollout voided invoice on the books until the date it was voided", async () => {
    const { INVOICE_ACCOUNTING_BASELINE_SQL } = await import("../lib/db-constraints");
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const shift = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };
    const arAt = async (asOfDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/balance-sheet?organizationId=${labId}&asOfDate=${iso(asOfDate)}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.assets.accountsReceivable);
    };

    const before = {
      live: await arAt(shift(-25)),
      afterVoid: await arAt(shift(-5)),
    };

    const invoiceId = await createInvoice("275.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({
        issuedAt: shift(-30),
        dueAt: shift(-30),
        status: "void",
        voidedAt: shift(-10),
        balanceDue: "0.00",
      })
      .where(eq(dbMod.invoices.id, invoiceId));
    await dbMod.db
      .delete(dbMod.invoiceAccountingEvents)
      .where(eq(dbMod.invoiceAccountingEvents.invoiceId, invoiceId));
    await dbMod.pool.query(INVOICE_ACCOUNTING_BASELINE_SQL);

    // It was a real receivable for the three weeks before the void.
    expect((await arAt(shift(-25))) - before.live).toBeCloseTo(275, 2);
    // The void removes it from the date it was voided onward.
    expect((await arAt(shift(-5))) - before.afterVoid).toBeCloseTo(0, 2);
  });

  it("ages a historical date by the due date the invoice carried then, not by a later revision", async () => {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const shift = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };
    const agingRow = async (asOfDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/ar-aging?organizationId=${labId}&asOf=${iso(asOfDate)}&detail=true`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data.rows
        .flatMap((row: any) => row.invoices ?? [])
        .find((invoice: any) => invoice.id === invoiceId);
    };

    const invoiceId = await createInvoice("275.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({ issuedAt: shift(-70), dueAt: shift(-70) })
      .where(eq(dbMod.invoices.id, invoiceId));

    const historic = shift(-20);
    const before = await agingRow(historic);
    expect(before, "invoice missing from historical aging").toBeTruthy();
    expect(before.bucket).toBe("d31_60");
    expect(Number(before.outstanding)).toBe(275);

    // Push the due date out and raise the invoice today.
    await dbMod.db
      .update(dbMod.invoices)
      .set({ dueAt: shift(30), total: "400.00", balanceDue: "400.00" })
      .where(eq(dbMod.invoices.id, invoiceId));

    const after = await agingRow(historic);
    expect(after.bucket).toBe("d31_60");
    expect(Number(after.outstanding)).toBe(275);

    const today = await agingRow(new Date());
    expect(today.bucket).toBe("current");
    expect(Number(today.outstanding)).toBe(400);
  });

  it("dates a void recorded through the generic invoice update", async () => {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const shift = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };
    const revenueFor = async (fromDate: Date, toDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/profit-loss?organizationId=${labId}&dateFrom=${iso(fromDate)}&dateTo=${iso(toDate)}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.revenue);
    };

    const earlyFrom = shift(-40);
    const earlyTo = shift(-21);
    const lateFrom = shift(-20);
    const lateTo = shift(1);

    const baselineEarly = await revenueFor(earlyFrom, earlyTo);
    const baselineLate = await revenueFor(lateFrom, lateTo);

    const invoiceId = await createInvoice("220.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({ issuedAt: shift(-30), dueAt: shift(-30) })
      .where(eq(dbMod.invoices.id, invoiceId));

    const patched = await request(app)
      .patch(`/api/invoices/${invoiceId}`)
      .set(auth())
      .send({ status: "void" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    // The generic status change is still a void, so it has to be dated like
    // one; an undated void would read as revenue that never existed.
    const voided = await invoiceRow(invoiceId);
    expect(voided.status).toBe("void");
    expect(voided.voidedAt).toBeTruthy();
    expect(Number(voided.balanceDue)).toBe(0);

    expect((await revenueFor(earlyFrom, earlyTo)) - baselineEarly).toBeCloseTo(
      220,
      2,
    );
    expect((await revenueFor(lateFrom, lateTo)) - baselineLate).toBeCloseTo(
      -220,
      2,
    );
  });

  it("recognizes no revenue for a draft invoice until it is issued", async () => {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const shift = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };
    const range = `dateFrom=${iso(shift(-5))}&dateTo=${iso(shift(0))}`;
    const revenue = async () => {
      const response = await request(app)
        .get(`/api/finance/reports/profit-loss?organizationId=${labId}&${range}`)
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return {
        revenue: Number(response.body.data.revenue),
        count: Number(response.body.data.invoiceCount),
      };
    };
    const before = await revenue();

    const draftId = await createInvoice("310.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({ status: "draft", issuedAt: null })
      .where(eq(dbMod.invoices.id, draftId));

    const withDraft = await revenue();
    expect(withDraft.revenue).toBeCloseTo(before.revenue, 2);
    expect(withDraft.count).toBe(before.count);

    // Issuing it is the recognition event.
    await dbMod.db
      .update(dbMod.invoices)
      .set({ status: "open", issuedAt: shift(-1) })
      .where(eq(dbMod.invoices.id, draftId));

    const issuedRevenue = await revenue();
    expect(issuedRevenue.revenue).toBeCloseTo(before.revenue + 310, 2);
    expect(issuedRevenue.count).toBe(before.count + 1);
  });

  it("settles the invoice on the date customer credit was applied, not on the row's write time", async () => {
    const invoiceId = await createInvoice("400.00");
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const issued = new Date();
    issued.setDate(issued.getDate() - 60);
    const creditedOn = new Date();
    creditedOn.setDate(creditedOn.getDate() - 30);
    const appliedOn = new Date();
    appliedOn.setDate(appliedOn.getDate() - 10);
    const beforeApplication = new Date(appliedOn);
    beforeApplication.setDate(beforeApplication.getDate() - 5);

    await dbMod.db
      .update(dbMod.invoices)
      .set({ issuedAt: issued, dueAt: issued })
      .where(eq(dbMod.invoices.id, invoiceId));

    const agingRow = async (asOfDate: string) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/ar-aging?organizationId=${labId}&asOf=${asOfDate}&detail=true`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data.rows
        .flatMap((row: any) => row.invoices ?? [])
        .find((invoice: any) => invoice.id === invoiceId);
    };
    const receivableAsOf = async (asOfDate: string) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/balance-sheet?organizationId=${labId}&asOfDate=${asOfDate}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.assets.accountsReceivable);
    };
    const unappliedCreditAsOf = async (asOfDate: string) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/ar-aging?organizationId=${labId}&asOf=${asOfDate}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.unappliedCreditTotal ?? 0);
    };

    // A credit that existed before the application date.
    const funded = await receivePayment({
      receivedAmount: 150,
      applications: [],
      paymentDate: creditedOn.toISOString(),
      memo: "Credit on account",
    });
    expect(funded.status, JSON.stringify(funded.body)).toBe(201);

    const today = iso(new Date());
    const receivableBefore = await receivableAsOf(iso(beforeApplication));
    const receivableTodayBefore = await receivableAsOf(today);
    const creditTodayBefore = await unappliedCreditAsOf(today);
    const agedBefore = await agingRow(iso(beforeApplication));
    expect(agedBefore?.outstanding).toBe("400.00");
    const creditBefore = await unappliedCreditAsOf(iso(beforeApplication));
    expect(creditBefore).toBeGreaterThanOrEqual(150);

    // Applying the credit is dated by the payment session, and it settles the
    // invoice exactly as cash would.
    const applied = await receivePayment({
      receivedAmount: 0,
      existingCreditAmount: 150,
      applications: [{ invoiceId, amount: 0, creditAmount: 150 }],
      paymentDate: appliedOn.toISOString(),
      memo: "Apply credit to invoice",
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);

    // History before the application is untouched.
    expect((await agingRow(iso(beforeApplication)))?.outstanding).toBe("400.00");
    expect(await receivableAsOf(iso(beforeApplication))).toBeCloseTo(
      receivableBefore,
      2,
    );

    // From the application date onward the receivable is $150 lower and the
    // credit is no longer unapplied — even though the application row was
    // written today.
    expect((await agingRow(today))?.outstanding).toBe("250.00");
    expect(await receivableAsOf(today)).toBeCloseTo(receivableTodayBefore - 150, 2);
    expect(await unappliedCreditAsOf(today)).toBeCloseTo(creditTodayBefore - 150, 2);
  });

  it("dates an older settlement from the receipt that recorded it", async () => {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const shift = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };
    const agingAt = async (asOfDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/ar-aging?organizationId=${labId}&asOf=${iso(asOfDate)}&detail=true`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data;
    };
    const receivableAt = async (asOfDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/balance-sheet?organizationId=${labId}&asOfDate=${iso(asOfDate)}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.assets.accountsReceivable);
    };
    const invoiceIn = (report: any, id: string) =>
      report.rows
        .flatMap((row: any) => row.invoices ?? [])
        .find((invoice: any) => invoice.id === id);

    const invoiceId = await createInvoice("400.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({ issuedAt: shift(-60), dueAt: shift(-60) })
      .where(eq(dbMod.invoices.id, invoiceId));
    const invoice = await invoiceRow(invoiceId);

    const beforePaymentDate = await receivableAt(shift(-30));
    const afterPaymentDate = await receivableAt(shift(-10));
    const codesBefore = (await agingAt(shift(-10))).limitations
      .map((limitation: any) => limitation.code)
      .sort();

    // A receipt recorded before invoice payment rows existed: the session and
    // its per-invoice application survive, the payment row never did.
    const sessionId = rid("ar_legacy_session");
    await dbMod.db.insert(dbMod.statementPaymentSessions).values({
      id: sessionId,
      labOrganizationId: labId,
      providerOrganizationId: providerId,
      requestFingerprint: rid("fp"),
      receiptNumber: rid("RCPT"),
      receivedAmount: "400.00",
      appliedAmount: "400.00",
      customerCreditAmount: "0.00",
      accountBalanceAfter: "0.00",
      paymentMethod: "check",
      paymentDate: shift(-20),
      labName: "AR Flow Lab",
      createdByUserId: adminId,
    });
    await dbMod.db.insert(dbMod.statementPaymentApplications).values({
      paymentSessionId: sessionId,
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      invoiceTotal: "400.00",
      amount: "400.00",
      invoiceBalanceBefore: "400.00",
      invoiceBalanceAfter: "0.00",
    });
    await dbMod.db
      .update(dbMod.invoices)
      .set({ balanceDue: "0.00", status: "paid" })
      .where(eq(dbMod.invoices.id, invoiceId));

    // Before the receipt's payment date the invoice is still owed in full.
    const historical = await agingAt(shift(-30));
    expect(Number(invoiceIn(historical, invoiceId).outstanding)).toBe(400);
    expect(invoiceIn(historical, invoiceId).unreconstructed).toBe(false);
    expect(await receivableAt(shift(-30))).toBeCloseTo(beforePaymentDate, 2);

    // From that date onward the application settles it, so the receivable is
    // $400 lower and the invoice drops out of aging.
    const settled = await agingAt(shift(-10));
    expect(invoiceIn(settled, invoiceId)).toBeUndefined();
    expect(await receivableAt(shift(-10))).toBeCloseTo(afterPaymentDate - 400, 2);

    // The settlement was reconstructed, so this invoice adds no limitation.
    expect(settled.limitations.map((l: any) => l.code).sort()).toEqual(
      codesBefore,
    );
  });

  it("discloses an older settlement nothing can date instead of inventing an opening balance", async () => {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const shift = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    };
    const agingAt = async (asOfDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/ar-aging?organizationId=${labId}&asOf=${iso(asOfDate)}&detail=true`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data;
    };
    const balanceSheetAt = async (asOfDate: Date) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/balance-sheet?organizationId=${labId}&asOfDate=${iso(asOfDate)}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data;
    };

    const receivableMidBefore = Number(
      (await balanceSheetAt(shift(-60))).assets.accountsReceivable,
    );
    const receivableTodayBefore = Number(
      (await balanceSheetAt(new Date())).assets.accountsReceivable,
    );

    const invoiceId = await createInvoice("250.00");
    await dbMod.db
      .update(dbMod.invoices)
      .set({
        issuedAt: shift(-90),
        dueAt: shift(-90),
        balanceDue: "0.00",
        status: "paid",
      })
      .where(eq(dbMod.invoices.id, invoiceId));
    // A genuinely pre-history invoice: no payment, no receipt, no deposit,
    // and only the rollout baseline for a snapshot — which records no
    // balance, because today's balance says nothing about the issue date.
    await dbMod.pool.query(
      `DELETE FROM invoice_accounting_events WHERE invoice_id = $1`,
      [invoiceId],
    );
    await dbMod.pool.query(
      `INSERT INTO invoice_accounting_events (
         lab_organization_id, invoice_id, event_type, occurred_at,
         effective_status, effective_total, effective_balance_due,
         effective_issued_at, effective_due_at, effective_voided_at,
         effective_deleted_at, effective_created_at
       )
       SELECT i.lab_organization_id, i.id, 'baseline',
              COALESCE(i.issued_at, i.created_at, now()),
              i.status, i.total, NULL, i.issued_at, i.due_at, i.voided_at,
              i.deleted_at, i.created_at
         FROM invoices i WHERE i.id = $1`,
      [invoiceId],
    );

    // No opening balance is manufactured: the receivable before and after the
    // invoice's own dates is exactly what it was without it.
    expect(
      Number((await balanceSheetAt(shift(-60))).assets.accountsReceivable),
    ).toBeCloseTo(receivableMidBefore, 2);
    const todaySheet = await balanceSheetAt(new Date());
    expect(Number(todaySheet.assets.accountsReceivable)).toBeCloseTo(
      receivableTodayBefore,
      2,
    );

    // Both reports say so rather than presenting the figure as history.
    const historical = await agingAt(shift(-60));
    expect(
      historical.rows
        .flatMap((row: any) => row.invoices ?? [])
        .find((row: any) => row.id === invoiceId),
    ).toBeUndefined();
    const agingLimitation = historical.limitations.find(
      (limitation: any) => limitation.code === "legacy_settlements_not_dated",
    );
    expect(agingLimitation, JSON.stringify(historical.limitations)).toBeTruthy();
    expect(agingLimitation.affectedInvoiceCount).toBeGreaterThanOrEqual(1);
    expect(Number(agingLimitation.affectedAmount)).toBeGreaterThanOrEqual(250);
    expect(agingLimitation.affectedCustomerIds).toContain(providerId);
    const sheetLimitation = todaySheet.limitations.find(
      (limitation: any) => limitation.code === "legacy_settlements_not_dated",
    );
    expect(sheetLimitation, JSON.stringify(todaySheet.limitations)).toBeTruthy();
    expect(Number(sheetLimitation.affectedAmount)).toBeGreaterThanOrEqual(250);
  });

  it("keeps a case-deleted invoice receivable before the deletion and drops it afterwards", async () => {
    const invoiceId = await createInvoice("300.00");
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const issued = new Date();
    issued.setDate(issued.getDate() - 40);
    const deletedAt = new Date();
    deletedAt.setDate(deletedAt.getDate() - 10);
    const beforeDeletion = new Date(deletedAt);
    beforeDeletion.setDate(beforeDeletion.getDate() - 5);

    await dbMod.db
      .update(dbMod.invoices)
      .set({ issuedAt: issued, dueAt: issued })
      .where(eq(dbMod.invoices.id, invoiceId));

    const agingRow = async (asOfDate: string) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/ar-aging?organizationId=${labId}&asOf=${asOfDate}&detail=true`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data.rows
        .flatMap((row: any) => row.invoices ?? [])
        .find((invoice: any) => invoice.id === invoiceId);
    };
    const receivableAsOf = async (asOfDate: string) => {
      const response = await request(app)
        .get(
          `/api/finance/reports/balance-sheet?organizationId=${labId}&asOfDate=${asOfDate}`,
        )
        .set(auth());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Number(response.body.data.assets.accountsReceivable);
    };

    const today = iso(new Date());
    const agedBeforeFreeze = await agingRow(iso(beforeDeletion));
    expect(agedBeforeFreeze?.outstanding).toBe("300.00");
    const receivableBeforeFreeze = await receivableAsOf(iso(beforeDeletion));
    const receivableTodayBeforeFreeze = await receivableAsOf(today);

    // Deleting the case freezes the invoice and zeroes its live balance.
    await dbMod.db
      .update(dbMod.invoices)
      .set({ frozen: true, balanceDue: "0.00", caseDeletedAt: deletedAt })
      .where(eq(dbMod.invoices.id, invoiceId));

    // History before the deletion is unchanged: the receivable was real then.
    const agedStillBefore = await agingRow(iso(beforeDeletion));
    expect(agedStillBefore?.outstanding).toBe("300.00");
    expect(await receivableAsOf(iso(beforeDeletion))).toBeCloseTo(
      receivableBeforeFreeze,
      2,
    );

    // From the deletion onward the invoice is no longer owed, and aging and
    // the balance sheet agree about that.
    expect(await agingRow(today)).toBeUndefined();
    expect(await receivableAsOf(today)).toBeCloseTo(
      receivableTodayBeforeFreeze - 300,
      2,
    );
  });
});
