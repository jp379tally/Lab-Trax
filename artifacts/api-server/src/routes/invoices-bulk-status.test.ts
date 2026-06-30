/**
 * Integration tests for the bulk invoice status change endpoint
 * POST /api/invoices/bulk-status.
 *
 * The endpoint applies a single target status to a selection of invoices,
 * mirroring the single-invoice PATCH side effects (audit log per invoice,
 * case-history event, paid-status ledgering). Authorization is per touched
 * lab org; frozen invoices are skipped; an invalid status is rejected.
 *
 * Skipped when DATABASE_URL is not configured. Each test cleans up after the
 * suite via afterAll so it is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - valid transition across two lab orgs updates ALL of them
 *  - frozen invoices are skipped (skippedFrozenCount), never changed
 *  - an invalid status value is rejected with 400 and changes nothing
 *  - 403 (and no change) when the caller lacks a billing role for a touched org
 *  - moving to "paid" creates a deposit; leaving "paid" reverses it
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import request from "supertest";

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

maybe("Bulk invoice status change (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  // A user who is a billing member of BOTH labs.
  const billingUserId = rid("ubill");
  // A user who is a billing member of only lab A.
  const labAOnlyUserId = rid("ulaba");

  const labAOrgId = rid("labA");
  const labBOrgId = rid("labB");
  const practiceAId = rid("provA");
  const practiceBId = rid("provB");

  const tokens = { both: "", labAOnly: "" };

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
    labOrganizationId: string;
    providerOrganizationId: string;
    status?: string;
    total?: string;
    balanceDue?: string;
    frozen?: boolean;
  }): Promise<string> {
    const { db, invoices } = dbMod as any;
    const id = rid("inv");
    await db.insert(invoices).values({
      id,
      invoiceNumber: rid("INV"),
      labOrganizationId: opts.labOrganizationId,
      providerOrganizationId: opts.providerOrganizationId,
      status: opts.status ?? "open",
      total: opts.total ?? "100.00",
      balanceDue: opts.balanceDue ?? "100.00",
      frozen: opts.frozen ?? false,
      createdByUserId: billingUserId,
    });
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-bulk-status";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: billingUserId, username: `bill_${billingUserId}`, password: "x" },
      { id: labAOnlyUserId, username: `laba_${labAOnlyUserId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labAOrgId, type: "lab", name: rid("StatusLabA") },
      { id: labBOrgId, type: "lab", name: rid("StatusLabB") },
      {
        id: practiceAId,
        type: "provider",
        name: rid("StatusPracticeA"),
        parentLabOrganizationId: labAOrgId,
      },
      {
        id: practiceBId,
        type: "provider",
        name: rid("StatusPracticeB"),
        parentLabOrganizationId: labBOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labAOrgId, userId: billingUserId, role: "billing", status: "active" },
      { id: rid("m"), labId: labBOrgId, userId: billingUserId, role: "billing", status: "active" },
      { id: rid("m"), labId: labAOrgId, userId: labAOnlyUserId, role: "billing", status: "active" },
    ]);

    tokens.both = await makeSession(billingUserId);
    tokens.labAOnly = await makeSession(labAOnlyUserId);
  }, 60_000);

  beforeEach(async () => {
    tokens.both = await makeSession(billingUserId);
    tokens.labAOnly = await makeSession(labAOnlyUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      invoices,
      organizationMemberships,
      userSessions,
      auditLogs,
      bankTransactions,
    } = dbMod as any;
    await db
      .delete(bankTransactions)
      .where(inArray(bankTransactions.labOrganizationId, [labAOrgId, labBOrgId]));
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labAOrgId, labBOrgId]));
    await db
      .delete(invoices)
      .where(inArray(invoices.labOrganizationId, [labAOrgId, labBOrgId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [billingUserId, labAOnlyUserId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [billingUserId, labAOnlyUserId]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labAOrgId, labBOrgId, practiceAId, practiceBId]));
    await db.delete(users).where(inArray(users.id, [billingUserId, labAOnlyUserId]));
  });

  it("applies a valid status to a selection spanning two lab orgs", async () => {
    const a1 = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId, status: "draft" });
    const b1 = await insertInvoice({ labOrganizationId: labBOrgId, providerOrganizationId: practiceBId, status: "draft" });

    const r = await request(appMod.default)
      .post("/api/invoices/bulk-status")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({ labOrganizationId: labAOrgId, invoiceIds: [a1, b1], status: "open" });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.updatedCount).toBe(2);
    expect(r.body.data.status).toBe("open");

    const { db, invoices } = dbMod as any;
    const rows = await db.query.invoices.findMany({
      where: inArray(invoices.id, [a1, b1]),
      columns: { id: true, status: true },
    });
    for (const row of rows) {
      expect(row.status).toBe("open");
    }
  });

  it("writes one audit log per invoice scoped to its own lab org", async () => {
    const a1 = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId, status: "draft" });
    const b1 = await insertInvoice({ labOrganizationId: labBOrgId, providerOrganizationId: practiceBId, status: "draft" });

    const r = await request(appMod.default)
      .post("/api/invoices/bulk-status")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({ invoiceIds: [a1, b1], status: "open" });

    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const { db, auditLogs } = dbMod as any;
    const logs = await db.query.auditLogs.findMany({
      where: inArray(auditLogs.entityId, [a1, b1]),
      columns: { entityId: true, organizationId: true, action: true },
    });
    const byId = Object.fromEntries(logs.map((l: any) => [l.entityId, l]));
    expect(byId[a1]?.organizationId).toBe(labAOrgId);
    expect(byId[b1]?.organizationId).toBe(labBOrgId);
    expect(byId[a1]?.action).toBe("bulk_invoice_status_change");
  });

  it("skips frozen invoices (skippedFrozenCount) and changes them not at all", async () => {
    const normal = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId, status: "draft" });
    const frozen = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId, status: "draft", frozen: true });

    const r = await request(appMod.default)
      .post("/api/invoices/bulk-status")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({ labOrganizationId: labAOrgId, invoiceIds: [normal, frozen], status: "open" });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.updatedCount).toBe(1);
    expect(r.body.data.skippedFrozenCount).toBe(1);

    const { db, invoices } = dbMod as any;
    const frozenRow = await db.query.invoices.findFirst({
      where: eq(invoices.id, frozen),
      columns: { status: true },
    });
    expect(frozenRow.status).toBe("draft");
  });

  it("rejects an invalid status value with 400 and changes nothing", async () => {
    const a1 = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId, status: "draft" });

    const r = await request(appMod.default)
      .post("/api/invoices/bulk-status")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({ labOrganizationId: labAOrgId, invoiceIds: [a1], status: "archived" });

    expect(r.status).toBe(400);

    const { db, invoices } = dbMod as any;
    const row = await db.query.invoices.findFirst({
      where: eq(invoices.id, a1),
      columns: { status: true },
    });
    expect(row.status).toBe("draft");
  });

  it("is 403 (and changes nothing) when caller lacks billing role for a touched org", async () => {
    const a1 = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId, status: "draft" });
    const b1 = await insertInvoice({ labOrganizationId: labBOrgId, providerOrganizationId: practiceBId, status: "draft" });

    const r = await request(appMod.default)
      .post("/api/invoices/bulk-status")
      .set("Authorization", `Bearer ${tokens.labAOnly}`)
      .send({ labOrganizationId: labAOrgId, invoiceIds: [a1, b1], status: "open" });

    expect(r.status).toBe(403);

    const { db, invoices } = dbMod as any;
    const rows = await db.query.invoices.findMany({
      where: inArray(invoices.id, [a1, b1]),
      columns: { id: true, status: true },
    });
    for (const row of rows) {
      expect(row.status).toBe("draft");
    }
  });

  it("creates a deposit when moving to paid and reverses it when leaving paid", async () => {
    const { db, organizations, bankAccounts, bankTransactions, bankTransactionInvoices } = dbMod as any;

    // ensureInvoiceDeposit only runs when the lab has a configured default
    // bank account, so set one up for lab A.
    const acctId = rid("acct");
    await db.insert(bankAccounts).values({
      id: acctId,
      labOrganizationId: labAOrgId,
      name: rid("Operating"),
      createdByUserId: billingUserId,
    });
    await db
      .update(organizations)
      .set({ defaultBankAccountId: acctId })
      .where(eq(organizations.id, labAOrgId));

    const inv = await insertInvoice({ labOrganizationId: labAOrgId, providerOrganizationId: practiceAId, status: "open", total: "300.00", balanceDue: "300.00" });

    const toPaid = await request(appMod.default)
      .post("/api/invoices/bulk-status")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({ labOrganizationId: labAOrgId, invoiceIds: [inv], status: "paid" });

    expect(toPaid.status, JSON.stringify(toPaid.body)).toBe(200);
    expect(toPaid.body.data.updatedCount).toBe(1);

    // A deposit (source "invoice", non-void) is now linked to the invoice.
    const linkedAfterPaid = await db
      .select({ id: bankTransactions.id, status: bankTransactions.status })
      .from(bankTransactionInvoices)
      .innerJoin(
        bankTransactions,
        eq(bankTransactions.id, bankTransactionInvoices.bankTransactionId),
      )
      .where(eq(bankTransactionInvoices.invoiceId, inv));
    const activeAfterPaid = linkedAfterPaid.filter((t: any) => t.status !== "void");
    expect(activeAfterPaid.length).toBeGreaterThanOrEqual(1);

    const fromPaid = await request(appMod.default)
      .post("/api/invoices/bulk-status")
      .set("Authorization", `Bearer ${tokens.both}`)
      .send({ labOrganizationId: labAOrgId, invoiceIds: [inv], status: "open" });

    expect(fromPaid.status, JSON.stringify(fromPaid.body)).toBe(200);

    // The auto-deposit link is removed; the transaction is voided.
    const linkedAfterReverse = await db
      .select({ id: bankTransactionInvoices.bankTransactionId })
      .from(bankTransactionInvoices)
      .where(eq(bankTransactionInvoices.invoiceId, inv));
    expect(linkedAfterReverse.length).toBe(0);
  });
});
