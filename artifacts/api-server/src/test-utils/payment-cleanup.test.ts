import { randomBytes } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  bankAccounts,
  bankTransactions,
  customerCreditApplications,
  customerCredits,
  db,
  invoices,
  payments,
  providerPaymentAllocations,
  providerPaymentCheckouts,
  statementPaymentApplications,
  statementPaymentReversals,
  statementPaymentSessions,
  organizations,
  users,
} from "@workspace/db";
import { cleanupPaymentFixtures } from "./payment-cleanup.js";

const SHOULD_RUN = !!process.env.DATABASE_URL;
const maybe = SHOULD_RUN ? describe : describe.skip;
const rid = (prefix: string) =>
  `${prefix}_${randomBytes(8).toString("hex")}`;

maybe("payment fixture cleanup", () => {
  const labId = rid("cleanup_test_lab");
  const providerId = rid("cleanup_test_provider");
  const userId = rid("cleanup_test_user");
  const fixtureIds: Graph[] = [];
  let bankAccountId = "";

  type Graph = {
    invoiceId: string;
    transactionId: string;
    checkoutId: string;
    sessionId: string;
    dependentRows: Array<{
      table: any;
      id: string;
    }>;
  };

  beforeAll(async () => {
    await db.insert(users).values({
      id: userId,
      username: userId,
      password: "x",
    });
    await db.insert(organizations).values([
      { id: labId, type: "lab", name: "Payment Cleanup Test Lab" },
      {
        id: providerId,
        type: "provider",
        name: "Payment Cleanup Test Practice",
        parentLabOrganizationId: labId,
      },
    ]);
    const [account] = await db
      .insert(bankAccounts)
      .values({
        labOrganizationId: labId,
        name: "Payment Cleanup Test Account",
        openingBalance: "0.00",
        openingDate: new Date(),
        accountType: "undeposited_funds",
        createdByUserId: userId,
      })
      .returning({ id: bankAccounts.id });
    bankAccountId = account.id;
  });

  afterEach(async () => {
    if (!fixtureIds.length) return;

    const invoiceIds = fixtureIds.map((graph) => graph.invoiceId);
    const transactionIds = fixtureIds.map((graph) => graph.transactionId);
    await cleanupPaymentFixtures({ invoiceIds, transactionIds }, db);
    await db
      .delete(bankTransactions)
      .where(inArray(bankTransactions.id, transactionIds));
    await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
    fixtureIds.length = 0;
  });

  afterAll(async () => {
    await db.delete(bankAccounts).where(eq(bankAccounts.id, bankAccountId));
    await db.delete(organizations).where(eq(organizations.id, providerId));
    await db.delete(organizations).where(eq(organizations.id, labId));
    await db.delete(users).where(eq(users.id, userId));
  });

  async function createGraph(prefix: string): Promise<Graph> {
    const invoiceId = rid(`${prefix}_invoice`);
    const transactionId = rid(`${prefix}_transaction`);
    const checkoutId = rid(`${prefix}_checkout`);
    const sessionId = rid(`${prefix}_session`);
    const allocationId = rid(`${prefix}_allocation`);
    const applicationId = rid(`${prefix}_application`);
    const paymentId = rid(`${prefix}_payment`);
    const creditId = rid(`${prefix}_credit`);
    const creditApplicationId = rid(`${prefix}_credit_application`);
    const reversalId = rid(`${prefix}_reversal`);
    const invoiceNumber = rid("CLEANUP_INV");

    await db.insert(invoices).values({
      id: invoiceId,
      invoiceNumber,
      labOrganizationId: labId,
      providerOrganizationId: providerId,
      status: "open",
      total: "20.00",
      balanceDue: "20.00",
      createdByUserId: userId,
    });
    await db.insert(bankTransactions).values({
      id: transactionId,
      labOrganizationId: labId,
      bankAccountId,
      txnDate: new Date(),
      type: "deposit",
      payee: "Payment Cleanup Test",
      creditAmount: "20.00",
      netAmount: "20.00",
      source: "customer_payment",
      createdByUserId: userId,
    });
    await db.insert(providerPaymentCheckouts).values({
      id: checkoutId,
      providerOrganizationId: providerId,
      initiatedByUserId: userId,
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
      providerOrganizationId: providerId,
      bankTransactionId: transactionId,
      providerPaymentCheckoutId: checkoutId,
      requestFingerprint: rid("cleanup_fingerprint"),
      receiptNumber: rid("CLEANUP_RECEIPT"),
      receivedAmount: "20.00",
      appliedAmount: "10.00",
      customerCreditAmount: "10.00",
      accountBalanceAfter: "0.00",
      paymentMethod: "card",
      labName: "Payment Cleanup Test Lab",
      createdByUserId: userId,
    });
    await db.insert(statementPaymentApplications).values({
      id: applicationId,
      paymentSessionId: sessionId,
      invoiceId,
      invoiceNumber,
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
      recordedByUserId: userId,
    });
    await db.insert(customerCredits).values({
      id: creditId,
      labOrganizationId: labId,
      providerOrganizationId: providerId,
      paymentSessionId: sessionId,
      amount: "10.00",
      remainingAmount: "10.00",
      createdByUserId: userId,
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
      initiatedByUserId: userId,
    });

    const graph: Graph = {
      invoiceId,
      transactionId,
      checkoutId,
      sessionId,
      dependentRows: [
        { table: statementPaymentReversals, id: reversalId },
        { table: customerCreditApplications, id: creditApplicationId },
        { table: statementPaymentApplications, id: applicationId },
        { table: payments, id: paymentId },
        { table: customerCredits, id: creditId },
        { table: providerPaymentAllocations, id: allocationId },
        { table: statementPaymentSessions, id: sessionId },
        { table: providerPaymentCheckouts, id: checkoutId },
      ],
    };
    fixtureIds.push(graph);
    return graph;
  }

  async function expectRow(table: any, id: string, count: number) {
    await expect(db.select().from(table).where(eq(table.id, id))).resolves.toHaveLength(
      count,
    );
  }

  it.each([
    { label: "session", selector: "paymentSessionIds", key: "sessionId" },
    { label: "invoice", selector: "invoiceIds", key: "invoiceId" },
    { label: "checkout", selector: "checkoutIds", key: "checkoutId" },
    { label: "transaction", selector: "transactionIds", key: "transactionId" },
  ] as const)(
    "removes every dependent row when the graph is discovered through a linked $label",
    async ({ selector, key }) => {
      const owned = await createGraph("owned");
      const unrelated = await createGraph("unrelated");

      await cleanupPaymentFixtures(
        { [selector]: [owned[key]] },
        db,
      );

      for (const row of owned.dependentRows) {
        await expectRow(row.table, row.id, 0);
      }
      await expectRow(invoices, owned.invoiceId, 1);
      await expectRow(bankTransactions, owned.transactionId, 1);

      for (const row of unrelated.dependentRows) {
        await expectRow(row.table, row.id, 1);
      }
      await expectRow(invoices, unrelated.invoiceId, 1);
      await expectRow(bankTransactions, unrelated.transactionId, 1);
    },
  );
});