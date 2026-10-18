/**
 * Integration tests for DELETE /api/invoices/:invoiceId/payments
 *
 * Covers three deposit-reversal scenarios:
 *   1. Single-invoice deposit   → deposit voided, link removed, invoice → open
 *   2. Shared batch deposit     → deposit amount reduced (not voided), other invoice unaffected
 *   3. Repeated partial payments → multiple exclusive deposits all voided
 *
 * Skipped when DATABASE_URL is not configured — same convention as other
 * api-server integration tests. All rows inserted are cleaned up in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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

maybe("DELETE /invoices/:invoiceId/payments (db integration)", () => {
  type DbMod = typeof import("@workspace/db");

  let dbMod: DbMod;
  let app: Express;
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const practiceId = rid("prov");
  const adminUserId = rid("uadm");

  let ufAccountId = "";

  const tokens: { admin: string } = { admin: "" };

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  async function insertInvoice(opts: { invoiceNumber: string; status?: string; total?: string; balanceDue?: string }) {
    const { db, invoices } = dbMod as any;
    const id = rid("inv");
    await db.insert(invoices).values({
      id,
      invoiceNumber: opts.invoiceNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      status: opts.status ?? "open",
      total: opts.total ?? "100.00",
      balanceDue: opts.balanceDue ?? "100.00",
      createdByUserId: adminUserId,
    });
    return id;
  }

  /** POST receive-payments and return { depositTransactionId }. */
  async function recordPayment(opts: {
    invoiceIds: string[];
    amounts: number[];
    depositBankAccountId?: string;
  }) {
    const applications = opts.invoiceIds.map((id, i) => ({
      invoiceId: id,
      amount: opts.amounts[i],
    }));
    const r = await request(app)
      .post("/api/invoices/receive-payments")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: practiceId,
        paymentMethod: "check",
        depositBankAccountId: opts.depositBankAccountId ?? ufAccountId,
        applications,
      });
    expect(r.status, `receive-payments failed: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.data as { depositTransactionId: string; totalApplied: string };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-delete-payments";

    dbMod = await import("@workspace/db");
    const appMod = await import("../app.js");
    auth = await import("../lib/auth.js");
    app = appMod.default;

    const { db, organizations, users, organizationMemberships, bankAccounts } =
      dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "DelPay Test Lab" },
      { id: practiceId, type: "provider", name: "DelPay Test Practice", parentLabOrganizationId: labOrgId },
    ]);
    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: adminUserId, role: "admin", status: "active" },
    ]);

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

    tokens.admin = await makeSession(adminUserId);
  });

  beforeEach(async () => {
    tokens.admin = await makeSession(adminUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      bankTransactionInvoices,
      bankTransactions,
      bankAccounts,
      invoices,
      organizationMemberships,
      userSessions,
      organizations,
      users,
      statementPaymentSessions,
      statementPaymentApplications,
    } = dbMod as any;

    await cleanupPaymentFixtures(
      { userIds: [adminUserId], organizationIds: [labOrgId, practiceId] },
      db,
    );

    await db.delete(bankTransactionInvoices).where(
      inArray(
        bankTransactionInvoices.bankTransactionId,
        db.select({ id: bankTransactions.id })
          .from(bankTransactions)
          .where(eq(bankTransactions.bankAccountId, ufAccountId)),
      ),
    );
    await db.delete(bankTransactions).where(eq(bankTransactions.bankAccountId, ufAccountId));
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(bankAccounts).where(eq(bankAccounts.id, ufAccountId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, adminUserId));
    await db.delete(userSessions).where(eq(userSessions.userId, adminUserId));
    await db.delete(organizations).where(inArray(organizations.id, [labOrgId, practiceId]));
    await db.delete(users).where(eq(users.id, adminUserId));
  });

  // ── Scenario 1: single-invoice exclusive deposit ────────────────────────────

  it("single-invoice deposit: voids deposit, removes link, reverts invoice to open", async () => {
    const { db, invoices, payments, bankTransactions, bankTransactionInvoices } =
      dbMod as any;

    const invId = await insertInvoice({ invoiceNumber: rid("S1") });
    const { depositTransactionId } = await recordPayment({ invoiceIds: [invId], amounts: [100] });

    // Confirm setup: invoice is paid, deposit is posted, link exists
    const [inv0] = await db.select().from(invoices).where(eq(invoices.id, invId));
    expect(inv0.status).toBe("paid");
    const [dep0] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, depositTransactionId));
    expect(dep0.status).toBe("posted");

    const r = await request(app)
      .delete(`/api/invoices/${invId}/payments`)
      .set("Authorization", `Bearer ${tokens.admin}`);

    expect(r.status, `DELETE failed: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.deletedCount).toBeGreaterThan(0);

    // Payment rows gone
    const remainingPayments = await db.select().from(payments).where(eq(payments.invoiceId, invId));
    expect(remainingPayments).toHaveLength(0);

    // Invoice reverted to open with full balance
    const [inv1] = await db.select().from(invoices).where(eq(invoices.id, invId));
    expect(inv1.status).toBe("open");
    expect(Number(inv1.balanceDue)).toBeCloseTo(100, 2);

    // Exclusive deposit is voided
    const [dep1] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, depositTransactionId));
    expect(dep1.status).toBe("void");

    // Link row removed
    const links = await db.select().from(bankTransactionInvoices).where(eq(bankTransactionInvoices.invoiceId, invId));
    expect(links).toHaveLength(0);
  });

  // ── Scenario 2: shared batch deposit ────────────────────────────────────────

  it("shared deposit: reduces deposit amount by this invoice's share, does not void; other invoice unaffected", async () => {
    const { db, invoices, payments, bankTransactions, bankTransactionInvoices } =
      dbMod as any;

    const invA = await insertInvoice({ invoiceNumber: rid("B1A"), total: "75.00", balanceDue: "75.00" });
    const invB = await insertInvoice({ invoiceNumber: rid("B1B"), total: "50.00", balanceDue: "50.00" });

    // Record a single batch payment covering both invoices → one shared deposit
    const { depositTransactionId } = await recordPayment({
      invoiceIds: [invA, invB],
      amounts: [75, 50],
    });

    const [depBefore] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, depositTransactionId));
    expect(Number(depBefore.netAmount)).toBeCloseTo(125, 2);

    // Delete payments for invoice A only
    const r = await request(app)
      .delete(`/api/invoices/${invA}/payments`)
      .set("Authorization", `Bearer ${tokens.admin}`);

    expect(r.status, `DELETE failed: ${JSON.stringify(r.body)}`).toBe(200);

    // Invoice A reverted to open
    const [invAafter] = await db.select().from(invoices).where(eq(invoices.id, invA));
    expect(invAafter.status).toBe("open");

    // Invoice B still paid with its own payment row intact
    const [invBafter] = await db.select().from(invoices).where(eq(invoices.id, invB));
    expect(invBafter.status).toBe("paid");
    const bPayments = await db.select().from(payments).where(eq(payments.invoiceId, invB));
    expect(bPayments.length).toBeGreaterThan(0);

    // Shared deposit is NOT voided — only reduced by invoice A's share ($75)
    const [depAfter] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, depositTransactionId));
    expect(depAfter.status).not.toBe("void");
    expect(Number(depAfter.netAmount)).toBeCloseTo(50, 2); // $125 - $75 = $50

    // Invoice A's link removed; invoice B's link still present
    const aLinks = await db.select().from(bankTransactionInvoices)
      .where(and(
        eq(bankTransactionInvoices.bankTransactionId, depositTransactionId),
        eq(bankTransactionInvoices.invoiceId, invA),
      ));
    expect(aLinks).toHaveLength(0);

    const bLinks = await db.select().from(bankTransactionInvoices)
      .where(and(
        eq(bankTransactionInvoices.bankTransactionId, depositTransactionId),
        eq(bankTransactionInvoices.invoiceId, invB),
      ));
    expect(bLinks).toHaveLength(1);
  });

  // ── Scenario 3: repeated partial payments (multiple exclusive deposits) ─────

  it("repeated partial payments: all exclusive deposits voided, invoice reverts to open", async () => {
    const { db, invoices, payments, bankTransactions, bankTransactionInvoices } =
      dbMod as any;

    const invId = await insertInvoice({ invoiceNumber: rid("P1"), total: "100.00", balanceDue: "100.00" });

    // First partial payment: $60
    const { depositTransactionId: dep1Id } = await recordPayment({ invoiceIds: [invId], amounts: [60] });
    // Second partial payment: $40 (completes the invoice)
    const { depositTransactionId: dep2Id } = await recordPayment({ invoiceIds: [invId], amounts: [40] });

    // Confirm invoice is fully paid
    const [invBefore] = await db.select().from(invoices).where(eq(invoices.id, invId));
    expect(invBefore.status).toBe("paid");

    const r = await request(app)
      .delete(`/api/invoices/${invId}/payments`)
      .set("Authorization", `Bearer ${tokens.admin}`);

    expect(r.status, `DELETE failed: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.data.deletedCount).toBe(2);

    // Invoice reverted
    const [invAfter] = await db.select().from(invoices).where(eq(invoices.id, invId));
    expect(invAfter.status).toBe("open");
    expect(Number(invAfter.balanceDue)).toBeCloseTo(100, 2);

    // Both exclusive deposits voided
    const [d1] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, dep1Id));
    const [d2] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, dep2Id));
    expect(d1.status).toBe("void");
    expect(d2.status).toBe("void");

    // All link rows removed
    const links = await db.select().from(bankTransactionInvoices).where(eq(bankTransactionInvoices.invoiceId, invId));
    expect(links).toHaveLength(0);

    // No payment rows remain
    const remainingPayments = await db.select().from(payments).where(eq(payments.invoiceId, invId));
    expect(remainingPayments).toHaveLength(0);
  });

  // ── Scenario 4: mixed exclusive + shared deposits for one invoice ────────────

  it("mixed deposits: exclusive deposit voided, shared deposit reduced by invoice's share only", async () => {
    const { db, invoices, payments, bankTransactions, bankTransactionInvoices } =
      dbMod as any;

    // Invoice I ($100) and a bystander invoice J ($60)
    const invI = await insertInvoice({ invoiceNumber: rid("M1I"), total: "100.00", balanceDue: "100.00" });
    const invJ = await insertInvoice({ invoiceNumber: rid("M1J"), total: "60.00", balanceDue: "60.00" });

    // First payment: $40 for I alone → exclusive deposit D1
    const { depositTransactionId: d1Id } = await recordPayment({ invoiceIds: [invI], amounts: [40] });

    // Second payment: $60 for I + $60 for J in a batch → shared deposit D2
    const { depositTransactionId: d2Id } = await recordPayment({
      invoiceIds: [invI, invJ],
      amounts: [60, 60],
    });

    // Invoice I is now fully paid ($40 + $60 = $100)
    const [invBefore] = await db.select().from(invoices).where(eq(invoices.id, invI));
    expect(invBefore.status).toBe("paid");

    const [d1Before] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, d1Id));
    const [d2Before] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, d2Id));
    expect(Number(d1Before.creditAmount)).toBeCloseTo(40, 2);
    expect(Number(d2Before.creditAmount)).toBeCloseTo(120, 2);

    // Delete all payments for invoice I
    const r = await request(app)
      .delete(`/api/invoices/${invI}/payments`)
      .set("Authorization", `Bearer ${tokens.admin}`);

    expect(r.status, `DELETE failed: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.data.deletedCount).toBe(2);

    // Invoice I reverted to open
    const [invIafter] = await db.select().from(invoices).where(eq(invoices.id, invI));
    expect(invIafter.status).toBe("open");

    // D1 (exclusive) is voided
    const [d1After] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, d1Id));
    expect(d1After.status).toBe("void");

    // D2 (shared with J) is NOT voided; reduced by I's share ($60), J's $60 remains
    const [d2After] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, d2Id));
    expect(d2After.status).not.toBe("void");
    expect(Number(d2After.netAmount)).toBeCloseTo(60, 2); // $120 - $60 = $60

    // Invoice J is still paid with its payment intact
    const [invJafter] = await db.select().from(invoices).where(eq(invoices.id, invJ));
    expect(invJafter.status).toBe("paid");
    const jPayments = await db.select().from(payments).where(eq(payments.invoiceId, invJ));
    expect(jPayments.length).toBeGreaterThan(0);

    // Invoice I's link to D2 removed; J's link still present
    const iLinksToD2 = await db.select().from(bankTransactionInvoices).where(
      and(
        eq(bankTransactionInvoices.bankTransactionId, d2Id),
        eq(bankTransactionInvoices.invoiceId, invI),
      ),
    );
    expect(iLinksToD2).toHaveLength(0);

    const jLinksToD2 = await db.select().from(bankTransactionInvoices).where(
      and(
        eq(bankTransactionInvoices.bankTransactionId, d2Id),
        eq(bankTransactionInvoices.invoiceId, invJ),
      ),
    );
    expect(jLinksToD2).toHaveLength(1);
  });

  // ── Scenario 5: two shared deposits for the same invoice ─────────────────────

  it("two shared deposits: each reduced by per-deposit attribution; bystander invoices unaffected", async () => {
    const { db, invoices, payments, bankTransactions, bankTransactionInvoices } =
      dbMod as any;

    const invI = await insertInvoice({ invoiceNumber: rid("T1I"), total: "100.00", balanceDue: "100.00" });
    const invJ = await insertInvoice({ invoiceNumber: rid("T1J"), total: "50.00", balanceDue: "50.00" });
    const invK = await insertInvoice({ invoiceNumber: rid("T1K"), total: "75.00", balanceDue: "75.00" });

    // Batch 1: I=$50 + J=$50 → shared deposit D1 ($100)
    const { depositTransactionId: d1Id } = await recordPayment({
      invoiceIds: [invI, invJ],
      amounts: [50, 50],
    });

    // Batch 2: I=$50 + K=$75 → shared deposit D2 ($125)
    const { depositTransactionId: d2Id } = await recordPayment({
      invoiceIds: [invI, invK],
      amounts: [50, 75],
    });

    // Invoice I is fully paid ($50 + $50 = $100)
    const [invBefore] = await db.select().from(invoices).where(eq(invoices.id, invI));
    expect(invBefore.status).toBe("paid");

    // Delete all payments for invoice I
    const r = await request(app)
      .delete(`/api/invoices/${invI}/payments`)
      .set("Authorization", `Bearer ${tokens.admin}`);

    expect(r.status, `DELETE failed: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.data.deletedCount).toBe(2);

    // Invoice I reverted
    const [invIafter] = await db.select().from(invoices).where(eq(invoices.id, invI));
    expect(invIafter.status).toBe("open");

    // D1 reduced by I's share ($50): J's $50 remains → D1.netAmount = $50
    const [d1After] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, d1Id));
    expect(d1After.status).not.toBe("void");
    expect(Number(d1After.netAmount)).toBeCloseTo(50, 2);

    // D2 reduced by I's share ($50): K's $75 remains → D2.netAmount = $75
    const [d2After] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, d2Id));
    expect(d2After.status).not.toBe("void");
    expect(Number(d2After.netAmount)).toBeCloseTo(75, 2);

    // J and K are still paid with their own payment rows intact
    const jPayments = await db.select().from(payments).where(eq(payments.invoiceId, invJ));
    expect(jPayments.length).toBeGreaterThan(0);
    const kPayments = await db.select().from(payments).where(eq(payments.invoiceId, invK));
    expect(kPayments.length).toBeGreaterThan(0);

    const [invJafter] = await db.select().from(invoices).where(eq(invoices.id, invJ));
    expect(invJafter.status).toBe("paid");
    const [invKafter] = await db.select().from(invoices).where(eq(invoices.id, invK));
    expect(invKafter.status).toBe("paid");

    // I's links to both deposits removed; J's link to D1 and K's link to D2 intact
    const iLinksToD1 = await db.select().from(bankTransactionInvoices).where(
      and(eq(bankTransactionInvoices.bankTransactionId, d1Id), eq(bankTransactionInvoices.invoiceId, invI)),
    );
    expect(iLinksToD1).toHaveLength(0);

    const iLinksToD2 = await db.select().from(bankTransactionInvoices).where(
      and(eq(bankTransactionInvoices.bankTransactionId, d2Id), eq(bankTransactionInvoices.invoiceId, invI)),
    );
    expect(iLinksToD2).toHaveLength(0);

    const jLinksToD1 = await db.select().from(bankTransactionInvoices).where(
      and(eq(bankTransactionInvoices.bankTransactionId, d1Id), eq(bankTransactionInvoices.invoiceId, invJ)),
    );
    expect(jLinksToD1).toHaveLength(1);

    const kLinksToD2 = await db.select().from(bankTransactionInvoices).where(
      and(eq(bankTransactionInvoices.bankTransactionId, d2Id), eq(bankTransactionInvoices.invoiceId, invK)),
    );
    expect(kLinksToD2).toHaveLength(1);
  });

  // ── Authorization ────────────────────────────────────────────────────────────

  it("returns 403 for non-member", async () => {
    const { db, users, userSessions } = dbMod as any;
    const outsiderId = rid("uout");
    await db.insert(users).values({ id: outsiderId, username: `out_${outsiderId}`, password: "x" });
    const outsiderToken = await makeSession(outsiderId);

    const invId = await insertInvoice({ invoiceNumber: rid("A1") });

    const r = await request(app)
      .delete(`/api/invoices/${invId}/payments`)
      .set("Authorization", `Bearer ${outsiderToken}`);

    expect(r.status).toBe(403);

    // Cleanup
    await db.delete(userSessions).where(eq(userSessions.userId, outsiderId));
    await db.delete(users).where(eq(users.id, outsiderId));
  });

  it("returns 404 for unknown invoice", async () => {
    const r = await request(app)
      .delete(`/api/invoices/${rid("missing")}/payments`)
      .set("Authorization", `Bearer ${tokens.admin}`);

    expect(r.status).toBe(404);
  });
});
