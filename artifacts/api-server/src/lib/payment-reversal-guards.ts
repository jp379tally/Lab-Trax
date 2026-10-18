import { and, eq, inArray } from "drizzle-orm";
import {
  statementPaymentApplications,
  statementPaymentReversals,
  statementPaymentSessions,
} from "@workspace/db";
import { HttpError } from "./http";

const ACTIVE = ["pending_processor", "processing", "processor_succeeded"];

export async function assertNoActiveCardReversalForInvoices(
  tx: any,
  invoiceIds: string[],
) {
  if (!invoiceIds.length) return;
  const [row] = await tx.select({ id: statementPaymentReversals.id })
    .from(statementPaymentApplications)
    .innerJoin(statementPaymentSessions, eq(statementPaymentSessions.id, statementPaymentApplications.paymentSessionId))
    .innerJoin(statementPaymentReversals, eq(statementPaymentReversals.paymentSessionId, statementPaymentSessions.id))
    .where(and(
      inArray(statementPaymentApplications.invoiceId, invoiceIds),
      eq(statementPaymentSessions.paymentMethod, "card"),
      inArray(statementPaymentReversals.status, ACTIVE),
    )).limit(1);
  if (row) throw new HttpError(409, "This invoice has a saved-card reversal in progress and cannot be changed.");
}

export async function assertNoActiveCardReversalForTransactions(
  tx: any,
  transactionIds: string[],
) {
  if (!transactionIds.length) return;
  const [row] = await tx.select({ id: statementPaymentReversals.id })
    .from(statementPaymentSessions)
    .innerJoin(statementPaymentReversals, eq(statementPaymentReversals.paymentSessionId, statementPaymentSessions.id))
    .where(and(
      inArray(statementPaymentSessions.bankTransactionId, transactionIds),
      eq(statementPaymentSessions.paymentMethod, "card"),
      inArray(statementPaymentReversals.status, ACTIVE),
    )).limit(1);
  if (row) throw new HttpError(409, "This payment has a saved-card reversal in progress and cannot be reconciled.");
}