import { ReceivePaymentsInputPaymentMethod } from "@workspace/api-client-react";
import { ApiError } from "@/lib/api";
import type { PayableCustomer } from "./model";
import { scopeInvoices } from "./model";
import type { CustomerScope, PaymentDefaults, StatementInvoice } from "./types";

export const AUTOMATIC_CARD_ATTEMPT_MESSAGE =
  "Stripe is still confirming a prior card attempt. The invoice remains reserved while automatic reconciliation runs. Do not submit another charge.";
export const SUPPORT_CARD_ATTEMPT_MESSAGE =
  "A prior card attempt has an uncertain processor outcome. Support review is required before this invoice can be charged. Do not submit another charge.";

export type Statement = {
  id: string;
  periodStart: string;
  periodEnd: string;
  savedBalanceDue: string;
  invoiceCount: number;
  detailProvenance?: "snapshot" | "live" | "mixed";
};

export type StatementPage = {
  rows: Statement[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextCursor?: string | null;
};

export type Draft = {
  statementId: string;
  paymentDate: string;
  paymentMethod: ReceivePaymentsInputPaymentMethod;
  doctorIdentity: string | null;
  doctorName: string | null;
  referenceNumber: string;
  memo: string;
  totalReceived: string;
  existingCreditAmount: string;
  applications: Record<string, string>;
  creditApplications: Record<string, string>;
  idempotencyKey: string;
  generatedReference?: string;
  cardChoice: "saved" | "new";
  cardholderName: string;
  saveCard: boolean;
  /** Invoices picked on the selection screen; null pays from every eligible invoice. */
  scopeInvoiceIds?: string[] | null;
};

export type Session = {
  id: string;
  customerEmail?: string | null;
  receiptNumber?: string;
  receivedAmount?: string;
  appliedAmount?: string;
  customerCreditAmount?: string;
  accountBalanceAfter?: string;
  doctorIdentity?: string | null;
  doctorDisplayName?: string | null;
  status?: string;
  reversal?: { status: "pending" | "completed" | "failed"; reason?: string | null } | null;
};

export type LegacySessionResponse = {
  paymentSession?: Session & {
    reversal?: { status: "pending" | "completed" | "failed"; failureReason?: string | null } | null;
  };
};

export const sessionFromResponse = (response: Session | LegacySessionResponse): Session => {
  const session =
    "paymentSession" in response && response.paymentSession ? response.paymentSession : (response as Session);
  const reversal = session.reversal;
  return reversal && "failureReason" in reversal
    ? {
        ...session,
        reversal: {
          status: reversal.status,
          reason: typeof reversal.failureReason === "string" ? reversal.failureReason : null,
        },
      }
    : session;
};

export function paymentErrorMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.status === 409 &&
    error.body &&
    typeof error.body === "object" &&
    "details" in error.body &&
    error.body.details &&
    typeof error.body.details === "object" &&
    (error.body.details as { code?: unknown }).code === "CARD_PAYMENT_ATTEMPT_BLOCKED"
  ) {
    const nextStep = (error.body.details as {
      nextStep?: "automatic_reconciliation" | "support_review";
    }).nextStep;
    return nextStep === "automatic_reconciliation"
      ? AUTOMATIC_CARD_ATTEMPT_MESSAGE
      : SUPPORT_CARD_ATTEMPT_MESSAGE;
  }
  return error instanceof Error ? error.message : "Payment could not be completed.";
}

/** Payment methods in the order the reference lists them. */
export const PAYMENT_METHODS: readonly ReceivePaymentsInputPaymentMethod[] = [
  ReceivePaymentsInputPaymentMethod.check,
  ReceivePaymentsInputPaymentMethod.ach,
  ReceivePaymentsInputPaymentMethod.card,
  ReceivePaymentsInputPaymentMethod.cash,
  ReceivePaymentsInputPaymentMethod.other,
];

export function paymentMethodLabel(method: ReceivePaymentsInputPaymentMethod): string {
  return method === "ach" ? "ACH" : method[0]!.toUpperCase() + method.slice(1);
}

export const DEFAULT_SUBJECT = "Payment receipt from {{labName}} — {{receiptNumber}}";
export const DEFAULT_BODY =
  "Hello {{customerName}},\n\nThank you for your payment to {{labName}}.\n\nThank you,\n{{labName}}";

const key = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `payment-${Date.now()}-${Math.random()}`;

export const normalizeDoctorName = (value: string | null | undefined) =>
  value?.trim().replace(/\s+/g, " ").toLowerCase() || "";

export function localCalendarDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const freshDraft = (statementId = ""): Draft => ({
  statementId,
  doctorIdentity: null,
  doctorName: null,
  paymentDate: localCalendarDate(),
  paymentMethod: ReceivePaymentsInputPaymentMethod.check,
  referenceNumber: "",
  memo: "",
  totalReceived: "",
  existingCreditAmount: "",
  applications: {},
  creditApplications: {},
  idempotencyKey: key(),
  cardChoice: "saved",
  cardholderName: "",
  saveCard: false,
});

/** A fresh draft carrying the Payment Summary defaults. */
export function draftWithDefaults(statementId: string, defaults: PaymentDefaults | null): Draft {
  const draft = freshDraft(statementId);
  if (!defaults) return draft;
  return {
    ...draft,
    paymentMethod: defaults.paymentMethod,
    paymentDate: defaults.paymentDate || draft.paymentDate,
    memo: defaults.memo,
  };
}

/**
 * Spreads `amount` over the oldest invoices first (by due date, else issue
 * date), each up to its current balance. Whatever is left over stays
 * unapplied; an unreadable balance counts as nothing owed.
 */
export function allocateOldestFirst(
  invoices: readonly StatementInvoice[],
  amount: number,
): Record<string, string> {
  const applications: Record<string, string> = {};
  const age = (invoice: StatementInvoice) => new Date(invoice.dueAt || invoice.issuedAt || 0).getTime();
  let rest = amount;
  for (const invoice of [...invoices].sort((a, b) => age(a) - age(b))) {
    if (!(rest > 0)) break;
    const value = Math.min(Number(invoice.currentBalanceDue) || 0, rest);
    if (value <= 0) continue;
    applications[invoice.id] = value.toFixed(2);
    rest = +(rest - value).toFixed(2);
  }
  return applications;
}

/** The statement a scope pays, or "" to pay outstanding invoices directly. */
export function scopeStatementId(customer: PayableCustomer, scope: CustomerScope): string {
  return scope.mode === "statement" && customer.statement ? customer.statement.statementId : "";
}

/**
 * The draft a customer starts the receiving step with: the summary defaults
 * and the invoices picked on the selection screen. A statement draft is
 * filled in once its statement loads; an invoice-led draft is filled in here,
 * receiving each scoped invoice's full balance.
 */
export function batchDraft(
  customer: PayableCustomer,
  scope: CustomerScope,
  defaults: PaymentDefaults | null,
): Draft {
  const statementId = scopeStatementId(customer, scope);
  const draft: Draft = { ...draftWithDefaults(statementId, defaults), scopeInvoiceIds: scope.invoiceIds };
  if (statementId) return draft;
  const invoices = scopeInvoices(customer, scope) ?? [];
  const applications: Record<string, string> = {};
  let total = 0;
  for (const invoice of invoices) {
    if (invoice.balance <= 0) continue;
    applications[invoice.id] = invoice.balance.toFixed(2);
    total += invoice.balance;
  }
  if (total <= 0) return draft;
  return { ...draft, totalReceived: total.toFixed(2), applications };
}
