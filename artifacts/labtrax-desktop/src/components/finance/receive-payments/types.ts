import type { ReceivePaymentsInputPaymentMethod } from "@workspace/api-client-react";

/** One invoice as the statement and eligible-account endpoints report it. */
export type StatementInvoice = {
  id: string;
  invoiceNumber: string;
  patientName?: string | null;
  doctorName?: string | null;
  doctor?: string | null;
  doctorIdentity?: string | null;
  doctorProfileId?: string | null;
  doctorDisplayName?: string | null;
  /** Historical issued-statement value. */
  status?: string;
  /** Historical issued-statement value. */
  issuedAt?: string;
  /** Historical issued-statement value. */
  dueAt?: string | null;
  total?: string;
  invoiceAmount?: string;
  /** Live settlement value. */
  currentDue?: string;
  /** Live settlement value. */
  currentBalanceDue?: string;
  /** Live payment rule. */
  eligibleForPayment?: boolean;
  detailProvenance?: "snapshot" | "live" | "unavailable";
};

export type EligibleStatementSummary = {
  statementId: string;
  sentAt: string;
  periodStart: string | null;
  periodEnd: string;
  invoiceCount: number;
  /** The statement's own payable invoices; a statement payment may settle only these. */
  invoiceIds?: string[];
};

/**
 * A customer the lab can receive a payment from, as returned by the
 * eligible-statement-accounts endpoint (a payable sent statement) or the
 * eligible-invoice-accounts endpoint (finalized open invoices). Invoice-led
 * rows carry no statement fields.
 */
export type EligibleAccount = {
  providerOrganizationId: string;
  providerName: string;
  statementId?: string | null;
  periodEnd?: string;
  sentAt?: string;
  invoiceCount: number;
  currentBalanceDue: string;
  statementCount?: number;
  sentDates?: string[];
  periodStart?: string | null;
  periods?: Array<{ periodStart: string | null; periodEnd: string }>;
  statements?: EligibleStatementSummary[];
  doctorNames?: string[];
  doctors?: Array<{ doctorIdentity: string | null; doctorDisplayName: string }>;
  doctorProfiles?: Array<{ id: string; doctorName: string; doctorDisplayName: string }>;
  outstandingInvoices?: StatementInvoice[];
  /** Customer Center account number; null when the customer has none. */
  accountNumber?: string | null;
  city?: string | null;
  state?: string | null;
  /** Most recent non-reversed payment the lab received from the customer. */
  lastPaymentAt?: string | null;
  lastPaymentAmount?: string | null;
};

/**
 * What one selected customer's payment covers. Statement mode pays the
 * customer's payable sent statement; invoices mode pays outstanding invoices
 * directly. `invoiceIds` limits either mode to chosen invoices (null = all).
 */
export type CustomerScope = {
  mode: "statement" | "invoices";
  invoiceIds: string[] | null;
  /** Picking an invoice outside the statement switched this customer to paying invoices directly. */
  switchedFromStatement?: boolean;
  /** The picked invoice that is not on the statement. */
  switchedBy?: string;
};

/** The selected customers, in the order the receiving step processes them. */
export type Selection = {
  ids: string[];
  scopes: Record<string, CustomerScope>;
};

export type PaymentDefaults = {
  paymentMethod: ReceivePaymentsInputPaymentMethod;
  paymentDate: string;
  memo: string;
};

export type PaymentOptions = {
  /** Allocate the amount received to the oldest invoices automatically. */
  applyOldestFirst: boolean;
  /** Let money received exceed what is applied; the excess becomes customer credit. */
  allowOverpayment: boolean;
  /** Open the receipt step with the receipt email ready to send. */
  emailReceipts: boolean;
};

export const DEFAULT_PAYMENT_OPTIONS: PaymentOptions = {
  applyOldestFirst: true,
  allowOverpayment: true,
  emailReceipts: false,
};

export type SavedSelection = {
  name: string;
  savedAt: string;
  /**
   * The customers in processing order, each with the payment scope chosen
   * when the set was saved. Sets saved before scopes were kept have none;
   * those customers load with their default scope.
   */
  customers: Array<{ id: string; name: string; scope?: CustomerScope }>;
};
