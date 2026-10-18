import {
  customerCreditApplications,
  customerCredits,
  db,
  payments,
  providerPaymentAllocations,
  providerPaymentCheckouts,
  providerPaymentCustomers,
  statementPaymentApplications,
  statementPaymentReversals,
  statementPaymentSessions,
} from "@workspace/db";
import { eq, inArray, or, type SQL } from "drizzle-orm";

export type PaymentFixtureScope = {
  userIds?: string[];
  organizationIds?: string[];
  invoiceIds?: string[];
  transactionIds?: string[];
  paymentSessionIds?: string[];
  checkoutIds?: string[];
};

function values(ids: string[] | undefined): string[] {
  return Array.from(new Set(ids ?? []));
}

function anyOf(conditions: SQL[]): SQL | undefined {
  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : or(...conditions);
}

/**
 * Removes payment records created by an integration-test fixture without
 * touching the fixture's users, organizations, invoices, or bank transactions.
 * Callers remain responsible for deleting those parent rows afterward.
 */
export async function cleanupPaymentFixtures(
  scope: PaymentFixtureScope,
  database: typeof db = db,
): Promise<void> {
  const userIds = values(scope.userIds);
  const organizationIds = values(scope.organizationIds);
  const invoiceIds = values(scope.invoiceIds);
  const transactionIds = values(scope.transactionIds);
  const requestedSessionIds = values(scope.paymentSessionIds);
  const requestedCheckoutIds = values(scope.checkoutIds);

  if (
    userIds.length === 0 &&
    organizationIds.length === 0 &&
    invoiceIds.length === 0 &&
    transactionIds.length === 0 &&
    requestedSessionIds.length === 0 &&
    requestedCheckoutIds.length === 0
  ) {
    return;
  }

  await database.transaction(async (tx) => {
    const sessionConditions: SQL[] = [];
    if (requestedSessionIds.length) {
      sessionConditions.push(inArray(statementPaymentSessions.id, requestedSessionIds));
    }
    if (userIds.length) {
      sessionConditions.push(inArray(statementPaymentSessions.createdByUserId, userIds));
    }
    if (organizationIds.length) {
      sessionConditions.push(
        inArray(statementPaymentSessions.labOrganizationId, organizationIds),
        inArray(statementPaymentSessions.providerOrganizationId, organizationIds),
      );
    }
    if (transactionIds.length) {
      sessionConditions.push(
        inArray(statementPaymentSessions.bankTransactionId, transactionIds),
      );
    }
    if (requestedCheckoutIds.length) {
      sessionConditions.push(
        inArray(
          statementPaymentSessions.providerPaymentCheckoutId,
          requestedCheckoutIds,
        ),
      );
    }
    if (invoiceIds.length) {
      sessionConditions.push(
        inArray(
          statementPaymentSessions.id,
          tx
            .select({ id: statementPaymentApplications.paymentSessionId })
            .from(statementPaymentApplications)
            .where(inArray(statementPaymentApplications.invoiceId, invoiceIds)),
        ),
        inArray(
          statementPaymentSessions.id,
          tx
            .select({ id: customerCreditApplications.paymentSessionId })
            .from(customerCreditApplications)
            .where(inArray(customerCreditApplications.invoiceId, invoiceIds)),
        ),
        inArray(
          statementPaymentSessions.id,
          tx
            .select({ id: payments.paymentSessionId })
            .from(payments)
            .where(inArray(payments.invoiceId, invoiceIds)),
        ),
      );
    }

    const sessionWhere = anyOf(sessionConditions);
    const sessionRows = sessionWhere
      ? await tx
          .select({
            id: statementPaymentSessions.id,
            checkoutId: statementPaymentSessions.providerPaymentCheckoutId,
          })
          .from(statementPaymentSessions)
          .where(sessionWhere)
      : [];
    const sessionIds = values([
      ...requestedSessionIds,
      ...sessionRows.map((row) => row.id),
    ]);

    const checkoutConditions: SQL[] = [];
    if (requestedCheckoutIds.length) {
      checkoutConditions.push(inArray(providerPaymentCheckouts.id, requestedCheckoutIds));
    }
    if (userIds.length) {
      checkoutConditions.push(inArray(providerPaymentCheckouts.initiatedByUserId, userIds));
    }
    if (organizationIds.length) {
      checkoutConditions.push(
        inArray(providerPaymentCheckouts.providerOrganizationId, organizationIds),
      );
    }
    if (invoiceIds.length) {
      checkoutConditions.push(
        inArray(
          providerPaymentCheckouts.id,
          tx
            .select({ id: providerPaymentAllocations.checkoutId })
            .from(providerPaymentAllocations)
            .where(inArray(providerPaymentAllocations.invoiceId, invoiceIds)),
        ),
        inArray(
          providerPaymentCheckouts.id,
          tx
            .select({ id: payments.providerPaymentCheckoutId })
            .from(payments)
            .where(inArray(payments.invoiceId, invoiceIds)),
        ),
      );
    }
    const discoveredSessionCheckoutIds = sessionRows
      .map((row) => row.checkoutId)
      .filter((id): id is string => id !== null);
    const checkoutWhere = anyOf(checkoutConditions);
    const checkoutRows = checkoutWhere
      ? await tx
          .select({ id: providerPaymentCheckouts.id })
          .from(providerPaymentCheckouts)
          .where(checkoutWhere)
      : [];
    const checkoutIds = values([
      ...requestedCheckoutIds,
      ...discoveredSessionCheckoutIds,
      ...checkoutRows.map((row) => row.id),
    ]);

    if (sessionIds.length) {
      await tx.delete(statementPaymentReversals).where(
        inArray(statementPaymentReversals.paymentSessionId, sessionIds),
      );
    }

    const creditApplicationConditions: SQL[] = [];
    const applicationConditions: SQL[] = [];
    const paymentConditions: SQL[] = [];
    const allocationConditions: SQL[] = [];
    if (sessionIds.length) {
      creditApplicationConditions.push(
        inArray(customerCreditApplications.paymentSessionId, sessionIds),
      );
      applicationConditions.push(
        inArray(statementPaymentApplications.paymentSessionId, sessionIds),
      );
      paymentConditions.push(inArray(payments.paymentSessionId, sessionIds));
    }
    if (invoiceIds.length) {
      creditApplicationConditions.push(
        inArray(customerCreditApplications.invoiceId, invoiceIds),
      );
      applicationConditions.push(
        inArray(statementPaymentApplications.invoiceId, invoiceIds),
      );
      paymentConditions.push(inArray(payments.invoiceId, invoiceIds));
      allocationConditions.push(
        inArray(providerPaymentAllocations.invoiceId, invoiceIds),
      );
    }
    if (checkoutIds.length) {
      paymentConditions.push(
        inArray(payments.providerPaymentCheckoutId, checkoutIds),
      );
      allocationConditions.push(
        inArray(providerPaymentAllocations.checkoutId, checkoutIds),
      );
    }
    if (transactionIds.length) {
      paymentConditions.push(inArray(payments.bankTransactionId, transactionIds));
    }

    const creditApplicationWhere = anyOf(creditApplicationConditions);
    if (creditApplicationWhere) {
      await tx.delete(customerCreditApplications).where(creditApplicationWhere);
    }
    const applicationWhere = anyOf(applicationConditions);
    if (applicationWhere) {
      await tx.delete(statementPaymentApplications).where(applicationWhere);
    }
    const paymentWhere = anyOf(paymentConditions);
    if (paymentWhere) {
      await tx.delete(payments).where(paymentWhere);
    }
    if (sessionIds.length) {
      await tx
        .delete(customerCredits)
        .where(inArray(customerCredits.paymentSessionId, sessionIds));
    }
    const allocationWhere = anyOf(allocationConditions);
    if (allocationWhere) {
      await tx.delete(providerPaymentAllocations).where(allocationWhere);
    }
    if (sessionIds.length) {
      await tx
        .delete(statementPaymentSessions)
        .where(inArray(statementPaymentSessions.id, sessionIds));
    }
    if (checkoutIds.length) {
      await tx
        .delete(providerPaymentCheckouts)
        .where(inArray(providerPaymentCheckouts.id, checkoutIds));
    }
    if (organizationIds.length) {
      await tx
        .delete(providerPaymentCustomers)
        .where(inArray(providerPaymentCustomers.providerOrganizationId, organizationIds));
    }
  });
}