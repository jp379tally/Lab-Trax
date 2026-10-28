import { createHash, randomBytes } from "node:crypto";
import type { Express } from "express";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupPaymentFixtures } from "../test-utils/payment-cleanup.js";

const {
  refundCreate,
  refundRetrieve,
  paymentIntentCreate,
  paymentIntentRetrieve,
  paymentIntentCancel,
  customersRetrieve,
  paymentMethodsRetrieve,
  getStripePublishableKey,
} = vi.hoisted(() => ({
  refundCreate: vi.fn(), refundRetrieve: vi.fn(), paymentIntentCreate: vi.fn(),
  paymentIntentRetrieve: vi.fn(), paymentIntentCancel: vi.fn(),
  customersRetrieve: vi.fn(), paymentMethodsRetrieve: vi.fn(),
  // The card-configuration route reads the publishable key through this
  // helper; the real implementation needs live Stripe credentials.
  getStripePublishableKey: vi.fn().mockResolvedValue(null),
}));
vi.mock("../lib/stripeClient.js", () => ({
  getUncachableStripeClient: vi.fn().mockResolvedValue({
    paymentIntents: {
      retrieve: paymentIntentRetrieve,
      cancel: paymentIntentCancel,
      create: paymentIntentCreate,
    },
    customers: { retrieve: customersRetrieve },
    paymentMethods: { retrieve: paymentMethodsRetrieve },
    charges: { retrieve: vi.fn().mockImplementation(async (id: string) => ({
      id, amount: id === "ch_accept" ? 5000 : id.includes("crash_gap") ? 700 : 500,
      currency: "usd",
      payment_intent: id.replace(/^ch_/, "pi_"),
    })) },
    refunds: { create: refundCreate, retrieve: refundRetrieve, list: vi.fn().mockResolvedValue({ data: [] }) },
  }),
  getStripePublishableKey,
  logStripeAccountOwnership: vi.fn().mockResolvedValue(undefined),
}));
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
}));

const SHOULD_RUN = !!process.env.DATABASE_URL;
const maybe = SHOULD_RUN ? describe : describe.skip;
const rid = (prefix: string) =>
  `${prefix}_${randomBytes(8).toString("hex")}`;

maybe("statement payment sessions (db integration)", () => {
  type DbModule = typeof import("@workspace/db");
  let dbMod: DbModule;
  let app: Express;
  let calendarDateInTimeZone: typeof import("./payment-sessions.js").calendarDateInTimeZone;
  let token = "";

  const labId = rid("pay_lab");
  const providerId = rid("pay_provider");
  const userId = rid("pay_admin");
  const billingUserId = rid("pay_billing");
  const invoiceOneId = rid("pay_inv");
  const invoiceTwoId = rid("pay_inv");
  const invoiceOneNumber = rid("INV");
  const invoiceTwoNumber = rid("INV");
  const statementId = rid("pay_stmt");
  const olderStatementId = rid("pay_stmt_old");
  let ufAccountId = "";
  let checkingAccountId = "";
  const createdSessionIds: string[] = [];
  const reversalInvoiceIds: string[] = [];
  const cardFixtureInvoiceIds: string[] = [];
  const cardFixtureSessionIds: string[] = [];
  const cardFixtureStatementIds: string[] = [];
  const ledgerFixtureInvoiceIds: string[] = [];
  const ledgerFixtureStatementIds: string[] = [];
  const ledgerFixtureOrgIds: string[] = [];

  afterEach(async () => {
    if (!SHOULD_RUN || !dbMod ||
      (!cardFixtureInvoiceIds.length && !ledgerFixtureInvoiceIds.length)) return;
    const t = dbMod as any;
    const { db, practiceStatementSends, practiceStatements, invoices, organizations } = t;
    await cleanupPaymentFixtures(
      {
        invoiceIds: [...cardFixtureInvoiceIds, ...ledgerFixtureInvoiceIds],
        paymentSessionIds: cardFixtureSessionIds,
      },
      db,
    );
    const statementIds = [
      ...cardFixtureStatementIds,
      ...ledgerFixtureStatementIds,
    ];
    if (statementIds.length) {
      await db.delete(practiceStatementSends).where(inArray(
        practiceStatementSends.statementId, statementIds));
      await db.delete(practiceStatements).where(inArray(
        practiceStatements.id, statementIds));
    }
    const invoiceIds = [...cardFixtureInvoiceIds, ...ledgerFixtureInvoiceIds];
    if (invoiceIds.length) {
      await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
    }
    // Practices created for a single ledger test go last: their invoices,
    // sessions, and credits have to be gone before the parent row can be.
    if (ledgerFixtureOrgIds.length) {
      await db.delete(organizations)
        .where(inArray(organizations.id, ledgerFixtureOrgIds));
    }
    ledgerFixtureOrgIds.length = 0;
    cardFixtureInvoiceIds.length = 0;
    cardFixtureSessionIds.length = 0;
    cardFixtureStatementIds.length = 0;
    ledgerFixtureInvoiceIds.length = 0;
    ledgerFixtureStatementIds.length = 0;
  });

  async function createAccessToken(forUserId = userId) {
    const auth = await import("../lib/auth.js");
    const sessionId = rid("pay_session");
    const accessToken = auth.signAccessToken(forUserId, sessionId);
    await (dbMod as any).db.insert((dbMod as any).userSessions).values({
      id: sessionId,
      userId: forUserId,
      tokenHash: createHash("sha256").update(accessToken).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return accessToken;
  }

  async function waitForBlockingEvents(
    blockerPid: number,
    expectedEvents: string[],
  ): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await (dbMod as any).pool.query(
        `SELECT wait_event
           FROM pg_stat_activity
          WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [blockerPid],
      );
      const remaining = [...expectedEvents];
      for (const row of result.rows as Array<{ wait_event: string | null }>) {
        const index = remaining.indexOf(row.wait_event ?? "");
        if (index >= 0) remaining.splice(index, 1);
      }
      if (remaining.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Timed out waiting for blocked PostgreSQL events: ${expectedEvents.join(", ")}`,
    );
  }

  async function createLedgerPagingFixtures() {
    const { db, invoices, practiceStatements, practiceStatementSends } = dbMod as any;
    const batches = [
      { day: "01", amount: "10.00" },
      { day: "02", amount: "20.00" },
      { day: "03", amount: "30.00" },
      { day: "04", amount: "40.00" },
    ];
    const fixture = batches.map(({ day, amount }) => {
      const invoiceId = rid("ledger_page_inv");
      const statementId = rid("ledger_page_stmt");
      const invoiceNumber = rid("LEDGER_PAGE");
      const issuedAt = new Date(`2099-01-${day}T12:00:00.000Z`);
      ledgerFixtureInvoiceIds.push(invoiceId);
      ledgerFixtureStatementIds.push(statementId);
      return {
        amount,
        invoiceId,
        invoiceNumber,
        issuedAt,
        statementId,
      };
    });
    await db.insert(invoices).values(fixture.map((row: any) => ({
      id: row.invoiceId,
      invoiceNumber: row.invoiceNumber,
      labOrganizationId: labId,
      providerOrganizationId: providerId,
      status: "open",
      total: row.amount,
      balanceDue: row.amount,
      issuedAt: row.issuedAt,
      displayMetadataJson: { patientName: row.invoiceNumber },
      createdByUserId: userId,
    })));
    await db.insert(practiceStatements).values(fixture.map((row: any) => ({
      id: row.statementId,
      labOrganizationId: labId,
      providerOrganizationId: providerId,
      periodStart: row.issuedAt,
      periodEnd: new Date(row.issuedAt.getTime() + 24 * 60 * 60 * 1000 - 1),
      invoiceCount: 1,
      totalBilled: row.amount,
      totalPaid: "0.00",
      balanceDue: row.amount,
      invoiceIdsJson: [row.invoiceId],
      invoiceAmountsJson: { [row.invoiceId]: row.amount },
      invoiceDetailsJson: {
        [row.invoiceId]: {
          invoiceNumber: row.invoiceNumber,
          patientName: row.invoiceNumber,
          billTo: null,
        },
      },
      createdByUserId: userId,
    })));
    await db.insert(practiceStatementSends).values(fixture.map((row: any) => ({
      statementId: row.statementId,
      channel: "email",
      recipient: "billing@example.test",
      status: "sent",
      sentByUserId: userId,
      sentAt: new Date(row.issuedAt.getTime() + 60 * 60 * 1000),
    })));
    return {
      invoiceNumbers: fixture.map((row: any) => row.invoiceNumber),
      statementIds: fixture.map((row: any) => row.statementId),
    };
  }

  beforeAll(async () => {
    process.env.JWT_SECRET =
      process.env.JWT_SECRET || "statement-payment-session-test-secret";
    dbMod = await import("@workspace/db");
    // CI databases used by this integration suite may be provisioned from the
    // baseline schema rather than running newly-added drizzle files. Keep the
    // focused route test self-contained while production obtains this table
    // through 0002_statement_payment_reversals.sql.
    await (dbMod as any).db.execute(sql`
      CREATE TABLE IF NOT EXISTS statement_payment_reversals (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        payment_session_id varchar NOT NULL REFERENCES statement_payment_sessions(id) ON DELETE restrict,
        processor_idempotency_key text NOT NULL,
        stripe_payment_intent_id text, stripe_charge_id text, stripe_refund_id text,
        amount numeric(12, 2) NOT NULL DEFAULT 0, currency text DEFAULT 'usd' NOT NULL,
        status text DEFAULT 'pending_processor' NOT NULL, failure_reason text,
        processor_lease_token text, processing_started_at timestamp with time zone,
        initiated_by_user_id varchar NOT NULL REFERENCES users(id) ON DELETE restrict,
        completed_at timestamp with time zone,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
    await (dbMod as any).db.execute(sql`
      ALTER TABLE statement_payment_reversals ADD COLUMN IF NOT EXISTS amount numeric(12, 2) NOT NULL DEFAULT 0;
      ALTER TABLE statement_payment_reversals ADD COLUMN IF NOT EXISTS currency text DEFAULT 'usd' NOT NULL;
      ALTER TABLE statement_payment_reversals ADD COLUMN IF NOT EXISTS processor_lease_token text;
      ALTER TABLE statement_payment_reversals ADD COLUMN IF NOT EXISTS processing_started_at timestamp with time zone;
    `);
    // Keep this integration suite usable against CI databases provisioned from
    // the baseline schema. These are the additive columns from migrations
    // 0015 and 0016, and must exist before the route (and Drizzle metadata)
    // is imported.
    await (dbMod as any).db.execute(sql`
      ALTER TABLE provider_payment_checkouts
        ADD COLUMN IF NOT EXISTS inline_draft_json jsonb;
      ALTER TABLE provider_payment_checkouts
        ADD COLUMN IF NOT EXISTS inline_draft_fingerprint text;
      ALTER TABLE statement_payment_sessions
        ADD COLUMN IF NOT EXISTS doctor_identity text;
      ALTER TABLE statement_payment_sessions
        ADD COLUMN IF NOT EXISTS doctor_display_name text;
    `);
    app = (await import("../app.js")).default;
    ({ calendarDateInTimeZone } = await import("./payment-sessions.js"));
    const {
      db,
      bankAccounts,
      invoices,
      organizationMemberships,
      organizations,
      practiceStatements,
      practiceStatementSends,
      users,
    } = dbMod as any;
    await db.insert(users).values({
      id: userId,
      username: userId,
      password: "x",
    });
    await db.insert(users).values({
      id: billingUserId,
      username: billingUserId,
      password: "x",
    });
    await db.insert(organizations).values([
      { id: labId, type: "lab", name: "Receipt Test Lab" },
      {
        id: providerId,
        type: "provider",
        name: "Receipt Test Practice",
        billingEmail: "billing@example.test",
        parentLabOrganizationId: labId,
      },
    ]);
    await db.insert(organizationMemberships).values({
      id: rid("pay_member"),
      labId,
      userId,
      role: "admin",
      status: "active",
    });
    await db.insert(organizationMemberships).values({
      id: rid("pay_billing_member"),
      labId,
      userId: billingUserId,
      role: "billing",
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
        createdByUserId: userId,
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
        createdByUserId: userId,
      })
      .returning();
    checkingAccountId = checking.id;
    await db.insert(invoices).values([
      {
        id: invoiceOneId,
        invoiceNumber: invoiceOneNumber,
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        status: "open",
        total: "100.00",
        balanceDue: "100.00",
         displayMetadataJson: { patientName: "Patient One", billTo: "Dr. One" },
        createdByUserId: userId,
      },
      {
        id: invoiceTwoId,
        invoiceNumber: invoiceTwoNumber,
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        status: "open",
        total: "80.00",
        balanceDue: "80.00",
         displayMetadataJson: { patientName: "Patient Two", billTo: "Dr. Two" },
        createdByUserId: userId,
      },
    ]);
    await db.insert(practiceStatements).values([
      {
        id: olderStatementId,
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        periodStart: new Date("2026-07-01T00:00:00.000Z"),
        periodEnd: new Date("2026-07-31T23:59:59.000Z"),
        invoiceCount: 1,
        totalBilled: "100.00",
        totalPaid: "0.00",
        balanceDue: "100.00",
        invoiceIdsJson: [invoiceOneId],
        invoiceAmountsJson: {
          [invoiceOneId]: "175.00",
        },
        invoiceDetailsJson: {
          [invoiceOneId]: {
            invoiceNumber: invoiceOneNumber,
            patientName: "Patient One",
            billTo: null,
          },
        },
        createdByUserId: userId,
      },
      {
        id: statementId,
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        periodStart: new Date("2026-08-01T00:00:00.000Z"),
        periodEnd: new Date("2026-08-31T23:59:59.000Z"),
        invoiceCount: 1,
        totalBilled: "80.00",
        totalPaid: "0.00",
        balanceDue: "80.00",
        invoiceIdsJson: [invoiceTwoId],
        invoiceAmountsJson: {
          [invoiceTwoId]: "95.00",
        },
        invoiceDetailsJson: {
          [invoiceTwoId]: {
            invoiceNumber: invoiceTwoNumber,
            patientName: "Patient Two",
            billTo: "Original Billing Contact",
          },
        },
        createdByUserId: userId,
      },
    ]);
    await db.insert(practiceStatementSends).values([
      { statementId: olderStatementId, channel: "email", recipient: "billing@example.test", status: "sent", sentByUserId: userId },
      { statementId, channel: "email", recipient: "billing@example.test", status: "sent", sentByUserId: userId },
    ]);
    token = await createAccessToken();
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      auditLogs,
      bankAccounts,
      bankDepositBatchMembers,
      bankTransactionInvoices,
      bankTransactions,
      customerCreditApplications,
      customerCredits,
      db,
      invoices,
      organizationMemberships,
      organizations,
      practiceStatements,
      practiceStatementSends,
      systemSettings,
      userSessions,
      users,
    } = dbMod as any;
    await cleanupPaymentFixtures(
      {
        userIds: [userId, billingUserId],
        organizationIds: [labId, providerId],
        invoiceIds: [invoiceOneId, invoiceTwoId, ...reversalInvoiceIds],
        paymentSessionIds: createdSessionIds,
      },
      db,
    );
    await db
      .delete(bankTransactionInvoices)
      .where(
        inArray(
          bankTransactionInvoices.bankTransactionId,
          db
            .select({ id: bankTransactions.id })
            .from(bankTransactions)
            .where(eq(bankTransactions.labOrganizationId, labId)),
        ),
      );
    await db.delete(bankDepositBatchMembers).where(
      inArray(
        bankDepositBatchMembers.aggregateBankTransactionId,
        db.select({ id: bankTransactions.id }).from(bankTransactions)
          .where(eq(bankTransactions.labOrganizationId, labId)),
      ),
    );
    await db
      .delete(bankTransactions)
      .where(eq(bankTransactions.labOrganizationId, labId));
    await db.delete(practiceStatementSends).where(inArray(practiceStatementSends.statementId, [statementId, olderStatementId]));
    await db.delete(practiceStatements).where(inArray(practiceStatements.id, [statementId, olderStatementId]));
     if (reversalInvoiceIds.length) {
       await db.delete(invoices).where(inArray(invoices.id, reversalInvoiceIds));
     }
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labId));
    await db.delete(bankAccounts).where(eq(bankAccounts.labOrganizationId, labId));
    await db
      .delete(auditLogs)
      .where(eq(auditLogs.organizationId, labId));
    await db
      .delete(systemSettings)
      .where(eq(systemSettings.key, `tmpl_payment_receipt:${labId}`));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [userId, billingUserId]));
    await db.delete(userSessions).where(inArray(userSessions.userId, [userId, billingUserId]));
    await db.delete(organizations).where(inArray(organizations.id, [providerId, labId]));
    await db.delete(users).where(inArray(users.id, [userId, billingUserId]));
  });

  it.each([
    { label: "user", selector: "userIds" },
    { label: "organization", selector: "organizationIds" },
    { label: "invoice", selector: "invoiceIds" },
    { label: "transaction", selector: "transactionIds" },
    { label: "session", selector: "paymentSessionIds" },
    { label: "checkout", selector: "checkoutIds" },
  ] as const)(
    "keeps $label-scoped payment fixture cleanup isolated",
    async ({ label, selector }) => {
      const {
        bankTransactions,
        customerCreditApplications,
        customerCredits,
        db,
        invoices,
        organizations,
        payments,
        providerPaymentAllocations,
        providerPaymentCheckouts,
        providerPaymentCustomers,
        statementPaymentApplications,
        statementPaymentReversals,
        statementPaymentSessions,
      } = dbMod as any;
      const ownedProviderId =
        label === "organization" ? rid("cleanup_provider") : providerId;
      const unrelatedProviderId =
        label === "organization" ? rid("cleanup_provider") : providerId;
      const ownedUserId = label === "user" ? billingUserId : userId;
      const ownedCustomerId = rid("cleanup_customer");
      const unrelatedCustomerId = rid("cleanup_customer");

      if (label === "organization") {
        await db.insert(organizations).values([
          {
            id: ownedProviderId,
            type: "provider",
            name: "Payment Cleanup Owned Practice",
            parentLabOrganizationId: labId,
          },
          {
            id: unrelatedProviderId,
            type: "provider",
            name: "Payment Cleanup Unrelated Practice",
            parentLabOrganizationId: labId,
          },
        ]);
        await db.insert(providerPaymentCustomers).values([
          {
            id: ownedCustomerId,
            providerOrganizationId: ownedProviderId,
            stripeCustomerId: rid("cus_cleanup"),
          },
          {
            id: unrelatedCustomerId,
            providerOrganizationId: unrelatedProviderId,
            stripeCustomerId: rid("cus_cleanup"),
          },
        ]);
      }

      const createGraph = async (
        prefix: string,
        createdByUserId: string,
        providerOrganizationId: string,
      ) => {
        const invoiceId = rid(`${prefix}_invoice`);
        const transactionId = rid(`${prefix}_transaction`);
        const checkoutId = rid(`${prefix}_checkout`);
        const sessionId = rid(`${prefix}_session`);
        const paymentId = rid(`${prefix}_payment`);
        const allocationId = rid(`${prefix}_allocation`);
        const applicationId = rid(`${prefix}_application`);
        const creditId = rid(`${prefix}_credit`);
        const creditApplicationId = rid(`${prefix}_credit_application`);
        const reversalId = rid(`${prefix}_reversal`);

        await db.insert(invoices).values({
          id: invoiceId,
          invoiceNumber: rid("CLEANUP"),
          labOrganizationId: labId,
          providerOrganizationId,
          status: "open",
          total: "20.00",
          balanceDue: "10.00",
          createdByUserId,
        });
        await db.insert(bankTransactions).values({
          id: transactionId,
          labOrganizationId: labId,
          bankAccountId: ufAccountId,
          txnDate: new Date(),
          type: "deposit",
          payee: "Payment Cleanup Test",
          creditAmount: "20.00",
          netAmount: "20.00",
          source: "customer_payment",
          createdByUserId,
        });
        await db.insert(providerPaymentCheckouts).values({
          id: checkoutId,
          providerOrganizationId,
          initiatedByUserId: createdByUserId,
          totalAmount: "20.00",
          status: "succeeded",
        });
        await db.insert(providerPaymentAllocations).values({
          id: allocationId,
          checkoutId,
          invoiceId,
          amount: "10.00",
        });
        await db.insert(statementPaymentSessions).values({
          id: sessionId,
          labOrganizationId: labId,
          providerOrganizationId,
          bankTransactionId: transactionId,
          providerPaymentCheckoutId: checkoutId,
          requestFingerprint: rid("fp"),
          receiptNumber: rid("receipt"),
          receivedAmount: "20.00",
          appliedAmount: "10.00",
          customerCreditAmount: "10.00",
          accountBalanceAfter: "0.00",
          paymentMethod: "card",
          labName: "Payment Cleanup Test Lab",
          createdByUserId,
        });
        await db.insert(statementPaymentApplications).values({
          id: applicationId,
          paymentSessionId: sessionId,
          invoiceId,
          invoiceNumber: rid("CLEANUP"),
          invoiceTotal: "20.00",
          amount: "10.00",
          invoiceBalanceBefore: "20.00",
          invoiceBalanceAfter: "10.00",
        });
        await db.insert(payments).values({
          id: paymentId,
          invoiceId,
          bankTransactionId: transactionId,
          paymentSessionId: sessionId,
          providerPaymentCheckoutId: checkoutId,
          amount: "10.00",
          paymentMethod: "card",
          recordedByUserId: createdByUserId,
        });
        await db.insert(customerCredits).values({
          id: creditId,
          labOrganizationId: labId,
          providerOrganizationId,
          paymentSessionId: sessionId,
          amount: "10.00",
          remainingAmount: "10.00",
          createdByUserId,
        });
        await db.insert(customerCreditApplications).values({
          id: creditApplicationId,
          customerCreditId: creditId,
          paymentSessionId: sessionId,
          invoiceId,
          amount: "1.00",
        });
        await db.insert(statementPaymentReversals).values({
          id: reversalId,
          paymentSessionId: sessionId,
          processorIdempotencyKey: rid("cleanup_reversal"),
          amount: "20.00",
          status: "pending_processor",
          initiatedByUserId: createdByUserId,
        });

        return {
          invoiceId,
          transactionId,
          checkoutId,
          sessionId,
          rows: [
            [
              statementPaymentReversals,
              statementPaymentReversals.id,
              reversalId,
            ],
            [
              customerCreditApplications,
              customerCreditApplications.id,
              creditApplicationId,
            ],
            [
              statementPaymentApplications,
              statementPaymentApplications.id,
              applicationId,
            ],
            [payments, payments.id, paymentId],
            [customerCredits, customerCredits.id, creditId],
            [
              providerPaymentAllocations,
              providerPaymentAllocations.id,
              allocationId,
            ],
            [statementPaymentSessions, statementPaymentSessions.id, sessionId],
            [providerPaymentCheckouts, providerPaymentCheckouts.id, checkoutId],
          ] as const,
        };
      };

      const owned = await createGraph(
        "cleanup_owned",
        ownedUserId,
        ownedProviderId,
      );
      const unrelated = await createGraph(
        "cleanup_other",
        userId,
        unrelatedProviderId,
      );
      const selectedId = {
        userIds: ownedUserId,
        organizationIds: ownedProviderId,
        invoiceIds: owned.invoiceId,
        transactionIds: owned.transactionId,
        paymentSessionIds: owned.sessionId,
        checkoutIds: owned.checkoutId,
      }[selector];

      try {
        await cleanupPaymentFixtures({ [selector]: [selectedId] }, db);

        for (const [table, idColumn, id] of owned.rows) {
          expect(
            await db.select().from(table).where(eq(idColumn, id)),
            `${label} selector left owned ${table[Symbol.for("drizzle:Name")] ?? "payment"} row ${id}`,
          ).toHaveLength(0);
        }
        for (const [table, idColumn, id] of unrelated.rows) {
          expect(
            await db.select().from(table).where(eq(idColumn, id)),
            `${label} selector removed unrelated ${table[Symbol.for("drizzle:Name")] ?? "payment"} row ${id}`,
          ).toHaveLength(1);
        }
        if (label === "organization") {
          expect(
            await db
              .select()
              .from(providerPaymentCustomers)
              .where(
                eq(
                  providerPaymentCustomers.providerOrganizationId,
                  ownedProviderId,
                ),
              ),
          ).toHaveLength(0);
          expect(
            await db
              .select()
              .from(providerPaymentCustomers)
              .where(eq(providerPaymentCustomers.id, unrelatedCustomerId)),
          ).toHaveLength(1);
        }
      } finally {
        await cleanupPaymentFixtures(
          {
            invoiceIds: [owned.invoiceId, unrelated.invoiceId],
            organizationIds:
              label === "organization"
                ? [ownedProviderId, unrelatedProviderId]
                : undefined,
          },
          db,
        );
        await db
          .delete(bankTransactions)
          .where(
            inArray(bankTransactions.id, [
              owned.transactionId,
              unrelated.transactionId,
            ]),
          );
        await db
          .delete(invoices)
          .where(inArray(invoices.id, [owned.invoiceId, unrelated.invoiceId]));
        if (label === "organization") {
          await db
            .delete(organizations)
            .where(
              inArray(organizations.id, [
                ownedProviderId,
                unrelatedProviderId,
              ]),
            );
        }
      }
    },
  );

  it("matches statement range dates to the viewer's local calendar day", () => {
    expect(calendarDateInTimeZone(
      new Date("2026-10-01T02:30:00.000Z"),
      "America/New_York",
    )).toBe("2026-09-30");
    expect(calendarDateInTimeZone(
      new Date("2026-09-01T03:30:00.000Z"),
      "America/New_York",
    )).toBe("2026-08-31");
    expect(() => calendarDateInTimeZone(new Date(), "Not/A_Timezone")).toThrow(
      "timeZone must be a valid IANA timezone.",
    );
  });

  it("GET /api/lab-orgs/:orgId/statements/account-summaries keeps the legacy array and pages newest-first", async () => {
    const { db, invoices, organizations, practiceStatements } = dbMod as any;
    const extraProviderId = rid("summary_provider");
    const extraInvoiceId = rid("summary_invoice");
    const extraStatementId = rid("summary_statement");

    const legacy = await request(app)
      .get(`/api/lab-orgs/${labId}/statements/account-summaries`)
      .set("Authorization", `Bearer ${token}`);
    expect(legacy.status).toBe(200);
    expect(Array.isArray(legacy.body.data)).toBe(true);
    expect(legacy.body.data.map((row: any) => row.practiceId)).toContain(providerId);

    await db.insert(organizations).values({
      id: extraProviderId,
      type: "provider",
      name: "Newest Summary Practice",
      parentLabOrganizationId: labId,
    });
    await db.insert(invoices).values({
      id: extraInvoiceId,
      invoiceNumber: rid("INV"),
      labOrganizationId: labId,
      providerOrganizationId: extraProviderId,
      status: "open",
      total: "40.00",
      balanceDue: "40.00",
      createdByUserId: userId,
    });
    await db.insert(practiceStatements).values({
      id: extraStatementId,
      labOrganizationId: labId,
      providerOrganizationId: extraProviderId,
      periodStart: new Date("2026-09-01T00:00:00.000Z"),
      periodEnd: new Date("2026-09-30T23:59:59.000Z"),
      invoiceCount: 1,
      totalBilled: "40.00",
      totalPaid: "0.00",
      balanceDue: "40.00",
      invoiceIdsJson: [extraInvoiceId],
      invoiceAmountsJson: { [extraInvoiceId]: "40.00" },
      invoiceDetailsJson: {
        [extraInvoiceId]: {
          invoiceNumber: "Summary Invoice",
          patientName: "Summary Patient",
        },
      },
      createdByUserId: userId,
    });

    try {
      const page = await request(app)
        .get(`/api/lab-orgs/${labId}/statements/account-summaries`)
        .query({ limit: 1, offset: 0 })
        .set("Authorization", `Bearer ${token}`);
      expect(page.status).toBe(200);
      expect(page.body.data).toMatchObject({
        total: 2,
        limit: 1,
        offset: 0,
        hasMore: true,
      });
      expect(page.body.data.rows[0].practiceId).toBe(extraProviderId);
      expect(page.body.data.rows[0].unpaidStatements[0].id).toBe(extraStatementId);
    } finally {
      await db.delete(practiceStatements).where(eq(practiceStatements.id, extraStatementId));
      await db.delete(invoices).where(eq(invoices.id, extraInvoiceId));
      await db.delete(organizations).where(eq(organizations.id, extraProviderId));
    }
  });

  it("keeps the statement-charges response shape unpaged", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const fixture = await createLedgerPagingFixtures();
    const response = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
      .set(auth);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual(expect.objectContaining({
      providerOrganizationId: providerId,
      rows: expect.any(Array),
      endingBalance: expect.any(String),
    }));
    expect(response.body.data).not.toHaveProperty("total");
    expect(response.body.data).not.toHaveProperty("limit");
    expect(response.body.data).not.toHaveProperty("offset");
    expect(response.body.data).not.toHaveProperty("hasMore");
    expect(response.body.data.rows).toEqual(expect.arrayContaining([
      ...fixture.invoiceNumbers.map((invoiceNumber) =>
        expect.objectContaining({ type: "invoice", invoiceNumber })),
      ...fixture.statementIds.map((statementId) =>
        expect.objectContaining({ type: "statement", statementId })),
    ]));
  });

  it("pages newest statement-charge batches without gaps or duplicates", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const baseline = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
      .set(auth);
    expect(baseline.status).toBe(200);
    const fixture = await createLedgerPagingFixtures();
    const expectedKeys = fixture.statementIds
      .map((statementId, index) => ({
        invoiceNumber: fixture.invoiceNumbers[index],
        statementId,
      }))
      .reverse()
      .flatMap(({ invoiceNumber, statementId }) => [
        `statement:${statementId}`,
        `invoice:${invoiceNumber}`,
      ]);
    const pages: any[][] = [];

    for (const offset of [0, 2, 4, 6]) {
      const response = await request(app)
        .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges?limit=2&offset=${offset}`)
        .set(auth);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data).toEqual(expect.objectContaining({
        limit: 2,
        offset,
        rows: expect.any(Array),
      }));
      expect(response.body.data.rows).toHaveLength(2);
      pages.push(response.body.data.rows);
    }

    // A rolled-up payment also names the statement it was applied to, so the
    // row's own type is what distinguishes a statement event from an invoice.
    const keys = pages.flat().map((row) =>
      row.type === "statement" ? `statement:${row.statementId}` : `invoice:${row.invoiceNumber}`);
    expect(keys).toEqual(expectedKeys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Number(pages[0][0].balance)).toBe(Number(baseline.body.data.endingBalance) + 100);
  });

  it("pages statement charges within a from/to date filter", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const baseline = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
      .set(auth);
    expect(baseline.status).toBe(200);
    const fixture = await createLedgerPagingFixtures();
    const query = "from=2099-01-02&to=2099-01-03";
    const expectedKeys = [
      `statement:${fixture.statementIds[2]}`,
      `invoice:${fixture.invoiceNumbers[2]}`,
      `statement:${fixture.statementIds[1]}`,
      `invoice:${fixture.invoiceNumbers[1]}`,
    ];
    const first = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges?${query}&limit=2`)
      .set(auth);
    const second = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges?${query}&limit=2&offset=2`)
      .set(auth);

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(first.body.data.total).toBe(4);
    expect(second.body.data.total).toBe(4);
    expect(first.body.data.rows.concat(second.body.data.rows).map((row: any) =>
      row.type === "statement" ? `statement:${row.statementId}` : `invoice:${row.invoiceNumber}`,
    )).toEqual(expectedKeys);
    expect(Number(first.body.data.endingBalance)).toBe(
      Number(baseline.body.data.endingBalance) + 60,
    );
  });

  it("reports balances for a partial newest statement-charge window", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const baseline = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
      .set(auth);
    expect(baseline.status).toBe(200);
    await createLedgerPagingFixtures();
    const response = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges?limit=3&offset=0`)
      .set(auth);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.rows).toHaveLength(3);
    expect(Number(response.body.data.openingBalance)).toBe(
      Number(baseline.body.data.endingBalance) + 60,
    );
    expect(Number(response.body.data.endingBalance)).toBe(
      Number(baseline.body.data.endingBalance) + 100,
    );
  });

  it("serializes provider-account work with the ordinary payment advisory key", async () => {
    const { pool } = dbMod as any;
    const first = await pool.connect();
    const second = await pool.connect();
    const keyLab = rid("lock_lab");
    const keyProvider = rid("lock_provider");
    try {
      await first.query("SELECT pg_advisory_lock(hashtext($1), hashtext($2))", [keyLab, keyProvider]);
      let ordinaryCompleted = false;
      const ordinary = second.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [keyLab, keyProvider],
      ).then(() => { ordinaryCompleted = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(ordinaryCompleted).toBe(false);
      await first.query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [keyLab, keyProvider]);
      await ordinary;
      expect(ordinaryCompleted).toBe(true);
    } finally {
      first.release();
      second.release();
    }
  });

  it("rejects cancellation when a generated credit has been consumed", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, providerPaymentCustomers } = dbMod as any;
    const stripeCustomerId = `cus_generated_${labId}`;
    await db.insert(providerPaymentCustomers).values({
      providerOrganizationId: providerId, stripeCustomerId,
      cardBrand: "visa", cardLast4: "4242",
    }).onConflictDoUpdate({
      target: providerPaymentCustomers.providerOrganizationId,
      set: { stripeCustomerId, cardBrand: "visa", cardLast4: "4242" },
    });
    customersRetrieve.mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: "pm_generated" } });
    paymentMethodsRetrieve.mockResolvedValue({
      type: "card", customer: stripeCustomerId, card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    });
    paymentIntentCreate.mockResolvedValueOnce({
      id: "pi_generated_credit", status: "succeeded", amount: 200,
      currency: "usd", latest_charge: "ch_generated_credit",
    });
    const created = await request(app).post("/api/billing/payment-sessions/card")
      .set(auth).send({
        labOrganizationId: labId, providerOrganizationId: providerId, statementId,
        receivedAmount: 2, paymentMethod: "card", cardLast4: "4242",
        idempotencyKey: rid("generated_credit_cancel"),
        applications: [{ invoiceId: invoiceOneId, amount: 1 }],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sessionId = created.body.data.id;
    createdSessionIds.push(sessionId);
    cardFixtureSessionIds.push(sessionId);
    const { customerCredits, customerCreditApplications } = dbMod as any;
    const [credit] = await db.select().from(customerCredits)
      .where(eq(customerCredits.paymentSessionId, sessionId));
    expect(credit).toBeTruthy();
    await db.insert(customerCreditApplications).values({
      customerCreditId: credit.id, paymentSessionId: sessionId,
      invoiceId: invoiceTwoId, amount: "1.00",
    });
    const refundsBefore = refundCreate.mock.calls.length;
    const cancelled = await request(app).delete(`/api/billing/payment-sessions/${sessionId}`)
      .set(auth);
    expect(cancelled.status).toBe(409);
    expect(refundCreate.mock.calls.length).toBe(refundsBefore);
    expect((await db.select().from(customerCredits).where(eq(customerCredits.id, credit.id)))).toHaveLength(1);
    await db.update((dbMod as any).invoices).set({ balanceDue: "100.00", status: "open" })
      .where(eq((dbMod as any).invoices.id, invoiceOneId));
  });

  it("dates a backdated card receipt by the selected payment date, not settlement time", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, providerPaymentCustomers, providerPaymentCheckouts, payments } = dbMod as any;
    const stripeCustomerId = `cus_backdated_${labId}`;
    await db.insert(providerPaymentCustomers).values({
      providerOrganizationId: providerId, stripeCustomerId,
      cardBrand: "visa", cardLast4: "4242",
    }).onConflictDoUpdate({
      target: providerPaymentCustomers.providerOrganizationId,
      set: { stripeCustomerId, cardBrand: "visa", cardLast4: "4242" },
    });
    customersRetrieve.mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: "pm_backdated" } });
    paymentMethodsRetrieve.mockResolvedValue({
      type: "card", customer: stripeCustomerId, card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    });
    paymentIntentCreate.mockResolvedValueOnce({
      id: "pi_backdated", status: "succeeded", amount: 500,
      currency: "usd", latest_charge: "ch_backdated",
    });
    const backdated = new Date();
    backdated.setDate(backdated.getDate() - 20);
    const key = rid("backdated_card");
    const created = await request(app).post("/api/billing/payment-sessions/card")
      .set(auth).send({
        labOrganizationId: labId, providerOrganizationId: providerId, statementId,
        receivedAmount: 5, paymentMethod: "card", cardLast4: "4242",
        paymentDate: backdated.toISOString(),
        idempotencyKey: key,
        applications: [{ invoiceId: invoiceOneId, amount: 5 }],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sessionId = created.body.data.id;
    createdSessionIds.push(sessionId);
    cardFixtureSessionIds.push(sessionId);

    // Aging and the balance sheet read payments.paidAt, so it has to match the
    // session and the bank entry instead of the processor settlement instant.
    const [checkout] = await db.select().from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.clientRequestId, key));
    const paymentRows = await db.select().from(payments)
      .where(eq(payments.providerPaymentCheckoutId, checkout.id));
    expect(paymentRows).toHaveLength(1);
    expect(new Date(paymentRows[0].paidAt).toISOString()).toBe(backdated.toISOString());

    const [session] = await db.select().from((dbMod as any).statementPaymentSessions)
      .where(eq((dbMod as any).statementPaymentSessions.id, sessionId));
    expect(new Date(session.paymentDate).toISOString()).toBe(backdated.toISOString());
    const [bankTxn] = await db.select().from((dbMod as any).bankTransactions)
      .where(eq((dbMod as any).bankTransactions.id, session.bankTransactionId));
    expect(new Date(bankTxn.txnDate).toISOString()).toBe(backdated.toISOString());

    await db.update((dbMod as any).invoices).set({ balanceDue: "100.00", status: "open" })
      .where(eq((dbMod as any).invoices.id, invoiceOneId));
  });

  it("denies payment and receipt surfaces to billing-only members", async () => {
    const billingToken = await createAccessToken(billingUserId);
    const auth = { Authorization: `Bearer ${billingToken}` };
    expect((await request(app).get(`/api/billing/statements/${statementId}`).set(auth)).status).toBe(403);
    expect((await request(app)
      .post("/api/billing/payment-sessions")
      .set(auth)
      .send({
        labOrganizationId: labId, providerOrganizationId: providerId, statementId,
        receivedAmount: 1, paymentMethod: "cash",
        applications: [{ invoiceId: invoiceOneId, amount: 1 }],
      })).status).toBe(403);
    expect((await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/customer-credits`)
      .set(auth)).status).toBe(403);
  });

  it("returns only the latest successfully sent statement with its live payable balance", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const eligible = await request(app)
      .get(`/api/billing/${labId}/eligible-statement-accounts`)
      .set(auth);
    expect(eligible.status, JSON.stringify(eligible.body)).toBe(200);
    expect(eligible.body.data).toEqual([
      expect.objectContaining({
        providerOrganizationId: providerId,
        statementId,
        statementCount: 2,
        sentDates: expect.arrayContaining([expect.any(String)]),
        outstandingInvoices: expect.arrayContaining([
          expect.objectContaining({ id: invoiceOneId, currentDue: "100.00" }),
          expect.objectContaining({ id: invoiceTwoId, currentDue: "80.00" }),
        ]),
        invoiceCount: 2,
        currentBalanceDue: "180.00",
      }),
    ]);

    const stalePayment = await request(app)
      .post("/api/billing/payment-sessions")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId: olderStatementId,
        receivedAmount: 1,
        paymentMethod: "cash",
        idempotencyKey: rid("stale_statement"),
        applications: [{ invoiceId: invoiceOneId, amount: 1 }],
      });
    expect(stalePayment.status).toBe(409);

    const staleCardPayment = await request(app)
      .post("/api/billing/payment-sessions/card")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId: olderStatementId,
        receivedAmount: 1,
        existingCreditAmount: 0,
        paymentMethod: "card",
        cardLast4: "4242",
        idempotencyKey: rid("stale_card_statement"),
        applications: [{ invoiceId: invoiceOneId, amount: 1 }],
      });
    expect(staleCardPayment.status).toBe(409);

    const { db, invoices } = dbMod as any;
    await db.update(invoices).set({ status: "void" }).where(inArray(invoices.id, [invoiceOneId, invoiceTwoId]));
    const noLongerEligible = await request(app)
      .get(`/api/billing/${labId}/eligible-statement-accounts`)
      .set(auth);
    expect(noLongerEligible.status).toBe(200);
    expect(noLongerEligible.body.data).toEqual([]);
    await db.update(invoices).set({ status: "open" }).where(inArray(invoices.id, [invoiceOneId, invoiceTwoId]));
  });

  it("persists a normalized doctor scope and exposes doctor identities", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, invoices } = dbMod as any;
    await db.update(invoices).set({
      balanceDue: "100.00",
      status: "open",
      displayMetadataJson: { patientName: "Patient One", billTo: "  Dr.   One  " },
    }).where(eq(invoices.id, invoiceOneId));
    const eligible = await request(app)
      .get(`/api/billing/${labId}/eligible-statement-accounts`).set(auth);
    expect(eligible.status).toBe(200);
    expect(eligible.body.data[0].doctors).toEqual(expect.arrayContaining([
      { doctorIdentity: "dr. one", doctorDisplayName: "Dr.   One" },
      { doctorIdentity: "dr. two", doctorDisplayName: "Dr. Two" },
    ]));
    expect(eligible.body.data[0].outstandingInvoices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: invoiceOneId, doctorIdentity: "dr. one" }),
    ]));
    const created = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId, providerOrganizationId: providerId,
        statementId, doctorName: "  DR. ONE ", receivedAmount: 1,
        paymentMethod: "cash", idempotencyKey: rid("doctor_scope"),
        applications: [{ invoiceId: invoiceOneId, amount: 1 }],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    createdSessionIds.push(created.body.data.id);
    expect(created.body.data).toEqual(expect.objectContaining({
      doctorIdentity: "dr. one",
      doctorDisplayName: "DR. ONE",
    }));
    await db.update(invoices).set({ balanceDue: "100.00", status: "open" })
      .where(eq(invoices.id, invoiceOneId));
  });

  it("uses stable invoice doctor identities when display names collide", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, doctorProfiles, invoices } = dbMod as any;
    const firstProfileId = rid("doctor_profile");
    const secondProfileId = rid("doctor_profile");
    await db.insert(doctorProfiles).values([
      {
        id: firstProfileId,
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        doctorName: "Dr. Alpha",
      },
      {
        id: secondProfileId,
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        doctorName: "Dr. Beta",
      },
    ]);
    await db.update(invoices).set({
      doctorIdentity: firstProfileId,
      displayMetadataJson: { patientName: "Patient One", billTo: "Dr. Same" },
      balanceDue: "100.00",
      status: "open",
    }).where(eq(invoices.id, invoiceOneId));
    await db.update(invoices).set({
      doctorIdentity: secondProfileId,
      displayMetadataJson: { patientName: "Patient Two", billTo: "Dr. Same" },
      balanceDue: "80.00",
      status: "open",
    }).where(eq(invoices.id, invoiceTwoId));

    try {
      const eligible = await request(app)
        .get(`/api/billing/${labId}/eligible-statement-accounts`)
        .set(auth);
      expect(eligible.status).toBe(200);
      expect(eligible.body.data[0].doctors).toEqual(expect.arrayContaining([
        { doctorIdentity: firstProfileId, doctorDisplayName: "Dr. Same" },
        { doctorIdentity: secondProfileId, doctorDisplayName: "Dr. Same" },
      ]));
      expect(eligible.body.data[0].doctorProfiles).toEqual(expect.arrayContaining([
        { id: firstProfileId, doctorName: "Dr. Alpha", doctorDisplayName: "Dr. Alpha" },
        { id: secondProfileId, doctorName: "Dr. Beta", doctorDisplayName: "Dr. Beta" },
      ]));

      const invoiceEligible = await request(app)
        .get(`/api/billing/${labId}/eligible-invoice-accounts`)
        .set(auth);
      expect(invoiceEligible.status).toBe(200);
      expect(invoiceEligible.body.data[0].doctorProfiles).toEqual(expect.arrayContaining([
        { id: firstProfileId, doctorName: "Dr. Alpha", doctorDisplayName: "Dr. Alpha" },
        { id: secondProfileId, doctorName: "Dr. Beta", doctorDisplayName: "Dr. Beta" },
      ]));

      const ledger = await request(app)
        .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
        .set(auth);
      expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
      const ledgerDoctorIdentities = new Set(
        ledger.body.data.rows
          .filter((row: any) => row.type === "invoice" && row.doctorIdentity)
          .map((row: any) => row.doctorIdentity),
      );
      expect(ledgerDoctorIdentities).toEqual(new Set([firstProfileId, secondProfileId]));

      const created = await request(app).post("/api/billing/payment-sessions")
        .set(auth).send({
          labOrganizationId: labId,
          providerOrganizationId: providerId,
          statementId,
          doctorIdentity: firstProfileId,
          doctorName: "Dr. Same",
          receivedAmount: 1,
          paymentMethod: "cash",
          idempotencyKey: rid("stable_doctor_scope"),
          applications: [{ invoiceId: invoiceOneId, amount: 1 }],
        });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      createdSessionIds.push(created.body.data.id);
      expect(created.body.data.doctorIdentity).toBe(firstProfileId);

      const crossIdentity = await request(app).post("/api/billing/payment-sessions")
        .set(auth).send({
          labOrganizationId: labId,
          providerOrganizationId: providerId,
          statementId,
          doctorIdentity: firstProfileId,
          doctorName: "Dr. Same",
          receivedAmount: 1,
          paymentMethod: "cash",
          idempotencyKey: rid("stable_doctor_cross"),
          applications: [{ invoiceId: invoiceTwoId, amount: 1 }],
        });
      expect(crossIdentity.status).toBe(400);
    } finally {
      await db.update(invoices).set({
        doctorIdentity: null,
        displayMetadataJson: { patientName: "Patient One", billTo: "Dr. One" },
        balanceDue: "100.00",
        status: "open",
      }).where(eq(invoices.id, invoiceOneId));
      await db.update(invoices).set({
        doctorIdentity: null,
        displayMetadataJson: { patientName: "Patient Two", billTo: "Dr. Two" },
        balanceDue: "80.00",
        status: "open",
      }).where(eq(invoices.id, invoiceTwoId));
      await db.delete(doctorProfiles).where(
        inArray(doctorProfiles.id, [firstProfileId, secondProfileId]),
      );
    }
  });

  it("moves a repaired legacy invoice into its selected profile scope without changing the practice account", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, doctorProfiles, invoices, organizations } = dbMod as any;
    const selectedProfileId = rid("doctor_profile");
    const otherPracticeProfileId = rid("doctor_profile_other_practice");
    const otherProviderId = rid("pay_provider_other");
    const repairSettlementSessionIds: string[] = [];
    await db.insert(organizations).values({
      id: otherProviderId,
      type: "provider",
      name: "Other Repair Test Practice",
      parentLabOrganizationId: labId,
    });
    await db.insert(doctorProfiles).values([
      {
        id: selectedProfileId,
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        doctorName: "Dr. One",
      },
      {
        id: otherPracticeProfileId,
        labOrganizationId: labId,
        providerOrganizationId: otherProviderId,
        doctorName: "Dr. Other Practice",
      },
    ]);
    await db.update(invoices).set({
      doctorIdentity: null,
      displayMetadataJson: { patientName: "Patient One", billTo: "Dr. One" },
      balanceDue: "100.00",
      status: "open",
    }).where(eq(invoices.id, invoiceOneId));
    await db.update(invoices).set({
      doctorIdentity: null,
      displayMetadataJson: { patientName: "Patient Two", billTo: "Dr. Two" },
      balanceDue: "80.00",
      status: "open",
    }).where(eq(invoices.id, invoiceTwoId));

    try {
      const beforeRepair = await request(app)
        .get(`/api/billing/${labId}/eligible-statement-accounts`)
        .set(auth);
      expect(beforeRepair.status, JSON.stringify(beforeRepair.body)).toBe(200);
      expect(beforeRepair.body.data[0]).toEqual(expect.objectContaining({
        providerOrganizationId: providerId,
        currentBalanceDue: "180.00",
        outstandingInvoices: expect.arrayContaining([
          expect.objectContaining({
            id: invoiceOneId,
            doctorIdentity: "dr. one",
            doctorProfileId: null,
          }),
          expect.objectContaining({
            id: invoiceTwoId,
            doctorIdentity: "dr. two",
            doctorProfileId: null,
          }),
        ]),
      }));
      const ledgerBeforeRepair = await request(app)
        .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
        .set(auth);
      expect(ledgerBeforeRepair.status, JSON.stringify(ledgerBeforeRepair.body)).toBe(200);

      const rejected = await request(app)
        .patch(`/api/invoices/${invoiceOneId}/repair-doctor`)
        .set(auth)
        .send({ doctorProfileId: otherPracticeProfileId });
      expect(rejected.status).toBe(400);
      expect((await db.select().from(invoices)
        .where(eq(invoices.id, invoiceOneId)))[0].doctorIdentity).toBeNull();

      const repaired = await request(app)
        .patch(`/api/invoices/${invoiceOneId}/repair-doctor`)
        .set(auth)
        .send({ doctorProfileId: selectedProfileId });
      expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
      expect(repaired.body.data.doctorIdentity).toBe(selectedProfileId);

      const afterRepair = await request(app)
        .get(`/api/billing/${labId}/eligible-statement-accounts`)
        .set(auth);
      expect(afterRepair.status, JSON.stringify(afterRepair.body)).toBe(200);
      expect(afterRepair.body.data[0]).toEqual(expect.objectContaining({
        providerOrganizationId: providerId,
        currentBalanceDue: "180.00",
        doctors: expect.arrayContaining([
          { doctorIdentity: selectedProfileId, doctorDisplayName: "Dr. One" },
          { doctorIdentity: "dr. two", doctorDisplayName: "Dr. Two" },
        ]),
        outstandingInvoices: expect.arrayContaining([
          expect.objectContaining({
            id: invoiceOneId,
            doctorIdentity: selectedProfileId,
            doctorProfileId: selectedProfileId,
          }),
          expect.objectContaining({
            id: invoiceTwoId,
            doctorIdentity: "dr. two",
            doctorProfileId: null,
          }),
        ]),
      }));

      const ledger = await request(app)
        .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
        .set(auth);
      expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
      const invoiceHistory = ledger.body.data.rows.filter(
        (row: any) => row.type === "invoice" &&
          [invoiceOneNumber, invoiceTwoNumber].includes(row.invoiceNumber),
      );
      expect(invoiceHistory).toEqual(expect.arrayContaining([
        expect.objectContaining({
          invoiceNumber: invoiceOneNumber,
          doctorIdentity: selectedProfileId,
          doctorName: "Dr. One",
        }),
        expect.objectContaining({
          invoiceNumber: invoiceTwoNumber,
          doctorIdentity: null,
          doctorName: "Dr. Two",
        }),
      ]));
      expect(ledger.body.data.endingBalance).toBe(
        ledgerBeforeRepair.body.data.endingBalance,
      );

      const payment = await request(app)
        .post("/api/billing/payment-sessions")
        .set(auth)
        .send({
          labOrganizationId: labId,
          providerOrganizationId: providerId,
          statementId,
          doctorIdentity: selectedProfileId,
          doctorName: "Dr. One",
          receivedAmount: 2,
          paymentMethod: "cash",
          idempotencyKey: rid("repaired_doctor_payment"),
          applications: [{ invoiceId: invoiceOneId, amount: 1 }],
        });
      expect(payment.status, JSON.stringify(payment.body)).toBe(201);
      repairSettlementSessionIds.push(payment.body.data.id);

      const creditApplication = await request(app)
        .post("/api/billing/payment-sessions")
        .set(auth)
        .send({
          labOrganizationId: labId,
          providerOrganizationId: providerId,
          statementId,
          doctorIdentity: selectedProfileId,
          doctorName: "Dr. One",
          receivedAmount: 0,
          existingCreditAmount: 1,
          paymentMethod: "cash",
          idempotencyKey: rid("repaired_doctor_credit"),
          applications: [{
            invoiceId: invoiceOneId,
            amount: 0,
            creditAmount: 1,
          }],
        });
      expect(creditApplication.status, JSON.stringify(creditApplication.body)).toBe(201);
      repairSettlementSessionIds.push(creditApplication.body.data.id);

      const ledgerAfterSettlements = await request(app)
        .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
        .set(auth);
      expect(
        ledgerAfterSettlements.status,
        JSON.stringify(ledgerAfterSettlements.body),
      ).toBe(200);
      const settlementHistory = ledgerAfterSettlements.body.data.rows;
      expect(settlementHistory.find((row: any) =>
        row.type === "payment" &&
        row.paymentSessionId === payment.body.data.id,
      )).toEqual(expect.objectContaining({
        invoiceNumber: invoiceOneNumber,
        doctorIdentity: selectedProfileId,
        doctorName: "Dr. One",
      }));
      expect(settlementHistory.find((row: any) =>
        row.type === "credit_application" &&
        row.paymentSessionId === creditApplication.body.data.id,
      )).toEqual(expect.objectContaining({
        invoiceNumber: invoiceOneNumber,
        doctorIdentity: selectedProfileId,
        doctorName: "Dr. One",
      }));
      expect(settlementHistory.find((row: any) =>
        row.type === "invoice" && row.invoiceNumber === invoiceTwoNumber,
      )).toEqual(expect.objectContaining({
        doctorIdentity: null,
        doctorName: "Dr. Two",
      }));
    } finally {
      await cleanupPaymentFixtures(
        { paymentSessionIds: repairSettlementSessionIds },
        db,
      );
      await db.update(invoices).set({
        doctorIdentity: null,
        displayMetadataJson: { patientName: "Patient One", billTo: "Dr. One" },
        balanceDue: "100.00",
        status: "open",
      }).where(eq(invoices.id, invoiceOneId));
      await db.update(invoices).set({
        doctorIdentity: null,
        displayMetadataJson: { patientName: "Patient Two", billTo: "Dr. Two" },
        balanceDue: "80.00",
        status: "open",
      }).where(eq(invoices.id, invoiceTwoId));
      await db.delete(doctorProfiles).where(inArray(
        doctorProfiles.id,
        [selectedProfileId, otherPracticeProfileId],
      ));
      await db.delete(organizations).where(eq(organizations.id, otherProviderId));
    }
  });

  it("rejects a doctor-scoped application for another doctor", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const response = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId, providerOrganizationId: providerId,
        statementId, doctorName: "Dr. One", receivedAmount: 1,
        paymentMethod: "cash", idempotencyKey: rid("doctor_cross"),
        applications: [{ invoiceId: invoiceTwoId, amount: 1 }],
      });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/selected doctor/i);
  });

  it("keeps whole-practice payments compatible with mixed doctors", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, invoices } = dbMod as any;
    await db.update(invoices).set({ balanceDue: "100.00", status: "open" })
      .where(eq(invoices.id, invoiceOneId));
    await db.update(invoices).set({ balanceDue: "80.00", status: "open" })
      .where(eq(invoices.id, invoiceTwoId));
    const response = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId, providerOrganizationId: providerId,
        statementId, receivedAmount: 2, paymentMethod: "cash",
        idempotencyKey: rid("whole_practice_mixed"),
        applications: [
          { invoiceId: invoiceOneId, amount: 1 },
          { invoiceId: invoiceTwoId, amount: 1 },
        ],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    createdSessionIds.push(response.body.data.id);
    expect(response.body.data.doctorIdentity).toBeNull();
    expect(response.body.data.doctorDisplayName).toBeNull();
    await db.update(invoices).set({ balanceDue: "100.00", status: "open" })
      .where(eq(invoices.id, invoiceOneId));
    await db.update(invoices).set({ balanceDue: "80.00", status: "open" })
      .where(eq(invoices.id, invoiceTwoId));
  });

  it("keeps null-attribution sessions as whole-practice in Undeposited Funds", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const response = await request(app)
      .get(`/api/finance/undeposited-funds?organizationId=${labId}`)
      .set(auth);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const rows = response.body.data as Array<{ paymentSession?: {
      doctorIdentity: string | null;
      doctorDisplayName: string | null;
    } | null }>;
    const historical = rows.find((row) => row.paymentSession?.doctorIdentity === null);
    expect(historical?.paymentSession).toEqual(expect.objectContaining({
      doctorIdentity: null,
      doctorDisplayName: null,
    }));
  });

  it("preflights inline-card drafts before creating a Stripe intent", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, providerPaymentAllocations, providerPaymentCheckouts } = dbMod as any;
    const before = paymentIntentCreate.mock.calls.length;
    const stale = await request(app)
      .post("/api/billing/payment-sessions/card/prepare")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId: olderStatementId,
        receivedAmount: 1,
        paymentMethod: "card",
        idempotencyKey: rid("inline_stale"),
        applications: [{ invoiceId: invoiceOneId, amount: 1 }],
      });
    expect(stale.status).toBe(409);
    expect(paymentIntentCreate).toHaveBeenCalledTimes(before);

    const rawCard = await request(app)
      .post("/api/billing/payment-sessions/card/prepare")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId,
        receivedAmount: 1,
        paymentMethod: "card",
        cardNumber: "4242424242424242",
        idempotencyKey: rid("inline_raw_card"),
        applications: [{ invoiceId: invoiceOneId, amount: 1 }],
      });
    expect(rawCard.status).toBe(400);
    expect(paymentIntentCreate).toHaveBeenCalledTimes(before);

    const mixedCredit = await request(app)
      .post("/api/billing/payment-sessions/card/prepare")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId,
        receivedAmount: 1,
        existingCreditAmount: 1,
        paymentMethod: "card",
        idempotencyKey: rid("inline_mixed_credit"),
        applications: [{ invoiceId: invoiceOneId, amount: 1, creditAmount: 1 }],
      });
    expect(mixedCredit.status).toBe(400);
    expect(JSON.stringify(mixedCredit.body)).toMatch(/credit separately/i);
    expect(paymentIntentCreate).toHaveBeenCalledTimes(before);

    const zeroOnlyKey = rid("inline_zero_only");
    const zeroOnly = await request(app)
      .post("/api/billing/payment-sessions/card/prepare")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId,
        receivedAmount: 1,
        paymentMethod: "card",
        idempotencyKey: zeroOnlyKey,
        applications: [{ invoiceId: invoiceOneId, amount: 0 }],
      });
    expect(zeroOnly.status).toBe(400);
    expect(paymentIntentCreate).toHaveBeenCalledTimes(before);
    expect(await db.select({ id: providerPaymentCheckouts.id })
      .from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.clientRequestId, zeroOnlyKey))).toEqual([]);

    const draftKey = rid("inline_bound_draft");
    paymentIntentCreate.mockResolvedValueOnce({
      id: rid("pi_inline_bound"),
      client_secret: "pi_inline_bound_secret",
      status: "requires_payment_method",
    });
    const firstDraft = await request(app)
      .post("/api/billing/payment-sessions/card/prepare")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId,
        receivedAmount: 1,
        paymentMethod: "card",
        idempotencyKey: draftKey,
        applications: [{ invoiceId: invoiceOneId, amount: 1 }],
      });
    expect(firstDraft.status, JSON.stringify(firstDraft.body)).toBe(201);
    expect(paymentIntentCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ payment_method_types: ["card"] }),
      expect.any(Object),
    );
    const processorCallsAfterFirstDraft = paymentIntentCreate.mock.calls.length;
    const editedDraft = await request(app)
      .post("/api/billing/payment-sessions/card/prepare")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId,
        receivedAmount: 2,
        paymentMethod: "card",
        idempotencyKey: draftKey,
        applications: [{ invoiceId: invoiceOneId, amount: 2 }],
      });
    expect(editedDraft.status).toBe(409);
    expect(paymentIntentCreate).toHaveBeenCalledTimes(processorCallsAfterFirstDraft);
    await cleanupPaymentFixtures(
      { checkoutIds: [firstDraft.body.data.checkoutId] },
      db,
    );

    const doctorScopedDraftKey = rid("inline_doctor_fingerprint");
    paymentIntentCreate.mockResolvedValueOnce({
      id: rid("pi_inline_doctor_fingerprint"),
      client_secret: "pi_inline_doctor_fingerprint_secret",
      status: "requires_payment_method",
    });
    const unscopedDraft = await request(app)
      .post("/api/billing/payment-sessions/card/prepare")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId,
        receivedAmount: 1,
        paymentMethod: "card",
        idempotencyKey: doctorScopedDraftKey,
        applications: [{ invoiceId: invoiceOneId, amount: 1 }],
      });
    expect(unscopedDraft.status).toBe(201);
    const processorCallsAfterDoctorBaseline = paymentIntentCreate.mock.calls.length;
    const doctorEditedDraft = await request(app)
      .post("/api/billing/payment-sessions/card/prepare")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId,
        doctorName: "Dr. One",
        receivedAmount: 1,
        paymentMethod: "card",
        idempotencyKey: doctorScopedDraftKey,
        applications: [{ invoiceId: invoiceOneId, amount: 1 }],
      });
    expect(doctorEditedDraft.status).toBe(409);
    await cleanupPaymentFixtures(
      { checkoutIds: [unscopedDraft.body.data.checkoutId] },
      db,
    );

    for (const endpoint of [
      "/api/billing/payment-sessions/card",
      "/api/billing/payment-sessions/card/confirm",
    ]) {
      const response = await request(app)
        .post(endpoint)
        .set(auth)
        .send({
          labOrganizationId: labId,
          providerOrganizationId: providerId,
          statementId,
          receivedAmount: 1,
          paymentMethod: "card",
          cardLast4: "4242",
          cardNumber: "4242424242424242",
          cvc: "123",
          expiry: "12/30",
          paymentIntentId: endpoint.endsWith("/confirm") ? "pi_inline" : undefined,
          idempotencyKey: rid("inline_raw_card_all_routes"),
          applications: [{ invoiceId: invoiceOneId, amount: 1 }],
        });
      expect(response.status).toBe(400);
    }
    expect(paymentIntentCreate).toHaveBeenCalledTimes(processorCallsAfterDoctorBaseline);
  });

  it("reconciles expired inline reservations without releasing uncertain outcomes", async () => {
    const { db, invoices, providerPaymentAllocations, providerPaymentCheckouts } = dbMod as any;
    const { reconcileExpiredInlineCardReservations } = await import("./payment-sessions.js");

    const createExpiredCheckout = async (paymentIntentId: string | null) => {
      const invoiceId = rid("inline_reconcile_invoice");
      const checkoutId = rid("inline_reconcile_checkout");
      cardFixtureInvoiceIds.push(invoiceId);
      await db.insert(invoices).values({
        id: invoiceId,
        invoiceNumber: rid("INV"),
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        status: "open",
        total: "25.00",
        balanceDue: "25.00",
        createdByUserId: userId,
      });
      await db.insert(providerPaymentCheckouts).values({
        id: checkoutId,
        providerOrganizationId: providerId,
        initiatedByUserId: userId,
        clientRequestId: rid("inline_reconcile_key"),
        stripePaymentIntentId: paymentIntentId,
        totalAmount: "1.00",
        status: "pending",
        inlineDraftJson: { paymentMethod: "card" },
        expiresAt: new Date(Date.now() - 60_000),
      });
      await db.insert(providerPaymentAllocations).values({
        checkoutId,
        invoiceId,
        amount: "1.00",
      });
      return checkoutId;
    };

    paymentIntentRetrieve.mockReset();
    paymentIntentCancel.mockReset();
    paymentIntentRetrieve.mockResolvedValue({ id: "pi_cancelled", status: "canceled" });
    const cancelledId = await createExpiredCheckout("pi_cancelled");
    const cancelled = await reconcileExpiredInlineCardReservations();
    expect(cancelled).toMatchObject({ found: 1, released: 1, deferred: 0 });
    expect((await db.select().from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.id, cancelledId)))[0].status).toBe("expired");
    expect(paymentIntentCancel).not.toHaveBeenCalled();

    paymentIntentRetrieve.mockResolvedValue({ id: "pi_processing", status: "processing" });
    paymentIntentCancel.mockRejectedValue(new Error("Stripe is still processing"));
    const processingId = await createExpiredCheckout("pi_processing");
    const deferred = await reconcileExpiredInlineCardReservations();
    expect(deferred).toMatchObject({ found: 1, released: 0, deferred: 1 });
    expect((await db.select().from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.id, processingId)))[0].status).toBe("pending");

    paymentIntentRetrieve.mockResolvedValue({ id: "pi_processing", status: "canceled" });
    const retried = await reconcileExpiredInlineCardReservations();
    expect(retried).toMatchObject({ found: 1, released: 1 });
    expect((await db.select().from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.id, processingId)))[0].status).toBe("expired");

    const noIntentId = await createExpiredCheckout(null);
    const noIntent = await reconcileExpiredInlineCardReservations();
    expect(noIntent).toMatchObject({ found: 1, released: 0, deferred: 1 });
    expect((await db.select().from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.id, noIntentId)))[0].status).toBe("pending");
    expect(paymentIntentRetrieve).toHaveBeenCalledTimes(3);
  });

  it("settles a late successful inline intent once during reconciliation", async () => {
    const { db, invoices, payments, providerPaymentAllocations, providerPaymentCheckouts,
      statementPaymentSessions } = dbMod as any;
    const { reconcileExpiredInlineCardReservations } = await import("./payment-sessions.js");
    const invoiceId = rid("inline_success_invoice");
    cardFixtureInvoiceIds.push(invoiceId);
    await db.insert(invoices).values({
      id: invoiceId,
      invoiceNumber: rid("INV"),
      labOrganizationId: labId,
      providerOrganizationId: providerId,
      status: "open",
      total: "25.00",
      balanceDue: "25.00",
      createdByUserId: userId,
    });
    paymentIntentCreate.mockReset();
    paymentIntentRetrieve.mockReset();
    paymentMethodsRetrieve.mockReset();
    paymentIntentCreate.mockResolvedValue({
      id: "pi_inline_scheduler_success",
      client_secret: "pi_inline_scheduler_success_secret",
      status: "requires_payment_method",
    });
    const prepared = await request(app)
      .post("/api/billing/payment-sessions/card/prepare")
      .set({ Authorization: `Bearer ${token}` })
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        receivedAmount: 1,
        paymentMethod: "card",
        idempotencyKey: rid("inline_scheduler_success"),
        applications: [{ invoiceId, amount: 1 }],
      });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
    const checkoutId = prepared.body.data.checkoutId;
    await db.update(providerPaymentCheckouts).set({
      expiresAt: new Date(Date.now() - 60_000),
    }).where(eq(providerPaymentCheckouts.id, checkoutId));
    const metadata = paymentIntentCreate.mock.calls.at(-1)?.[0]?.metadata;
    paymentIntentRetrieve.mockResolvedValue({
      id: "pi_inline_scheduler_success",
      status: "succeeded",
      metadata,
      payment_method: "pm_inline_scheduler_success",
      latest_charge: "ch_inline_scheduler_success",
    });
    paymentMethodsRetrieve.mockResolvedValue({
      id: "pm_inline_scheduler_success",
      type: "card",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    });

    const [first, second] = await Promise.all([
      reconcileExpiredInlineCardReservations(),
      reconcileExpiredInlineCardReservations(),
    ]);
    expect(first).toMatchObject({ found: 1, succeeded: 1, released: 0 });
    expect(second).toMatchObject({ found: 1, succeeded: 1, released: 0 });
    expect((await db.select().from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.id, checkoutId)))[0].status).toBe("succeeded");
    expect((await db.select().from(payments)
      .where(eq(payments.providerPaymentCheckoutId, checkoutId)))).toHaveLength(1);
    expect((await db.select().from(statementPaymentSessions)
      .where(eq(statementPaymentSessions.providerPaymentCheckoutId, checkoutId)))).toHaveLength(1);
    expect((await db.select().from(providerPaymentAllocations)
      .where(eq(providerPaymentAllocations.checkoutId, checkoutId)))).toHaveLength(1);
    paymentIntentCreate.mockReset();
    paymentIntentRetrieve.mockReset();
    paymentIntentCancel.mockReset();
    paymentMethodsRetrieve.mockReset();
  });

  it("accepts saved-card credit allocations through the real card endpoint contract", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const idempotencyKey = rid("card_credit_contract");
    const response = await request(app)
      .post("/api/billing/payment-sessions/card")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId,
        receivedAmount: 5,
        existingCreditAmount: 5,
        paymentMethod: "card",
        cardLast4: "4242",
        idempotencyKey,
        applications: [{ invoiceId: invoiceTwoId, amount: 5, creditAmount: 5 }],
      });
    // The fixture deliberately has no available credit/shared Stripe card.
    // A 409 is the required pre-charge stale-credit rejection; other statuses
    // are processor/configuration failures after accepting the combined shape.
    expect([400, 402, 409, 503]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain("cannot combine existing credit");
    const processorCallsBeforeDuplicate = paymentIntentCreate.mock.calls.length;
    const duplicate = await request(app)
      .post("/api/billing/payment-sessions/card")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId,
        receivedAmount: 1,
        paymentMethod: "card",
        cardLast4: "4242",
        idempotencyKey: rid("duplicate_card_invoice"),
        applications: [
          { invoiceId: invoiceOneId, amount: 1, creditAmount: 0 },
          { invoiceId: invoiceOneId, amount: 0, creditAmount: 1 },
        ],
      });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.message).toContain("only be allocated once");
    expect(paymentIntentCreate).toHaveBeenCalledTimes(
      processorCallsBeforeDuplicate,
    );
    const { db, providerPaymentCheckouts } = dbMod as any;
    const pending = await db.select({ id: providerPaymentCheckouts.id })
      .from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.clientRequestId, idempotencyKey));
    await cleanupPaymentFixtures(
      { checkoutIds: pending.map((checkout: { id: string }) => checkout.id) },
      db,
    );
  });

  it("settles a real saved-card overpayment with per-invoice credit and replays safely", async () => {
    const t = dbMod as any;
    const { db, invoices, practiceStatements, practiceStatementSends,
      providerPaymentCustomers, statementPaymentSessions, customerCredits,
      payments, bankTransactions, providerPaymentAllocations,
      providerPaymentCheckouts } = t;
    const staleCheckoutIds = (
      await db
        .select({ id: providerPaymentCheckouts.id })
        .from(providerPaymentCheckouts)
        .where(eq(providerPaymentCheckouts.providerOrganizationId, providerId))
    ).map((row: { id: string }) => row.id);
    if (staleCheckoutIds.length) {
      await db.delete(providerPaymentAllocations).where(
        inArray(providerPaymentAllocations.checkoutId, staleCheckoutIds),
      );
      await db.delete(providerPaymentCheckouts).where(
        inArray(providerPaymentCheckouts.id, staleCheckoutIds),
      );
    }
    const staleStatements = await db.select({ id: practiceStatements.id })
      .from(practiceStatements)
      .where(and(
        eq(practiceStatements.providerOrganizationId, providerId),
        gt(practiceStatements.periodEnd, new Date("2026-08-31T23:59:59Z")),
      ));
    if (staleStatements.length) {
      const staleIds = staleStatements.map((row: any) => row.id);
      await db.delete(practiceStatementSends)
        .where(inArray(practiceStatementSends.statementId, staleIds));
      await db.delete(practiceStatements).where(inArray(practiceStatements.id, staleIds));
    }
    const invA = rid("card_accept_inv");
    const invB = rid("card_accept_inv");
    const stmt = rid("card_accept_stmt");
    const sourceSession = rid("card_credit_source");
    const key = rid("card_accept_key");
    cardFixtureInvoiceIds.push(invA, invB);
    cardFixtureSessionIds.push(sourceSession);
    cardFixtureStatementIds.push(stmt);
    await db.insert(invoices).values([
      { id: invA, invoiceNumber: rid("INV"), labOrganizationId: labId, providerOrganizationId: providerId,
        status: "open", total: "30.00", balanceDue: "30.00", createdByUserId: userId },
      { id: invB, invoiceNumber: rid("INV"), labOrganizationId: labId, providerOrganizationId: providerId,
        status: "open", total: "40.00", balanceDue: "40.00", createdByUserId: userId },
    ]);
    await db.insert(practiceStatements).values({
      id: stmt, labOrganizationId: labId, providerOrganizationId: providerId,
      periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30"),
      invoiceCount: 2, totalBilled: "70.00", totalPaid: "0.00", balanceDue: "70.00",
       invoiceIdsJson: [invA, invB],
       invoiceAmountsJson: { [invA]: "35.00", [invB]: "45.00" },
       createdByUserId: userId,
    });
    await db.insert(practiceStatementSends).values({
      statementId: stmt, channel: "email", recipient: "billing@example.test",
      status: "sent", sentByUserId: userId,
    });
    const stripeCustomerId = `cus_accept_${labId}`;
    await db.insert(providerPaymentCustomers).values({
      providerOrganizationId: providerId, stripeCustomerId: stripeCustomerId,
      cardBrand: "visa", cardLast4: "4242",
    }).onConflictDoUpdate({
      target: providerPaymentCustomers.providerOrganizationId,
      set: { stripeCustomerId, cardBrand: "visa", cardLast4: "4242" },
    });
    await db.insert(statementPaymentSessions).values({
      id: sourceSession, labOrganizationId: labId, providerOrganizationId: providerId,
      statementId: stmt, requestFingerprint: rid("source_fp"), receiptNumber: rid("RCP"),
      receivedAmount: "10.00", appliedAmount: "10.00", customerCreditAmount: "0.00",
      accountBalanceAfter: "60.00", paymentMethod: "cash", labName: "Receipt Test Lab",
      paymentDate: new Date(), status: "undeposited", createdByUserId: userId,
    });
    await db.insert(customerCredits).values({
      labOrganizationId: labId, providerOrganizationId: providerId,
      paymentSessionId: sourceSession, amount: "10.00", remainingAmount: "10.00",
      createdByUserId: userId,
    });
    customersRetrieve.mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: "pm_accept" } });
    paymentMethodsRetrieve.mockResolvedValue({
      type: "card", customer: stripeCustomerId, card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    });
    paymentIntentCreate.mockResolvedValue({
      id: "pi_accept", status: "succeeded", latest_charge: "ch_accept",
    });
    const stripeAmount = 5000;
    paymentIntentCreate.mockImplementation(async (params: any) => {
      expect(params.amount).toBe(stripeAmount);
      return { id: "pi_accept", status: "succeeded", latest_charge: "ch_accept" };
    });
    const auth = { Authorization: `Bearer ${token}` };
    const payload = {
      labOrganizationId: labId, providerOrganizationId: providerId, statementId: stmt,
      receivedAmount: 50, existingCreditAmount: 10, paymentMethod: "card", cardLast4: "4242",
      idempotencyKey: key, applications: [
        { invoiceId: invA, amount: 30, creditAmount: 0 },
        { invoiceId: invB, amount: 0, creditAmount: 10 },
      ],
    };
    const created = await request(app).post("/api/billing/payment-sessions/card").set(auth).send(payload);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sessionId = created.body.data.id;
    cardFixtureSessionIds.push(sessionId);
    expect(created.body.data.customerCreditAmount).toBe("20.00");
    expect(
      created.body.data.applications.map(
        (application: any) => application.statementInvoiceAmount,
      ).sort(),
    ).toEqual(["35.00", "45.00"]);
    const [checkout] = await db.select().from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.clientRequestId, key));
    expect((await db.select().from(payments)
      .where(eq(payments.providerPaymentCheckoutId, checkout.id)))).toHaveLength(1);
    const [a, b] = await Promise.all([
      db.select().from(invoices).where(eq(invoices.id, invA)),
      db.select().from(invoices).where(eq(invoices.id, invB)),
    ]);
    expect(a[0]).toMatchObject({ balanceDue: "0.00", status: "paid" });
    expect(b[0]).toMatchObject({ balanceDue: "30.00", status: "partially_paid" });
    expect((await db.select().from(customerCredits).where(eq(customerCredits.paymentSessionId, sourceSession)))
      .length).toBeGreaterThan(0);
    expect((await db.select().from(customerCredits).where(eq(customerCredits.paymentSessionId, sessionId)))[0].remainingAmount).toBe("20.00");
    const replay = await request(app).post("/api/billing/payment-sessions/card").set(auth).send(payload);
    expect(replay.status).toBe(200);
    expect((await db.select().from(payments)
      .where(eq(payments.providerPaymentCheckoutId, checkout.id)))).toHaveLength(1);
    refundCreate.mockResolvedValueOnce({ id: "re_accept", status: "succeeded", charge: "ch_accept", amount: 5000, currency: "usd" });
    const cancelled = await request(app).delete(`/api/billing/payment-sessions/${sessionId}`).set(auth);
    expect(cancelled.status).toBe(200);
    expect(refundCreate).toHaveBeenCalled();
    expect((await db.select().from(customerCredits).where(
      eq(customerCredits.paymentSessionId, sourceSession)))).toHaveLength(1);
    await cleanupPaymentFixtures(
      {
        invoiceIds: [invA, invB],
        paymentSessionIds: [sourceSession],
        checkoutIds: [checkout.id],
      },
      db,
    );
    await db.delete(practiceStatementSends).where(eq(practiceStatementSends.statementId, stmt));
    await db.delete(practiceStatements).where(eq(practiceStatements.id, stmt));
    await db.delete(invoices).where(inArray(invoices.id, [invA, invB]));
  });

  it("records, reproduces, emails, and exactly cancels an overpayment", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, invoices } = dbMod as any;
    await db
      .update(invoices)
      .set({
        invoiceNumber: "RENAMED-AFTER-STATEMENT",
        displayMetadataJson: {
          patientName: "Changed Patient",
          billTo: "Changed Billing Contact",
        },
      })
      .where(eq(invoices.id, invoiceTwoId));
    const context = await request(app)
      .get(`/api/billing/statements/${statementId}`)
      .set(auth);
    expect(context.status).toBe(200);
    expect(context.body.data.savedBalanceDue).toBe("80.00");
    expect(context.body.data.invoices).toHaveLength(1);
    expect(context.body.data.invoices[0]).toMatchObject({
      invoiceNumber: invoiceTwoNumber,
      patientName: "Patient Two",
      billTo: "Original Billing Contact",
      currentBalanceDue: "80.00",
      eligibleForPayment: true,
      detailProvenance: "snapshot",
    });
    expect(context.body.data).toMatchObject({
      hasInvoiceDetailSnapshots: true,
      detailProvenance: "snapshot",
    });

    const payload = {
      labOrganizationId: labId,
      providerOrganizationId: providerId,
      statementId,
      receivedAmount: 150,
      paymentMethod: "check",
      checkNumber: "1234",
      idempotencyKey: rid("idempotency"),
      applications: [
        { invoiceId: invoiceOneId, amount: 100 },
        { invoiceId: invoiceTwoId, amount: 25 },
      ],
    };
    const created = await request(app)
      .post("/api/billing/payment-sessions")
      .set(auth)
      .send(payload);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const session = created.body.data;
    createdSessionIds.push(session.id);
    expect(session.receivedAmount).toBe("150.00");
    expect(session.appliedAmount).toBe("125.00");
    expect(session.customerCreditAmount).toBe("25.00");
    expect(session.applications).toHaveLength(2);
    expect(session.applications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        invoiceNumber: invoiceOneNumber,
        patientName: "Patient One",
        statementInvoiceAmount: "175.00",
      }),
      expect.objectContaining({
        invoiceNumber: invoiceTwoNumber,
        patientName: "Patient Two",
        statementInvoiceAmount: "95.00",
      }),
    ]));

    const retry = await request(app)
      .post("/api/billing/payment-sessions")
      .set(auth)
      .send(payload);
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(session.id);
    const conflictingRetry = await request(app)
      .post("/api/billing/payment-sessions")
      .set(auth)
      .send({
        ...payload,
        paymentMethod: "cash",
        checkNumber: null,
      });
    expect(conflictingRetry.status).toBe(409);

    const { organizations } = dbMod as any;
    await (dbMod as any).db
      .update(organizations)
      .set({ name: "Renamed After Payment" })
      .where(eq(organizations.id, labId));
    await db
      .update(invoices)
      .set({
        invoiceNumber: "RENAMED-AFTER-PAYMENT",
        displayMetadataJson: {
          patientName: "Changed Again",
          billTo: "Changed Again",
        },
        providerOrganizationId: labId,
        deletedAt: new Date(),
      })
      .where(eq(invoices.id, invoiceTwoId));
    const reproduced = await request(app)
      .get(`/api/billing/payment-sessions/${session.id}`)
      .set(auth);
    expect(reproduced.body.data.labName).toBe("Receipt Test Lab");
    expect(reproduced.body.data.applications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        invoiceNumber: invoiceTwoNumber,
        patientName: "Patient Two",
      }),
    ]));
    const historicalStatement = await request(app)
      .get(`/api/billing/statements/${statementId}`)
      .set(auth);
    expect(historicalStatement.body.data.invoices).toEqual([
      expect.objectContaining({
        id: invoiceTwoId,
        invoiceNumber: invoiceTwoNumber,
        patientName: "Patient Two",
        billTo: "Original Billing Contact",
        status: "deleted",
        currentBalanceDue: "0.00",
        eligibleForPayment: false,
      }),
    ]);
    await db
      .update(invoices)
      .set({
        invoiceNumber: invoiceTwoNumber,
        displayMetadataJson: { patientName: "Patient Two" },
        providerOrganizationId: providerId,
        deletedAt: null,
      })
      .where(eq(invoices.id, invoiceTwoId));

    const { bankTransactions, customerCredits } = dbMod as any;
    const [transaction] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, session.bankTransactionId));
    expect(transaction.bankAccountId).toBe(ufAccountId);
    expect(transaction.creditAmount).toBe("150.00");
    const [credit] = await db
      .select()
      .from(customerCredits)
      .where(eq(customerCredits.paymentSessionId, session.id));
    expect(credit.remainingAmount).toBe("25.00");

    const secondCreditOrigin = await request(app)
      .post("/api/billing/payment-sessions")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId,
        receivedAmount: 5,
        paymentMethod: "cash",
        idempotencyKey: rid("second_credit_origin"),
        applications: [],
      });
    expect(secondCreditOrigin.status).toBe(201);
    createdSessionIds.push(secondCreditOrigin.body.data.id);
    const [secondCredit] = await db
      .select()
      .from(customerCredits)
      .where(eq(customerCredits.paymentSessionId, secondCreditOrigin.body.data.id));
    expect(secondCredit.remainingAmount).toBe("5.00");

    const mixedPayload = {
      labOrganizationId: labId,
      providerOrganizationId: providerId,
      statementId,
      receivedAmount: 5,
      existingCreditAmount: 30,
      paymentMethod: "cash",
      idempotencyKey: rid("mixed_credit_cash"),
      applications: [{ invoiceId: invoiceTwoId, amount: 5 }],
    };
    const mixed = await request(app)
      .post("/api/billing/payment-sessions")
      .set(auth)
      .send(mixedPayload);
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(201);
    createdSessionIds.push(mixed.body.data.id);
    expect(mixed.body.data.applications).toHaveLength(1);
    expect(mixed.body.data.applications[0]).toMatchObject({
      amount: "35.00",
      invoiceBalanceBefore: "55.00",
      invoiceBalanceAfter: "20.00",
    });
    const mixedReplay = await request(app)
      .post("/api/billing/payment-sessions")
      .set(auth)
      .send(mixedPayload);
    expect(mixedReplay.status).toBe(200);
    expect(mixedReplay.body.data.id).toBe(mixed.body.data.id);
    const mixedReversal = await request(app)
      .delete(`/api/billing/payment-sessions/${mixed.body.data.id}`)
      .set(auth);
    expect(mixedReversal.status).toBe(200);
    const [restoredCredit] = await db
      .select()
      .from(customerCredits)
      .where(eq(customerCredits.id, credit.id));
    expect(restoredCredit.remainingAmount).toBe("25.00");
    const [restoredSecondCredit] = await db
      .select()
      .from(customerCredits)
      .where(eq(customerCredits.id, secondCredit.id));
    expect(restoredSecondCredit.remainingAmount).toBe("5.00");
    const secondCreditReversal = await request(app)
      .delete(`/api/billing/payment-sessions/${secondCreditOrigin.body.data.id}`)
      .set(auth);
    expect(secondCreditReversal.status).toBe(200);

    const pdf = await request(app)
      .get(`/api/billing/payment-sessions/${session.id}/receipt.pdf`)
      .set(auth);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");

    const email = await request(app)
      .post(`/api/billing/payment-sessions/${session.id}/send-receipt`)
      .set(auth)
      .send({
        to: "billing@example.test",
        subject: "Receipt {{receiptNumber}}",
        body: "Received {{amountReceived}}; credit {{customerCredit}}",
      });
    expect(email.status).toBe(200);
    expect(email.body.data.delivered).toBe(false);
    expect(email.body.data.reason).toBe("disabled_in_test");
    expect(email.body.data.subject).toContain(session.receiptNumber);

    const cancelled = await request(app)
      .delete(`/api/billing/payment-sessions/${session.id}`)
      .set(auth);
    expect(cancelled.status).toBe(200);
    const restored = await db
      .select()
      .from(invoices)
      .where(inArray(invoices.id, [invoiceOneId, invoiceTwoId]));
    expect(restored.map((row: any) => row.balanceDue).sort()).toEqual([
      "100.00",
      "80.00",
    ]);
    const remainingCredits = await db
      .select()
      .from(customerCredits)
      .where(eq(customerCredits.paymentSessionId, session.id));
    expect(remainingCredits).toHaveLength(0);

    const ledger = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
      .set(auth);
    expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
    expect(ledger.body.data.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "invoice", invoiceNumber: expect.any(String) }),
      expect.objectContaining({ type: "statement", statementId }),
    ]));
    const invoiceRows = ledger.body.data.rows.filter((row: any) => row.type === "invoice");
    expect(invoiceRows.every((row: any) =>
      typeof row.balance === "string" && row.balance === row.openBalance,
    )).toBe(true);
    expect(Number(ledger.body.data.endingBalance)).toBeLessThanOrEqual(180);

    const futureLedger = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges?from=2999-01-01&to=2999-01-31&timeZone=America%2FNew_York`)
      .set(auth);
    expect(futureLedger.status, JSON.stringify(futureLedger.body)).toBe(200);
    expect(futureLedger.body.data.rows).toEqual([]);
    expect(futureLedger.body.data.endingBalance).toBe(ledger.body.data.endingBalance);

    const incompleteRange = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges?from=2026-01-01`)
      .set(auth);
    expect(incompleteRange.status).toBe(400);

    const invalidRange = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges?from=2026-13-01&to=2026-13-31`)
      .set(auth);
    expect(invalidRange.status).toBe(400);
  });

  it("labels legacy statement details as live and retains deleted invoice ids as unavailable", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, invoices, practiceStatements } = dbMod as any;
    await db.update(practiceStatements)
      .set({ invoiceDetailsJson: null })
      .where(eq(practiceStatements.id, olderStatementId));
    await db.update(invoices)
      .set({ deletedAt: new Date() })
      .where(eq(invoices.id, invoiceOneId));
    try {
      const response = await request(app)
        .get(`/api/billing/statements/${olderStatementId}`)
        .set(auth);
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        hasInvoiceDetailSnapshots: false,
        detailProvenance: "live",
      });
      expect(response.body.data.invoices).toContainEqual(expect.objectContaining({
        id: invoiceOneId,
        invoiceNumber: "Unavailable",
        detailProvenance: "unavailable",
        eligibleForPayment: false,
      }));
    } finally {
      await db.update(invoices).set({ deletedAt: null }).where(eq(invoices.id, invoiceOneId));
      await db.update(practiceStatements).set({
        invoiceDetailsJson: {
          [invoiceOneId]: { invoiceNumber: invoiceOneNumber, patientName: "Patient One", billTo: null },
        },
      }).where(eq(practiceStatements.id, olderStatementId));
    }
  });

  it("reports mixed provenance when a non-null snapshot only partially covers invoice ids", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, practiceStatements } = dbMod as any;
    const [originalStatement] = await db.select().from(practiceStatements).where(eq(practiceStatements.id, statementId));
    await db.update(practiceStatements).set({
      invoiceIdsJson: [invoiceTwoId, "missing-legacy-invoice"],
      invoiceDetailsJson: {
        [invoiceTwoId]: { invoiceNumber: invoiceTwoNumber, patientName: "Patient Two", billTo: "Original Billing Contact" },
        "missing-legacy-invoice": { malformed: true },
        "extraneous-invoice": { invoiceNumber: "EXTRA", patientName: null, billTo: null },
      },
    }).where(eq(practiceStatements.id, statementId));
    try {
      const response = await request(app)
        .get(`/api/billing/statements/${statementId}`)
        .set(auth);
      expect(response.status).toBe(200);
      expect(response.body.data.detailProvenance).toBe("mixed");
      expect(response.body.data.hasInvoiceDetailSnapshots).toBe(false);
      expect(response.body.data.invoices.find((invoice: any) => invoice.id === invoiceTwoId).detailProvenance).toBe("snapshot");
      expect(response.body.data.invoices.find((invoice: any) => invoice.id === "missing-legacy-invoice").detailProvenance).toBe("unavailable");
    } finally {
      await db.update(practiceStatements).set({
        invoiceIdsJson: originalStatement.invoiceIdsJson,
        invoiceDetailsJson: originalStatement.invoiceDetailsJson,
      }).where(eq(practiceStatements.id, statementId));
    }
  });

  it("leaves no active deposit membership when creation races session cancellation", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const created = await request(app)
      .post("/api/billing/payment-sessions")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId,
        receivedAmount: 20,
        paymentMethod: "cash",
        idempotencyKey: rid("idempotency"),
        applications: [{ invoiceId: invoiceTwoId, amount: 20 }],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    createdSessionIds.push(created.body.data.id);

    const [deposited, cancelled] = await Promise.all([
      request(app).post("/api/finance/make-deposits").set(auth).send({
        organizationId: labId,
        bankAccountId: checkingAccountId,
        transactionIds: [created.body.data.bankTransactionId],
      }),
      request(app)
        .delete(`/api/billing/payment-sessions/${created.body.data.id}`)
        .set(auth),
    ]);
    expect([200, 400]).toContain(deposited.status);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const { db, bankDepositBatchMembers, bankTransactions } = dbMod as any;
    const activeMemberships = await db.select().from(bankDepositBatchMembers)
      .where(and(
        eq(
          bankDepositBatchMembers.childBankTransactionId,
          created.body.data.bankTransactionId,
        ),
        isNull(bankDepositBatchMembers.releasedAt),
      ));
    expect(activeMemberships).toHaveLength(0);
    if (deposited.status === 200) {
      const [aggregate] = await db.select().from(bankTransactions)
        .where(eq(bankTransactions.id, deposited.body.data.aggregateTransactionId));
      expect(aggregate.status).toBe("void");
    }
  });

  it("creates distinct receipt identities for concurrent payments", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const sharedKey = rid("parallel_same");
    const create = (key: string, invoiceId = invoiceTwoId) =>
      request(app)
        .post("/api/billing/payment-sessions")
        .set(auth)
        .send({
          labOrganizationId: labId,
          providerOrganizationId: providerId,
          statementId,
          receivedAmount: 5,
          paymentMethod: "cash",
          idempotencyKey: key,
          applications: [{ invoiceId, amount: 5 }],
        });
    const [first, second] = await Promise.all([
      create(sharedKey),
      create(sharedKey),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(first.body.data.id).toBe(second.body.data.id);
    expect(first.body.data.applications[0]).toMatchObject({
      amount: "5.00",
    });
    expect(
      Number(first.body.data.applications[0].invoiceBalanceBefore) -
        Number(first.body.data.applications[0].invoiceBalanceAfter),
    ).toBe(5);
    createdSessionIds.push(first.body.data.id);

    const { db, invoices } = dbMod as any;
    const beforeRows = await db
      .select()
      .from(invoices)
      .where(inArray(invoices.id, [invoiceOneId, invoiceTwoId]));
    const before = beforeRows.reduce(
      (sum: number, invoice: any) => sum + Number(invoice.balanceDue),
      0,
    );
    const [differentOne, differentTwo] = await Promise.all([
      create(rid("parallel_distinct"), invoiceOneId),
      create(rid("parallel_distinct"), invoiceTwoId),
    ]);
    expect([differentOne.status, differentTwo.status]).toEqual([201, 201]);
    createdSessionIds.push(differentOne.body.data.id, differentTwo.body.data.id);
    expect(
      [
        Number(differentOne.body.data.accountBalanceAfter),
        Number(differentTwo.body.data.accountBalanceAfter),
      ].sort((a, b) => a - b),
    ).toEqual([before - 10, before - 5]);
  });

  it("fails closed when an invoice changes before cancellation", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const created = await request(app)
      .post("/api/billing/payment-sessions")
      .set(auth)
      .send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId,
        receivedAmount: 5,
        paymentMethod: "cash",
        idempotencyKey: rid("changed_invoice"),
        applications: [{ invoiceId: invoiceOneId, amount: 5 }],
      });
    expect(created.status).toBe(201);
    createdSessionIds.push(created.body.data.id);
    const { db, invoices } = dbMod as any;
    const [paidInvoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceOneId));
    await db
      .update(invoices)
      .set({ status: "void", balanceDue: "0.00" })
      .where(eq(invoices.id, invoiceOneId));
    const cancelled = await request(app)
      .delete(`/api/billing/payment-sessions/${created.body.data.id}`)
      .set(auth);
    expect(cancelled.status).toBe(409);
    await db
      .update(invoices)
      .set({ status: paidInvoice.status, balanceDue: paidInvoice.balanceDue })
      .where(eq(invoices.id, invoiceOneId));
  });

  it("reverses saved cards exactly once and recovers pending processor and local failures", async () => {
    const {
      bankDepositBatchMembers, bankTransactions, db, invoices, providerPaymentCheckouts,
      statementPaymentApplications, statementPaymentReversals, statementPaymentSessions,
    } = dbMod as any;
    const makeCardSession = async (options?: { label?: string; overpayment?: number }) => {
      const label = options?.label ?? "card_reversal";
      const overpayment = options?.overpayment ?? 0;
      const receivedAmount = 5 + overpayment;
      const invoiceId = rid("card_reversal_invoice");
      const checkoutId = rid(`${label}_checkout`);
      const sessionId = rid("card_reversal_session");
      reversalInvoiceIds.push(invoiceId);
      createdSessionIds.push(sessionId);
      await db.insert(invoices).values({
        id: invoiceId, invoiceNumber: rid("INV"), labOrganizationId: labId,
        providerOrganizationId: providerId, status: "partially_paid",
        total: "10.00", balanceDue: "5.00", createdByUserId: userId,
      });
      await db.insert(providerPaymentCheckouts).values({
        id: checkoutId, providerOrganizationId: providerId, initiatedByUserId: userId,
        totalAmount: receivedAmount.toFixed(2), status: "succeeded",
        stripePaymentIntentId: `pi_${checkoutId}`, stripeChargeId: `ch_${checkoutId}`,
      });
      await db.insert((dbMod as any).payments).values({
        invoiceId, amount: "5.00", paymentMethod: "card",
        referenceNumber: `pi_${checkoutId}`, stripePaymentIntentId: `pi_${checkoutId}`,
        providerPaymentCheckoutId: checkoutId, recordedByUserId: userId,
      });
      const [bank] = await db.insert(bankTransactions).values({
        labOrganizationId: labId, bankAccountId: ufAccountId, txnDate: new Date(),
        type: "deposit", payee: "Card practice", debitAmount: "0.00",
        creditAmount: receivedAmount.toFixed(2), netAmount: receivedAmount.toFixed(2),
        cleared: false, status: "posted",
        source: "customer_payment", createdByUserId: userId,
      }).returning();
      await db.insert(statementPaymentSessions).values({
        id: sessionId, labOrganizationId: labId, providerOrganizationId: providerId,
        statementId, bankTransactionId: bank.id, providerPaymentCheckoutId: checkoutId,
        requestFingerprint: rid("fingerprint"), receiptNumber: rid("RCP"),
        receivedAmount: receivedAmount.toFixed(2), appliedAmount: "5.00",
        customerCreditAmount: overpayment.toFixed(2),
        accountBalanceAfter: "5.00", paymentMethod: "card", cardLast4: "4242",
        paymentDate: new Date(), labName: "Receipt Test Lab", status: "undeposited",
        createdByUserId: userId,
      });
      await db.insert(statementPaymentApplications).values({
        paymentSessionId: sessionId, invoiceId, invoiceNumber: rid("INV"),
        invoiceTotal: "10.00", amount: "5.00", invoiceBalanceBefore: "10.00",
        invoiceBalanceAfter: "5.00",
      });
      let creditId: string | null = null;
      if (overpayment > 0) {
        const [credit] = await db.insert((dbMod as any).customerCredits).values({
          labOrganizationId: labId, providerOrganizationId: providerId,
          paymentSessionId: sessionId, amount: overpayment.toFixed(2),
          remainingAmount: overpayment.toFixed(2), createdByUserId: userId,
        }).returning();
        creditId = credit.id;
      }
      return {
        invoiceId,
        sessionId,
        checkoutId,
        creditId,
        bankTransactionId: bank.id,
      };
    };
    const auth = { Authorization: `Bearer ${token}` };

    const reconciled = await makeCardSession({ label: "reconciled_batch" });
    const deposited = await request(app).post("/api/finance/make-deposits")
      .set(auth)
      .send({
        organizationId: labId,
        bankAccountId: checkingAccountId,
        transactionIds: [reconciled.bankTransactionId],
      });
    expect(deposited.status, JSON.stringify(deposited.body)).toBe(200);
    await db.update(bankTransactions).set({ reconciled: true })
      .where(eq(bankTransactions.id, deposited.body.data.aggregateTransactionId));
    const refundCallsBeforeReconciled = refundCreate.mock.calls.length;
    const rejectedReconciled = await request(app)
      .delete(`/api/billing/payment-sessions/${reconciled.sessionId}`)
      .set(auth);
    expect(rejectedReconciled.status).toBe(409);
    expect(refundCreate).toHaveBeenCalledTimes(refundCallsBeforeReconciled);
    expect((await db.select().from(statementPaymentReversals)
      .where(eq(statementPaymentReversals.paymentSessionId, reconciled.sessionId)))).toHaveLength(0);
    expect((await db.select().from(statementPaymentSessions)
      .where(eq(statementPaymentSessions.id, reconciled.sessionId)))[0].status).toBe("deposited");

    const raced = await makeCardSession({ label: "deposit_race" });
    refundCreate.mockResolvedValueOnce({
      id: "re_deposit_race", status: "succeeded", charge: `ch_${raced.checkoutId}`,
      amount: 500, currency: "usd",
    });
    let releaseFence!: () => void;
    let markFenceHeld!: () => void;
    const fenceHeld = new Promise<void>((resolve) => { markFenceHeld = resolve; });
    const releaseFencePromise = new Promise<void>((resolve) => { releaseFence = resolve; });
    const blocker = db.transaction(async (tx: any) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(
          hashtext('labtrax:deposit-batch-mutations'),
          hashtext(${labId})
        )`,
      );
      markFenceHeld();
      await releaseFencePromise;
    });
    await fenceHeld;
    const racedDeposit = request(app).post("/api/finance/make-deposits")
      .set(auth)
      .send({
        organizationId: labId,
        bankAccountId: checkingAccountId,
        transactionIds: [raced.bankTransactionId],
      })
      .then((response) => response);
    const racedCancellation = request(app)
      .delete(`/api/billing/payment-sessions/${raced.sessionId}`)
      .set(auth)
      .then((response) => response);
    const { pool } = dbMod as any;
    const waiterDeadline = Date.now() + 5_000;
    let waiterCount = 0;
    while (Date.now() < waiterDeadline) {
      const result = await pool.query(
        `SELECT count(*)::int AS count
           FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = hashtext($1)::oid
            AND objid = hashtext($2)::oid
            AND NOT granted`,
        ["labtrax:deposit-batch-mutations", labId],
      );
      waiterCount = Number(result.rows[0]?.count ?? 0);
      if (waiterCount >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiterCount).toBeGreaterThanOrEqual(2);
    releaseFence();
    await blocker;
    const [racedDepositResult, racedCancellationResult] = await Promise.all([
      racedDeposit,
      racedCancellation,
    ]);
    expect([200, 400]).toContain(racedDepositResult.status);
    expect(
      racedCancellationResult.status,
      JSON.stringify(racedCancellationResult.body),
    ).toBe(200);
    expect(await db.select().from(bankDepositBatchMembers).where(and(
      eq(bankDepositBatchMembers.childBankTransactionId, raced.bankTransactionId),
      isNull(bankDepositBatchMembers.releasedAt),
    ))).toHaveLength(0);

    const success = await makeCardSession();
    refundCreate.mockResolvedValueOnce({
      id: "re_success", status: "succeeded", charge: `ch_${success.checkoutId}`,
      amount: 500, currency: "usd",
    });
    expect((await request(app).post(`/api/billing/payment-sessions/${success.sessionId}/reversal`).set(auth)).status).toBe(200);
    expect(refundCreate).toHaveBeenLastCalledWith(
      { charge: expect.stringContaining("ch_card_reversal_checkout"), amount: 500,
        metadata: expect.objectContaining({ statementPaymentReversalId: expect.any(String) }) },
      { idempotencyKey: `statement-card-reversal-${success.sessionId}` },
    );
    expect((await db.select().from(statementPaymentReversals).where(eq(statementPaymentReversals.paymentSessionId, success.sessionId)))[0].status).toBe("completed");
    expect((await db.select().from(invoices).where(eq(invoices.id, success.invoiceId)))[0]).toMatchObject({
      balanceDue: "10.00", status: "open",
    });
    expect((await db.select().from(statementPaymentSessions).where(eq(statementPaymentSessions.id, success.sessionId)))[0].status).toBe("cancelled");
    expect(await db.select().from((dbMod as any).payments).where(
      eq((dbMod as any).payments.providerPaymentCheckoutId, success.checkoutId),
    )).toHaveLength(0);
    const successSession = (await db.select().from(statementPaymentSessions)
      .where(eq(statementPaymentSessions.id, success.sessionId)))[0];
    expect((await db.select().from(bankTransactions)
      .where(eq(bankTransactions.id, successSession.bankTransactionId)))[0]).toMatchObject({
      status: "void",
    });
    const completedRefundCalls = refundCreate.mock.calls.length;
    expect((await request(app).post(`/api/billing/payment-sessions/${success.sessionId}/reversal`).set(auth)).body.data.reversal.status).toBe("completed");
    expect((await request(app).delete(`/api/billing/payment-sessions/${success.sessionId}`).set(auth)).body.data.reversal.status).toBe("completed");
    expect(refundCreate).toHaveBeenCalledTimes(completedRefundCalls);

    const crashGap = await makeCardSession({ label: "crash_gap", overpayment: 2 });
    await db.insert(statementPaymentReversals).values({
      paymentSessionId: crashGap.sessionId,
      processorIdempotencyKey: `statement-card-reversal-${crashGap.sessionId}`,
      stripePaymentIntentId: `pi_${crashGap.checkoutId}`,
      stripeChargeId: `ch_${crashGap.checkoutId}`,
      stripeRefundId: "re_crash_gap",
      amount: "7.00", currency: "usd", status: "processor_succeeded",
      initiatedByUserId: userId,
    });
    const reservedCredits = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/customer-credits`)
      .set(auth);
    expect(reservedCredits.body.data.totalAvailable).toBe("0.00");
    const consumeReserved = await request(app)
      .post("/api/billing/payment-sessions")
      .set(auth)
      .send({
        labOrganizationId: labId, providerOrganizationId: providerId, statementId,
        receivedAmount: 0, existingCreditAmount: 2, paymentMethod: "check",
        applications: [{ invoiceId: invoiceTwoId, amount: 0, creditAmount: 2 }],
      });
    expect(consumeReserved.status).toBe(400);
    const refundCallsBeforeCrashRetry = refundCreate.mock.calls.length;
    const crashRetry = await request(app)
      .post(`/api/billing/payment-sessions/${crashGap.sessionId}/reversal`)
      .set(auth);
    expect(crashRetry.status).toBe(200);
    expect(crashRetry.body.data.reversal.status).toBe("completed");
    expect(refundCreate).toHaveBeenCalledTimes(refundCallsBeforeCrashRetry);
    expect(await db.select().from((dbMod as any).customerCredits)
      .where(eq((dbMod as any).customerCredits.id, crashGap.creditId))).toHaveLength(0);

    const pending = await makeCardSession();
    refundCreate.mockResolvedValueOnce({
      id: "re_pending", status: "pending", charge: `ch_${pending.checkoutId}`,
      amount: 500, currency: "usd",
    });
    const pendingResponse = await request(app).post(`/api/billing/payment-sessions/${pending.sessionId}/reversal`).set(auth);
    expect(pendingResponse.status).toBe(200);
    expect(pendingResponse.body.data).toMatchObject({
      id: pending.sessionId, reversal: { status: "pending", reason: "processor_reversal_pending" },
    });
    refundRetrieve.mockResolvedValueOnce({
      id: "re_pending", status: "succeeded", charge: `ch_${pending.checkoutId}`,
      amount: 500, currency: "usd",
    });
    expect((await request(app).post(`/api/billing/payment-sessions/${pending.sessionId}/reversal`).set(auth)).status).toBe(200);
    expect(refundCreate.mock.calls.filter((call: any[]) =>
      call[1].idempotencyKey === `statement-card-reversal-${pending.sessionId}`,
    )).toHaveLength(1);

    const partial = await makeCardSession();
    const callsBeforeIneligible = refundCreate.mock.calls.length;
    await db.update(invoices).set({ total: "11.00" }).where(eq(invoices.id, partial.invoiceId));
    refundCreate.mockResolvedValueOnce({
      id: "re_partial", status: "succeeded", charge: `ch_${partial.checkoutId}`,
      amount: 500, currency: "usd",
    });
    expect((await request(app).post(`/api/billing/payment-sessions/${partial.sessionId}/reversal`).set(auth)).status).toBe(409);
    expect(refundCreate).toHaveBeenCalledTimes(callsBeforeIneligible);
    expect((await db.select().from(statementPaymentReversals)
      .where(eq(statementPaymentReversals.paymentSessionId, partial.sessionId)))).toHaveLength(0);
    expect((await db.select().from(invoices).where(eq(invoices.id, partial.invoiceId)))[0]).toMatchObject({
      total: "11.00", balanceDue: "5.00", status: "partially_paid",
    });
    await db.update(invoices).set({ total: "10.00" }).where(eq(invoices.id, partial.invoiceId));
    await db.update(invoices).set({ providerOrganizationId: labId })
      .where(eq(invoices.id, partial.invoiceId));
    expect((await request(app).post(`/api/billing/payment-sessions/${partial.sessionId}/reversal`).set(auth)).status).toBe(409);
    expect(refundCreate).toHaveBeenCalledTimes(callsBeforeIneligible);
    expect((await db.select().from(statementPaymentReversals)
      .where(eq(statementPaymentReversals.paymentSessionId, partial.sessionId)))).toHaveLength(0);
    await db.update(invoices).set({ providerOrganizationId: providerId })
      .where(eq(invoices.id, partial.invoiceId));
    expect((await request(app).post(`/api/billing/payment-sessions/${partial.sessionId}/reversal`).set(auth)).status).toBe(200);
    expect(refundCreate.mock.calls.filter((call: any[]) => call[1].idempotencyKey === `statement-card-reversal-${partial.sessionId}`)).toHaveLength(1);

    const forbidden = await makeCardSession();
    const plainGet = await request(app).get(`/api/billing/payment-sessions/${forbidden.sessionId}`).set(auth);
    expect(plainGet.body.data.reversal).toBeNull();
    expect((await db.select().from(statementPaymentReversals)
      .where(eq(statementPaymentReversals.paymentSessionId, forbidden.sessionId)))).toHaveLength(0);
    const billingToken = await createAccessToken(billingUserId);
    expect((await request(app).post(`/api/billing/payment-sessions/${forbidden.sessionId}/reversal`).set({ Authorization: `Bearer ${billingToken}` })).status).toBe(403);
    const forbiddenReversals = await db.select().from(statementPaymentReversals)
      .where(eq(statementPaymentReversals.paymentSessionId, forbidden.sessionId));
    expect(forbiddenReversals).toHaveLength(0);
  });

  it("serializes payment settlement and cancellation with restoration sync at the invoice lock", async () => {
    const t = dbMod as any;
    const { db, cases, caseRestorations, invoices, payments,
      practiceStatements, practiceStatementSends,
      statementPaymentApplications, statementPaymentSessions } = t;
    const caseId = rid("lock_case");
    const invoiceId = rid("lock_invoice");
    const statementId = rid("lock_statement");
    const holder = await t.pool.connect();
    const blockerPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const started: Promise<unknown>[] = [];
    let sessionId: string | null = null;
    try {
      await db.insert(cases).values({
        id: caseId, caseNumber: rid("LOCK"), labOrganizationId: labId,
        providerOrganizationId: providerId, patientFirstName: "Lock",
        patientLastName: "Payment", doctorName: "Dr. Payment",
        status: "received", createdByUserId: userId,
      });
      await db.insert(caseRestorations).values({
        id: rid("lock_restoration"), caseId, toothNumber: "14",
        restorationType: "Crown", material: "Zirconia", quantity: 1,
        unitPrice: "80.00",
      });
      await db.insert(invoices).values({
        id: invoiceId, invoiceNumber: rid("LOCK_INV"), caseId,
        labOrganizationId: labId, providerOrganizationId: providerId,
        status: "open", subtotal: "80.00", total: "80.00",
        balanceDue: "80.00", createdByUserId: userId,
      });
      await db.insert(practiceStatements).values({
        id: statementId, labOrganizationId: labId, providerOrganizationId: providerId,
        periodStart: new Date("2030-01-01"), periodEnd: new Date("2030-01-31"),
        invoiceCount: 1, totalBilled: "80.00", totalPaid: "0.00",
        balanceDue: "80.00", invoiceIdsJson: [invoiceId], createdByUserId: userId,
      });
      await db.insert(practiceStatementSends).values({
        statementId, channel: "email", recipient: "billing@example.test",
        status: "sent", sentByUserId: userId,
      });
      const { syncInvoiceFromRestorations } = await import("../lib/invoice-sync.js");
      const auth = { Authorization: `Bearer ${token}` };

      await db.update(caseRestorations)
        .set({ unitPrice: "90.00" })
        .where(eq(caseRestorations.caseId, caseId));
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [invoiceId]);
      await holder.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
      const sync = syncInvoiceFromRestorations({ caseId, actorUserId: userId });
      const settle = Promise.resolve(request(app).post("/api/billing/payment-sessions").set(auth).send({
        labOrganizationId: labId, providerOrganizationId: providerId, statementId,
        receivedAmount: 10, paymentMethod: "cash", idempotencyKey: rid("lock_settle"),
        applications: [{ invoiceId, amount: 10 }],
      }));
      started.push(sync, settle);
      await waitForBlockingEvents(blockerPid, ["advisory", "transactionid"]);
      await holder.query("COMMIT");
      const [syncResult, settleResult] = await Promise.all([sync, settle]);
      expect(syncResult).toBe(invoiceId);
      expect(settleResult.status).toBe(201);
      sessionId = settleResult.body.data.id;
      let invoice = (await db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0];
      expect([
        { status: "partially_paid", total: "80.00", balanceDue: "70.00" },
        { status: "partially_paid", total: "90.00", balanceDue: "80.00" },
      ]).toContainEqual({
        status: invoice.status,
        total: invoice.total,
        balanceDue: invoice.balanceDue,
      });
      expect((await db.select().from(statementPaymentApplications)
        .where(eq(statementPaymentApplications.paymentSessionId, sessionId)))).toHaveLength(1);
      expect((await db.select().from(payments)
        .where(eq(payments.paymentSessionId, sessionId)))).toHaveLength(1);

      const totalBeforeCancellation = invoice.total;
      await db.update(caseRestorations)
        .set({ unitPrice: "100.00" })
        .where(eq(caseRestorations.caseId, caseId));
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [invoiceId]);
      await holder.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
      const syncAgain = syncInvoiceFromRestorations({ caseId, actorUserId: userId });
      const cancel = Promise.resolve(
        request(app).delete(`/api/billing/payment-sessions/${sessionId}`).set(auth),
      );
      started.push(syncAgain, cancel);
      await waitForBlockingEvents(blockerPid, ["advisory", "transactionid"]);
      await holder.query("COMMIT");
      const [syncAgainResult, cancelResult] = await Promise.all([syncAgain, cancel]);
      expect(syncAgainResult).toBe(invoiceId);
      expect(cancelResult.status).toBe(200);
      invoice = (await db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0];
      expect([
        { status: "open", total: totalBeforeCancellation, balanceDue: totalBeforeCancellation },
        { status: "open", total: "100.00", balanceDue: "100.00" },
      ]).toContainEqual({
        status: invoice.status,
        total: invoice.total,
        balanceDue: invoice.balanceDue,
      });
      expect((await db.select().from(statementPaymentApplications)
        .where(eq(statementPaymentApplications.paymentSessionId, sessionId)))).toHaveLength(1);
      expect((await db.select().from(payments)
        .where(eq(payments.paymentSessionId, sessionId)))).toHaveLength(0);
      expect((await db.select().from(statementPaymentSessions)
        .where(eq(statementPaymentSessions.id, sessionId)))[0].status).toBe("cancelled");
    } finally {
      try { await holder.query("ROLLBACK"); } catch {}
      await Promise.allSettled(started);
      holder.release();
      if (sessionId) {
        await cleanupPaymentFixtures(
          { invoiceIds: [invoiceId], paymentSessionIds: [sessionId] },
          db,
        );
      }
      await db.delete(practiceStatementSends).where(eq(practiceStatementSends.statementId, statementId));
      await db.delete(practiceStatements).where(eq(practiceStatements.id, statementId));
      await db.delete(invoices).where(eq(invoices.id, invoiceId));
      await db.delete(caseRestorations).where(eq(caseRestorations.caseId, caseId));
      await db.delete(cases).where(eq(cases.id, caseId));
    }
  });

  // ── Live statement figures and the rolled-up statement-charge ledger ─────
  // A practice_statements row freezes billed / paid / balance-due when the
  // statement is generated and nothing rewrites it when a payment is recorded
  // later, so the reported settlement figures are derived from the
  // statement's own invoices as they stand now.
  // A practice of its own, for a ledger test whose figures must not be moved
  // by fixture state another test left on the shared account.
  async function createLedgerCustomer() {
    const { db, organizations } = dbMod as any;
    const id = rid("ledger_practice");
    await db.insert(organizations).values({
      id,
      type: "provider",
      name: "Ledger Test Practice",
      billingEmail: "ledger@example.test",
      parentLabOrganizationId: labId,
    });
    ledgerFixtureOrgIds.push(id);
    return id;
  }

  async function createLiveStatementFixture(
    amounts: string[],
    customerId: string = providerId,
  ) {
    const { db, invoices, practiceStatements, practiceStatementSends } =
      dbMod as any;
    const liveStatementId = rid("live_stmt");
    // The newest sent statement is the one eligible to receive a payment, so
    // this period closes after the suite's other statements. Its invoices are
    // issued before today, leaving a payment recorded now as the newest event.
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const rows = amounts.map((amount, index) => ({
      amount,
      id: rid("live_inv"),
      invoiceNumber: rid("LIVE"),
      issuedAt: new Date(`2026-09-0${index + 1}T12:00:00.000Z`),
      dueAt: new Date(`2026-10-0${index + 1}T12:00:00.000Z`),
      patientName: `Patient ${index + 1}`,
    }));
    for (const row of rows) ledgerFixtureInvoiceIds.push(row.id);
    ledgerFixtureStatementIds.push(liveStatementId);
    await db.insert(invoices).values(rows.map((row) => ({
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      labOrganizationId: labId,
      providerOrganizationId: customerId,
      status: "open",
      total: row.amount,
      balanceDue: row.amount,
      issuedAt: row.issuedAt,
      dueAt: row.dueAt,
      displayMetadataJson: { patientName: row.patientName, billTo: "Dr. Live" },
      createdByUserId: userId,
    })));
    const totalBilled = amounts
      .reduce((sum, amount) => sum + Number(amount), 0)
      .toFixed(2);
    await db.insert(practiceStatements).values({
      id: liveStatementId,
      labOrganizationId: labId,
      providerOrganizationId: customerId,
      periodStart,
      periodEnd: new Date("2026-09-30T23:59:59.000Z"),
      invoiceCount: rows.length,
      totalBilled,
      totalPaid: "0.00",
      balanceDue: totalBilled,
      invoiceIdsJson: rows.map((row) => row.id),
      invoiceAmountsJson: Object.fromEntries(
        rows.map((row) => [row.id, row.amount]),
      ),
      invoiceDetailsJson: Object.fromEntries(rows.map((row) => [row.id, {
        invoiceNumber: row.invoiceNumber,
        patientName: row.patientName,
        billTo: "Dr. Live",
         issuedAt: row.issuedAt.toISOString(),
         dueAt: row.dueAt.toISOString(),
         status: "open",
      }])),
      createdByUserId: userId,
    });
    await db.insert(practiceStatementSends).values({
      statementId: liveStatementId,
      channel: "email",
      recipient: "billing@example.test",
      status: "sent",
      sentByUserId: userId,
      sentAt: new Date("2026-09-10T12:00:00.000Z"),
    });
    return { statementId: liveStatementId, totalBilled, invoices: rows };
  }

  it("derives statement paid and balance figures from the statement's invoices", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const fixture = await createLiveStatementFixture(["60.00", "40.00"]);
    const [firstInvoice, secondInvoice] = fixture.invoices;

    const practiceRow = async () => {
      const response = await request(app)
        .get(`/api/invoices/practice-statements?providerOrganizationId=${providerId}&labOrganizationId=${labId}`)
        .set(auth);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data.find((row: any) => row.id === fixture.statementId);
    };
    const accountRow = async () => {
      const response = await request(app)
        .get(`/api/billing/${labId}/accounts/${providerId}/statements`)
        .set(auth);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data.find((row: any) => row.id === fixture.statementId);
    };
    const statementDetail = async () => {
      const response = await request(app)
        .get(`/api/billing/statements/${fixture.statementId}`)
        .set(auth);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data;
    };
    const expectFigures = async (totalPaid: string, balanceDue: string) => {
      const figures = {
        totalBilled: "100.00",
        totalPaid,
        currentTotalPaid: totalPaid,
        balanceDue,
        currentBalanceDue: balanceDue,
        // The issued snapshot is untouched by later settlement.
        snapshotTotalPaid: "0.00",
        snapshotBalanceDue: "100.00",
      };
      expect(await practiceRow()).toEqual(expect.objectContaining(figures));
      expect(await accountRow()).toEqual(expect.objectContaining({
        ...figures,
        savedBalanceDue: balanceDue,
      }));
      expect(await statementDetail()).toEqual(expect.objectContaining({
        ...figures,
        savedBalanceDue: balanceDue,
      }));
    };

    await expectFigures("0.00", "100.00");

    const partial = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId: fixture.statementId,
        receivedAmount: 60,
        paymentMethod: "check",
        checkNumber: "7001",
        idempotencyKey: rid("live_partial"),
        applications: [{ invoiceId: firstInvoice.id, amount: 60 }],
      });
    expect(partial.status, JSON.stringify(partial.body)).toBe(201);
    await expectFigures("60.00", "40.00");

    const remainder = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId: fixture.statementId,
        receivedAmount: 40,
        paymentMethod: "check",
        checkNumber: "7002",
        idempotencyKey: rid("live_remainder"),
        applications: [{ invoiceId: secondInvoice.id, amount: 40 }],
      });
    expect(remainder.status, JSON.stringify(remainder.body)).toBe(201);
    await expectFigures("100.00", "0.00");

    const cancelled = await request(app)
      .delete(`/api/billing/payment-sessions/${remainder.body.data.id}`)
      .set(auth);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    await expectFigures("60.00", "40.00");

    // Voiding stops the invoice being owed without it ever being paid, so it
    // has to leave the paid figure alone while clearing the balance.
    const voided = await request(app)
      .post(`/api/invoices/${secondInvoice.id}/void`)
      .set(auth)
      .send({ reason: "statement figure coverage" });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    await expectFigures("60.00", "0.00");
  });

  it("keeps issued invoice dates and statuses stable while settlement remains live", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const fixture = await createLiveStatementFixture(["60.00", "40.00"]);
    const [editedInvoice, deletedInvoice] = fixture.invoices;
    const detail = async () => {
      const response = await request(app)
        .get(`/api/billing/statements/${fixture.statementId}`)
        .set(auth);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data;
    };

    await dbMod.db.update(dbMod.invoices).set({
      issuedAt: new Date("2027-01-15T12:00:00.000Z"),
      dueAt: new Date("2027-02-15T12:00:00.000Z"),
      status: "partially_paid",
      balanceDue: "25.00",
    }).where(eq(dbMod.invoices.id, editedInvoice.id));
    await dbMod.db.update(dbMod.invoices).set({
      issuedAt: new Date("2027-03-15T12:00:00.000Z"),
      dueAt: new Date("2027-04-15T12:00:00.000Z"),
      status: "paid",
      balanceDue: "0.00",
      deletedAt: new Date("2027-05-01T12:00:00.000Z"),
    }).where(eq(dbMod.invoices.id, deletedInvoice.id));

    const statement = await detail();
    expect(statement.invoices).toEqual([
      expect.objectContaining({
        id: editedInvoice.id,
        issuedAt: editedInvoice.issuedAt.toISOString(),
        dueAt: editedInvoice.dueAt.toISOString(),
        status: "open",
        currentBalanceDue: "25.00",
        eligibleForPayment: true,
         detailProvenance: "snapshot",
      }),
      expect.objectContaining({
        id: deletedInvoice.id,
        issuedAt: deletedInvoice.issuedAt.toISOString(),
        dueAt: deletedInvoice.dueAt.toISOString(),
        status: "open",
        currentBalanceDue: "0.00",
        eligibleForPayment: false,
      }),
    ]);
    expect(statement).toEqual(expect.objectContaining({
      totalPaid: "35.00",
      currentTotalPaid: "35.00",
      balanceDue: "25.00",
      currentBalanceDue: "25.00",
      snapshotTotalPaid: "0.00",
      snapshotBalanceDue: "100.00",
    }));
  });

  it("reports one ledger event per payment received, not one per invoice settled", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const fixture = await createLiveStatementFixture(["30.00", "20.00", "50.00"]);
    const fixtureNumbers = fixture.invoices.map((row) => row.invoiceNumber);
    const [before, beforeLedger] = await Promise.all([
      request(app).get(`/api/billing/${labId}/accounts/${providerId}/balance`).set(auth),
      request(app).get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`).set(auth),
    ]);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(beforeLedger.status, JSON.stringify(beforeLedger.body)).toBe(200);

    const created = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId: fixture.statementId,
        receivedAmount: 100,
        paymentMethod: "check",
        checkNumber: "7100",
        idempotencyKey: rid("ledger_rollup"),
        applications: fixture.invoices.map((row) => ({
          invoiceId: row.id,
          amount: Number(row.amount),
        })),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const session = created.body.data;

    const ledger = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
      .set(auth);
    expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
    const allRows: any[] = ledger.body.data.rows;
    const sessionRows = allRows.filter((row) => row.paymentSessionId === session.id);
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]).toEqual(expect.objectContaining({
      type: "payment",
      typeLabel: "Payment (3 invoices)",
      invoiceCount: 3,
      paymentAmount: "100.00",
      paymentMethod: "check",
      referenceNumber: session.receiptNumber,
      statementId: fixture.statementId,
      statementLabel: "09-2026",
      // The event is the payment, not any one invoice it happened to settle.
      invoiceNumber: null,
      patientName: null,
      invoiceAmount: null,
    }));
    expect(allRows.filter((row) =>
      row.type === "payment" && fixtureNumbers.includes(row.invoiceNumber),
    )).toEqual([]);

    // The running balance moves by the payment received, once.
    const rolledIndex = allRows.findIndex((row) => row.id === sessionRows[0].id);
    expect(rolledIndex).toBeGreaterThan(0);
    expect(Number(allRows[rolledIndex].balance)).toBeCloseTo(
      Number(allRows[rolledIndex - 1].balance) - 100,
      2,
    );
    const after = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/balance`)
      .set(auth);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    // The ledger's ending balance tracks the customer's account balance: both
    // move by exactly the money received, so the payment is counted once.
    expect(Number(beforeLedger.body.data.endingBalance) -
      Number(ledger.body.data.endingBalance)).toBeCloseTo(100, 2);
    expect(Number(before.body.data.currentBalance) -
      Number(after.body.data.currentBalance)).toBeCloseTo(100, 2);

    // Paging and the date filter see the same rolled-up events.
    const paged = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges?limit=100&offset=0`)
      .set(auth);
    expect(paged.status, JSON.stringify(paged.body)).toBe(200);
    expect(paged.body.data.total).toBe(allRows.length);
    expect(paged.body.data.rows.map((row: any) => row.id)).toEqual(
      allRows.map((row) => row.id).reverse(),
    );
    expect(paged.body.data.endingBalance).toBe(ledger.body.data.endingBalance);

    const accrualWindow = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges?from=2026-09-01&to=2026-09-03&timeZone=UTC`)
      .set(auth);
    expect(accrualWindow.status, JSON.stringify(accrualWindow.body)).toBe(200);
    expect(accrualWindow.body.data.rows.map((row: any) => row.invoiceNumber).sort())
      .toEqual([...fixtureNumbers].sort());
    expect(accrualWindow.body.data.rows.some((row: any) =>
      row.paymentSessionId === session.id)).toBe(false);
  });

  it("counts an overpayment once when it generates customer credit", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const fixture = await createLiveStatementFixture(["50.00"]);
    const [invoice] = fixture.invoices;
    const [before, beforeLedger] = await Promise.all([
      request(app).get(`/api/billing/${labId}/accounts/${providerId}/balance`).set(auth),
      request(app).get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`).set(auth),
    ]);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(beforeLedger.status, JSON.stringify(beforeLedger.body)).toBe(200);

    const created = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId: fixture.statementId,
        receivedAmount: 80,
        paymentMethod: "check",
        checkNumber: "7200",
        idempotencyKey: rid("ledger_overpay"),
        applications: [{ invoiceId: invoice.id, amount: 50 }],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const session = created.body.data;

    const ledger = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
      .set(auth);
    expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
    const sessionRows = ledger.body.data.rows.filter((row: any) =>
      row.paymentSessionId === session.id);
    // The received amount is the whole event: the unapplied remainder became
    // credit, and reporting it again would double-count the same money.
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]).toEqual(expect.objectContaining({
      type: "payment",
      typeLabel: "Payment",
      invoiceCount: 1,
      paymentAmount: "80.00",
      invoiceNumber: invoice.invoiceNumber,
    }));

    const balance = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/balance`)
      .set(auth);
    expect(balance.status, JSON.stringify(balance.body)).toBe(200);
    expect(Number(balance.body.data.availableCredit) -
      Number(before.body.data.availableCredit)).toBeCloseTo(30, 2);
    // Settled invoice plus generated credit is one movement of 80 on both the
    // ledger and the account balance; counting the credit again would show 110.
    expect(Number(beforeLedger.body.data.endingBalance) -
      Number(ledger.body.data.endingBalance)).toBeCloseTo(80, 2);
    expect(Number(before.body.data.currentBalance) -
      Number(balance.body.data.currentBalance)).toBeCloseTo(80, 2);
  });

  it("stops counting credit spent on an invoice that was later deleted or voided", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    // Its own practice, so the two figures can be compared outright instead of
    // through the fixture state other tests leave on the shared account.
    const customerId = await createLedgerCustomer();
    const fixture = await createLiveStatementFixture(
      ["50.00", "20.00", "10.00"],
      customerId,
    );
    const [overpaidInvoice, deletedInvoice, voidedInvoice] = fixture.invoices;
    const figures = async () => {
      const [balance, ledger] = await Promise.all([
        request(app).get(`/api/billing/${labId}/accounts/${customerId}/balance`).set(auth),
        request(app).get(`/api/billing/${labId}/accounts/${customerId}/statement-charges`).set(auth),
      ]);
      expect(balance.status, JSON.stringify(balance.body)).toBe(200);
      expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
      return {
        currentBalance: balance.body.data.currentBalance as string,
        availableCredit: balance.body.data.availableCredit as string,
        endingBalance: ledger.body.data.endingBalance as string,
        rows: ledger.body.data.rows as any[],
      };
    };

    const before = await figures();
    expect(before.endingBalance).toBe(before.currentBalance);

    // An overpayment settles the first invoice and leaves 30.00 of credit.
    const overpaid = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: customerId,
        statementId: fixture.statementId,
        receivedAmount: 80,
        paymentMethod: "check",
        checkNumber: "7300",
        idempotencyKey: rid("ledger_credit_overpay"),
        applications: [{ invoiceId: overpaidInvoice.id, amount: 50 }],
      });
    expect(overpaid.status, JSON.stringify(overpaid.body)).toBe(201);

    // That credit then settles the other two invoices in full.
    const applied = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: customerId,
        statementId: fixture.statementId,
        receivedAmount: 0,
        existingCreditAmount: 30,
        paymentMethod: "check",
        idempotencyKey: rid("ledger_credit_apply"),
        applications: [
          { invoiceId: deletedInvoice.id, amount: 0, creditAmount: 20 },
          { invoiceId: voidedInvoice.id, amount: 0, creditAmount: 10 },
        ],
      });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);

    const settled = await figures();
    expect(settled.availableCredit).toBe("0.00");
    expect(settled.endingBalance).toBe(settled.currentBalance);
    expect(settled.rows.filter((row) => row.type === "credit_application"))
      .toHaveLength(2);

    const deleted = await request(app).delete("/api/invoices/bulk")
      .set(auth).send({ labOrganizationId: labId, invoiceIds: [deletedInvoice.id] });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    const voided = await request(app).post(`/api/invoices/${voidedInvoice.id}/void`)
      .set(auth).send({ reason: "credit ledger coverage" });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);

    const after = await figures();
    // Both charges the credit settled are gone from the ledger, so the credit
    // backs nothing: subtracting its original 30.00 would report the account
    // 30.00 lower than it is.
    expect(after.endingBalance).toBe(after.currentBalance);
    expect(Number(before.endingBalance) - Number(after.endingBalance))
      .toBeCloseTo(80, 2);
    expect(Number(before.currentBalance) - Number(after.currentBalance))
      .toBeCloseTo(80, 2);
    // Deleting the invoice does not hand the consumed credit back, and the
    // applications against dead invoices stop being reported.
    expect(after.availableCredit).toBe("0.00");
    expect(after.rows.filter((row) => row.type === "credit_application"))
      .toEqual([]);
    expect(after.rows.map((row) => row.invoiceNumber)).not.toContain(
      deletedInvoice.invoiceNumber,
    );
    expect(after.rows.map((row) => row.invoiceNumber)).not.toContain(
      voidedInvoice.invoiceNumber,
    );
  });

  it("keeps a payment recorded against one invoice as its own ledger event", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const fixture = await createLiveStatementFixture(["45.00"]);
    const [invoice] = fixture.invoices;
    const [before, beforeLedger] = await Promise.all([
      request(app).get(`/api/billing/${labId}/accounts/${providerId}/balance`).set(auth),
      request(app).get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`).set(auth),
    ]);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(beforeLedger.status, JSON.stringify(beforeLedger.body)).toBe(200);

    const recorded = await request(app)
      .post(`/api/invoices/${invoice.id}/payments`)
      .set(auth)
      .send({ amount: 45, paymentMethod: "cash", referenceNumber: "CHK-9001" });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);

    const ledger = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
      .set(auth);
    expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
    const paymentRows = ledger.body.data.rows.filter((row: any) =>
      row.type === "payment" && row.invoiceNumber === invoice.invoiceNumber);
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0]).toEqual(expect.objectContaining({
      typeLabel: "Payment",
      invoiceCount: 1,
      paymentAmount: "45.00",
      referenceNumber: "CHK-9001",
      paymentMethod: "cash",
      patientName: invoice.patientName,
      paymentSessionId: null,
      statementId: null,
    }));

    const balance = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/balance`)
      .set(auth);
    expect(balance.status, JSON.stringify(balance.body)).toBe(200);
    expect(Number(beforeLedger.body.data.endingBalance) -
      Number(ledger.body.data.endingBalance)).toBeCloseTo(45, 2);
    expect(Number(before.body.data.currentBalance) -
      Number(balance.body.data.currentBalance)).toBeCloseTo(45, 2);
  });

  // Saved-card settlement writes its payment rows before the receipt session
  // exists, so they can only be grouped back through the provider payment
  // checkout. If that link stops matching, the same card payment reappears
  // once per invoice it settled, each row showing the wrong amount.
  it("rolls a saved-card settlement across invoices into one ledger event", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, payments, providerPaymentCheckouts, providerPaymentCustomers } =
      dbMod as any;
    const fixture = await createLiveStatementFixture(["12.00", "18.00", "20.00"]);
    const fixtureNumbers = fixture.invoices.map((row) => row.invoiceNumber);

    const stripeCustomerId = `cus_ledger_card_${labId}`;
    await db.insert(providerPaymentCustomers).values({
      providerOrganizationId: providerId, stripeCustomerId,
      cardBrand: "visa", cardLast4: "4242",
    }).onConflictDoUpdate({
      target: providerPaymentCustomers.providerOrganizationId,
      set: { stripeCustomerId, cardBrand: "visa", cardLast4: "4242" },
    });
    customersRetrieve.mockResolvedValue({
      deleted: false,
      invoice_settings: { default_payment_method: "pm_ledger_card" },
    });
    paymentMethodsRetrieve.mockResolvedValue({
      type: "card", customer: stripeCustomerId,
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    });
    paymentIntentCreate.mockResolvedValueOnce({
      id: "pi_ledger_card", status: "succeeded", amount: 5000,
      currency: "usd", latest_charge: "ch_ledger_card",
    });

    const [before, beforeLedger] = await Promise.all([
      request(app).get(`/api/billing/${labId}/accounts/${providerId}/balance`).set(auth),
      request(app).get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`).set(auth),
    ]);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(beforeLedger.status, JSON.stringify(beforeLedger.body)).toBe(200);

    const key = rid("ledger_card");
    const created = await request(app).post("/api/billing/payment-sessions/card")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId: fixture.statementId,
        receivedAmount: 50,
        paymentMethod: "card",
        cardLast4: "4242",
        idempotencyKey: key,
        applications: fixture.invoices.map((row) => ({
          invoiceId: row.id,
          amount: Number(row.amount),
        })),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const session = created.body.data;
    cardFixtureSessionIds.push(session.id);

    // The grouping under test: settlement stamped the checkout on each payment
    // row and left the session id null, so only the checkout link can fold
    // these three rows back into one received payment.
    const [checkout] = await db.select().from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.clientRequestId, key));
    const paymentRows = await db.select().from(payments)
      .where(eq(payments.providerPaymentCheckoutId, checkout.id));
    expect(paymentRows).toHaveLength(3);
    expect(paymentRows.every((row: any) => row.paymentSessionId === null)).toBe(true);

    const ledger = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
      .set(auth);
    expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
    const allRows: any[] = ledger.body.data.rows;
    const sessionRows = allRows.filter((row) => row.paymentSessionId === session.id);
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]).toEqual(expect.objectContaining({
      type: "payment",
      typeLabel: "Payment (3 invoices)",
      invoiceCount: 3,
      paymentAmount: "50.00",
      paymentMethod: "card",
      referenceNumber: session.receiptNumber,
      statementId: fixture.statementId,
      invoiceNumber: null,
      patientName: null,
      invoiceAmount: null,
    }));
    expect(allRows.filter((row) =>
      row.type === "payment" && fixtureNumbers.includes(row.invoiceNumber),
    )).toEqual([]);

    const after = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/balance`)
      .set(auth);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(Number(beforeLedger.body.data.endingBalance) -
      Number(ledger.body.data.endingBalance)).toBeCloseTo(50, 2);
    expect(Number(before.body.data.currentBalance) -
      Number(after.body.data.currentBalance)).toBeCloseTo(50, 2);
  });

  // The older Receive Payments batch predates payment sessions entirely: its
  // payment rows carry neither a session nor a checkout, only the deposit's
  // bank transaction. That is the third and last way a payment finds its
  // session, and the only thing keeping a deposited batch from being listed
  // once per invoice.
  it("rolls a Receive Payments deposit batch into one ledger event", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, payments, statementPaymentSessions } = dbMod as any;
    const fixture = await createLiveStatementFixture(["25.00", "35.00"]);
    const fixtureNumbers = fixture.invoices.map((row) => row.invoiceNumber);
    const [before, beforeLedger] = await Promise.all([
      request(app).get(`/api/billing/${labId}/accounts/${providerId}/balance`).set(auth),
      request(app).get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`).set(auth),
    ]);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(beforeLedger.status, JSON.stringify(beforeLedger.body)).toBe(200);

    const received = await request(app).post("/api/invoices/receive-payments")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        paymentMethod: "check",
        referenceNumber: "8100",
        depositBankAccountId: checkingAccountId,
        applications: fixture.invoices.map((row) => ({
          invoiceId: row.id,
          amount: Number(row.amount),
        })),
      });
    expect(received.status, JSON.stringify(received.body)).toBe(201);
    const depositTransactionId = received.body.data.depositTransactionId;
    const [session] = await db.select().from(statementPaymentSessions)
      .where(eq(statementPaymentSessions.bankTransactionId, depositTransactionId));
    expect(session).toBeTruthy();
    cardFixtureSessionIds.push(session.id);

    // The grouping under test: nothing but the deposit's bank transaction ties
    // these payment rows to the batch receipt.
    const paymentRows = await db.select().from(payments)
      .where(eq(payments.bankTransactionId, depositTransactionId));
    expect(paymentRows).toHaveLength(2);
    expect(paymentRows.every((row: any) =>
      row.paymentSessionId === null && row.providerPaymentCheckoutId === null,
    )).toBe(true);

    const ledger = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statement-charges`)
      .set(auth);
    expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
    const allRows: any[] = ledger.body.data.rows;
    const sessionRows = allRows.filter((row) => row.paymentSessionId === session.id);
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]).toEqual(expect.objectContaining({
      type: "payment",
      typeLabel: "Payment (2 invoices)",
      invoiceCount: 2,
      paymentAmount: "60.00",
      paymentMethod: "check",
      referenceNumber: session.receiptNumber,
      invoiceNumber: null,
      patientName: null,
      invoiceAmount: null,
    }));
    expect(allRows.filter((row) =>
      row.type === "payment" && fixtureNumbers.includes(row.invoiceNumber),
    )).toEqual([]);

    const after = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/balance`)
      .set(auth);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(Number(beforeLedger.body.data.endingBalance) -
      Number(ledger.body.data.endingBalance)).toBeCloseTo(60, 2);
    expect(Number(before.body.data.currentBalance) -
      Number(after.body.data.currentBalance)).toBeCloseTo(60, 2);
  });

  // The customer-account screens open with these four reads. Each one has
  // previously broken in a way no test caught, so they are covered here
  // directly on their response shape rather than only as a side effect of
  // the payment flows that happen to call them.
  it("serves the account statement list for the customer account screen", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const fixture = await createLiveStatementFixture(["60.00", "40.00"]);
    const [firstInvoice, secondInvoice] = fixture.invoices;

    const response = await request(app)
      .get(`/api/billing/${labId}/accounts/${providerId}/statements`)
      .set(auth);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    const row = response.body.data.find(
      (candidate: any) => candidate.id === fixture.statementId,
    );
    expect(row).toEqual(expect.objectContaining({
      id: fixture.statementId,
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-09-30T23:59:59.000Z",
      invoiceCount: 2,
      totalBilled: "100.00",
      totalPaid: "0.00",
      currentTotalPaid: "0.00",
      balanceDue: "100.00",
      currentBalanceDue: "100.00",
      savedBalanceDue: "100.00",
      snapshotTotalPaid: "0.00",
      snapshotBalanceDue: "100.00",
      invoiceIds: [firstInvoice.id, secondInvoice.id],
      createdAt: expect.any(String),
    }));
    // The suite's own statements belong to the same account, so the list is
    // the account's whole statement history, newest period first.
    const ids = response.body.data.map((candidate: any) => candidate.id);
    expect(ids).toEqual(expect.arrayContaining([
      fixture.statementId, statementId, olderStatementId,
    ]));
    expect(ids.indexOf(fixture.statementId)).toBeLessThan(ids.indexOf(statementId));
    expect(ids.indexOf(statementId)).toBeLessThan(ids.indexOf(olderStatementId));
  });

  it("serves a single statement's invoice detail rows", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const fixture = await createLiveStatementFixture(["60.00", "40.00"]);
    const [firstInvoice, secondInvoice] = fixture.invoices;

    const response = await request(app)
      .get(`/api/billing/statements/${fixture.statementId}`)
      .set(auth);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual(expect.objectContaining({
      id: fixture.statementId,
      labOrganizationId: labId,
      providerOrganizationId: providerId,
      invoiceCount: 2,
      totalBilled: "100.00",
      balanceDue: "100.00",
      currentBalanceDue: "100.00",
      snapshotBalanceDue: "100.00",
    }));
    expect(response.body.data.invoices).toEqual([
      {
        id: firstInvoice.id,
        invoiceNumber: firstInvoice.invoiceNumber,
        patientName: firstInvoice.patientName,
        billTo: "Dr. Live",
        status: "open",
        issuedAt: firstInvoice.issuedAt.toISOString(),
        dueAt: firstInvoice.dueAt.toISOString(),
        total: "60.00",
        currentBalanceDue: "60.00",
        eligibleForPayment: true,
        detailProvenance: "snapshot",
      },
      {
        id: secondInvoice.id,
        invoiceNumber: secondInvoice.invoiceNumber,
        patientName: secondInvoice.patientName,
        billTo: "Dr. Live",
        status: "open",
        issuedAt: secondInvoice.issuedAt.toISOString(),
        dueAt: secondInvoice.dueAt.toISOString(),
        total: "40.00",
        currentBalanceDue: "40.00",
        eligibleForPayment: true,
        detailProvenance: "snapshot",
      },
    ]);
  });

  it("serves the account's available customer credits", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const creditList = async () => {
      const response = await request(app)
        .get(`/api/billing/${labId}/accounts/${providerId}/customer-credits`)
        .set(auth);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data;
    };

    const before = await creditList();
    expect(before).toEqual(expect.objectContaining({
      totalAvailable: expect.stringMatching(/^-?\d+\.\d{2}$/),
      credits: expect.any(Array),
    }));

    const fixture = await createLiveStatementFixture(["50.00"]);
    const [invoice] = fixture.invoices;
    const overpayment = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        statementId: fixture.statementId,
        receivedAmount: 80,
        paymentMethod: "check",
        checkNumber: "7300",
        memo: "Customer credit read coverage",
        idempotencyKey: rid("credit_read"),
        applications: [{ invoiceId: invoice.id, amount: 50 }],
      });
    expect(overpayment.status, JSON.stringify(overpayment.body)).toBe(201);

    const after = await creditList();
    expect(after.credits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        labOrganizationId: labId,
        providerOrganizationId: providerId,
        paymentSessionId: overpayment.body.data.id,
        amount: "30.00",
        remainingAmount: "30.00",
        note: "Customer credit read coverage",
        reversedAt: null,
      }),
    ]));
    // The advertised total is the sum of what the list itself reports as
    // still available, so the screen's header and rows cannot disagree.
    expect(after.totalAvailable).toBe(
      after.credits
        .reduce((sum: number, credit: any) => sum + Number(credit.remainingAmount), 0)
        .toFixed(2),
    );
    expect(Number(after.totalAvailable) - Number(before.totalAvailable))
      .toBeCloseTo(30, 2);
    expect(after.credits).toHaveLength(before.credits.length + 1);
  });

  // Receive Payments lists each payable customer with the account number and
  // location Customer Center shows, and the last payment the lab received from
  // them. "Received" means money in: a payment session is one payment however
  // many invoices it settled, worth what was received (overpayment included);
  // a payment recorded straight onto an invoice counts too; reversed or
  // reversal-reserved payments and credit-only applications do not.
  it("lists each payable customer's identity and most recent received payment", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { db, organizations, payments, statementPaymentReversals } = dbMod as any;
    const customerId = await createLedgerCustomer();
    const fixture = await createLiveStatementFixture(
      ["40.00", "30.00", "20.00"],
      customerId,
    );
    const [firstInvoice, secondInvoice, thirdInvoice] = fixture.invoices;
    const listedAccounts = async () => {
      const [statementLed, invoiceLed] = await Promise.all([
        request(app).get(`/api/billing/${labId}/eligible-statement-accounts`).set(auth),
        request(app).get(`/api/billing/${labId}/eligible-invoice-accounts`).set(auth),
      ]);
      expect(statementLed.status, JSON.stringify(statementLed.body)).toBe(200);
      expect(invoiceLed.status, JSON.stringify(invoiceLed.body)).toBe(200);
      const find = (rows: any[]) =>
        rows.find((row) => row.providerOrganizationId === customerId);
      const accounts = [find(statementLed.body.data), find(invoiceLed.body.data)];
      expect(accounts.every(Boolean)).toBe(true);
      return accounts;
    };
    const expectBoth = async (expected: Record<string, unknown>) => {
      for (const account of await listedAccounts()) {
        expect(account).toEqual(expect.objectContaining(expected));
      }
    };

    // A customer without an account number or address, and nothing received.
    await expectBoth({
      accountNumber: null,
      city: null,
      state: null,
      lastPaymentAt: null,
      lastPaymentAmount: null,
      doctorLastPayments: [],
    });
    // The statement row names the payable statement's own invoices, which is
    // what a statement payment may settle.
    const [statementLedAccount] = await listedAccounts();
    expect(statementLedAccount.statementId).toBe(fixture.statementId);
    expect(statementLedAccount.statements).toEqual([
      expect.objectContaining({
        statementId: fixture.statementId,
        invoiceCount: 3,
        invoiceIds: expect.arrayContaining(fixture.invoices.map((invoice: { id: string }) => invoice.id)),
      }),
    ]);
    expect(statementLedAccount.statements[0].invoiceIds).toHaveLength(3);
    const accountNumber = rid("ACCT");
    await db.update(organizations)
      .set({ accountNumber, city: "Austin", state: "TX" })
      .where(eq(organizations.id, customerId));
    await expectBoth({ accountNumber, city: "Austin", state: "TX", lastPaymentAt: null });

    // A backdated overpayment: the money received, not the 15.00 applied.
    const backdated = new Date();
    backdated.setDate(backdated.getDate() - 20);
    const overpaid = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: customerId,
        statementId: fixture.statementId,
        receivedAmount: 20,
        paymentMethod: "check",
        checkNumber: "8100",
        paymentDate: backdated.toISOString(),
        doctorName: "Dr. Live",
        idempotencyKey: rid("last_payment_overpay"),
        applications: [{ invoiceId: firstInvoice.id, amount: 15 }],
      });
    expect(overpaid.status, JSON.stringify(overpaid.body)).toBe(201);
    await expectBoth({
      lastPaymentAt: backdated.toISOString(),
      lastPaymentAmount: "20.00",
      doctorLastPayments: [{
        doctorIdentity: "dr. live",
        lastPaymentAt: backdated.toISOString(),
        lastPaymentAmount: "20.00",
      }],
    });

    // A payment recorded directly against one invoice is newer.
    const direct = await request(app)
      .post(`/api/invoices/${secondInvoice.id}/payments`)
      .set(auth)
      .send({ amount: 10, paymentMethod: "cash", referenceNumber: "CASH-8101" });
    expect(direct.status, JSON.stringify(direct.body)).toBe(201);
    const [directRow] = await db.select().from(payments)
      .where(eq(payments.invoiceId, secondInvoice.id));
    const directPaidAt = new Date(directRow.paidAt);
    await expectBoth({
      lastPaymentAt: directPaidAt.toISOString(),
      lastPaymentAmount: "10.00",
      doctorLastPayments: [{
        doctorIdentity: "dr. live",
        lastPaymentAt: backdated.toISOString(),
        lastPaymentAmount: "20.00",
      }],
    });

    // A later Receive Payments session becomes the most recent payment...
    const laterDate = new Date(directPaidAt.getTime() + 1_000);
    const later = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: customerId,
        statementId: fixture.statementId,
        receivedAmount: 12,
        paymentMethod: "check",
        checkNumber: "8102",
        paymentDate: laterDate.toISOString(),
        doctorName: "Dr. Live",
        idempotencyKey: rid("last_payment_later"),
        applications: [{ invoiceId: thirdInvoice.id, amount: 12 }],
      });
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    await expectBoth({
      lastPaymentAt: laterDate.toISOString(),
      lastPaymentAmount: "12.00",
      doctorLastPayments: [{
        doctorIdentity: "dr. live",
        lastPaymentAt: laterDate.toISOString(),
        lastPaymentAmount: "12.00",
      }],
    });

    // ...but not while a reversal holds it, the same reservation the
    // customer-credit listing applies. A failed reversal releases it.
    await db.insert(statementPaymentReversals).values({
      paymentSessionId: later.body.data.id,
      processorIdempotencyKey: rid("last_payment_reversal"),
      amount: "12.00",
      status: "pending_processor",
      initiatedByUserId: userId,
    });
    await expectBoth({
      lastPaymentAt: directPaidAt.toISOString(),
      lastPaymentAmount: "10.00",
      doctorLastPayments: [{
        doctorIdentity: "dr. live",
        lastPaymentAt: backdated.toISOString(),
        lastPaymentAmount: "20.00",
      }],
    });
    await db.update(statementPaymentReversals)
      .set({ status: "failed", failureReason: "last payment coverage" })
      .where(eq(statementPaymentReversals.paymentSessionId, later.body.data.id));
    await expectBoth({
      lastPaymentAt: laterDate.toISOString(),
      lastPaymentAmount: "12.00",
      doctorLastPayments: [{
        doctorIdentity: "dr. live",
        lastPaymentAt: laterDate.toISOString(),
        lastPaymentAmount: "12.00",
      }],
    });
    await db.delete(statementPaymentReversals)
      .where(eq(statementPaymentReversals.paymentSessionId, later.body.data.id));

    // Cancelling the session takes it back out.
    const cancelled = await request(app)
      .delete(`/api/billing/payment-sessions/${later.body.data.id}`)
      .set(auth);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    await expectBoth({
      lastPaymentAt: directPaidAt.toISOString(),
      lastPaymentAmount: "10.00",
      doctorLastPayments: [{
        doctorIdentity: "dr. live",
        lastPaymentAt: backdated.toISOString(),
        lastPaymentAmount: "20.00",
      }],
    });

    // An unattributed legacy-style session can update practice-wide history,
    // but must not be assigned to the doctor's summary.
    const unattributedDate = new Date(directPaidAt.getTime() + 2_000);
    const unattributed = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: customerId,
        statementId: fixture.statementId,
        receivedAmount: 5,
        paymentMethod: "check",
        checkNumber: "8103",
        paymentDate: unattributedDate.toISOString(),
        idempotencyKey: rid("last_payment_unattributed"),
        applications: [{ invoiceId: firstInvoice.id, amount: 5 }],
      });
    expect(unattributed.status, JSON.stringify(unattributed.body)).toBe(201);
    await expectBoth({
      lastPaymentAt: unattributedDate.toISOString(),
      lastPaymentAmount: "5.00",
      doctorLastPayments: [{
        doctorIdentity: "dr. live",
        lastPaymentAt: backdated.toISOString(),
        lastPaymentAmount: "20.00",
      }],
    });

    // Applying existing credit receives no money, so it is not a payment.
    const creditOnly = await request(app).post("/api/billing/payment-sessions")
      .set(auth).send({
        labOrganizationId: labId,
        providerOrganizationId: customerId,
        statementId: fixture.statementId,
        receivedAmount: 0,
        existingCreditAmount: 5,
        paymentMethod: "check",
        paymentDate: new Date(unattributedDate.getTime() + 2_000).toISOString(),
        idempotencyKey: rid("last_payment_credit_only"),
        applications: [{ invoiceId: thirdInvoice.id, amount: 0, creditAmount: 5 }],
      });
    expect(creditOnly.status, JSON.stringify(creditOnly.body)).toBe(201);
    await expectBoth({
      accountNumber,
      city: "Austin",
      state: "TX",
      lastPaymentAt: unattributedDate.toISOString(),
      lastPaymentAmount: "5.00",
      doctorLastPayments: [{
        doctorIdentity: "dr. live",
        lastPaymentAt: backdated.toISOString(),
        lastPaymentAmount: "20.00",
      }],
    });
  });

  it("serves the inline card configuration only when Stripe is configured", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const cardConfig = () => request(app)
      .get("/api/billing/payment-sessions/card/config")
      .query({ labOrganizationId: labId })
      .set(auth);

    getStripePublishableKey.mockResolvedValueOnce("pk_test_card_config");
    const configured = await cardConfig();
    expect(configured.status, JSON.stringify(configured.body)).toBe(200);
    expect(configured.body.data).toEqual({ publishableKey: "pk_test_card_config" });

    getStripePublishableKey.mockResolvedValueOnce(null);
    const unconfigured = await cardConfig();
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.data).toBeUndefined();
  });
});
